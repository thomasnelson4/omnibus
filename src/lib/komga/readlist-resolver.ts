// src/lib/komga/readlist-resolver.ts
//
// What a reading list looks like in Komga: the ordered list of book ids to push, plus why every
// entry that is NOT in it was left out. The push itself (readlist-push.ts) owns naming, ownership
// and idempotence; this module only answers "which books, in which order, and what was skipped".
//
// Two halves, on purpose:
//   - resolveReadList(ctx) is PURE. Everything it needs is handed in — the entries, the resolved
//     issues, the book links, the library map, the path mappings — so all six classification
//     buckets are unit-testable without a database or a Komga.
//   - resolveReadListForPush() loads that context and calls the pure core.
//
// It never WRITES. In particular it does not write the `issueId` back onto a ReadingListItem when it
// resolves one through a provider id: that is the GET /api/reading-lists auto-link's job, with its
// owner-access and conditional-write rules, and a push must not silently make an edit the user did
// not make. Both sides share the same lookup rule (pickIssueForProviderId) so they cannot disagree.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { findIssueForProviderId } from '@/lib/reading-list-links';
import { isBookLinkValid } from './reconcile';
import { isKomgaScannable, toKomgaPath, type KomgaPathMapping } from './path-map';
import {
    komgaLibrariesForOmnibusLibrary,
    komgaLibraryRowToResolved,
    type OmnibusLibraryRef,
    type ResolvedKomgaLibrary,
} from './libraries';
import type { KomgaSettings } from './settings';
import { getKomgaSettings } from './settings';

/** Every way an entry can fail to become a Komga book. Stable strings: they are stored and shown. */
export type SkipReason =
    | 'placeholder'
    | 'notDownloaded'
    | 'unsupportedFormat'
    | 'libraryUnmapped'
    | 'awaitingScan'
    | 'duplicate';

export interface SkippedSummary {
    placeholder: number;
    notDownloaded: number;
    unsupportedFormat: number;
    libraryUnmapped: number;
    awaitingScan: number;
    duplicate: number;
}

export function emptySkippedSummary(): SkippedSummary {
    return { placeholder: 0, notDownloaded: 0, unsupportedFormat: 0, libraryUnmapped: 0, awaitingScan: 0, duplicate: 0 };
}

export function serializeSkippedSummary(s: SkippedSummary): string {
    return JSON.stringify(s);
}

/** Tolerant parse of a stored skippedSummary column; anything unreadable reads as all-zero. */
export function parseSkippedSummary(raw: string | null | undefined): SkippedSummary {
    const out = emptySkippedSummary();
    if (!raw) return out;
    try {
        const o = JSON.parse(raw) as Record<string, unknown>;
        for (const k of Object.keys(out) as (keyof SkippedSummary)[]) {
            const v = o?.[k];
            if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
        }
    } catch {
        // A truncated column must not take the status API down.
    }
    return out;
}

/** One reading-list entry, as the resolver sees it. */
export interface ResolverItem {
    id: string;
    order: number;
    issueId: string | null;
    cvIssueId: number | null;
    metadataSource: string;
    title: string;
}

/** A local Issue, reduced to what classification needs. */
export interface ResolverIssue {
    id: string;
    filePath: string | null;
    libraryId: string | null;
}

export interface ResolverBookLink {
    issueId?: string;
    komgaBookId: string;
    komgaLibraryId: string;
    omnibusPath: string;
}

export interface ResolvedEntry {
    itemId: string;
    issueId: string | null;
    komgaBookId: string | null;
    /** null when the entry became a book. */
    reason: SkipReason | null;
}

export interface ResolveResult {
    /** Komga book ids in list order, first occurrence wins. */
    bookIds: string[];
    entries: ResolvedEntry[];
    skipped: SkippedSummary;
    total: number;
    resolvedCount: number;
}

export interface ResolveContext {
    items: ResolverItem[];
    /** Linked issues, keyed by Issue.id. */
    issuesById: Map<string, ResolverIssue>;
    /** Issues resolved through a provider id, keyed `${metadataSource}:${cvIssueId}`. */
    issuesByProviderId: Map<string, ResolverIssue>;
    /** KomgaBookLink rows, keyed by Issue.id. Read-only: the resolver never creates one. */
    linksByIssueId: Map<string, ResolverBookLink>;
    komgaLibs: ResolvedKomgaLibrary[];
    omnibusLibraries: OmnibusLibraryRef[];
    pathMappings: KomgaPathMapping[];
}

export const providerKey = (source: string, cvIssueId: number) => `${source}:${cvIssueId}`;

/** (order, id) — `order` is user-set and duplicates are possible after a partial reorder. */
export function orderResolverItems(items: readonly ResolverItem[]): ResolverItem[] {
    return [...items].sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
}

/**
 * The pure core. `mappedLibraryIds` is derived from RUNTIME containment (a Komga library over a
 * parent folder serves several Omnibus libraries), not the cached `omnibusLibraryId` column.
 */
export function resolveReadList(ctx: ResolveContext): ResolveResult {
    const skipped = emptySkippedSummary();
    const entries: ResolvedEntry[] = [];
    const bookIds: string[] = [];
    const seenBooks = new Set<string>();

    const mappedLibraryIds = new Set<string>();
    for (const lib of ctx.omnibusLibraries) {
        if (komgaLibrariesForOmnibusLibrary(lib, ctx.komgaLibs).length > 0) mappedLibraryIds.add(lib.id);
    }

    // Komga library settings for the scannability test, keyed by Omnibus library id (first match wins:
    // the classification only asks "would any library serving this folder index this file").
    const libsByOmnibusId = new Map<string, ResolvedKomgaLibrary[]>();
    for (const lib of ctx.omnibusLibraries) {
        const serving = komgaLibrariesForOmnibusLibrary(lib, ctx.komgaLibs);
        if (serving.length) libsByOmnibusId.set(lib.id, serving);
    }

    const bump = (reason: SkipReason) => { skipped[reason] += 1; };

    for (const item of orderResolverItems(ctx.items)) {
        const issue = item.issueId
            ? ctx.issuesById.get(item.issueId) ?? null
            : (item.cvIssueId ? ctx.issuesByProviderId.get(providerKey(item.metadataSource, item.cvIssueId)) ?? null : null);

        // A title-only entry, and an entry whose provider issue simply is not in the library, have
        // nothing to push. Both are "a placeholder in the reading order".
        if (!issue) {
            bump('placeholder');
            entries.push({ itemId: item.id, issueId: null, komgaBookId: null, reason: 'placeholder' });
            continue;
        }
        if (!issue.filePath?.trim()) {
            bump('notDownloaded');
            entries.push({ itemId: item.id, issueId: issue.id, komgaBookId: null, reason: 'notDownloaded' });
            continue;
        }
        const libraryId = issue.libraryId;
        const serving = libraryId ? libsByOmnibusId.get(libraryId) : undefined;
        if (!serving || serving.length === 0) {
            bump('libraryUnmapped');
            entries.push({ itemId: item.id, issueId: issue.id, komgaBookId: null, reason: 'libraryUnmapped' });
            continue;
        }
        const komgaPath = toKomgaPath(issue.filePath, ctx.pathMappings);
        const scannable = !!komgaPath && serving.some(lib => isKomgaScannable(komgaPath, { root: lib.root, ...lib.settings }));
        if (!scannable) {
            // Includes "no path mapping covers this file": Komga cannot see it, so it cannot be a book.
            bump('unsupportedFormat');
            entries.push({ itemId: item.id, issueId: issue.id, komgaBookId: null, reason: 'unsupportedFormat' });
            continue;
        }
        const link = ctx.linksByIssueId.get(issue.id);
        if (!link || !isBookLinkValid(link, issue.filePath)) {
            bump('awaitingScan');
            entries.push({ itemId: item.id, issueId: issue.id, komgaBookId: null, reason: 'awaitingScan' });
            continue;
        }
        if (seenBooks.has(link.komgaBookId)) {
            // The same book twice in one list: Komga rejects duplicate bookIds outright (400).
            bump('duplicate');
            entries.push({ itemId: item.id, issueId: issue.id, komgaBookId: link.komgaBookId, reason: 'duplicate' });
            continue;
        }
        seenBooks.add(link.komgaBookId);
        bookIds.push(link.komgaBookId);
        entries.push({ itemId: item.id, issueId: issue.id, komgaBookId: link.komgaBookId, reason: null });
    }

    return { bookIds, entries, skipped, total: entries.length, resolvedCount: bookIds.length };
}

// ---------------------------------------------------------------------------
// The loading half
// ---------------------------------------------------------------------------

export type ResolveDb = Pick<typeof prisma, 'readingListItem' | 'issue' | 'komgaBookLink' | 'komgaLibrary' | 'library'>;

export interface ResolveDeps {
    db?: ResolveDb;
    settings?: KomgaSettings;
    komgaLibs?: ResolvedKomgaLibrary[];
    omnibusLibraries?: OmnibusLibraryRef[];
    now?: () => Date;
}

export interface ResolvedReadList {
    readingListId: string;
    result: ResolveResult;
}

const ISSUE_SELECT = {
    id: true,
    filePath: true,
    series: { select: { libraryId: true } },
} as const;

/**
 * Load everything the pure core needs for one list and run it. Returns null when the list does not
 * exist (deleted between the enqueue and the job), so the caller can skip quietly.
 */
export async function resolveReadListForPush(readingListId: string, deps: ResolveDeps = {}): Promise<ResolvedReadList | null> {
    const db = (deps.db ?? prisma) as ResolveDb;
    const items = await (db as any).readingListItem.findMany({
        where: { listId: readingListId },
        select: { id: true, order: true, issueId: true, cvIssueId: true, metadataSource: true, title: true },
    }) as ResolverItem[];
    if (items.length === 0) return { readingListId, result: resolveReadList({ items: [], issuesById: new Map(), issuesByProviderId: new Map(), linksByIssueId: new Map(), komgaLibs: [], omnibusLibraries: [], pathMappings: [] }) };

    const issueIds = [...new Set(items.map(i => i.issueId).filter((id): id is string => !!id))];
    const issuesById = new Map<string, ResolverIssue>();
    if (issueIds.length > 0) {
        const rows = await (db as any).issue.findMany({ where: { id: { in: issueIds } }, select: ISSUE_SELECT }) as any[];
        for (const r of rows) issuesById.set(r.id, { id: r.id, filePath: r.filePath ?? null, libraryId: r.series?.libraryId ?? null });
    }

    // The shared rule, one lookup per unlinked entry. Deliberately NOT written back to the item.
    const issuesByProviderId = new Map<string, ResolverIssue>();
    for (const item of items) {
        if (item.issueId || !item.cvIssueId) continue;
        const source = item.metadataSource || 'COMICVINE';
        const key = providerKey(source, item.cvIssueId);
        if (issuesByProviderId.has(key)) continue;
        const found = await findIssueForProviderId(item.cvIssueId, source);
        if (found) issuesByProviderId.set(key, found);
    }

    const resolvedIssueIds = new Set<string>([...issuesById.keys()]);
    for (const i of issuesByProviderId.values()) resolvedIssueIds.add(i.id);

    const linksByIssueId = new Map<string, ResolverBookLink>();
    if (resolvedIssueIds.size > 0) {
        const links = await (db as any).komgaBookLink.findMany({
            where: { issueId: { in: [...resolvedIssueIds] } },
            select: { issueId: true, komgaBookId: true, komgaLibraryId: true, omnibusPath: true },
        }) as ResolverBookLink[];
        for (const l of links) if (l.issueId) linksByIssueId.set(l.issueId, l);
    }

    let komgaLibs = deps.komgaLibs;
    if (!komgaLibs) {
        try {
            komgaLibs = ((await (db as any).komgaLibrary.findMany({})) as any[]).map(komgaLibraryRowToResolved);
        } catch (e) {
            Logger.log(`[Komga] read-list resolve could not load the Komga library cache: ${String(e)}`, 'debug');
            komgaLibs = [];
        }
    }
    let omnibusLibraries = deps.omnibusLibraries;
    if (!omnibusLibraries) {
        omnibusLibraries = (await (db as any).library.findMany({ select: { id: true, name: true, path: true } })) as OmnibusLibraryRef[];
    }
    const settings = deps.settings ?? await getKomgaSettings();

    return {
        readingListId,
        result: resolveReadList({
            items,
            issuesById,
            issuesByProviderId,
            linksByIssueId,
            komgaLibs,
            omnibusLibraries: omnibusLibraries ?? [],
            pathMappings: settings.pathMappings,
        }),
    };
}