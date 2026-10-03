// src/lib/komga/verify.ts
//
// Post-scan verification (step f): did Komga actually see the files Omnibus just changed?
//
// The question is answered against the SNAPSHOT taken before the scan cleared pendingPaths (step c
// reads it for exactly this reason), and it is deliberately narrow. For every path Omnibus reported:
//
//   file exists and is scannable  ->  Komga must have a non-deleted book at the mapped path whose
//                                     fileLastModified is at least floor(mtime) - 2 s. The slack
//                                     covers Komga's whole-second timestamps and coarse-grained
//                                     filesystems (LIVE delta 9), and an in-place rewrite, which
//                                     keeps the book id but moves fileLastModified.
//   file is gone                  ->  no non-deleted book may be left at that path.
//
// A miss is not an error, it is a retry: the paths go back into pendingPaths and the library is
// marked dirty again, so the flush re-scans. The second retry scans deep (step c keys off
// retryCount >= 2), and after KOMGA_VERIFY_MAX_RETRIES the paths are dropped with a JobLog warning
// rather than retried forever.
//
// What verification is NOT: a Komga that cannot be reached. That is the settle stage's problem, and
// counting it as a miss would burn the retry budget on an outage and end in a false "gave up".

import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { isKomgaError } from './types';
import type { KomgaClient } from './client';
import type { KomgaBookDto } from './types';
import type { KomgaSettings } from './settings';
import type { ResolvedKomgaLibrary } from './libraries';
import { isKomgaScannable, isPathUnder, normalizeKomgaPath, toKomgaPath } from './path-map';
import { mergePendingPaths } from './changes';
import { isBookLinkValid } from './reconcile';
import {
    KOMGA_OVERFLOW_STAT_LIMIT,
    KOMGA_VERIFY_GIVEUP_PREFIX,
    KOMGA_VERIFY_MAX_RETRIES,
    KOMGA_VERIFY_MTIME_SLACK_MS,
} from './constants';

/** Enough rows to find KOMGA_OVERFLOW_STAT_LIMIT scannable ones, since the filter runs client-side. */
const OVERFLOW_FETCH = 4 * KOMGA_OVERFLOW_STAT_LIMIT;
/** Bound on the files one pendingPaths entry may expand to when it is a folder. */
const MAX_FOLDER_EXPANSION = 2_000;

export type VerifyDb = Pick<typeof prisma,
    'komgaSyncState' | 'komgaBookLink' | 'issue' | 'jobLog'>;

export interface StatLike { mtimeMs: number; isDirectory: boolean }

/** The slice of fs.stat verify needs, injected so tests never touch the disk. */
export interface VerifyFs {
    stat(path: string): Promise<StatLike | null>;
}

const realVerifyFs: VerifyFs = {
    async stat(path: string): Promise<StatLike | null> {
        try {
            const { stat } = await import('node:fs/promises');
            const st = await stat(path);
            // isDirectory is a METHOD on Stats, not a property.
            return { mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() };
        } catch {
            // ENOENT (or an unreadable parent) is an answer, not a failure: "the file is gone".
            return null;
        }
    },
};

export interface VerifyDeps {
    db: VerifyDb;
    client: KomgaClient;
    settings: KomgaSettings;
    komgaLibs: ResolvedKomgaLibrary[];
    /** The snapshot step c read before clearing pendingPaths. */
    snapshotPaths?: string[];
    snapshotOverflow?: boolean;
    now?: () => Date;
    fs?: VerifyFs;
}

export interface VerifyResult {
    /** True when Komga could not be asked. Nothing about the retry state changed. */
    unverifiable: boolean;
    /** Candidates checked (a folder counts as its files). */
    checked: number;
    /** Skipped: not scannable, or outside every Komga library. */
    skipped: number;
    /** Paths that are in the DB but not yet in Komga. */
    missed: string[];
    /** Candidates whose link exists but no longer describes the issue's file — "awaiting scan". */
    awaitingScan: number;
    /** Retry budget spent; the missed paths were dropped with a warning. */
    gaveUp: boolean;
    /** The overflow (pendingPaths cap hit) sweep ran. */
    overflowChecked: number;
}

const log = (msg: string, level: 'info' | 'warn' | 'error' | 'debug' = 'debug') =>
    Logger.log(`[Komga] ${msg}`, level);

/**
 * Is Komga's view of this file current?
 *
 * PURE. `fileLastModified` is whole-second UTC (LIVE delta 9) and is the file mtime TRUNCATED
 * DOWN, so the floor() is what makes an unchanged file compare equal, and the 2 s slack absorbs a
 * filesystem that reports a coarser or slightly rounded mtime. An unparseable timestamp is a miss,
 * not a pass.
 */
export function isBookCurrent(book: KomgaBookDto | undefined | null, mtimeMs: number, slackMs = KOMGA_VERIFY_MTIME_SLACK_MS): boolean {
    if (!book || book.deleted === true) return false;
    const reported = Date.parse(book.fileLastModified ?? '');
    if (!Number.isFinite(reported)) return false;
    return reported >= Math.floor(mtimeMs / 1000) * 1000 - slackMs;
}

export async function verifyLibrary(omnibusLibraryId: string, deps: VerifyDeps): Promise<VerifyResult> {
    const { db, client, settings } = deps;
    const now = deps.now ?? (() => new Date());
    const fsys = deps.fs ?? realVerifyFs;

    const result: VerifyResult = {
        unverifiable: false, checked: 0, skipped: 0, missed: [], awaitingScan: 0,
        gaveUp: false, overflowChecked: 0,
    };

    const state = await db.komgaSyncState.findUnique({ where: { omnibusLibraryId } });
    const retryCount = state?.retryCount ?? 0;
    const lastScanRequestedAt = state?.lastScanRequestedAt ?? null;

    // ---- every Komga book, by path. HTTP first; a failure here means "cannot verify", not "miss".
    const bookByUrl = new Map<string, KomgaBookDto>();
    try {
        for (const lib of deps.komgaLibs) {
            for await (const book of client.listBooks(lib.komgaLibraryId)) {
                const url = normalizeKomgaPath(book.url);
                if (url && !bookByUrl.has(url)) bookByUrl.set(url, book);
            }
        }
    } catch (e) {
        result.unverifiable = true;
        const message = isKomgaError(e) ? (e.detail || e.message) : getErrorMessage(e);
        log(`cannot verify ${omnibusLibraryId}: Komga book listing failed (${message}); leaving the retry state alone`, 'warn');
        return result;
    }

    // ---- expand the snapshot into concrete files. Folder paths are prefixes (a rename or a
    // metadata sweep reports the series folder), so they are expanded from the DB, not stat'ed once.
    const snapshot = (deps.snapshotPaths ?? []).map(p => normalizeKomgaPath(p)).filter((p): p is string => Boolean(p));
    // path -> its stat, captured once: this loop and the check loop below both need it, and a
    // library folder can hold a few thousand files.
    const candidates = new Map<string, StatLike | null>();
    const dirPrefixes: string[] = [];
    let truncated = false;
    for (const path of snapshot) {
        const st = await fsys.stat(path);
        if (st?.isDirectory) {
            dirPrefixes.push(path === '/' ? '/' : `${path}/`);
            continue;
        }
        candidates.set(path, st);
    }
    if (dirPrefixes.length > 0) {
        const rows = await db.issue.findMany({
            where: { OR: dirPrefixes.map(p => ({ filePath: { startsWith: p } })) },
            select: { filePath: true },
            take: MAX_FOLDER_EXPANSION,
            orderBy: { filePath: 'asc' },
        });
        if (rows.length >= MAX_FOLDER_EXPANSION) truncated = true;
        for (const row of rows) {
            const p = normalizeKomgaPath(row.filePath);
            // Folder members are not in the snapshot, so they have never been stat'ed.
            if (p && !candidates.has(p)) candidates.set(p, null);
        }
    }

    // ---- check each candidate
    const issuePaths = await findIssuesAt(db, [...candidates.keys()]);
    const issueIdByPath = new Map(issuePaths.map(i => [normalizeKomgaPath(i.filePath) ?? '', i.id]));
    const links = issuePaths.length > 0
        ? await db.komgaBookLink.findMany({ where: { issueId: { in: issuePaths.map(i => i.id) } }, select: { issueId: true, omnibusPath: true } })
        : [];
    const linkByIssue = new Map(links.map(l => [l.issueId, l]));

    for (const [path, known] of candidates) {
        const lib = libraryFor(deps.komgaLibs, path, settings);
        if (!lib) { result.skipped += 1; continue; }
        const issueId = issueIdByPath.get(path);
        if (issueId) {
            const link = linkByIssue.get(issueId);
            if (link && !isBookLinkValid(link, path)) result.awaitingScan += 1;
        }

        const st = known ?? await fsys.stat(path);
        if (!st) {
            // The file is gone. A book left at that path is now a Komga copy of nothing.
            if (bookByUrl.has(lib.komgaPath)) result.missed.push(path);
            continue;
        }
        if (!isKomgaScannable(lib.komgaPath, {
            root: lib.lib.root,
            scanCbx: lib.lib.settings.scanCbx,
            scanPdf: lib.lib.settings.scanPdf,
            scanEpub: lib.lib.settings.scanEpub,
            scanDirectoryExclusions: lib.lib.settings.scanDirectoryExclusions,
        })) { result.skipped += 1; continue; }

        const book = bookByUrl.get(lib.komgaPath);
        result.checked += 1;
        if (!isBookCurrent(book, st.mtimeMs)) result.missed.push(path);
    }

    // ---- overflow: pendingPaths hit its cap, so whole folders were dropped from the snapshot.
    // Nothing above could see them, so sweep for files Komga has no book for and that were written
    // around the scan request. A truncated folder expansion gets the same sweep: it has the same
    // hole (files under the folder that were never looked at) and the same bounded answer.
    if (deps.snapshotOverflow || truncated) {
        result.overflowChecked = await sweepOverflow(db, deps.komgaLibs, settings, bookByUrl, fsys, lastScanRequestedAt, result);
    }

    // ---- outcome
    const at = now();
    const missed = [...new Set(result.missed)];
    result.missed = missed;

    if (missed.length === 0) {
        await db.komgaSyncState.updateMany({
            where: { omnibusLibraryId },
            data: { retryCount: 0, lastSyncCompletedAt: at, lastError: null },
        }).catch((e: unknown) => log(`could not record the verify success: ${getErrorMessage(e)}`, 'warn'));
        log(
            `verification passed for ${omnibusLibraryId} (${result.checked} file(s), ${result.skipped} skipped, ${result.awaitingScan} awaiting scan)`,
            'debug',
        );
        return result;
    }

    const giveUp = retryCount + 1 >= KOMGA_VERIFY_MAX_RETRIES;
    result.gaveUp = giveUp;

    if (giveUp) {
        // PLAN: after 2 retries, warn and drop. The paths are already out of pendingPaths (step c
        // cleared them), so "drop" is the absence of the push-back below.
        await db.jobLog.create({
            data: {
                jobType: 'KOMGA_SCAN',
                status: 'COMPLETED_WITH_ERRORS',
                relatedItem: omnibusLibraryId,
                durationMs: null,
                message: `${KOMGA_VERIFY_GIVEUP_PREFIX} ${missed.length} path(s) after ${KOMGA_VERIFY_MAX_RETRIES} verification retries; giving up on: ${missed.slice(0, 20).join(', ')}${missed.length > 20 ? ` (+${missed.length - 20} more)` : ''}`.slice(0, 1000),
            },
        }).catch((e: unknown) => log(`could not write the verification give-up JobLog: ${getErrorMessage(e)}`, 'warn'));
        await db.komgaSyncState.updateMany({
            where: { omnibusLibraryId },
            data: { retryCount: 0, lastSyncCompletedAt: at, pendingOverflow: false, lastError: null },
        }).catch((e: unknown) => log(`could not record the verify give-up: ${getErrorMessage(e)}`, 'warn'));
        log(`verification gave up on ${missed.length} path(s) for ${omnibusLibraryId} after ${KOMGA_VERIFY_MAX_RETRIES} retries`, 'warn');
        return result;
    }

    // ---- miss: re-dirty the library with exactly the paths that failed.
    const merged = mergePendingPaths(state?.pendingPaths ?? null, missed);
    await db.komgaSyncState.updateMany({
        where: { omnibusLibraryId },
        data: {
            lastChangeAt: at,
            pendingPaths: merged.json,
            pendingOverflow: merged.overflow || Boolean(state?.pendingOverflow),
            retryCount: retryCount + 1,
        },
    }).catch((e: unknown) => log(`could not re-dirty ${omnibusLibraryId} after a verification miss: ${getErrorMessage(e)}`, 'warn'));
    log(
        `verification missed ${missed.length} path(s) for ${omnibusLibraryId} (retry ${retryCount + 1}/${KOMGA_VERIFY_MAX_RETRIES})`,
        'warn',
    );
    return result;
}

interface IssuePathRow { id: string; filePath: string | null }

/**
 * The issues sitting at exactly these paths, in batches.
 *
 * Batched because a folder expansion can produce thousands of paths and an `in` list that long is a
 * bind-parameter bomb on SQLite (its default SQLITE_MAX_VARIABLE_NUMBER is 32766 on modern builds
 * but 999 on older ones).
 */
async function findIssuesAt(db: VerifyDb, paths: string[]): Promise<IssuePathRow[]> {
    const out: IssuePathRow[] = [];
    for (let i = 0; i < paths.length; i += 500) {
        const batch = paths.slice(i, i + 500);
        const rows = await db.issue.findMany({ where: { filePath: { in: batch } }, select: { id: true, filePath: true } });
        out.push(...rows);
    }
    return out;
}

/** The Komga library a file belongs to, with its path already mapped into Komga space. */
function libraryFor(
    komgaLibs: ResolvedKomgaLibrary[], filePath: string, settings: KomgaSettings,
): { lib: ResolvedKomgaLibrary; komgaPath: string } | null {
    const komgaPath = toKomgaPath(filePath, settings.pathMappings);
    if (!komgaPath) return null;
    const key = normalizeKomgaPath(komgaPath);
    if (!key) return null;
    for (const lib of komgaLibs) {
        if (isPathUnder(key, lib.root)) return { lib, komgaPath: key };
    }
    return null;
}

/**
 * The overflow sweep. Anything that is scannable, has no Komga book, and was modified within the
 * window around the scan request is a miss: Komga was asked to look at exactly this file and did
 * not. Bounded at KOMGA_OVERFLOW_STAT_LIMIT stats.
 */
async function sweepOverflow(
    db: VerifyDb, komgaLibs: ResolvedKomgaLibrary[], settings: KomgaSettings,
    bookByUrl: Map<string, KomgaBookDto>, fsys: VerifyFs, lastScanRequestedAt: Date | null,
    result: VerifyResult,
): Promise<number> {
    // 120 s of slack backwards: a file written just before the scan request is still that scan's
    // responsibility, and a stat that lands seconds after the request must not read as "old".
    const windowStart = (lastScanRequestedAt ? lastScanRequestedAt.getTime() : Date.now()) - 120_000;
    let statCount = 0;

    for (const lib of komgaLibs) {
        const prefix = normalizeKomgaPath(lib.translatedRoot);
        if (!prefix) continue;
        const rows = await db.issue.findMany({
            where: { filePath: { startsWith: prefix === '/' ? '/' : `${prefix}/` } },
            select: { filePath: true },
            take: OVERFLOW_FETCH,
            orderBy: { filePath: 'asc' },
        });
        for (const row of rows) {
            if (statCount >= KOMGA_OVERFLOW_STAT_LIMIT) break;
            const filePath = normalizeKomgaPath(row.filePath);
            if (!filePath) continue;
            const mapped = libraryFor(komgaLibs, filePath, settings);
            if (!mapped) continue;
            if (!isKomgaScannable(mapped.komgaPath, {
                root: mapped.lib.root,
                scanCbx: mapped.lib.settings.scanCbx,
                scanPdf: mapped.lib.settings.scanPdf,
                scanEpub: mapped.lib.settings.scanEpub,
                scanDirectoryExclusions: mapped.lib.settings.scanDirectoryExclusions,
            })) continue;
            if (bookByUrl.has(mapped.komgaPath)) continue;
            if (statCount >= KOMGA_OVERFLOW_STAT_LIMIT) break;
            statCount += 1;
            const st = await fsys.stat(filePath);
            if (st && !st.isDirectory && st.mtimeMs >= windowStart) result.missed.push(filePath);
        }
    }
    return statCount;
}