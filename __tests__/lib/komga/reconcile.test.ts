import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// reconcile.ts builds the identity map and DELETES rows. These tests drive it against the real
// __tests__/helpers/fake-komga.ts (so the book listing is genuine HTTP with Komga's paging and its
// empty-body 404s) and an in-memory Prisma fake that records exactly which rows were written.
const mocks = vi.hoisted(() => ({
    stateFindUnique: vi.fn(),
    stateCreate: vi.fn(),
    stateUpdate: vi.fn(),
    stateUpdateMany: vi.fn(),
}));

vi.unmock('@/lib/komga/changes');
vi.mock('@/lib/db', () => ({
    prisma: {
        komgaSyncState: {
            findUnique: mocks.stateFindUnique,
            create: mocks.stateCreate,
            update: mocks.stateUpdate,
            updateMany: mocks.stateUpdateMany,
        },
    },
}));

import {
    reconcileLibrary,
    extractProviderKeys,
    issueProviderKey,
    isBookLinkValid,
    majority,
    removalBudget,
} from '@/lib/komga/reconcile';
import { KomgaClient } from '@/lib/komga/client';
import { startFakeKomga, makeKomgaBook, makeKomgaLibrary, type FakeKomga } from '../../helpers/fake-komga';
import type { ResolvedKomgaLibrary } from '@/lib/komga/libraries';
import type { KomgaBookDto } from '@/lib/komga/types';

const LIB = 'olib1';
const K = '0RT15AAAAAAK';
const SERIES = 'ser-1';

const SETTINGS = {
    enabled: true,
    url: 'http://komga.local',
    apiKey: 'key',
    pathMappings: [{ omnibus: '/data', komga: '/komga' }],
    pathMappingsRaw: '[]',
    scanOnChange: true,
    readListsEnabled: false,
    instanceId: null,
};

const komgaLib = (over: Partial<ResolvedKomgaLibrary> = {}): ResolvedKomgaLibrary => ({
    komgaLibraryId: K, name: 'Comics', root: '/komga', translatedRoot: '/data',
    omnibusLibraryId: LIB, unavailable: false,
    settings: {
        hashFiles: true, importComicInfoBook: true, importComicInfoReadList: false,
        emptyTrashAfterScan: false, scanForceModifiedTime: false, convertToCbz: false,
        repairExtensions: false, scanCbx: true, scanPdf: true, scanEpub: true,
        scanDirectoryExclusions: [], oneshotsDirectory: null,
    },
    ...over,
});

const issue = (over: Record<string, unknown> = {}) => ({
    id: 'i1', filePath: '/data/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz',
    metadataSource: 'COMICVINE', metadataId: '100101', seriesId: SERIES, ...over,
});

const book = (over: Partial<KomgaBookDto> = {}, links: { label: string; url: string }[] = []) =>
    makeKomgaBook({
        id: 'B1', seriesId: 'KS1', libraryId: K,
        url: '/komga/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz',
        ...over,
    }, { links });

// ------------------------------------------------------------------ in-memory prisma

interface LinkRow {
    id: string; issueId: string; komgaBookId: string; komgaSeriesId: string; komgaLibraryId: string;
    omnibusPath: string; komgaPath: string; matchedBy: string; missCount: number; verifiedAt: Date;
}

let seq = 0;

function makeDb(over: {
    issues?: Record<string, unknown>[];
    links?: Partial<LinkRow>[];
    seriesLinks?: Record<string, unknown>[];
    komgaLibraries?: unknown[];
    state?: Record<string, unknown>;
    /** Called at the start of every $transaction batch; used to prove no HTTP is in flight. */
    onTx?: () => void;
} = {}) {
    const issues = [...(over.issues ?? [])];
    const links: LinkRow[] = (over.links ?? []).map(l => ({
        id: `L${++seq}`, issueId: 'i1', komgaBookId: 'B1', komgaSeriesId: 'KS1', komgaLibraryId: K,
        omnibusPath: '/data/x.cbz', komgaPath: '/komga/x.cbz', matchedBy: 'PATH', missCount: 0,
        verifiedAt: new Date(0), ...l,
    })) as LinkRow[];
    const seriesLinks = [...(over.seriesLinks ?? [])];
    const state = { omnibusLibraryId: LIB, retryCount: 0, pendingPaths: null, pendingOverflow: false, ...(over.state ?? {}) };

    const writes = {
        transactions: [] as unknown[][],
        stateUpdates: [] as Record<string, unknown>[],
        jobLogs: [] as Record<string, unknown>[],
    };

    const startsWith = (v: unknown, p: string) => typeof v === 'string' && v.startsWith(p);

    const db: any = {
        issue: {
            findMany: vi.fn(async ({ where }: any) => {
                const cond = where?.filePath?.startsWith;
                if (typeof cond === 'string') return issues.filter(i => startsWith(i.filePath, cond));
                if (where?.OR) {
                    const prefixes = where.OR.map((o: any) => o.filePath.startsWith);
                    return issues.filter(i => prefixes.some((p: string) => startsWith(i.filePath, p)));
                }
                if (Array.isArray(where?.filePath?.in)) {
                    return issues.filter(i => where.filePath.in.includes(i.filePath));
                }
                return issues;
            }),
        },
        komgaBookLink: {
            findMany: vi.fn(async ({ where }: any) =>
                links.filter(l => !where?.komgaLibraryId || l.komgaLibraryId === where.komgaLibraryId)),
            create: vi.fn(async ({ data }: any) => {
                const row = { id: `L${++seq}`, ...data } as LinkRow;
                links.push(row);
                return row;
            }),
            update: vi.fn(async ({ where, data }: any) => {
                const row = links.find(l => l.id === where.id);
                if (row) Object.assign(row, data);
                return row;
            }),
            delete: vi.fn(async ({ where }: any) => {
                const i = links.findIndex(l => l.id === where.id);
                if (i >= 0) links.splice(i, 1);
                return {};
            }),
        },
        komgaSeriesLink: {
            findMany: vi.fn(async ({ where }: any) =>
                seriesLinks.filter(s => !where?.komgaLibraryId || s.komgaLibraryId === where.komgaLibraryId)),
            create: vi.fn(async ({ data }: any) => { seriesLinks.push(data); return data; }),
            update: vi.fn(async ({ where, data }: any) => {
                const row = seriesLinks.find(s => s.id === where.id);
                if (row) Object.assign(row, data);
                return row;
            }),
            delete: vi.fn(async ({ where }: any) => {
                const i = seriesLinks.findIndex(s => s.id === where.id);
                if (i >= 0) seriesLinks.splice(i, 1);
                return {};
            }),
        },
        komgaLibrary: { findMany: vi.fn(async () => over.komgaLibraries ?? []) },
        komgaSyncState: {
            findUnique: vi.fn(async () => state),
            updateMany: vi.fn(async ({ data }: any) => { writes.stateUpdates.push(data); Object.assign(state, data); return { count: 1 }; }),
            update: vi.fn(async ({ data }: any) => { writes.stateUpdates.push(data); Object.assign(state, data); return state; }),
            create: vi.fn(async ({ data }: any) => { Object.assign(state, data); return state; }),
        },
        jobLog: { create: vi.fn(async ({ data }: any) => { writes.jobLogs.push(data); return data; }) },
        // Array-form $transaction, exactly like Prisma: the operations are already created, so this
        // just runs them in order. Recording the batches is what lets the chunking be asserted.
        $transaction: vi.fn(async (ops: any[]) => {
            over.onTx?.();
            writes.transactions.push(ops);
            for (const op of ops) await op;
            return ops;
        }),
    };
    mocks.stateFindUnique.mockResolvedValue(state);
    mocks.stateUpdateMany.mockResolvedValue({ count: 1 });
    return { db, links, seriesLinks, state, writes };
}

let fake: FakeKomga | null = null;
const client = (f: FakeKomga) => new KomgaClient({ baseUrl: f.url, apiKey: f.state.apiKey });

const run = (db: any, over: Record<string, any> = {}) =>
    reconcileLibrary(LIB, {
        db, client: client(fake!), settings: SETTINGS as never,
        komgaLibs: [komgaLib(over.komgaLib as Partial<ResolvedKomgaLibrary> | undefined)],
        now: () => new Date('2026-03-01T12:00:00Z'),
    });

const lastJobLog = (writes: any) => writes.jobLogs.at(-1);
/** The most recent KomgaSyncState write, asserted non-null so a missing write fails loudly. */
const lastStateUpdate = (writes: any): Record<string, unknown> => {
    const last = writes.stateUpdates.at(-1);
    expect(last).toBeDefined();
    return last as Record<string, unknown>;
};

beforeEach(() => { seq = 0; });
afterEach(async () => { if (fake) { await fake.close(); fake = null; } });

// ------------------------------------------------------------------ pure helpers

describe('provider key parsing', () => {
    it('reads the issue-level ComicVine and Metron urls', () => {
        expect(extractProviderKeys([
            { label: 'comicvine.gamespot.com', url: 'https://comicvine.gamespot.com/x/4000-100101/' },
            { label: 'metron.cloud', url: 'https://metron.cloud/issue/9001/' },
        ])).toEqual(['CV:100101', 'METRON:9001']);
    });

    it('does not let a ComicVine id on a Metron url masquerade as a Metron issue', () => {
        // '/issue/4000-123' would otherwise capture '4000' and claim Metron issue 4000.
        expect(extractProviderKeys([{ label: 'metron.cloud', url: 'https://metron.cloud/issue/4000-123/' }])).toEqual([]);
    });

    it('ignores series-level links and junk', () => {
        expect(extractProviderKeys([
            { label: 'comicvine.gamespot.com', url: 'https://comicvine.gamespot.com/alpha-squad-1/4000-/' },
            { label: 'x', url: '' },
        ])).toEqual([]);
        expect(extractProviderKeys(undefined)).toEqual([]);
    });

    it('rejects Omnibus placeholder ids', () => {
        expect(issueProviderKey('COMICVINE', 'unmatched_1712')).toBeNull();
        expect(issueProviderKey('LOCAL', 'LOCAL')).toBeNull();
        expect(issueProviderKey('COMICVINE', '0')).toBeNull();
        expect(issueProviderKey('COMICVINE', null)).toBeNull();
        expect(issueProviderKey('SOME_OTHER_SOURCE', '42')).toBeNull();
        expect(issueProviderKey('comicvine', ' 42 ')).toBe('CV:42');
    });
});

describe('small pure helpers', () => {
    it('allows the larger of 20 removals or 25%', () => {
        expect(removalBudget(0)).toBe(20);
        expect(removalBudget(30)).toBe(20);
        expect(removalBudget(400)).toBe(100);
    });

    it('picks the majority, and null for nothing', () => {
        expect(majority(['a', 'a', 'b'])).toBe('a');
        expect(majority([])).toBeNull();
        expect(majority(['a', 'b'])).toBe('a'); // stable tie-break
    });

    it('calls a link valid only while it still describes the issue file', () => {
        expect(isBookLinkValid({ omnibusPath: '/data/a.cbz' }, '/data/a.cbz')).toBe(true);
        expect(isBookLinkValid({ omnibusPath: '/data/a.cbz/' }, '/data//a.cbz')).toBe(true);
        expect(isBookLinkValid({ omnibusPath: '/data/a.cbz' }, '/data/b.cbz')).toBe(false);
        expect(isBookLinkValid(null, '/data/a.cbz')).toBe(false);
        expect(isBookLinkValid({ omnibusPath: '/data/a.cbz' }, null)).toBe(false);
    });
});

// ------------------------------------------------------------------ matching

describe('PATH matching', () => {
    it('links an issue to the book at the mapped path', async () => {
        fake = await startFakeKomga({ state: { books: [book()] } });
        const { db, links } = makeDb({ issues: [issue()] });
        const result = await run(db);
        expect(result.counts.path).toBe(1);
        expect(result.counts.link).toBe(0);
        expect(links).toHaveLength(1);
        expect(links[0]).toMatchObject({
            issueId: 'i1', komgaBookId: 'B1', komgaSeriesId: 'KS1', komgaLibraryId: K,
            omnibusPath: '/data/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz',
            komgaPath: '/komga/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz',
            matchedBy: 'PATH', missCount: 0,
        });
    });

    it('does NOT match a book that merely shares a name at a different path', async () => {
        fake = await startFakeKomga({ state: { books: [book({ url: '/komga/Elsewhere/Alpha Squad 001 (2020).cbz' })] } });
        const { db, links } = makeDb({ issues: [issue()] });
        const result = await run(db);
        expect(links).toHaveLength(0);
        expect(result.counts.unmatchedOmnibusIssues).toBe(1);
        expect(result.counts.komgaBooksNotInOmnibus).toBe(1);
    });

    it('issues outside the mapped prefix are not candidates at all', async () => {
        fake = await startFakeKomga({ state: { books: [book()] } });
        const { db, links } = makeDb({ issues: [issue({ filePath: '/elsewhere/a.cbz' })] });
        await run(db);
        expect(links).toHaveLength(0);
    });

    it('excludes a url that two books share from path matching', async () => {
        fake = await startFakeKomga({
            state: {
                books: [
                    book(),
                    book({ id: 'B2', url: '/komga/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz' }),
                ],
            },
        });
        const { db, links } = makeDb({ issues: [issue()] });
        await run(db);
        expect(links).toHaveLength(0);
    });
});

describe('LINK matching', () => {
    const cvLink = (id: string) => ({ label: 'comicvine.gamespot.com', url: `https://comicvine.gamespot.com/x/4000-${id}/` });

    it('links by provider url when the path moved', async () => {
        fake = await startFakeKomga({
            state: {
                books: [
                    makeKomgaBook({ id: 'B9', libraryId: K, url: '/komga/Alpha Squad (2020)/Alpha Squad 001 (2020) renamed.cbz' },
                        { links: [cvLink('100101')] }),
                ],
            },
        });
        const { db, links } = makeDb({ issues: [issue()] });
        const result = await run(db);
        expect(result.counts.link).toBe(1);
        expect(links[0]).toMatchObject({ komgaBookId: 'B9', matchedBy: 'LINK' });
    });

    it('matches a Metron issue against a Metron url', async () => {
        fake = await startFakeKomga({
            state: {
                books: [
                    makeKomgaBook({ id: 'BM', libraryId: K, url: '/komga/m/1.cbz' },
                        { links: [{ label: 'metron.cloud', url: 'https://metron.cloud/issue/777/' }] }),
                ],
            },
        });
        // The issue filePath deliberately does NOT map to the book path: only the provider url can.
        const { db, links } = makeDb({
            issues: [issue({ filePath: '/data/m/old-name.cbz', metadataSource: 'METRON', metadataId: '777' })],
        });
        expect((await run(db)).counts.link).toBe(1);
        expect(links[0].matchedBy).toBe('LINK');
    });

    it('never uses unmatched_* or LOCAL ids', async () => {
        fake = await startFakeKomga({
            state: { books: [makeKomgaBook({ id: 'B1', libraryId: K, url: '/komga/other/1.cbz' }, { links: [cvLink('1712')] })] },
        });
        const { db, links } = makeDb({
            issues: [issue({ filePath: '/data/other/elsewhere.cbz', metadataSource: 'LOCAL', metadataId: 'unmatched_1712' })],
        });
        expect((await run(db)).counts.link).toBe(0);
        expect(links).toHaveLength(0);
    });

    it('a PATH-matched book is never a LINK candidate', async () => {
        fake = await startFakeKomga({
            state: {
                books: [
                    book({}, [cvLink('100101')]),
                    makeKomgaBook({ id: 'B2', libraryId: K, url: '/komga/copy/1.cbz' }, { links: [cvLink('100101')] }),
                ],
            },
        });
        const { db, links } = makeDb({ issues: [issue()] });
        const result = await run(db);
        expect(result.counts.path).toBe(1);
        expect(result.counts.link).toBe(0);
        expect(links).toHaveLength(1);
        expect(links[0].komgaBookId).toBe('B1');
    });

    // The non-match assertions. A matcher that is too eager passes every positive test above.
    it('does NOT link when two issues claim the same provider id', async () => {
        fake = await startFakeKomga({
            state: { books: [makeKomgaBook({ id: 'B1', libraryId: K, url: '/komga/x/1.cbz' }, { links: [cvLink('100101')] })] },
        });
        const { db, links } = makeDb({
            issues: [
                issue({ id: 'i1', filePath: '/data/x/first.cbz', metadataId: '100101' }),
                issue({ id: 'i2', filePath: '/data/x/second.cbz', metadataId: '100101' }),
            ],
        });
        const result = await run(db);
        expect(result.counts.path).toBe(0);
        expect(result.counts.link).toBe(0);
        expect(links).toHaveLength(0);
    });

    it('does NOT link when two books expose the same provider id', async () => {
        fake = await startFakeKomga({
            state: {
                books: [
                    makeKomgaBook({ id: 'B1', libraryId: K, url: '/komga/x/1.cbz' }, { links: [cvLink('100101')] }),
                    makeKomgaBook({ id: 'B2', libraryId: K, url: '/komga/x/2.cbz' }, { links: [cvLink('100101')] }),
                ],
            },
        });
        const { db, links } = makeDb({ issues: [issue({ filePath: '/data/x/elsewhere.cbz' })] });
        expect((await run(db)).counts.link).toBe(0);
        expect(links).toHaveLength(0);
    });

    it('does NOT link a book whose links resolve to two different issues', async () => {
        fake = await startFakeKomga({
            state: {
                books: [
                    makeKomgaBook({ id: 'B1', libraryId: K, url: '/komga/x/1.cbz' }, {
                        links: [cvLink('1'), { label: 'metron.cloud', url: 'https://metron.cloud/issue/2/' }],
                    }),
                ],
            },
        });
        const { db, links } = makeDb({
            issues: [
                issue({ id: 'i1', filePath: '/data/x/first.cbz', metadataId: '1', metadataSource: 'COMICVINE' }),
                issue({ id: 'i2', filePath: '/data/x/second.cbz', metadataId: '2', metadataSource: 'METRON' }),
            ],
        });
        expect((await run(db)).counts.link).toBe(0);
        expect(links).toHaveLength(0);
    });
});

// ------------------------------------------------------------------ stale links

describe('stale links', () => {
    const staleLink = (over: Partial<LinkRow> = {}) => ({
        issueId: 'i1', komgaBookId: 'B1',
        omnibusPath: '/data/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz',
        komgaPath: '/komga/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz', ...over,
    });

    it('ONE miss must NOT delete: it only records missCount', async () => {
        // The linked book is still in the listing but at another path, so this is a pure path miss:
        // no proof of deletion exists, so the row must survive with missCount 1.
        fake = await startFakeKomga({ state: { books: [book({ id: 'B1', url: '/komga/moved-away/1.cbz' })] } });
        const { db, links } = makeDb({ issues: [issue()], links: [staleLink({ missCount: 0 })] });
        const result = await run(db);
        expect(result.counts.removedLinks).toBe(0);
        expect(links).toHaveLength(1);
        expect(links[0].missCount).toBe(1);
    });

    it('deletes on the SECOND consecutive miss', async () => {
        fake = await startFakeKomga({ state: { books: [book({ id: 'B1', url: '/komga/moved-away/1.cbz' })] } });
        const { db, links } = makeDb({ issues: [issue()], links: [staleLink({ missCount: 1 })] });
        const result = await run(db);
        expect(result.counts.removedLinks).toBe(1);
        expect(links).toHaveLength(0);
    });

    it('a miss that becomes a match again resets missCount to zero', async () => {
        fake = await startFakeKomga({ state: { books: [book()] } });
        const { db, links } = makeDb({ issues: [issue()], links: [staleLink({ missCount: 1 })] });
        await run(db);
        expect(links).toHaveLength(1);
        expect(links[0].missCount).toBe(0);
    });

    it('removes immediately when getBook 404s (LIVE delta 11: empty body)', async () => {
        fake = await startFakeKomga({ state: { books: [book()] } });
        const { db, links } = makeDb({
            issues: [issue({ id: 'i2', filePath: '/data/nowhere/2.cbz' })],
            links: [staleLink({ issueId: 'i2', komgaBookId: 'HARDDELETED', missCount: 0 })],
        });
        const result = await run(db);
        expect(result.counts.removedLinks).toBe(1);
        expect(links).toHaveLength(0);
    });

    it('removes immediately when getBook reports deleted=true (unhashed rename)', async () => {
        fake = await startFakeKomga({ state: { books: [book(), book({ id: 'SOFT', url: '/komga/gone/1.cbz', deleted: true })] } });
        const { db, links } = makeDb({
            issues: [issue({ id: 'i2', filePath: '/data/nowhere/2.cbz' })],
            links: [staleLink({ issueId: 'i2', komgaBookId: 'SOFT', missCount: 0 })],
        });
        expect((await run(db)).counts.removedLinks).toBe(1);
        expect(links).toHaveLength(0);
    });

    it('removes immediately when the issue no longer has a filePath', async () => {
        fake = await startFakeKomga({ state: { books: [book()] } });
        const { db, links } = makeDb({ issues: [issue({ filePath: null })], links: [staleLink()] });
        expect((await run(db)).counts.removedLinks).toBe(1);
        expect(links).toHaveLength(0);
    });

    it('does not re-probe Komga for a link the listing already proved stale by path', async () => {
        fake = await startFakeKomga({ state: { books: [book({ id: 'B1', url: '/komga/elsewhere/1.cbz' })] } });
        const { db } = makeDb({ issues: [issue()], links: [staleLink({ missCount: 0 })] });
        await run(db);
        const singleBookGets = fake.requests.filter(
            r => r.route.startsWith('/api/v1/books/') && r.route !== '/api/v1/books/list');
        expect(singleBookGets).toHaveLength(0);
    });
});

// ------------------------------------------------------------------ the safety valve

describe('the safety valve', () => {
    /** 30 links whose issues have no file: each is an immediate removal, well over the budget. */
    const manyDeletable = () => Array.from({ length: 30 }, (_, n) => ({
        id: `x${n}`, issueId: `i${n}`, komgaBookId: `B${n}`, komgaSeriesId: 'KS1', komgaLibraryId: K,
        omnibusPath: `/data/${n}.cbz`, komgaPath: `/komga/${n}.cbz`, matchedBy: 'PATH', missCount: 0,
        verifiedAt: new Date(0),
    })).map(({ id: _id, ...rest }: any) => rest as Partial<LinkRow>);

    it('trips on a 0-book listing while links exist, and keeps every link', async () => {
        fake = await startFakeKomga({ state: { books: [] } });
        const { db, links, writes } = makeDb({
            issues: [issue()],
            links: [{ issueId: 'i1', komgaBookId: 'B1', missCount: 0 }],
        });
        const result = await run(db);
        expect(result.ok).toBe(false);
        expect(result.valves.join(' ')).toMatch(/listed 0 books while 1 link/);
        expect(links).toHaveLength(1);
        expect(links[0].missCount).toBe(0);
        expect(db.komgaBookLink.delete).not.toHaveBeenCalled();
        expect(writes.transactions).toHaveLength(0);
        expect(lastStateUpdate(writes).lastError).toMatch(/safety valve/);
    });

    it('trips when this pass would remove more than max(20, 25%) of the links', async () => {
        fake = await startFakeKomga({ state: { books: [book()] } });
        const { db, links } = makeDb({
            issues: Array.from({ length: 30 }, (_, n) => issue({ id: `i${n}`, filePath: null })),
            links: manyDeletable(),
        });
        const result = await run(db);
        expect(result.valves.join(' ')).toMatch(/would remove 30 link\(s\), above the 20 allowed/);
        expect(links).toHaveLength(30);
        expect(db.komgaBookLink.delete).not.toHaveBeenCalled();
    });

    it('trips when a book url is not an absolute path', async () => {
        fake = await startFakeKomga({ state: { books: [book({ url: 'Alpha Squad 001 (2020).cbz' })] } });
        const { db } = makeDb({ issues: [issue()], links: [{ issueId: 'i1', komgaBookId: 'B1', missCount: 0 }] });
        const result = await run(db);
        expect(result.valves.join(' ')).toMatch(/not an absolute path/);
        expect(db.komgaBookLink.delete).not.toHaveBeenCalled();
    });

    it('trips when a book url is outside the library root', async () => {
        fake = await startFakeKomga({ state: { books: [book({ url: '/somewhere/else/1.cbz' })] } });
        const { db } = makeDb({ issues: [issue()], links: [{ issueId: 'i1', komgaBookId: 'B1', missCount: 0 }] });
        const result = await run(db);
        expect(result.valves.join(' ')).toMatch(/outside the library root/);
    });

    it('trips when Komga reports the library as unavailable', async () => {
        fake = await startFakeKomga({ state: { books: [book()] } });
        const { db, links } = makeDb({
            issues: [issue()],
            links: [{ issueId: 'i1', komgaBookId: 'B1', missCount: 0 }],
        });
        const result = await run(db, { komgaLib: komgaLib({ unavailable: true }) });
        expect(result.valves.join(' ')).toMatch(/unavailable/);
        expect(links).toHaveLength(1);
    });

    it('does NOT bump missCount on a valve trip, so two bad passes cannot empty the map', async () => {
        // 0 books twice in a row: without this rule both passes would bump missCount and the map
        // would be deleted on the second one.
        fake = await startFakeKomga({ state: { books: [] } });
        for (const _ of [1, 2]) {
            const { db, links } = makeDb({ issues: [issue()], links: [{ issueId: 'i1', komgaBookId: 'B1', missCount: 0 }] });
            await run(db);
            expect(links).toHaveLength(1);
            expect(links[0].missCount).toBe(0);
        }
    });

    it('records the trip in the KOMGA_RECONCILE JobLog and does not move lastReconciledAt', async () => {
        fake = await startFakeKomga({ state: { books: [] } });
        const { db, writes } = makeDb({ issues: [issue()], links: [{ issueId: 'i1', komgaBookId: 'B1', missCount: 0 }] });
        await run(db);
        const log = lastJobLog(writes);
        expect(log.jobType).toBe('KOMGA_RECONCILE');
        expect(log.status).toBe('COMPLETED_WITH_ERRORS');
        expect(JSON.parse(log.message as string).valveMessages.length).toBe(1);
        expect(lastStateUpdate(writes).lastReconciledAt).toBeUndefined();
    });
});

// ------------------------------------------------------------------ writes

describe('writing', () => {
    it('writes only changed rows: an already-correct link is not rewritten', async () => {
        fake = await startFakeKomga({ state: { books: [book()] } });
        const { db, writes } = makeDb({
            issues: [issue()],
            links: [{
                issueId: 'i1', komgaBookId: 'B1', komgaSeriesId: 'KS1', komgaLibraryId: K,
                omnibusPath: '/data/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz',
                komgaPath: '/komga/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz',
                matchedBy: 'PATH', missCount: 0, verifiedAt: new Date('2026-01-01T00:00:00Z'),
            }],
        });
        await run(db);
        expect(db.komgaBookLink.update).not.toHaveBeenCalled();
        expect(db.komgaBookLink.create).not.toHaveBeenCalled();
        // The only row written is the (still missing) series link.
        expect(db.komgaSeriesLink.create).toHaveBeenCalledTimes(1);
        expect(writes.transactions.flat()).toHaveLength(1);
    });

    it('writes nothing at all when the series link is already right too', async () => {
        fake = await startFakeKomga({ state: { books: [book()] } });
        const { db, writes } = makeDb({
            issues: [issue()],
            links: [{
                issueId: 'i1', komgaBookId: 'B1', komgaSeriesId: 'KS1', komgaLibraryId: K,
                omnibusPath: '/data/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz',
                komgaPath: '/komga/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz',
                matchedBy: 'PATH', missCount: 0, verifiedAt: new Date('2026-01-01T00:00:00Z'),
            }],
            seriesLinks: [{ id: 'sl1', seriesId: SERIES, komgaSeriesId: 'KS1', komgaLibraryId: K, verifiedAt: new Date('2026-01-01T00:00:00Z') }],
        });
        await run(db);
        expect(writes.transactions).toHaveLength(0);
    });

    it('updates a row in place when the book id changed under a rename with hashing', async () => {
        fake = await startFakeKomga({ state: { books: [book({ id: 'BNEW' })] } });
        const { db, links } = makeDb({
            issues: [issue()],
            links: [{
                issueId: 'i1', komgaBookId: 'BOLD', komgaSeriesId: 'KS1', komgaLibraryId: K,
                omnibusPath: '/data/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz',
                komgaPath: '/komga/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz',
                matchedBy: 'PATH', missCount: 0, verifiedAt: new Date(0),
            }],
        });
        await run(db);
        expect(links).toHaveLength(1);
        expect(links[0].komgaBookId).toBe('BNEW');
        expect(db.komgaBookLink.update).toHaveBeenCalled();
    });

    it('deletes the row that holds a book another issue now claims, before upserting', async () => {
        fake = await startFakeKomga({
            state: {
                books: [
                    book({ id: 'B1', url: '/komga/x/1.cbz' }),
                    book({ id: 'B2', url: '/komga/x/2.cbz' }),
                ],
            },
        });
        const { db, links } = makeDb({
            issues: [issue({ id: 'i1', filePath: '/data/x/1.cbz' }), issue({ id: 'i2', filePath: '/data/x/2.cbz' })],
            links: [{ issueId: 'i2', komgaBookId: 'B1', komgaSeriesId: 'KS1', komgaLibraryId: K, omnibusPath: '/data/x/2.cbz', komgaPath: '/komga/x/2.cbz', matchedBy: 'PATH', missCount: 0 }],
        });
        await run(db);
        expect(links).toHaveLength(2);
        expect(links.filter(l => l.komgaBookId === 'B1')).toHaveLength(1);
        expect(links.find(l => l.komgaBookId === 'B1')!.issueId).toBe('i1');
    });

    it('chunks the write into $transaction batches of 500', async () => {
        const N = 1_100;
        const books = Array.from({ length: N }, (_, n) =>
            book({ id: `B${n}`, url: `/komga/s/${n}.cbz`, seriesId: 'KS1' }));
        fake = await startFakeKomga({ state: { books } });
        const { db, writes } = makeDb({
            issues: Array.from({ length: N }, (_, n) =>
                issue({ id: `i${n}`, filePath: `/data/s/${n}.cbz`, metadataId: String(n + 1) })),
        });
        await run(db);
        expect(db.komgaBookLink.create).toHaveBeenCalledTimes(N);
        expect(writes.transactions.length).toBeGreaterThan(1);
        for (const chunk of writes.transactions) expect(chunk.length).toBeLessThanOrEqual(500);
        // N book links plus the single series link.
        expect(writes.transactions.map(c => c.length).reduce((a, b) => a + b, 0)).toBe(N + 1);
    });

    it('never awaits HTTP inside a transaction: every request precedes the first batch', async () => {
        // Issue #195: Node's SQLite runs connection_limit=1, so an awaited fetch inside a
        // $transaction blocks every other writer in the process. The request count is sampled on
        // entry to every batch; if it ever grows afterwards, HTTP happened inside a transaction.
        const books = [book(), book({ id: 'B2', url: '/komga/x/2.cbz' })];
        fake = await startFakeKomga({ state: { books } });
        const httpAtTx: number[] = [];
        const { db } = makeDb({
            issues: [issue({ id: 'i1' }), issue({ id: 'i2', filePath: '/data/x/2.cbz' })],
            // A stale link whose book Komga has hard-deleted, so the getBook probe runs too.
            links: [{ issueId: 'i3', komgaBookId: 'GONE', missCount: 0 }],
            onTx: () => httpAtTx.push(fake!.requests.length),
        });
        // i3 does not exist in the issues array above, so add it as a file with no book.
        (db.issue.findMany as any).mockImplementation(async ({ where }: any) => {
            const rows = [
                { id: 'i1', filePath: '/data/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz' },
                { id: 'i2', filePath: '/data/x/2.cbz' },
                { id: 'i3', filePath: '/data/x/3.cbz' },
            ];
            return typeof where?.filePath?.startsWith === 'string'
                ? rows.filter(r => r.filePath.startsWith(where.filePath.startsWith))
                : rows;
        });
        await run(db);
        expect(httpAtTx.length).toBeGreaterThan(0);
        expect(fake!.requests.length).toBeGreaterThan(1);
        expect(Math.max(...httpAtTx)).toBe(fake!.requests.length);
    });

    it('writes a KomgaSeriesLink with the majority Komga series of a series\' books', async () => {
        fake = await startFakeKomga({
            state: {
                books: [
                    book({ id: 'B1', url: '/komga/s/1.cbz', seriesId: 'KS1' }),
                    book({ id: 'B2', url: '/komga/s/2.cbz', seriesId: 'KS2' }),
                    book({ id: 'B3', url: '/komga/s/3.cbz', seriesId: 'KS2' }),
                ],
            },
        });
        const { db, seriesLinks } = makeDb({
            issues: [
                issue({ id: 'i1', filePath: '/data/s/1.cbz' }),
                issue({ id: 'i2', filePath: '/data/s/2.cbz' }),
                issue({ id: 'i3', filePath: '/data/s/3.cbz' }),
            ],
        });
        await run(db);
        expect(seriesLinks).toHaveLength(1);
        expect(seriesLinks[0]).toMatchObject({ seriesId: SERIES, komgaSeriesId: 'KS2', komgaLibraryId: K });
    });

    it('drops a series link once its series has no linked book left', async () => {
        fake = await startFakeKomga({ state: { books: [book()] } });
        const { db, seriesLinks } = makeDb({
            // The issue has a file but Komga has no book for it, so the link misses twice and goes.
            issues: [issue({ filePath: '/data/nothing/here.cbz' })],
            links: [{ issueId: 'i1', komgaBookId: 'B1', missCount: 1 }],
            seriesLinks: [{ id: 'sl1', seriesId: SERIES, komgaSeriesId: 'KS9', komgaLibraryId: K, verifiedAt: new Date(0) }],
        });
        await run(db);
        expect(seriesLinks).toHaveLength(0);
    });

    it('records the JOBLOG counts', async () => {
        fake = await startFakeKomga({
            state: {
                books: [
                    book({ id: 'B1', url: '/komga/x/1.cbz' }),
                    book({ id: 'B2', url: '/komga/x/2.cbz', seriesId: 'KS1' }, [
                        { label: 'comicvine.gamespot.com', url: 'https://comicvine.gamespot.com/x/4000-5/' },
                    ]),
                    book({ id: 'B3', url: '/komga/orphan/9.cbz' }),
                ],
            },
        });
        const { db, writes } = makeDb({
            issues: [
                issue({ id: 'i1', filePath: '/data/x/1.cbz' }),
                issue({ id: 'i2', filePath: '/data/x/moved.cbz', metadataId: '5' }),
                issue({ id: 'i3', filePath: '/data/x/nothing.cbz', metadataId: '77' }),
            ],
        });
        const result = await run(db);
        expect(result.counts).toMatchObject({ path: 1, link: 1, unmatchedOmnibusIssues: 1, komgaBooksNotInOmnibus: 1, removedLinks: 0 });
        const log = lastJobLog(writes);
        expect(log.jobType).toBe('KOMGA_RECONCILE');
        expect(log.status).toBe('COMPLETED');
        const parsed = JSON.parse(log.message as string);
        expect(parsed.path).toBe(1);
        expect(parsed.link).toBe(1);
        expect(parsed.unmatchedOmnibusIssues).toBe(1);
        expect(parsed.komgaBooksNotInOmnibus).toBe(1);
    });

    it('stamps lastReconciledAt on a clean pass', async () => {
        fake = await startFakeKomga({ state: { books: [book()] } });
        const { db, writes } = makeDb({ issues: [issue()] });
        await run(db);
        expect(lastStateUpdate(writes).lastReconciledAt).toBeInstanceOf(Date);
        expect(lastStateUpdate(writes).lastError).toBeNull();
    });
});

describe('failure handling', () => {
    it('makes no writes when the book listing itself fails', async () => {
        fake = await startFakeKomga({
            state: { failures: [{ method: 'POST', path: '/api/v1/books/list', status: 500, times: 10 }] },
        });
        const { db, writes } = makeDb({ issues: [issue()], links: [{ issueId: 'i1', komgaBookId: 'B1', missCount: 0 }] });
        const result = await run(db);
        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toMatch(/could not list its books/);
        expect(db.komgaBookLink.delete).not.toHaveBeenCalled();
        expect(writes.transactions).toHaveLength(0);
    });

    it('skips a Komga library with no usable path mapping', async () => {
        fake = await startFakeKomga({ state: { books: [book()] } });
        const { db, writes } = makeDb({ issues: [issue()] });
        const result = await reconcileLibrary(LIB, {
            db, client: client(fake), settings: SETTINGS as never,
            komgaLibs: [komgaLib({ translatedRoot: null })],
        });
        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toMatch(/no usable path mapping/);
        expect(writes.transactions).toHaveLength(0);
    });

    it('does nothing when no Komga library serves the Omnibus library', async () => {
        fake = await startFakeKomga({ state: { books: [] } });
        const { db, writes } = makeDb({ issues: [issue()] });
        const result = await reconcileLibrary(LIB, { db, client: client(fake), settings: SETTINGS as never, komgaLibs: [] });
        expect(result.ok).toBe(true);
        expect(result.counts.komgaLibraries).toBe(0);
        expect(writes.jobLogs).toHaveLength(0);
    });
});
describe('a stale link that is re-matched in the same pass', () => {
    it('resets missCount instead of writing the bump back over the new value', async () => {
        // The book was renamed with hashing: a NEW id at the issue's path while the row still points
        // at the old one. Both the miss and the re-match land in one pass, and the row must end at
        // missCount 0 — writing the bump after the update would leave it at 1.
        fake = await startFakeKomga({ state: { books: [book({ id: 'BNEW' })] } });
        const { db, links } = makeDb({
            issues: [issue({ id: 'i1' })],
            links: [{
                id: 'row1', issueId: 'i1', komgaBookId: 'BOLD', komgaSeriesId: 'KS1', komgaLibraryId: K,
                omnibusPath: '/data/old.cbz', komgaPath: '/komga/old.cbz',
                matchedBy: 'PATH', missCount: 0, verifiedAt: new Date(0),
            }],
        });
        await run(db);
        expect(links).toHaveLength(1);
        expect(links[0].komgaBookId).toBe('BNEW');
        expect(links[0].missCount).toBe(0);
    });
});
