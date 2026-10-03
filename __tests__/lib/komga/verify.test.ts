import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// verify.ts answers "did Komga see what we just wrote?" against the snapshot taken before the scan
// cleared pendingPaths. The HTTP side is the real fake Komga; the disk is injected, so mtime can be
// set to the exact millisecond the boundary rules care about.
const mocks = vi.hoisted(() => ({ stateFindUnique: vi.fn() }));

vi.unmock('@/lib/komga/changes');
vi.mock('@/lib/db', () => ({ prisma: { komgaSyncState: { findUnique: mocks.stateFindUnique } } }));

import { verifyLibrary, isBookCurrent } from '@/lib/komga/verify';
import { KomgaClient } from '@/lib/komga/client';
import { startFakeKomga, makeKomgaBook, type FakeKomga } from '../../helpers/fake-komga';
import type { ResolvedKomgaLibrary } from '@/lib/komga/libraries';
import { KOMGA_VERIFY_MAX_RETRIES } from '@/lib/komga/constants';

const LIB = 'olib1';
const K = '0RT15AAAAAAK';
const SERIES = 'ser-1';
const NOW = new Date('2026-03-01T12:00:00.000Z');

const SETTINGS = {
    enabled: true, url: 'http://komga.local', apiKey: 'key',
    pathMappings: [{ omnibus: '/data', komga: '/komga' }], pathMappingsRaw: '[]',
    scanOnChange: true, readListsEnabled: false, instanceId: null,
};

const komgaLib = (over: Partial<ResolvedKomgaLibrary> = {}): ResolvedKomgaLibrary => ({
    komgaLibraryId: K, name: 'Comics', root: '/komga', translatedRoot: '/data', omnibusLibraryId: LIB,
    unavailable: false,
    settings: {
        hashFiles: true, importComicInfoBook: true, importComicInfoReadList: false,
        emptyTrashAfterScan: false, scanForceModifiedTime: false, convertToCbz: false,
        repairExtensions: false, scanCbx: true, scanPdf: true, scanEpub: true,
        scanDirectoryExclusions: [], oneshotsDirectory: null,
    },
    ...over,
});

const PATH = '/data/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz';
const KOMGA_PATH = '/komga/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz';

/** The whole-second stamp Komga would report for a file with this mtime (LIVE delta 9). */
const stampFor = (mtimeMs: number) => new Date(Math.floor(mtimeMs / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const komgaBook = (over: Record<string, unknown> = {}) => makeKomgaBook({
    id: 'B1', libraryId: K, url: KOMGA_PATH, ...over,
} as any);

// ------------------------------------------------------------------ fakes

function makeDb(over: {
    issues?: { id: string; filePath: string | null }[];
    links?: { issueId: string; omnibusPath: string }[];
    state?: Record<string, unknown>;
} = {}) {
    const issues = [...(over.issues ?? [])];
    const links = [...(over.links ?? [])];
    const state = {
        omnibusLibraryId: LIB, retryCount: 0, pendingPaths: null, pendingOverflow: false,
        lastScanRequestedAt: NOW, ...(over.state ?? {}),
    };
    const writes = { stateUpdates: [] as Record<string, unknown>[], jobLogs: [] as Record<string, unknown>[] };

    const filterIssues = (where: any) => {
        if (Array.isArray(where?.filePath?.in)) {
            return issues.filter(i => where.filePath.in.includes(i.filePath));
        }
        const starts = Array.isArray(where?.OR)
            ? where.OR.map((o: any) => o.filePath.startsWith)
            : (typeof where?.filePath?.startsWith === 'string' ? [where.filePath.startsWith] : []);
        return issues.filter(i => starts.some((s: string) => typeof i.filePath === 'string' && i.filePath.startsWith(s)));
    };

    const db: any = {
        issue: {
            findMany: vi.fn(async ({ where, take }: any) => {
                const rows = filterIssues(where);
                return typeof take === 'number' ? rows.slice(0, take) : rows;
            }),
        },
        komgaBookLink: { findMany: vi.fn(async () => links) },
        komgaSyncState: {
            findUnique: vi.fn(async () => state),
            updateMany: vi.fn(async ({ data }: any) => { writes.stateUpdates.push(data); Object.assign(state, data); return { count: 1 }; }),
        },
        jobLog: { create: vi.fn(async ({ data }: any) => { writes.jobLogs.push(data); return data; }) },
    };
    mocks.stateFindUnique.mockResolvedValue(state);
    return { db, state, writes };
}

/** A disk: paths present with the given mtime, everything else gone. */
const disk = (files: Record<string, { mtimeMs: number; isDirectory?: boolean }>) => ({
    stat: vi.fn(async (path: string) => {
        const f = files[path];
        return f ? { mtimeMs: f.mtimeMs, isDirectory: f.isDirectory ?? false } : null;
    }),
});

let fake: FakeKomga | null = null;
const client = () => new KomgaClient({ baseUrl: fake!.url, apiKey: fake!.state.apiKey });

const run = (db: any, files: Record<string, { mtimeMs: number; isDirectory?: boolean }>, opts: {
    snapshotPaths?: string[];
    snapshotOverflow?: boolean;
    komgaLibs?: ResolvedKomgaLibrary[];
} = {}) => verifyLibrary(LIB, {
    db, client: client(), settings: SETTINGS as never,
    komgaLibs: opts.komgaLibs ?? [komgaLib()],
    snapshotPaths: opts.snapshotPaths ?? [PATH],
    snapshotOverflow: opts.snapshotOverflow ?? false,
    now: () => NOW,
    fs: disk(files),
});

const lastState = (writes: any): Record<string, unknown> => {
    const w = writes.stateUpdates.at(-1);
    expect(w).toBeDefined();
    return w as Record<string, unknown>;
};

beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => { if (fake) { await fake.close(); fake = null; } });

// ------------------------------------------------------------------ the pure rule

describe('the mtime rule', () => {
    const book = (fileLastModified: string) => ({ deleted: false, fileLastModified } as any);

    it('accepts a book whose stamp is exactly floor(mtime) - 2 s', () => {
        const mtime = Date.parse('2026-03-01T10:00:00.000Z');
        expect(isBookCurrent(book(new Date(mtime - 2000).toISOString()), mtime)).toBe(true);
    });

    it('rejects one millisecond below the -2 s slack', () => {
        const mtime = Date.parse('2026-03-01T10:00:00.000Z');
        expect(isBookCurrent(book(new Date(mtime - 2001).toISOString()), mtime)).toBe(false);
    });

    it('accepts the sub-second remainder below the floor', () => {
        // mtime 10:00:00.999 -> Komga reports 10:00:00Z; that is floor(mtime), not below it.
        const mtime = Date.parse('2026-03-01T10:00:00.999Z');
        expect(isBookCurrent(book(stampFor(mtime)), mtime)).toBe(true);
    });

    it('rejects an in-place rewrite Komga has not noticed (a stamp older than the file)', () => {
        const mtime = Date.parse('2026-03-01T10:00:00.000Z');
        expect(isBookCurrent(book(new Date(mtime - 60_000).toISOString()), mtime)).toBe(false);
    });

    it('rejects a deleted book and an unparseable stamp', () => {
        expect(isBookCurrent(null, Date.now())).toBe(false);
        expect(isBookCurrent({ deleted: true, fileLastModified: '2030-01-01T00:00:00Z' } as any, Date.now())).toBe(false);
        expect(isBookCurrent({ deleted: false, fileLastModified: 'nonsense' } as any, Date.now())).toBe(false);
    });
});

// ------------------------------------------------------------------ passes and misses

describe('verification', () => {
    it('passes when Komga has the book and its stamp is current', async () => {
        const mtime = NOW.getTime() - 500;
        fake = await startFakeKomga({ state: { books: [komgaBook({ fileLastModified: stampFor(mtime) })] } });
        const { db, writes } = makeDb({ issues: [{ id: 'i1', filePath: PATH }] });
        const result = await run(db, { [PATH]: { mtimeMs: mtime } });
        expect(result.missed).toEqual([]);
        expect(result.checked).toBe(1);
        expect(lastState(writes).lastSyncCompletedAt).toBe(NOW);
        expect(lastState(writes).retryCount).toBe(0);
    });

    it('misses when Komga has no book at the path, and re-dirties the library', async () => {
        fake = await startFakeKomga({ state: { books: [] } });
        const { db, writes } = makeDb({ issues: [{ id: 'i1', filePath: PATH }], state: { retryCount: 0 } });
        const result = await run(db, { [PATH]: { mtimeMs: NOW.getTime() - 1000 } });
        expect(result.missed).toEqual([PATH]);
        const w = lastState(writes);
        expect(w.lastChangeAt).toBe(NOW);
        expect(w.retryCount).toBe(1);
        expect(JSON.parse(w.pendingPaths as string)).toEqual([PATH]);
        expect(w.lastSyncCompletedAt).toBeUndefined();
    });

    it('misses when the book is there but stale (an in-place rewrite Komga has not seen)', async () => {
        fake = await startFakeKomga({ state: { books: [komgaBook({ fileLastModified: stampFor(NOW.getTime() - 600_000) })] } });
        const { db } = makeDb({ issues: [{ id: 'i1', filePath: PATH }] });
        expect((await run(db, { [PATH]: { mtimeMs: NOW.getTime() } })).missed).toEqual([PATH]);
    });

    it('passes when the file is gone AND Komga has no book left at that path', async () => {
        fake = await startFakeKomga({ state: { books: [] } });
        const { db, writes } = makeDb({ issues: [{ id: 'i1', filePath: PATH }] });
        const result = await run(db, {});
        expect(result.missed).toEqual([]);
        expect(lastState(writes).lastSyncCompletedAt).toBe(NOW);
    });

    it('misses when the file is gone but Komga still has a book at that path', async () => {
        fake = await startFakeKomga({ state: { books: [komgaBook()] } });
        const { db } = makeDb({ issues: [{ id: 'i1', filePath: PATH }] });
        expect((await run(db, {})).missed).toEqual([PATH]);
    });

    it('skips an extension Komga never indexes (.cb7)', async () => {
        const cb7 = '/data/Alpha Squad (2020)/Alpha Squad 001 (2020).cb7';
        fake = await startFakeKomga({ state: { books: [] } });
        const { db, writes } = makeDb({ issues: [{ id: 'i1', filePath: cb7 }] });
        const result = await run(db, { [cb7]: { mtimeMs: NOW.getTime() } }, { snapshotPaths: [cb7] });
        expect(result.skipped).toBe(1);
        expect(result.missed).toEqual([]);
        expect(lastState(writes).lastSyncCompletedAt).toBe(NOW);
    });

    it('skips a path outside every Komga library', async () => {
        const outside = '/elsewhere/1.cbz';
        fake = await startFakeKomga({ state: { books: [] } });
        const { db } = makeDb({ issues: [{ id: 'i1', filePath: outside }] });
        const result = await run(db, { [outside]: { mtimeMs: NOW.getTime() } }, { snapshotPaths: [outside] });
        expect(result.skipped).toBe(1);
        expect(result.missed).toEqual([]);
    });

    it('skips when the library does not index the format at all', async () => {
        const pdf = '/data/Alpha Squad (2020)/Alpha Squad 001 (2020).pdf';
        fake = await startFakeKomga({ state: { books: [] } });
        const { db } = makeDb({ issues: [{ id: 'i1', filePath: pdf }] });
        const noPdf = komgaLib({ settings: { ...komgaLib().settings, scanPdf: false } });
        const result = await run(db, { [pdf]: { mtimeMs: NOW.getTime() } }, { snapshotPaths: [pdf], komgaLibs: [noPdf] });
        expect(result.skipped).toBe(1);
        expect(result.missed).toEqual([]);
    });

    it('expands a FOLDER path into the files under it', async () => {
        const dir = '/data/Alpha Squad (2020)';
        const second = '/data/Alpha Squad (2020)/Alpha Squad 002 (2020).cbz';
        const outside = '/data/Other (2021)/Other 001 (2021).cbz';
        fake = await startFakeKomga({ state: { books: [komgaBook({ fileLastModified: stampFor(NOW.getTime() - 100) })] } });
        const { db } = makeDb({
            issues: [{ id: 'i1', filePath: PATH }, { id: 'i2', filePath: second }, { id: 'i3', filePath: outside }],
        });
        const result = await run(db, {
            [PATH]: { mtimeMs: NOW.getTime() - 100 },
            [dir]: { mtimeMs: NOW.getTime(), isDirectory: true },
            [second]: { mtimeMs: NOW.getTime() },
            [outside]: { mtimeMs: NOW.getTime() },
        }, { snapshotPaths: [dir] });
        // The one under the folder has no book; the file in another folder was never in the snapshot.
        expect(result.checked).toBe(2);
        expect(result.missed).toEqual([second]);
    });

    it('counts a candidate whose link no longer describes the issue file as awaiting scan', async () => {
        fake = await startFakeKomga({ state: { books: [komgaBook({ fileLastModified: stampFor(NOW.getTime() - 100) })] } });
        const { db } = makeDb({
            issues: [{ id: 'i1', filePath: PATH }],
            links: [{ issueId: 'i1', omnibusPath: '/data/Old Name.cbz' }],
        });
        expect((await run(db, { [PATH]: { mtimeMs: NOW.getTime() - 100 } })).awaitingScan).toBe(1);
    });

    it('does not count a current link as awaiting scan', async () => {
        fake = await startFakeKomga({ state: { books: [komgaBook({ fileLastModified: stampFor(NOW.getTime() - 100) })] } });
        const { db } = makeDb({
            issues: [{ id: 'i1', filePath: PATH }],
            links: [{ issueId: 'i1', omnibusPath: PATH }],
        });
        expect((await run(db, { [PATH]: { mtimeMs: NOW.getTime() - 100 } })).awaitingScan).toBe(0);
    });
});

// ------------------------------------------------------------------ retries

describe('the retry budget', () => {
    it('increments retryCount on the first miss', async () => {
        fake = await startFakeKomga({ state: { books: [] } });
        const { db, writes } = makeDb({ issues: [{ id: 'i1', filePath: PATH }], state: { retryCount: 0 } });
        await run(db, { [PATH]: { mtimeMs: NOW.getTime() } });
        expect(lastState(writes).retryCount).toBe(1);
    });

    it('gives up after KOMGA_VERIFY_MAX_RETRIES, warning with up to 20 paths and dropping them', async () => {
        fake = await startFakeKomga({ state: { books: [] } });
        const many = Array.from({ length: 25 }, (_, n) => `/data/s/${n}.cbz`);
        const { db, writes } = makeDb({
            issues: many.map((p, n) => ({ id: `i${n}`, filePath: p })),
            state: { retryCount: KOMGA_VERIFY_MAX_RETRIES - 1 },
        });
        const files = Object.fromEntries(many.map(p => [p, { mtimeMs: NOW.getTime() }]));
        const result = await run(db, files, { snapshotPaths: many });
        expect(result.gaveUp).toBe(true);
        expect(result.missed).toHaveLength(25);

        const w = lastState(writes);
        expect(w.retryCount).toBe(0);
        expect(w.pendingPaths).toBeUndefined();       // not pushed back: dropped
        expect(w.lastChangeAt).toBeUndefined();       // and not re-dirtied

        const log = writes.jobLogs.at(-1)!;
        expect(log.status).toBe('COMPLETED_WITH_ERRORS');
        const message = log.message as string;
        expect(message).toContain('/data/s/0.cbz');
        expect(message).toContain('(+5 more)');
        // Only 20 of the 25 are listed.
        expect(message.match(/\.cbz/g)!.length).toBe(20);
    });

    it('resets retryCount to zero on a clean pass', async () => {
        fake = await startFakeKomga({ state: { books: [komgaBook({ fileLastModified: stampFor(NOW.getTime() - 100) })] } });
        const { db, writes } = makeDb({ issues: [{ id: 'i1', filePath: PATH }], state: { retryCount: 2 } });
        await run(db, { [PATH]: { mtimeMs: NOW.getTime() - 100 } });
        expect(lastState(writes).retryCount).toBe(0);
        expect(lastState(writes).lastSyncCompletedAt).toBe(NOW);
    });

    it('treats an unreachable Komga as "cannot verify" and leaves the retry state alone', async () => {
        fake = await startFakeKomga({
            state: { failures: [{ method: 'POST', path: '/api/v1/books/list', status: 500, times: 5 }] },
        });
        const { db, writes } = makeDb({ issues: [{ id: 'i1', filePath: PATH }], state: { retryCount: 1 } });
        const result = await run(db, { [PATH]: { mtimeMs: NOW.getTime() } });
        expect(result.unverifiable).toBe(true);
        expect(result.missed).toEqual([]);
        expect(writes.stateUpdates).toHaveLength(0);
    });
});

// ------------------------------------------------------------------ overflow

describe('the pendingPaths overflow sweep', () => {
    it('treats a recently written, unbooked, scannable file as a miss', async () => {
        fake = await startFakeKomga({ state: { books: [] } });
        const { db, writes } = makeDb({
            issues: [{ id: 'i1', filePath: '/data/s/1.cbz' }],
            state: { lastScanRequestedAt: NOW },
        });
        const result = await run(db, { '/data/s/1.cbz': { mtimeMs: NOW.getTime() - 1000 } }, {
            snapshotPaths: [], snapshotOverflow: true,
        });
        expect(result.overflowChecked).toBe(1);
        expect(result.missed).toEqual(['/data/s/1.cbz']);
        expect(lastState(writes).retryCount).toBe(1);
    });

    it('ignores a file older than lastScanRequestedAt - 120 s', async () => {
        fake = await startFakeKomga({ state: { books: [] } });
        const { db, writes } = makeDb({ issues: [{ id: 'i1', filePath: '/data/s/1.cbz' }] });
        const result = await run(db, { '/data/s/1.cbz': { mtimeMs: NOW.getTime() - 121_000 } }, {
            snapshotPaths: [], snapshotOverflow: true,
        });
        expect(result.overflowChecked).toBe(1);
        expect(result.missed).toEqual([]);
        expect(lastState(writes).lastSyncCompletedAt).toBe(NOW);
    });

    it('does not sweep files Komga already has, or that are not scannable', async () => {
        const cb7 = '/data/s/1.cb7';
        fake = await startFakeKomga({ state: { books: [komgaBook()] } });
        const { db } = makeDb({ issues: [{ id: 'i1', filePath: cb7 }] });
        const result = await run(db, {
            [PATH]: { mtimeMs: NOW.getTime() },
            [cb7]: { mtimeMs: NOW.getTime() },
        }, { snapshotPaths: [], snapshotOverflow: true });
        expect(result.missed).toEqual([]);
    });

    it('is bounded to 500 stats', async () => {
        fake = await startFakeKomga({ state: { books: [] } });
        const many = Array.from({ length: 900 }, (_, n) => `/data/s/${String(n).padStart(4, '0')}.cbz`);
        const { db } = makeDb({ issues: many.map((p, n) => ({ id: `i${n}`, filePath: p })) });
        const files = Object.fromEntries(many.map(p => [p, { mtimeMs: NOW.getTime() }]));
        const result = await run(db, files, { snapshotPaths: [], snapshotOverflow: true });
        expect(result.overflowChecked).toBe(500);
        expect(result.missed.length).toBe(500);
    });
});
describe('a truncated folder expansion', () => {
    it('falls back to the bounded overflow sweep instead of claiming success', async () => {
        // A folder with more files than the expansion cap: the tail was never looked at, so the
        // same sweep the pendingPaths overflow uses covers the hole.
        fake = await startFakeKomga({ state: { books: [] } });
        const dir = '/data/Big (2020)';
        const many = Array.from({ length: 2100 }, (_, n) => `${dir}/${String(n).padStart(5, '0')}.cbz`);
        const { db, writes } = makeDb({ issues: many.map((p, n) => ({ id: `i${n}`, filePath: p })) });
        const files: Record<string, { mtimeMs: number }> = {};
        for (const p of many) files[p] = { mtimeMs: NOW.getTime() - 1000 };
        const result = await run(db, { ...files, [dir]: { mtimeMs: NOW.getTime(), isDirectory: true } }, {
            snapshotPaths: [dir],
        });
        expect(result.overflowChecked).toBeGreaterThan(0);
        expect(result.checked).toBe(2000);
        // The sweep found misses beyond the expanded prefix, so this is a real failure, not a pass.
        expect(result.missed.length).toBeGreaterThan(0);
        expect(lastState(writes).retryCount).toBe(1);
    }, 30_000);
});
