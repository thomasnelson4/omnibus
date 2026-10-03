// src/lib/komga/reconcile.ts
//
// The identity map: Omnibus Issue/Series <-> Komga Book/Series ids.
//
// This module DELETES rows, so its shape is driven by one rule: distrust the listing, prove the
// deletion, and make every failure path keep what is already stored. Specifically
//
//   * every HTTP call happens BEFORE any write, and never inside a $transaction (issue #195: Node's
//     SQLite runs connection_limit=1, so an awaited fetch inside a transaction blocks every other
//     writer in the process);
//   * the whole diff is computed in memory, and only rows that actually changed are written;
//   * a link is removed only after it missed in two consecutive reconciles, or when Komga itself
//     says the book is gone (404 / deleted). One miss never deletes;
//   * the safety valve below aborts ALL map writes when the listing looks wrong. It is checked on
//     the computed diff, not on a special code path, so a new reason to distrust the listing
//     cannot be added anywhere else without tripping it too.
//
// Match order (PLAN Phase 3): PATH first (file url equality — the primary shared key), then LINK
// among only the still-unmatched, using the issue-level provider URL that Omnibus writes into
// <Web> and Komga hands back as metadata.links.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { isKomgaError } from './types';
import type { KomgaClient } from './client';
import type { KomgaBookDto, KomgaWebLinkDto } from './types';
import type { KomgaSettings } from './settings';
import { komgaLibraryRowToResolved, type ResolvedKomgaLibrary } from './libraries';
import { isPathUnder, normalizeKomgaPath, toKomgaPath, toOmnibusPath } from './path-map';
import { KOMGA_DB_CHUNK } from './constants';

/**
 * The models reconcile touches, plus the root $transaction it writes through. sync.ts injects a
 * superset of this. $transaction is part of the interface on purpose: a write that cannot be
 * batched would otherwise be a runtime `undefined is not a function`, which is exactly the class of
 * bug the issue #195 rule exists to make impossible.
 */
export type ReconcileDb = Pick<typeof prisma,
    'komgaSyncState' | 'komgaBookLink' | 'komgaSeriesLink' | 'issue' | 'komgaLibrary' | 'jobLog' | '$transaction'>;

export type MatchedBy = 'PATH' | 'LINK';

/** How many link removals one pass may make before the valve trips: the larger of 20 and 25%. */
export function removalBudget(existingLinkCount: number): number {
    return Math.max(20, Math.ceil(Math.max(existingLinkCount, 0) / 4));
}

/**
 * The issue-level provider ids a book exposes through metadata.links.
 *
 * PLAN says "parse 4000-(\d+) / metron.cloud/(\d+)". Both patterns are host-scoped here, and the
 * captured id must be followed by a path/query boundary. Without that, `metron.cloud/issue/4000-123`
 * yields METRON:4000 — a Metron issue that happens to be numbered 4000 — which would silently
 * link two unrelated files. A wrong link is worse than no link: it survives two reconciles and is
 * only noticed when a reading list comes out wrong.
 */
export function extractProviderKeys(links: readonly KomgaWebLinkDto[] | null | undefined): string[] {
    const out = new Set<string>();
    for (const link of links ?? []) {
        const url = typeof link?.url === 'string' ? link.url : '';
        if (!url) continue;
        const cv = /comicvine\.gamespot\.com\/(?:x|issue)\/4000-(\d+)(?=[/?#]|$)/i.exec(url);
        if (cv) out.add(`CV:${cv[1]}`);
        const metron = /metron\.cloud\/issue\/(\d+)(?=[/?#]|$)/i.exec(url);
        if (metron) out.add(`METRON:${metron[1]}`);
    }
    return [...out];
}

/**
 * The provider key an Omnibus issue claims, or null when it has none usable.
 *
 * `unmatched_*` and `LOCAL` are Omnibus's placeholders for "no provider id" (see
 * api/library/series/route.ts). Several of them share the same source, so matching on them would
 * let one placeholder file claim another's book. Non-numeric and '0' ids are placeholders too:
 * Metron and ComicVine issue ids are positive integers and the importer treats "0" as unknown.
 */
export function issueProviderKey(metadataSource: string | null | undefined, metadataId: string | null | undefined): string | null {
    const raw = typeof metadataId === 'string' ? metadataId.trim() : '';
    if (!raw || !/^\d+$/.test(raw) || raw === '0') return null;
    const src = (metadataSource ?? '').trim().toUpperCase();
    if (src === 'COMICVINE') return `CV:${raw}`;
    if (src === 'METRON') return `METRON:${raw}`;
    return null;
}

/** The majority value, or null for an empty list. Ties go to the first-seen key (stable Map order). */
export function majority<T>(values: readonly T[]): T | null {
    const counts = new Map<T, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best: T | null = null;
    let bestCount = 0;
    for (const [v, c] of counts) {
        if (c > bestCount) { best = v; bestCount = c; }
    }
    return best;
}

/**
 * A link is valid while it still describes the file the issue points at. Anything else means the
 * issue moved since the link was written and Komga has not necessarily seen the new path — the
 * "awaiting Komga scan" state Phase 4's resolver reads.
 */
export function isBookLinkValid(link: { omnibusPath: string } | null | undefined, issueFilePath: string | null | undefined): boolean {
    if (!link || typeof link.omnibusPath !== 'string') return false;
    const a = normalizeKomgaPath(link.omnibusPath);
    const b = normalizeKomgaPath(issueFilePath);
    return Boolean(a && b && a === b);
}

export interface ReconcileCounts {
    komgaLibraries: number;
    booksListed: number;
    /** Issues linked by file path. */
    path: number;
    /** Issues linked by provider URL among the still-unmatched. */
    link: number;
    /** Issues under the prefix with no book (nothing to link, or the listing is incomplete). */
    unmatchedOmnibusIssues: number;
    /** Books Komga has that no Omnibus issue claims. */
    komgaBooksNotInOmnibus: number;
    /** Existing links deleted this pass. */
    removedLinks: number;
    seriesLinksWritten: number;
    valveTrips: number;
}

export interface ReconcileResult {
    ok: boolean;
    counts: ReconcileCounts;
    /** One line per tripped valve, human readable. Empty on a clean pass. */
    valves: string[];
    errors: string[];
}

export interface ReconcileDeps {
    db: ReconcileDb;
    client: KomgaClient;
    settings: KomgaSettings;
    /** Resolved Komga libraries for this Omnibus library; read from the cache table when absent. */
    komgaLibs?: ResolvedKomgaLibrary[];
    now?: () => Date;
}

interface IssueRow {
    id: string;
    filePath: string | null;
    metadataSource: string;
    metadataId: string | null;
    seriesId: string;
}

interface LinkRow {
    id: string;
    issueId: string;
    komgaBookId: string;
    komgaSeriesId: string;
    komgaLibraryId: string;
    omnibusPath: string;
    komgaPath: string;
    matchedBy: string;
    missCount: number;
    verifiedAt: Date;
}

/** Every column of a KomgaBookLink this module writes. */
interface LinkData {
    komgaBookId: string; komgaSeriesId: string; komgaLibraryId: string;
    omnibusPath: string; komgaPath: string; matchedBy: string; missCount: number; verifiedAt: Date;
}
interface SeriesData { komgaSeriesId: string; komgaLibraryId: string; verifiedAt: Date }

interface Assignment { issueId: string; seriesId: string; book: KomgaBookDto; matchedBy: MatchedBy; path: string; komgaPath: string }

/** One queued write. Built eagerly and executed later in a chunk, never across an await of HTTP. */
type WriteOp = Prisma.PrismaPromise<unknown>;

/** Bound on the per-library getBook probes for stale links; see reconcileKomgaLibrary. */
const MAX_BOOK_PROBES = 200;

const log = (msg: string, level: 'info' | 'warn' | 'error' | 'debug' = 'debug') =>
    Logger.log(`[Komga] ${msg}`, level);

const emptyCounts = (): ReconcileCounts => ({
    komgaLibraries: 0, booksListed: 0, path: 0, link: 0, unmatchedOmnibusIssues: 0,
    komgaBooksNotInOmnibus: 0, removedLinks: 0, seriesLinksWritten: 0, valveTrips: 0,
});

function addCounts(target: ReconcileCounts, add: ReconcileCounts): void {
    for (const key of Object.keys(target) as (keyof ReconcileCounts)[]) target[key] += add[key];
}

// ------------------------------------------------------------------ entry point

/**
 * Reconcile every Komga library that serves `omnibusLibraryId`, then write the JobLog row and
 * stamp lastReconciledAt.
 *
 * Never throws: every failure is folded into `errors` and logged, because the caller is a sync
 * stage whose real job (verify) must still run.
 */
export async function reconcileLibrary(omnibusLibraryId: string, deps: ReconcileDeps): Promise<ReconcileResult> {
    const { db, client, settings } = deps;
    const now = deps.now ?? (() => new Date());
    const counts = emptyCounts();
    const valves: string[] = [];
    const errors: string[] = [];

    let komgaLibs = deps.komgaLibs ?? [];
    if (komgaLibs.length === 0) {
        try {
            komgaLibs = (await db.komgaLibrary.findMany({})).map(komgaLibraryRowToResolved);
        } catch (e) {
            errors.push(`could not read the cached Komga library list: ${getErrorMessage(e)}`);
            log(errors[errors.length - 1], 'warn');
            return { ok: false, counts, valves, errors };
        }
    }
    if (komgaLibs.length === 0) {
        return { ok: true, counts, valves, errors };
    }

    for (const lib of komgaLibs) {
        const result = await reconcileKomgaLibrary(lib, { db, client, settings, now });
        addCounts(counts, result.counts);
        valves.push(...result.valves);
        errors.push(...result.errors);
    }

    const at = now();
    // lastReconciledAt only moves when the pass produced a trustworthy picture: a hard error (no
    // listing at all) must leave the timestamp alone so the health check can see the staleness.
    const lastError = valves.length > 0
        ? `reconcile safety valve: ${valves[0]}`.slice(0, 500)
        : null;
    // A tripped valve means the map was NOT reconciled, so lastReconciledAt must not move: the
    // Phase 5 health check reads its staleness as "the map is out of date", which is exactly true.
    const trustworthy = errors.length === 0 && valves.length === 0;
    await db.komgaSyncState.updateMany({
        where: { omnibusLibraryId },
        data: {
            ...(trustworthy ? { lastReconciledAt: at } : {}),
            lastError,
        },
    }).catch((e: unknown) => {
        const message = `could not record the reconcile result: ${getErrorMessage(e)}`;
        errors.push(message);
        log(message, 'warn');
    });

    await db.jobLog.create({
        data: {
            jobType: 'KOMGA_RECONCILE',
            status: valves.length > 0 || errors.length > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
            relatedItem: omnibusLibraryId,
            durationMs: null,
            message: JSON.stringify({
                ...counts,
                komgaLibraries: komgaLibs.map(l => l.name),
                valveMessages: valves,
                errors,
            }).slice(0, 2000),
        },
    }).catch((e: unknown) => log(`could not write the reconcile JobLog: ${getErrorMessage(e)}`, 'warn'));

    if (valves.length > 0) {
        log(`reconcile for ${omnibusLibraryId}: safety valve tripped (${valves.length}): ${valves[0]}`, 'warn');
    }
    return { ok: trustworthy && valves.length === 0, counts, valves, errors };
}

// ------------------------------------------------------------------ one Komga library

async function reconcileKomgaLibrary(
    lib: ResolvedKomgaLibrary,
    deps: { db: ReconcileDb; client: KomgaClient; settings: KomgaSettings; now: () => Date },
): Promise<ReconcileResult> {
    const { db, client, settings } = deps;
    const counts = emptyCounts();
    counts.komgaLibraries = 1;
    const valves: string[] = [];
    const errors: string[] = [];

    const prefix = normalizeKomgaPath(lib.translatedRoot);
    const root = normalizeKomgaPath(lib.root);
    if (!prefix || !root) {
        errors.push(`${lib.name}: no usable path mapping for its root ${lib.root}`);
        return { ok: false, counts, valves, errors };
    }

    // ---- read everything first. No write below this line happens before the last await.
    const books: KomgaBookDto[] = [];
    try {
        for await (const book of client.listBooks(lib.komgaLibraryId)) books.push(book);
    } catch (e) {
        const message = `${lib.name}: could not list its books: ${isKomgaError(e) ? (e.detail || e.message) : getErrorMessage(e)}`;
        errors.push(message);
        log(message, 'warn');
        return { ok: false, counts, valves, errors };
    }
    counts.booksListed = books.length;

    const existingLinks = await db.komgaBookLink.findMany({ where: { komgaLibraryId: lib.komgaLibraryId } });

    const prefixForQuery = prefix === '/' ? '/' : `${prefix}/`;
    const issues = await db.issue.findMany({
        where: { filePath: { startsWith: prefixForQuery } },
        select: { id: true, filePath: true, metadataSource: true, metadataId: true, seriesId: true },
    });

    // ---- the url map. An url outside the library root means the listing is not this library's.
    const byUrl = new Map<string, KomgaBookDto>();
    const ambiguousUrls = new Set<string>();
    let urlFault: string | null = null;
    for (const book of books) {
        const url = normalizeKomgaPath(book.url);
        if (!url || !url.startsWith('/')) {
            urlFault = `${lib.name}: book ${book.id} has a url that is not an absolute path (${book.url})`;
            break;
        }
        if (!isPathUnder(url, root)) {
            urlFault = `${lib.name}: book ${book.id} has a url outside the library root (${url} not under ${root})`;
            break;
        }
        // Two books on one url cannot both be identity-matched; drop the url rather than pick one.
        if (byUrl.has(url)) {
            ambiguousUrls.add(url);
            byUrl.delete(url);
            continue;
        }
        if (!ambiguousUrls.has(url)) byUrl.set(url, book);
    }
    if (ambiguousUrls.size > 0) {
        log(`${lib.name}: ${ambiguousUrls.size} url(s) carry more than one book; they are excluded from path matching`, 'warn');
    }

    // ---- PASS 1: PATH
    const assignments: Assignment[] = [];
    const matchedBooks = new Set<string>();
    const matchedIssues = new Set<string>();
    const issueById = new Map<string, IssueRow>();
    for (const issue of issues) issueById.set(issue.id, issue);

    for (const issue of issues) {
        const filePath = normalizeKomgaPath(issue.filePath);
        if (!filePath) continue;
        const komgaPath = toKomgaPath(filePath, settings.pathMappings);
        const key = komgaPath ? normalizeKomgaPath(komgaPath) : null;
        if (!key) continue;
        const book = byUrl.get(key);
        if (!book || matchedBooks.has(book.id)) continue;
        assignments.push({ issueId: issue.id, seriesId: issue.seriesId, book, matchedBy: 'PATH', path: filePath, komgaPath: key });
        matchedBooks.add(book.id);
        matchedIssues.add(issue.id);
    }

    // ---- PASS 2: LINK, only among what is still unmatched on BOTH sides
    const openBooks = books.filter(b => !matchedBooks.has(b.id));
    const openIssues = issues.filter(i => !matchedIssues.has(i.id));

    const booksByKey = new Map<string, Set<string>>();
    for (const book of openBooks) {
        for (const key of extractProviderKeys(book.metadata?.links)) {
            if (!booksByKey.has(key)) booksByKey.set(key, new Set());
            booksByKey.get(key)!.add(book.id);
        }
    }
    const issuesByKey = new Map<string, Set<string>>();
    for (const issue of openIssues) {
        const key = issueProviderKey(issue.metadataSource, issue.metadataId);
        if (!key) continue;
        if (!issuesByKey.has(key)) issuesByKey.set(key, new Set());
        issuesByKey.get(key)!.add(issue.id);
    }

    // One issue may be proposed by several books (two books carrying the same <Web>): that is
    // ambiguous, so every proposer is dropped rather than the first one winning.
    const proposals = new Map<string, string[]>(); // issueId -> bookIds
    for (const book of openBooks) {
        const candidates = new Set<string>();
        for (const key of extractProviderKeys(book.metadata?.links)) {
            if ((booksByKey.get(key)?.size ?? 0) !== 1) continue;    // key not unique among books
            const holders = issuesByKey.get(key);
            if (!holders || holders.size !== 1) continue;            // key not unique among issues
            candidates.add([...holders][0]);
        }
        if (candidates.size !== 1) continue;
        const issueId = [...candidates][0];
        if (!proposals.has(issueId)) proposals.set(issueId, []);
        proposals.get(issueId)!.push(book.id);
    }

    const bookById = new Map(openBooks.map(b => [b.id, b]));
    for (const [issueId, bookIds] of proposals) {
        if (bookIds.length !== 1) continue;
        const book = bookById.get(bookIds[0]);
        const issue = issueById.get(issueId);
        if (!book || !issue) continue;
        const filePath = normalizeKomgaPath(issue.filePath);
        const komgaPath = filePath ? normalizeKomgaPath(toKomgaPath(filePath, settings.pathMappings) ?? '') : null;
        if (!filePath || !komgaPath) continue;
        assignments.push({ issueId, seriesId: issue.seriesId, book, matchedBy: 'LINK', path: filePath, komgaPath });
        matchedBooks.add(book.id);
        matchedIssues.add(issueId);
    }

    for (const a of assignments) counts[a.matchedBy === 'PATH' ? 'path' : 'link'] += 1;

    // ---- existing links: still valid, stale (probe Komga), or immediately removable
    const bookByIdAll = new Map(books.map(b => [b.id, b]));
    const retained = new Map<string, LinkRow>();       // issueId -> row kept as-is
    const drop = new Set<string>();                    // link ids to delete
    const missBump = new Map<string, number>();        // link id -> new missCount
    let probes = 0;

    for (const row of existingLinks) {
        const issue = issueById.get(row.issueId);
        // The issue is gone (cascaded), or it has no file at all: the link describes nothing.
        // Immediate, no probe — PLAN Phase 3 rule 6.
        if (!issue || !issue.filePath) {
            drop.add(row.id);
            counts.removedLinks += 1;
            continue;
        }
        const book = bookByIdAll.get(row.komgaBookId);
        const issuePath = normalizeKomgaPath(issue.filePath);
        const bookPath = book ? normalizeKomgaPath(book.url) : null;
        const stillSameFile = Boolean(
            book && issuePath && bookPath
            && (normalizeKomgaPath(toOmnibusPath(bookPath, settings.pathMappings) ?? '') ?? null) === issuePath,
        );
        if (stillSameFile) {
            retained.set(row.issueId, row);
            matchedBooks.add(row.komgaBookId);
            continue;
        }

        // Missing from this listing. Ask Komga directly when it is cheap: a 404 or deleted=true is
        // proof (a rename with hashing hard-deletes the old book, LIVE delta 17), and it removes
        // the row at once. Capped so a badly-out-of-sync library cannot turn into thousands of
        // sequential requests; uncapped links still follow the two-miss rule, which is safe.
        let gone = false;
        if (book === undefined && probes < MAX_BOOK_PROBES) {
            probes += 1;
            try {
                const probe = await client.getBook(row.komgaBookId);
                gone = probe.deleted === true;
            } catch (e) {
                // KomgaError 404 has an EMPTY body (LIVE delta 11) — the client's error mapping is
                // what tells us. Anything else (unreachable, 5xx) is not proof of deletion.
                gone = isKomgaError(e) && e.kind === 'notFound';
            }
        }
        if (gone) {
            drop.add(row.id);
            counts.removedLinks += 1;
            continue;
        }
        const next = (row.missCount ?? 0) + 1;
        if (next >= 2) {
            drop.add(row.id);
            counts.removedLinks += 1;
        } else {
            missBump.set(row.id, next);
        }
    }

    counts.unmatchedOmnibusIssues = issues.filter(i => !matchedIssues.has(i.id)).length;
    counts.komgaBooksNotInOmnibus = books.filter(b => !matchedBooks.has(b.id)).length;

    // ---- the safety valve, on the COMPUTED diff
    const budget = removalBudget(existingLinks.length);
    if (counts.booksListed === 0 && existingLinks.length > 0) {
        valves.push(`${lib.name}: Komga listed 0 books while ${existingLinks.length} link(s) exist`);
    }
    if (counts.removedLinks > budget) {
        valves.push(`${lib.name}: this pass would remove ${counts.removedLinks} link(s), above the ${budget} allowed for ${existingLinks.length} existing link(s)`);
    }
    if (urlFault) valves.push(urlFault);
    if (lib.unavailable) valves.push(`${lib.name}: Komga reports its root folder as unavailable`);

    if (valves.length > 0) {
        // Abort is the DEFAULT outcome: no deletes, no upserts, and above all no missCount bump.
        // A bump recorded while the listing is untrustworthy would delete the whole map two passes
        // later, which is exactly the failure this valve exists to prevent.
        counts.removedLinks = 0;
        return { ok: false, counts, valves, errors };
    }

    // ---- the diff, in memory
    const issueAssignments = new Map(assignments.map(a => [a.issueId, a]));
    const at = deps.now();
    const deleteIds = new Set(drop);
    // A book belongs to one issue and an issue to one book (both are @unique). An assignment that
    // takes over a row held by someone else deletes that row first, in the same transaction and
    // before the upsert.
    const byIssue = new Map(existingLinks.map(r => [r.issueId, r]));
    const byBook = new Map(existingLinks.map(r => [r.komgaBookId, r]));

    const upserts: { issueId: string; data: LinkData; id: string | null }[] = [];
    for (const a of assignments) {
        const row = byIssue.get(a.issueId);
        const data: LinkData = {
            komgaBookId: a.book.id,
            komgaSeriesId: a.book.seriesId,
            komgaLibraryId: lib.komgaLibraryId,
            omnibusPath: a.path,
            komgaPath: a.komgaPath,
            matchedBy: a.matchedBy,
            missCount: 0,
            verifiedAt: at,
        };
        const holder = byBook.get(a.book.id);
        if (holder && holder.issueId !== a.issueId) deleteIds.add(holder.id);
        if (!row) { upserts.push({ issueId: a.issueId, data, id: null }); continue; }
        deleteIds.delete(row.id);
        // The row is being re-pointed, so a stale miss recorded for it earlier in this same pass
        // must not be written back afterwards — missCount is part of `data` and lands at 0.
        missBump.delete(row.id);
        const changed = row.komgaBookId !== data.komgaBookId
            || row.komgaSeriesId !== data.komgaSeriesId
            || row.omnibusPath !== data.omnibusPath
            || row.komgaPath !== data.komgaPath
            || row.matchedBy !== data.matchedBy
            || (row.missCount ?? 0) !== 0;
        if (changed) upserts.push({ issueId: a.issueId, data, id: row.id });
    }

    // ---- writes. Only changed rows, deletes before upserts (a book is @unique, so the row that
    // held it has to go first), chunked.
    const ops: WriteOp[] = [];
    for (const id of deleteIds) ops.push(db.komgaBookLink.delete({ where: { id } }));
    for (const u of upserts) {
        ops.push(u.id
            ? db.komgaBookLink.update({ where: { id: u.id }, data: u.data })
            : db.komgaBookLink.create({ data: { issueId: u.issueId, ...u.data } }));
    }
    // A stale link's row is otherwise untouched: only its missCount moves, and only when it moved.
    for (const [rowId, next] of missBump) {
        const row = existingLinks.find(r => r.id === rowId);
        if (!row || row.missCount === next) continue;
        ops.push(db.komgaBookLink.update({ where: { id: rowId }, data: { missCount: next } }));
    }

    // Series links: the majority Komga series of each series' linked books. Computed from the post-write
    // link set (assignments plus retained rows) so a removal that empties a series drops its link.
    const seriesRows = await db.komgaSeriesLink.findMany({ where: { komgaLibraryId: lib.komgaLibraryId } });
    const survivingIssueIds = new Set([...issueAssignments.keys(), ...retained.keys()]);
    const seriesOfIssue = new Map(issues.map(i => [i.id, i.seriesId]));
    const seriesBookIds = new Map<string, string[]>();
    const pushSeries = (seriesId: string, komgaSeriesId: string) => {
        if (!seriesBookIds.has(seriesId)) seriesBookIds.set(seriesId, []);
        seriesBookIds.get(seriesId)!.push(komgaSeriesId);
    };
    for (const a of assignments) pushSeries(a.seriesId, a.book.seriesId);
    for (const [issueId, row] of retained) {
        const seriesId = seriesOfIssue.get(issueId);
        if (seriesId && survivingIssueIds.has(issueId)) pushSeries(seriesId, row.komgaSeriesId);
    }

    const keepSeries = new Set<string>();
    for (const [seriesId, ids] of seriesBookIds) {
        const winner = majority(ids);
        if (!winner) continue;
        keepSeries.add(seriesId);
        const existing = seriesRows.find(r => r.seriesId === seriesId);
        const data: SeriesData = { komgaSeriesId: winner, komgaLibraryId: lib.komgaLibraryId, verifiedAt: at };
        if (!existing) { ops.push(db.komgaSeriesLink.create({ data: { seriesId, ...data } })); counts.seriesLinksWritten += 1; }
        else if (existing.komgaSeriesId !== winner || existing.komgaLibraryId !== lib.komgaLibraryId) {
            ops.push(db.komgaSeriesLink.update({ where: { id: existing.id }, data }));
            counts.seriesLinksWritten += 1;
        }
    }
    for (const row of seriesRows) {
        if (!keepSeries.has(row.seriesId)) ops.push(db.komgaSeriesLink.delete({ where: { id: row.id } }));
    }

    await runChunked(deps.db, ops);

    log(
        `${lib.name}: ${counts.booksListed} book(s), ${counts.path} path + ${counts.link} link match(es), `
        + `${counts.removedLinks} removal(s), ${counts.unmatchedOmnibusIssues} unmatched issue(s)`,
        'debug',
    );
    return { ok: true, counts, valves, errors };
}

/** Array-form $transaction in KOMGA_DB_CHUNK-sized batches. Never holds an open transaction across a wait. */
async function runChunked(db: ReconcileDb, ops: WriteOp[]): Promise<void> {
    for (let i = 0; i < ops.length; i += KOMGA_DB_CHUNK) {
        const chunk = ops.slice(i, i + KOMGA_DB_CHUNK);
        if (chunk.length === 0) continue;
        await db.$transaction(chunk);
    }
}