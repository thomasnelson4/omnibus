// src/lib/komga/changes.ts
//
// HOT PATH. Called with `void recordLibraryChange(...)` from ~25 Node call sites (file moves,
// metadata embeds, conversions) and from the engine's POST /api/internal/library-changed.
//
// Rules this file must never break (a violation here is a production incident, not a lint nit):
//   * NO queue, NO bullmq, NO ioredis, NO client/factory, NOTHING that does HTTP. Komga is told
//     about a change by the flush timer later, never by an outbound call from here.
//   * NEVER throws and never rejects. Every caller uses `void`, so a rejection would surface as an
//     unhandled rejection — which fails a vitest run. The whole body is one try/catch.
//   * Never awaits anything slow. Two cached reads and at most three indexed queries per call.
//
// The one thing it does lose is documented and accepted: pendingPaths is merged with a
// read-modify-write, so two concurrent callers can drop a path from each other's list. Phase 3
// verification is the backstop — it re-lists the library and rescans on a miss, so a lost path
// costs a missed optimisation, never a missed book.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getLibraryRootEntries } from '@/lib/library-roots';
import { getKomgaHotFlags } from './settings';
import { normalizeKomgaPath } from './path-map';
import { KOMGA_PENDING_PATH_CAP } from './constants';

export interface LibraryChange {
    /** Absolute container paths of changed files/folders. BOTH old and new for a move/rename. */
    paths?: (string | null | undefined)[];
    seriesIds?: (string | null | undefined)[];
    issueIds?: (string | null | undefined)[];
    /** Short kebab-case slug: 'import', 'rename', 'issue-move', 'cbr-sweep', … */
    reason: string;
    /**
     * Provenance tag, used only in logs. CONTRACT-P2 typed this `'node' | 'engine'`, but
     * P2-INVENTORY's call sites need finer granularity ('converter:engine', 'api/library/rename:local',
     * 'match-collision:attachAsCollected') and none of those match that union. Widened to string;
     * see DEVIATIONS.md.
     */
    source?: string;
}

/** The per-library accumulator written to KomgaSyncState. */
interface LibraryAccumulator {
    paths: string[];
    /** True when this library was named by ID (series/issue), not merely implied by a path. */
    fromId: boolean;
}

/**
 * Merge `add` into a stored pendingPaths JSON array: dedupe, drop anything that no longer
 * normalizes, cap at KOMGA_PENDING_PATH_CAP and report whether the cap was exceeded (sticky — only
 * a scan that actually clears the state resets it).
 *
 * PURE. Returns `{ json: null }` when there is nothing to store, so the column is cleared rather
 * than set to "[]".
 */
export function mergePendingPaths(
    existingJson: string | null,
    add: string[],
    cap: number = KOMGA_PENDING_PATH_CAP
): { json: string | null; overflow: boolean } {
    const out: string[] = [];
    const seen = new Set<string>();
    let overflow = false;

    const push = (raw: string) => {
        const norm = normalizeKomgaPath(raw);
        if (!norm || seen.has(norm)) return;
        if (out.length >= cap) { overflow = true; return; }
        seen.add(norm);
        out.push(norm);
    };

    for (const p of parseStoredPaths(existingJson)) push(p);
    for (const p of add) push(p);

    return { json: out.length ? JSON.stringify(out) : null, overflow };
}

/** Existing pendingPaths, tolerating null, "" and corrupt JSON (corruption drops it rather than throwing). */
function parseStoredPaths(existingJson: string | null): string[] {
    if (!existingJson) return [];
    try {
        const parsed = JSON.parse(existingJson);
        return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * The Omnibus library whose root contains `p`, choosing the LONGEST matching root. Longest wins so
 * a library nested inside another (both roots can exist) is chosen over its parent.
 *
 * PURE. Normalized, case-sensitive, folder-boundary only: '/data/Series' is inside '/data', but
 * '/data/Series2' is not. Returns null when the path is outside every root.
 */
export function resolveLibraryForPath(p: string, libraries: { id: string; path: string }[]): string | null {
    const target = normalizeKomgaPath(p);
    if (!target) return null;

    let best: { id: string; len: number } | null = null;
    for (const lib of libraries) {
        const root = normalizeKomgaPath(lib.path);
        if (!root) continue;
        // Folder boundary only: equal, or a proper '/' prefix. ('/' as a root contains everything.)
        const contained = target === root || (root === '/' ? target !== '' : target.startsWith(root.endsWith('/') ? root : root + '/'));
        if (contained && (!best || root.length > best.len)) best = { id: lib.id, len: root.length };
    }
    return best?.id ?? null;
}

/**
 * Record that something changed in one or more Omnibus libraries. Resolves always; throws never.
 *
 * Resolution rules (LIVE-verified, and a deliberate narrowing of PLAN's wording — see
 * DEVIATIONS.md):
 *   * A path that is positively OUTSIDE every library root is DROPPED and does not trigger the
 *     mark-all fallback. Staging, download and /unmatched writes legitimately look like this, and
 *     scanning every library because someone tidied a cache directory is worse than missing a
 *     hint we were not going to act on.
 *   * The mark-all fallback fires only when IDs were given and NONE of them could be attributed —
 *     a series/issue row that no longer exists, or one with a null libraryId and an out-of-root
 *     folderPath — AND no path resolved either. Those are genuinely unclassifiable inputs.
 */
export async function recordLibraryChange(change: LibraryChange): Promise<void> {
    try {
        const flags = await getKomgaHotFlags();
        if (!flags.enabled || !flags.scanOnChange) return;

        const paths = (change.paths ?? []).filter((p): p is string => typeof p === 'string' && p.length > 0);
        const seriesIds = (change.seriesIds ?? []).filter((s): s is string => typeof s === 'string' && s.length > 0);
        const issueIds = (change.issueIds ?? []).filter((s): s is string => typeof s === 'string' && s.length > 0);
        if (paths.length === 0 && seriesIds.length === 0 && issueIds.length === 0) return;

        const libraries = await getLibraryRootEntries();
        if (libraries.length === 0) return;

        const byId = new Map<string, LibraryAccumulator>();
        const acc = (libraryId: string): LibraryAccumulator => {
            let e = byId.get(libraryId);
            if (!e) { e = { paths: [], fromId: false }; byId.set(libraryId, e); }
            return e;
        };

        for (const p of paths) {
            const libId = resolveLibraryForPath(p, libraries);
            if (libId) acc(libId).paths.push(p);
        }

        if (seriesIds.length) {
            const rows = await prisma.series.findMany({
                where: { id: { in: seriesIds } },
                select: { id: true, libraryId: true, folderPath: true },
            });
            for (const row of rows) {
                if (row.libraryId) acc(row.libraryId).fromId = true;
                // A null libraryId still carries a folderPath that may sit under a root.
                if (!row.libraryId && row.folderPath) {
                    const libId = resolveLibraryForPath(row.folderPath, libraries);
                    if (libId) acc(libId).fromId = true;
                }
            }
        }

        if (issueIds.length) {
            const rows = await prisma.issue.findMany({
                where: { id: { in: issueIds } },
                select: { filePath: true, series: { select: { libraryId: true, folderPath: true } } },
            });
            for (const row of rows) {
                const libId = row.series?.libraryId ?? (row.series?.folderPath ? resolveLibraryForPath(row.series.folderPath, libraries) : null);
                if (!libId) continue;
                const e = acc(libId);
                e.fromId = true;
                // The issue's own file is the path that matters — its series folder is a prefix
                // guess, and Phase 3 treats directories as prefixes.
                if (row.filePath) e.paths.push(row.filePath);
            }
        }

        const unresolvedIds = (seriesIds.length + issueIds.length) > 0 && !Array.from(byId.values()).some(e => e.fromId);
        if (unresolvedIds && byId.size === 0) {
            // Nothing was attributable at all (including no path). Mark every library dirty with no
            // paths: verification will find whatever actually moved.
            for (const lib of libraries) { acc(lib.id); }
            Logger.log(`[Komga] recordLibraryChange: ${seriesIds.length} series / ${issueIds.length} issue ids unresolvable; marking all ${libraries.length} libraries dirty (reason=${change.reason})`, 'debug');
        }

        const now = new Date();
        for (const [libraryId, entry] of byId) {
            // Read-modify-write. A concurrent writer can drop a path from pendingPaths; Phase 3
            // verification is the backstop, so this is a lost optimisation, never a missed book.
            const existing = await prisma.komgaSyncState.findUnique({ where: { omnibusLibraryId: libraryId } });
            const merged = mergePendingPaths(existing?.pendingPaths ?? null, entry.paths);
            const overflow = merged.overflow || Boolean(existing?.pendingOverflow);

            await prisma.komgaSyncState.upsert({
                where: { omnibusLibraryId: libraryId },
                create: {
                    omnibusLibraryId: libraryId,
                    dirtySince: now,
                    lastChangeAt: now,
                    pendingPaths: merged.json,
                    pendingOverflow: overflow,
                },
                update: {
                    // dirtySince sticks at the FIRST change of a burst; that is what the max-wait
                    // clause of the due rule is measured from.
                    dirtySince: existing?.dirtySince ?? now,
                    lastChangeAt: now,
                    pendingPaths: merged.json,
                    pendingOverflow: overflow,
                },
            });
        }
    } catch (e) {
        Logger.log(`[Komga] recordLibraryChange failed: ${getErrorMessage(e)}`, 'debug');
    }
}
