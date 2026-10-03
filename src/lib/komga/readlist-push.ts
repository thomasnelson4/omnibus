// src/lib/komga/readlist-push.ts
//
// The write side of requirement 2: push an Omnibus reading list into Komga, keep it in step, and
// clean it up again.
//
// What this module owns:
//   - the naming rule and the OWNERSHIP MARKER that distinguishes a list Omnibus may rewrite from
//     one it must never touch;
//   - the idempotent push (PLAN §"Push algorithm", steps 1-6);
//   - the drift check that undoes edits made inside Komga (StoryArc appends, tryRestoreBooks id
//     swaps, a user renaming the list);
//   - the remote delete job and the orphan sweep.
//
// What it does NOT own: which books belong in the list (readlist-resolver.ts) and whether to push at
// all (readlist-trigger.ts).
//
// Live facts this is built against (Komga 1.28.1, LIVE_VERIFICATION deltas 10-19):
//   - read-list names are case-insensitively unique but NOT trimmed -> normalise here, once;
//   - a PATCH with an unknown book id fails 500 (SQLITE_CONSTRAINT_FOREIGNKEY) and rolls the WHOLE
//     request back, rename included -> never send an unverified id, and recover by re-verifying;
//   - PATCH returns 204 with an empty body and fully replaces `bookIds`; `bookIds: []` is a 400, so
//     an empty list is never sent;
//   - DELETE returns 204, and deleting a list that is already gone returns 404 -> success.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { isKomgaError, type KomgaReadListDto } from './types';
import type { KomgaClient } from './client';
import type { KomgaSettings } from './settings';
import { getKomgaSettings } from './settings';
import { getKomgaClient } from './factory';
import { compareKomgaVersions } from './connection-test';
import { KOMGA_READLIST_MIN_VERSION, KOMGA_SETTINGS_CACHE_TTL_MS } from './constants';
import {
    resolveReadListForPush,
    serializeSkippedSummary,
    type ResolveDb,
    type SkippedSummary,
} from './readlist-resolver';

const log = (msg: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info') => Logger.log(`[Komga] ${msg}`, level);

// ---------------------------------------------------------------------------
// Naming and the ownership marker
// ---------------------------------------------------------------------------

export const KOMGA_NAME_SUFFIX = ' (Omnibus)';

/**
 * Komga does NOT trim read-list names but DOES compare them case-insensitively, so two Omnibus
 * lists whose names differ only by whitespace or case would collide on the second push. Collapse
 * every run of whitespace (including the non-breaking kinds a title can carry) and trim.
 */
export function normalizeKomgaReadListName(name: string | null | undefined): string {
    return (name ?? '').replace(/[\s\u00a0\u2000-\u200b\ufeff]+/g, ' ').trim();
}

/** Komga's own uniqueness rule: case-insensitive, untrimmed. */
export function komgaNameEquals(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}

/** `{name}` for a global (or legacy system) list, `{name} ({ownerUsername})` for a user-owned one. */
export function komgaReadListName(list: { name: string; isGlobal: boolean; userId: string | null; ownerUsername: string | null }): string {
    const base = normalizeKomgaReadListName(list.name);
    const owner = list.isGlobal || !list.userId ? null : normalizeKomgaReadListName(list.ownerUsername);
    return owner ? `${base} (${owner})` : base;
}

/**
 * The ownership marker, appended to the Komga summary. Everything that decides "may Omnibus touch
 * this list?" reads THIS and nothing else, so it has to be parseable back exactly.
 */
export function komgaReadListMarker(instanceId: string, readingListId: string): string {
    return `Managed by Omnibus · instance ${instanceId} · list ${readingListId} · edits in Komga are overwritten`;
}

export interface KomgaReadListMarker { instanceId: string; readingListId: string }

/** null for a list Omnibus does not manage (or one whose marker was edited by hand). */
export function parseKomgaReadListMarker(summary: string | null | undefined): KomgaReadListMarker | null {
    if (!summary) return null;
    const m = /Managed by Omnibus · instance (\S+) · list (\S+) · edits in Komga are overwritten/.exec(summary);
    if (!m) return null;
    return { instanceId: m[1], readingListId: m[2] };
}

/** The list description, then the marker, separated by a blank line (empty description => marker only). */
export function komgaReadListSummary(description: string | null | undefined, instanceId: string, readingListId: string): string {
    const desc = (description ?? '').trim();
    const marker = komgaReadListMarker(instanceId, readingListId);
    return desc ? `${desc}\n\n${marker}` : marker;
}

// ---------------------------------------------------------------------------
// Version gate
// ---------------------------------------------------------------------------

// SAFETY: cross-bundle module state must live on globalThis (see queue.ts).
const g = globalThis as unknown as { __komgaReadListVersion?: { url: string; version: string | null; at: number } };

/**
 * Read-list PATCH support landed in Komga 1.23.3. Cached per URL: a push happens on every list edit
 * and /actuator/info is a wasted round trip per push.
 */
export async function isReadListPushSupported(client: KomgaClient, settings: KomgaSettings): Promise<boolean> {
    const url = settings.url ?? '';
    const cached = g.__komgaReadListVersion;
    if (cached && cached.url === url && Date.now() - cached.at < KOMGA_SETTINGS_CACHE_TTL_MS) {
        return !!cached.version && compareKomgaVersions(cached.version, KOMGA_READLIST_MIN_VERSION) >= 0;
    }
    let version: string | null = null;
    try {
        version = (await client.getInfo()).version ?? null;
    } catch (e) {
        log(`could not read the Komga version for the read-list gate: ${getErrorMessage(e)}`, 'warn');
        return false;
    }
    g.__komgaReadListVersion = { url, version, at: Date.now() };
    if (!version) return false;
    return compareKomgaVersions(version, KOMGA_READLIST_MIN_VERSION) >= 0;
}

/** Test seam: forget the cached version. */
export function invalidateReadListVersionCache(): void {
    delete g.__komgaReadListVersion;
}

// ---------------------------------------------------------------------------
// pushReadList
// ---------------------------------------------------------------------------

export type PushStatus = 'pushed' | 'unchanged' | 'waiting' | 'skipped' | 'error';

export interface PushResult {
    status: PushStatus;
    readingListId: string;
    komgaReadListId?: string | null;
    name?: string;
    bookCount?: number;
    pushedCount?: number;
    skipped?: SkippedSummary;
    error?: string;
    reason?: string;
}

export type PushDb = ResolveDb & Pick<typeof prisma, 'readingList' | 'komgaReadListLink'>;

export interface PushDeps {
    db?: PushDb;
    client?: KomgaClient | null;
    settings?: KomgaSettings;
    komgaLibs?: Parameters<typeof resolveReadListForPush>[1] extends { komgaLibs?: infer T } ? T : never;
    /** Called with an OMNIBUS library id when a pushed book id turned out to be stale. */
    enqueueSync?: (omnibusLibraryId: string, reason: string) => Promise<void>;
    now?: () => Date;
}

interface ListRow {
    id: string;
    name: string;
    description: string | null;
    isGlobal: boolean;
    userId: string | null;
    komgaSync: boolean;
    user: { username: string } | null;
}

function parseBookIds(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

/** Order matters to Komga (it keeps the array order), so this is a positional compare. */
export function sameBookIds(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((id, i) => id === b[i]);
}

async function loadList(db: PushDb, readingListId: string): Promise<ListRow | null> {
    return (await (db as any).readingList.findUnique({
        where: { id: readingListId },
        select: {
            id: true, name: true, description: true, isGlobal: true, userId: true, komgaSync: true,
            user: { select: { username: true } },
        },
    })) as ListRow | null;
}

async function writeLink(db: PushDb, readingListId: string, data: Record<string, unknown>): Promise<void> {
    await (db as any).komgaReadListLink.upsert({
        where: { readingListId },
        create: { readingListId, ...data },
        update: data,
    });
}

/**
 * The three name-collision outcomes, as one pure function over the remote list Komga would refuse:
 *
 *   null      → the name is free (or the colliding list is one we may take over): use `name`
 *   string    → retry with this name (the " (Omnibus)" suffix)
 *   'taken'   → the suffixed name is taken too, by a list this instance does not own
 *
 * `takeoverIds` are reading-list ids that no longer exist in Omnibus but are still marked as ours —
 * their remote list is an orphan we are allowed to re-point (this is how a re-imported list adopts
 * the list its predecessor pushed).
 */
export function resolveNameCollision(args: {
    name: string;
    remotes: readonly KomgaReadListDto[];
    instanceId: string;
    /** The marker of a remote list means "this instance may take it over". */
    isTakeover: (marker: KomgaReadListMarker) => Promise<boolean>;
    /** The remote list id the collision was resolved against, when it may be taken over. */
}): Promise<{ name: string; takeoverId: string | null; error: string | null }> {
    return (async () => {
        const collide = (n: string) => args.remotes.find(r => komgaNameEquals(r.name, n)) ?? null;
        const first = collide(args.name);
        if (!first) return { name: args.name, takeoverId: null, error: null };
        const marker = parseKomgaReadListMarker(first.summary);
        if (marker && marker.instanceId === args.instanceId && await args.isTakeover(marker)) {
            return { name: args.name, takeoverId: first.id, error: null };
        }
        const suffixed = `${args.name}${KOMGA_NAME_SUFFIX}`;
        const second = collide(suffixed);
        if (!second) return { name: suffixed, takeoverId: null, error: null };
        const marker2 = parseKomgaReadListMarker(second.summary);
        if (marker2 && marker2.instanceId === args.instanceId && await args.isTakeover(marker2)) {
            return { name: suffixed, takeoverId: second.id, error: null };
        }
        return {
            name: suffixed,
            takeoverId: null,
            error: `Komga already has a read list named "${suffixed}" that this Omnibus instance does not manage; nothing was changed.`,
        };
    })();
}

/** PLAN step 6: 400/5xx from bad ids → re-verify each id, drop the dead ones, retry once. */
export interface VerifyBooksResult {
    kept: string[];
    dropped: string[];
    komgaLibraryIds: string[];
}

export async function verifyPushedBookIds(client: KomgaClient, bookIds: string[]): Promise<VerifyBooksResult> {
    const kept: string[] = [];
    const dropped: string[] = [];
    const komgaLibraryIds = new Set<string>();
    for (const id of bookIds) {
        try {
            const book = await client.getBook(id);
            // A soft-deleted book still satisfies the FK (Komga keeps the row), but it is not in any
            // library any more, so pushing it would only push a dead entry.
            if (book?.deleted) {
                dropped.push(id);
                if (book.libraryId) komgaLibraryIds.add(book.libraryId);
            } else {
                kept.push(id);
            }
        } catch (e) {
            // GET /books/{id} answers 404 with an EMPTY body, so error handling must not need JSON.
            if (isKomgaError(e) && e.kind === 'notFound') {
                dropped.push(id);
            } else {
                log(`could not verify pushed book ${id}: ${getErrorMessage(e)}`, 'debug');
                kept.push(id);
            }
        }
    }
    return { kept, dropped, komgaLibraryIds: [...komgaLibraryIds] };
}

/** Turn a Komga library id into the Omnibus library to rescan, through the cached mapping. */
async function omnibusLibrariesForKomgaLibraries(db: PushDb, komgaLibraryIds: string[]): Promise<string[]> {
    if (komgaLibraryIds.length === 0) return [];
    const rows = (await (db as any).komgaLibrary.findMany({
        where: { komgaLibraryId: { in: komgaLibraryIds } },
        select: { komgaLibraryId: true, omnibusLibraryId: true },
    })) as { komgaLibraryId: string; omnibusLibraryId: string | null }[];
    return [...new Set(rows.map(r => r.omnibusLibraryId).filter((id): id is string => !!id))];
}

/**
 * Which Komga libraries the DEAD books came from. A hard-deleted book answers 404 with an empty
 * body, so getBook cannot say where it lived — but Omnibus still has its KomgaBookLink row, and
 * that library is exactly the one whose scan fell behind. Without this the "enqueue a sync for the
 * affected library" half of PLAN step 6 would only ever fire for SOFT-deleted books.
 */
async function komgaLibrariesForDroppedBooks(db: PushDb, dropped: string[]): Promise<string[]> {
    if (dropped.length === 0) return [];
    try {
        const rows = (await (db as any).komgaBookLink.findMany({
            where: { komgaBookId: { in: dropped } },
            select: { komgaLibraryId: true },
        })) as { komgaLibraryId: string }[];
        return [...new Set(rows.map(r => r.komgaLibraryId).filter(Boolean))];
    } catch {
        // Not fatal: the push still succeeds with the surviving ids.
        return [];
    }
}

/**
 * Idempotent push of one list. Steps 1-6 of PLAN's algorithm, in order. Never throws: every failure
 * becomes a status on the link, because a thrown push is a dead job and a silently stale list.
 */
export async function pushReadList(readingListId: string, deps: PushDeps = {}): Promise<PushResult> {
    const db = (deps.db ?? prisma) as PushDb;
    const now = deps.now ?? (() => new Date());
    const settings = deps.settings ?? await getKomgaSettings();
    const base: PushResult = { status: 'skipped', readingListId };

    if (!settings.enabled || !settings.readListsEnabled) return { ...base, reason: 'disabled' };

    const list = await loadList(db, readingListId);
    if (!list) return { ...base, reason: 'missing' };
    if (!list.komgaSync) return { ...base, reason: 'off' };

    const client = deps.client !== undefined ? deps.client : await getKomgaClient(settings);
    if (!client) return { ...base, reason: 'no-client' };
    if (!await isReadListPushSupported(client, settings)) {
        const msg = `Komga ${settings.url} is older than ${KOMGA_READLIST_MIN_VERSION}; read lists are not pushed.`;
        await writeLink(db, readingListId, { status: 'error', lastError: msg, updatedAt: now() }).catch(() => {});
        return { ...base, status: 'error', error: msg, reason: 'version' };
    }

    const instanceId = settings.instanceId ?? '';
    let link = (await (db as any).komgaReadListLink.findUnique({ where: { readingListId } })) as {
        komgaReadListId: string | null;
        lastPushedName: string | null;
        lastPushedSummary: string | null;
        lastPushedBookIds: string | null;
    } | null;

    const resolved = await resolveReadListForPush(readingListId, { db, settings, komgaLibs: deps.komgaLibs });
    if (!resolved) return { ...base, reason: 'missing' };
    const { bookIds, skipped, resolvedCount } = resolved.result;
    const skippedSummary = serializeSkippedSummary(skipped);

    // PLAN step 4: an empty list is never pushed and never emptied. Komga rejects `bookIds: []`, and
    // wiping a list that exists only because of a mapping hiccup is worse than a stale list.
    if (bookIds.length === 0) {
        await writeLink(db, readingListId, {
            status: 'waiting',
            pushedCount: 0,
            skippedCount: skipped.placeholder + skipped.notDownloaded + skipped.unsupportedFormat
                + skipped.libraryUnmapped + skipped.awaitingScan + skipped.duplicate,
            skippedSummary,
            lastError: null,
            komgaReadListId: link?.komgaReadListId ?? null,
            updatedAt: now(),
        });
        return {
            status: 'waiting', readingListId, komgaReadListId: link?.komgaReadListId ?? null,
            bookCount: 0, pushedCount: 0, skipped, reason: 'no-resolvable-books',
        };
    }

    const desiredName = komgaReadListName({
        name: list.name, isGlobal: list.isGlobal, userId: list.userId,
        ownerUsername: list.user?.username ?? null,
    });
    const desiredSummary = komgaReadListSummary(list.description, instanceId, readingListId);

    const linkExists = async (id: string) => !!(await (db as any).readingList.findUnique({ where: { id }, select: { id: true } }));
    const isTakeover = async (marker: { instanceId: string; readingListId: string }) =>
        marker.instanceId === instanceId && marker.readingListId !== readingListId
        && !(await linkExists(marker.readingListId));

    const listExists = async () => {
        try {
            return await client.listReadLists();
        } catch (e) {
            log(`could not list Komga read lists for ${readingListId}: ${getErrorMessage(e)}`, 'warn');
            return null;
        }
    };

    // Apply the payload; `mode` says whether the remote list already exists.
    // A create may be retried ONCE with a different name. Without this guard a Komga that keeps
    // answering "name already exists" for a list our own listing cannot see (a race we lost twice,
    // or a name Komga normalises differently) would recurse until the process died.
    let createRetried = false;
    const apply = async (target: { id: string | null; name: string }): Promise<PushResult> => {
        const payload = { name: target.name, summary: desiredSummary, ordered: true, bookIds };
        if (target.id && link?.komgaReadListId === target.id && link.lastPushedName === desiredName
            && link.lastPushedSummary === desiredSummary && sameBookIds(parseBookIds(link.lastPushedBookIds), bookIds)) {
            await writeLink(db, readingListId, {
                status: 'synced', pushedCount: resolvedCount, skippedSummary, lastError: null, updatedAt: now(),
            });
            return { status: 'unchanged', readingListId, komgaReadListId: target.id, name: target.name, bookCount: bookIds.length, pushedCount: resolvedCount, skipped };
        }
        try {
            if (target.id) {
                await client.updateReadList(target.id, payload);
            } else {
                const created = await client.createReadList(payload);
                target.id = created.id;
            }
        } catch (e) {
            const message = getErrorMessage(e);
            if (isKomgaError(e) && e.kind === 'notFound' && target.id) {
                // PLAN step 6: gone -> recreate. The old id may still hold the name, but it does not
                // exist, so the create below is free.
                await (db as any).komgaReadListLink.updateMany({ where: { readingListId }, data: { komgaReadListId: null } });
                link = null;
                return apply({ id: null, name: target.name });
            }
            if (isKomgaError(e) && (e.kind === 'badRequest' || e.kind === 'server')) {
                const nameCollision = /already exists/i.test(message);
                if (nameCollision && !target.id && !createRetried) {
                    const remotes = await listExists();
                    if (!remotes) return recordError(message);
                    const again = await resolveNameCollision({ name: target.name, remotes, instanceId, isTakeover });
                    if (again.error) return recordError(again.error);
                    if (again.name === target.name && !again.takeoverId) {
                        // The listing does not show anything under that name, so retrying the same
                        // name is pointless — it would just fail again.
                        return recordError(message);
                    }
                    createRetried = true;
                    return apply({ id: again.takeoverId, name: again.name });
                }
                const check = await verifyPushedBookIds(client, bookIds);
                if (check.dropped.length > 0 && check.kept.length > 0) {
                    log(`dropping ${check.dropped.length} stale book id(s) from ${readingListId} and retrying once`, 'warn');
                    const libraryIds = [...new Set([...check.komgaLibraryIds, ...await komgaLibrariesForDroppedBooks(db, check.dropped)])];
                    const affected = await omnibusLibrariesForKomgaLibraries(db, libraryIds);
                    if (deps.enqueueSync) {
                        for (const libId of affected) {
                            // Promise.resolve, not a bare .catch: a caller may pass a sync callback,
                            // and an unhandled throw here would lose the push result entirely.
                            await Promise.resolve(deps.enqueueSync(libId, 'readlist:stale-book-ids'))
                                .catch((e2: unknown) => log(`could not enqueue a sync for ${libId}: ${getErrorMessage(e2)}`, 'warn'));
                        }
                    }
                    return applyWithBooks(check.kept, { id: target.id, name: target.name });
                }
            }
            return recordError(message);
        }
        await writeLink(db, readingListId, {
            komgaReadListId: target.id,
            lastPushedName: desiredName,
            lastPushedSummary: desiredSummary,
            lastPushedBookIds: JSON.stringify(bookIds),
            lastPushedAt: now(),
            status: 'synced',
            pushedCount: resolvedCount,
            skippedCount: Object.values(skipped).reduce((a, b) => a + b, 0),
            skippedSummary,
            lastError: null,
            updatedAt: now(),
        });
        return {
            status: 'pushed', readingListId, komgaReadListId: target.id ?? null,
            name: target.name, bookCount: bookIds.length, pushedCount: resolvedCount, skipped,
        };
    };

    /** One retry with the ids that survived re-verification (PLAN step 6, the "retry once" half). */
    const applyWithBooks = async (ids: string[], target: { id: string | null; name: string }): Promise<PushResult> => {
        try {
            if (target.id) await client.updateReadList(target.id, { name: target.name, summary: desiredSummary, ordered: true, bookIds: ids });
            else target.id = (await client.createReadList({ name: target.name, summary: desiredSummary, ordered: true, bookIds: ids })).id;
        } catch (e) {
            return recordError(getErrorMessage(e));
        }
        await writeLink(db, readingListId, {
            komgaReadListId: target.id,
            lastPushedName: desiredName,
            lastPushedSummary: desiredSummary,
            lastPushedBookIds: JSON.stringify(ids),
            lastPushedAt: now(),
            status: 'synced',
            pushedCount: ids.length,
            skippedCount: Object.values(skipped).reduce((a, b) => a + b, 0) + (bookIds.length - ids.length),
            skippedSummary,
            lastError: null,
            updatedAt: now(),
        });
        return { status: 'pushed', readingListId, komgaReadListId: target.id ?? null, name: target.name, bookCount: ids.length, pushedCount: ids.length, skipped };
    };

    const recordError = async (message: string): Promise<PushResult> => {
        const text = message.slice(0, 500);
        await writeLink(db, readingListId, { status: 'error', lastError: text, skippedSummary, updatedAt: now() })
            .catch(e => log(`could not record the read-list error for ${readingListId}: ${getErrorMessage(e)}`, 'warn'));
        log(`push of ${readingListId} failed: ${text}`, 'warn');
        return { status: 'error', readingListId, komgaReadListId: link?.komgaReadListId ?? null, error: text, skipped };
    };

    // An existing link goes straight to PATCH: no listing needed, and the drift check (which does
    // list) is what catches a remote that moved on its own.
    if (link?.komgaReadListId) return apply({ id: link.komgaReadListId, name: desiredName });

    // PLAN steps 2-3: adopt by marker, or create under a name that does not collide.
    const remotes = await listExists();
    if (!remotes) return recordError('Could not list the Komga read lists.');
    const adopted = remotes.find(r => {
        const m = parseKomgaReadListMarker(r.summary);
        return !!m && m.instanceId === instanceId && m.readingListId === readingListId;
    });
    if (adopted) {
        log(`adopting Komga read list ${adopted.id} for ${readingListId} by marker`, 'debug');
        return apply({ id: adopted.id, name: desiredName });
    }
    const collision = await resolveNameCollision({ name: desiredName, remotes, instanceId, isTakeover });
    if (collision.error) return recordError(collision.error);
    return apply({ id: collision.takeoverId, name: collision.name });
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export interface DriftResult {
    remote: number;
    links: number;
    reverted: number;
    recreated: number;
    repushed: number;
    orphansDeleted: number;
}

/**
 * One listing, then: revert every list that drifted, recreate the missing ones, sweep orphans and
 * re-push anything whose intended payload changed. This is what makes sync one-way in practice.
 */
export async function checkReadListDrift(deps: PushDeps = {}): Promise<DriftResult> {
    const db = (deps.db ?? prisma) as PushDb;
    const settings = deps.settings ?? await getKomgaSettings();
    const result: DriftResult = { remote: 0, links: 0, reverted: 0, recreated: 0, repushed: 0, orphansDeleted: 0 };
    if (!settings.enabled || !settings.readListsEnabled) return result;

    const client = deps.client !== undefined ? deps.client : await getKomgaClient(settings);
    if (!client) return result;

    let remotes: KomgaReadListDto[];
    try {
        remotes = await client.listReadLists();
    } catch (e) {
        log(`drift check could not list read lists: ${getErrorMessage(e)}`, 'warn');
        return result;
    }
    result.remote = remotes.length;

    const links = (await (db as any).komgaReadListLink.findMany({
        where: { komgaReadListId: { not: null } },
    })) as { readingListId: string; komgaReadListId: string | null; lastPushedName: string | null; lastPushedSummary: string | null; lastPushedBookIds: string | null }[];
    result.links = links.length;

    for (const link of links) {
        const remote = remotes.find(r => r.id === link.komgaReadListId);
        if (!remote) {
            // Gone remotely (deleted by hand, or Komga dropped it): forget the id and let the push
            // rebuild it from the current list.
            await (db as any).komgaReadListLink.updateMany({ where: { readingListId: link.readingListId }, data: { komgaReadListId: null, status: 'pending' } })
                .catch((e: unknown) => log(`could not clear the stale Komga id for ${link.readingListId}: ${getErrorMessage(e)}`, 'warn'));
            const pushed = await pushReadList(link.readingListId, deps).catch(() => null);
            if (pushed && (pushed.status === 'pushed' || pushed.status === 'waiting')) result.recreated += 1;
            continue;
        }
        const intendedIds = parseBookIds(link.lastPushedBookIds);
        const drifted = remote.name !== link.lastPushedName
            || remote.summary !== link.lastPushedSummary
            || !sameBookIds(remote.bookIds ?? [], intendedIds);
        if (!drifted) continue;
        if (intendedIds.length === 0) {
            // Nothing to PATCH back to without emptying the list, which Komga rejects.
            await (db as any).komgaReadListLink.updateMany({ where: { readingListId: link.readingListId }, data: { status: 'waiting' } })
                .catch(() => {});
            continue;
        }
        try {
            await client.updateReadList(remote.id, { name: link.lastPushedName ?? remote.name, summary: link.lastPushedSummary ?? '', ordered: true, bookIds: intendedIds });
            result.reverted += 1;
        } catch (e) {
            log(`could not revert drift on Komga read list ${remote.id}: ${getErrorMessage(e)}`, 'warn');
        }
    }

    result.orphansDeleted = await sweepOrphanedReadLists({ ...deps, db, client, settings, remotes });

    // Anything whose intended payload changed since the last push (a list edited without a trigger,
    // or whose resolver now resolves differently) gets one more debounce-free pass.
    for (const link of links) {
        const pushed = await pushReadList(link.readingListId, deps).catch(() => null);
        if (pushed?.status === 'pushed') result.repushed += 1;
    }
    return result;
}

// ---------------------------------------------------------------------------
// Delete job + orphan sweep
// ---------------------------------------------------------------------------

export interface ReadListDeleteResult {
    status: 'deleted' | 'gone' | 'refused' | 'skipped';
    readingListId: string;
    komgaReadListId: string;
    reason?: string;
}

/**
 * Delete one remote list, but only after checking the marker. A list whose marker names another
 * instance, or no instance at all, is a USER's list and is left alone. 404 counts as success: the
 * point of the job is that the remote list is not there any more.
 */
export async function deleteKomgaReadList(
    data: { komgaReadListId: string; readingListId: string },
    deps: PushDeps = {},
): Promise<ReadListDeleteResult> {
    const db = (deps.db ?? prisma) as PushDb;
    const settings = deps.settings ?? await getKomgaSettings();
    const out: ReadListDeleteResult = { status: 'skipped', readingListId: data.readingListId, komgaReadListId: data.komgaReadListId };
    if (!settings.enabled || !settings.readListsEnabled) return { ...out, reason: 'disabled' };

    const client = deps.client !== undefined ? deps.client : await getKomgaClient(settings);
    if (!client) return { ...out, reason: 'no-client' };

    let remote: KomgaReadListDto | undefined;
    try {
        const remotes = await client.listReadLists();
        remote = remotes.find(r => r.id === data.komgaReadListId);
    } catch (e) {
        log(`delete job could not list read lists for ${data.komgaReadListId}: ${getErrorMessage(e)}`, 'warn');
        return { ...out, reason: 'unreachable' };
    }
    if (!remote) {
        await forgetLink(db, data.readingListId);
        return { ...out, status: 'gone' };
    }
    const marker = parseKomgaReadListMarker(remote.summary);
    if (!marker || marker.instanceId !== (settings.instanceId ?? '')) {
        const reason = `Komga read list ${data.komgaReadListId} is not managed by this Omnibus instance; it was not deleted.`;
        log(reason, 'warn');
        await (db as any).komgaReadListLink.updateMany({ where: { readingListId: data.readingListId }, data: { lastError: reason } })
            .catch(() => {});
        return { ...out, status: 'refused', reason };
    }
    if (marker.readingListId !== data.readingListId) {
        // The list was TAKEN OVER in the meantime: a re-import copied komgaSync onto the replacement
        // list and its push adopted this remote (rewriting the marker). Deleting now would remove a
        // list the new list legitimately owns, so this job stands down.
        const reason = `Komga read list ${data.komgaReadListId} now belongs to reading list ${marker.readingListId}; it was not deleted.`;
        log(reason, 'debug');
        return { ...out, status: 'refused', reason };
    }
    try {
        await client.deleteReadList(remote.id);
    } catch (e) {
        // DELTA 16: deleting an already-deleted list is a 404, which is the outcome we wanted.
        if (isKomgaError(e) && e.kind === 'notFound') {
            await forgetLink(db, data.readingListId);
            return { ...out, status: 'gone' };
        }
        log(`could not delete Komga read list ${remote.id}: ${getErrorMessage(e)}`, 'warn');
        return { ...out, reason: 'delete-failed' };
    }
    await forgetLink(db, data.readingListId);
    return { ...out, status: 'deleted' };
}

async function forgetLink(db: PushDb, readingListId: string): Promise<void> {
    await (db as any).komgaReadListLink.deleteMany({ where: { readingListId } })
        .catch((e: unknown) => log(`could not drop the read-list link for ${readingListId}: ${getErrorMessage(e)}`, 'warn'));
}

/**
 * Remote lists this instance pushed whose Omnibus list no longer exists (deleted while Komga was
 * unreachable, or dropped by a restore). Only lists carrying THIS instance's marker are touched.
 */
export async function sweepOrphanedReadLists(deps: PushDeps & { remotes?: KomgaReadListDto[] } = {}): Promise<number> {
    const db = (deps.db ?? prisma) as PushDb;
    const settings = deps.settings ?? await getKomgaSettings();
    if (!settings.enabled || !settings.readListsEnabled) return 0;
    const instanceId = settings.instanceId ?? '';
    if (!instanceId) return 0;
    const client = deps.client !== undefined ? deps.client : await getKomgaClient(settings);
    if (!client) return 0;

    let remotes = deps.remotes;
    if (!remotes) {
        try {
            remotes = await client.listReadLists();
        } catch (e) {
            log(`orphan sweep could not list read lists: ${getErrorMessage(e)}`, 'warn');
            return 0;
        }
    }
    const markers = remotes
        .map(r => ({ remote: r, marker: parseKomgaReadListMarker(r.summary) }))
        .filter((x): x is { remote: KomgaReadListDto; marker: KomgaReadListMarker } =>
            !!x.marker && x.marker.instanceId === instanceId);
    if (markers.length === 0) return 0;

    const known = (await (db as any).komgaReadListLink.findMany({ select: { readingListId: true } })) as { readingListId: string }[];
    const linked = new Set(known.map(l => l.readingListId));
    const orphans = markers.filter(x => !linked.has(x.marker.readingListId));
    const existing = orphans.length
        ? await (db as any).readingList.findMany({ where: { id: { in: orphans.map(o => o.marker.readingListId) } }, select: { id: true } })
        : [];
    const alive = new Set((existing as { id: string }[]).map(r => r.id));
    const gone = orphans.filter(o => !alive.has(o.marker.readingListId));

    let deleted = 0;
    for (const o of gone) {
        try {
            await client.deleteReadList(o.remote.id);
            deleted += 1;
            log(`orphan sweep deleted Komga read list ${o.remote.id} (list ${o.marker.readingListId} is gone)`, 'info');
        } catch (e) {
            if (isKomgaError(e) && e.kind === 'notFound') { deleted += 1; continue; }
            log(`orphan sweep could not delete ${o.remote.id}: ${getErrorMessage(e)}`, 'warn');
        }
    }
    return deleted;
}