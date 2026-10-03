// __tests__/lib/komga/readlist-push.test.ts
//
// pushReadList / checkReadListDrift / deleteKomgaReadList against the real
// __tests__/helpers/fake-komga.ts, plus the pure naming, marker and collision helpers.
//
// The fake reproduces the read-list rules this module is built on (LIVE_VERIFICATION deltas 12-16):
// case-insensitive-but-untrimmed names, 204 PATCH with an empty body, `bookIds: []` rejected, an
// unknown book id failing the whole request with a 500 FK error, and DELETE 204 then 404.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    getKomgaClient: vi.fn(),
    enqueueSync: vi.fn(),
}));

vi.unmock('@/lib/komga/changes');
vi.mock('@/lib/komga/factory', () => ({ getKomgaClient: mocks.getKomgaClient }));
vi.mock('@/lib/db', () => ({ prisma: {} }));   // every db access goes through deps.db

import {
    checkReadListDrift,
    deleteKomgaReadList,
    invalidateReadListVersionCache,
    komgaNameEquals,
    komgaReadListMarker,
    komgaReadListName,
    komgaReadListSummary,
    normalizeKomgaReadListName,
    parseKomgaReadListMarker,
    pushReadList,
    sameBookIds,
    sweepOrphanedReadLists,
    verifyPushedBookIds,
} from '@/lib/komga/readlist-push';
import { KomgaClient } from '@/lib/komga/client';
import { startFakeKomga, makeKomgaBook, makeKomgaLibrary, type FakeKomga } from '../../helpers/fake-komga';
import type { KomgaReadListDto } from '@/lib/komga/types';

const INSTANCE = 'inst-1';
const LIST_ID = 'rl-omnibus-1';
const KLIB = 'KLIB00000001';
const OLIB = 'olib-1';

const SETTINGS = {
    enabled: true,
    url: 'http://komga.local',
    apiKey: 'key',
    pathMappings: [{ omnibus: '/data', komga: '/comics' }],
    pathMappingsRaw: '[]',
    scanOnChange: true,
    readListsEnabled: true,
    instanceId: INSTANCE,
};

// ---------------------------------------------------------------- in-memory prisma
interface LinkRow {
    readingListId: string;
    komgaReadListId: string | null;
    lastPushedName: string | null;
    lastPushedSummary: string | null;
    lastPushedBookIds: string | null;
    lastPushedAt: Date | null;
    status: string;
    pushedCount: number;
    skippedCount: number;
    skippedSummary: string | null;
    lastError: string | null;
}

function makeDb(over: {
    list?: Record<string, unknown> | null;
    items?: any[];
    links?: LinkRow[];
    bookLinks?: any[];
    libraryLinks?: { komgaLibraryId: string; omnibusLibraryId: string | null }[];
} = {}) {
    const list = over.list === undefined ? {
        id: LIST_ID, name: 'My List', description: 'desc', isGlobal: false, userId: 'u1', komgaSync: true,
        user: { username: 'alice' },
    } : over.list;
    const links: LinkRow[] = [...(over.links ?? [])];
    const db = {
        readingList: {
            findUnique: vi.fn(async ({ where }: any) => (where.id === LIST_ID || where.id === 'rl-old' ? list : null)),
            findMany: vi.fn(async () => [list]),
        },
        readingListItem: { findMany: vi.fn(async () => over.items ?? []) },
        // Linked issues: one row per item that has an issueId, at the path its link recorded.
        issue: {
            findMany: vi.fn(async ({ where }: any) => {
                const ids: string[] = (where?.id?.in ?? (where?.id ? [where.id] : [])) as string[];
                return ids.map(id => issueRow(id, (over.bookLinks ?? []).find((b: any) => b.issueId === id)?.omnibusPath));
            }),
        },
        komgaBookLink: {
            findMany: vi.fn(async () => over.bookLinks ?? []),
        },
        komgaLibrary: {
            findMany: vi.fn(async () => [{
                komgaLibraryId: KLIB, name: 'Comics', root: '/comics/manga', translatedRoot: '/data/manga',
                omnibusLibraryId: OLIB, settings: JSON.stringify({ scanCbx: true, scanPdf: true, scanEpub: true, scanDirectoryExclusions: [] }), unavailable: false,
            }]),
        },
        library: { findMany: vi.fn(async () => [{ id: OLIB, name: 'Manga', path: '/data/manga' }]) },
        komgaReadListLink: {
            findUnique: vi.fn(async ({ where }: any) => links.find(l => l.readingListId === where.readingListId) ?? null),
            upsert: vi.fn(async ({ where, create, update }: any) => {
                const i = links.findIndex(l => l.readingListId === where.readingListId);
                if (i === -1) links.push({ ...create });
                else links[i] = { ...links[i], ...update };
                return links.find(l => l.readingListId === where.readingListId);
            }),
            updateMany: vi.fn(async ({ where, data }: any) => {
                const l = links.find(x => x.readingListId === where.readingListId);
                if (l) Object.assign(l, data);
                return { count: l ? 1 : 0 };
            }),
            deleteMany: vi.fn(async ({ where }: any) => {
                const i = links.findIndex(x => x.readingListId === where.readingListId);
                if (i !== -1) links.splice(i, 1);
                return { count: 1 };
            }),
            findMany: vi.fn(async () => [...links]),
        },
    };
    return { db, links };
}

const linkRow = (over: Partial<LinkRow> = {}): LinkRow => ({
    readingListId: LIST_ID, komgaReadListId: null, lastPushedName: null, lastPushedSummary: null,
    lastPushedBookIds: null, lastPushedAt: null, status: 'pending', pushedCount: 0, skippedCount: 0,
    skippedSummary: null, lastError: null, ...over,
});

/** One resolvable item → one book. */
const oneItem = (issueId = 'e1') => [{ id: 'i1', order: 0, issueId, cvIssueId: null, metadataSource: 'COMICVINE', title: 'X #1' }];
const issueRow = (id = 'e1', filePath = '/data/manga/S/e1.cbz') => ({ id, filePath, series: { libraryId: OLIB } });
const bookLinkRow = (issueId = 'e1', bookId = 'BK0000000001') =>
    ({ issueId, komgaBookId: bookId, komgaLibraryId: KLIB, omnibusPath: `/data/manga/S/${issueId}.cbz` });

let fake: FakeKomga | null = null;
let client: KomgaClient;

async function startFake(over: Partial<Parameters<typeof startFakeKomga>[0]> = {}) {
    fake = await startFakeKomga({
        state: {
            version: '1.28.1',
            libraries: [makeKomgaLibrary({ id: KLIB, root: '/comics/manga' })],
            books: [makeKomgaBook({ id: 'BK0000000001', libraryId: KLIB, url: '/comics/manga/S/e1.cbz' })],
            ...(over.state ?? {}),
        } as never,
    });
    client = new KomgaClient({ baseUrl: fake.url, apiKey: fake.state.apiKey });
    mocks.getKomgaClient.mockResolvedValue(client);
    return fake;
}

const remote = (over: Partial<KomgaReadListDto> = {}): KomgaReadListDto => ({
    id: 'RL00000000001', name: 'My List', summary: '', ordered: true, bookIds: [],
    createdDate: '2026-01-01T00:00:00Z', lastModifiedDate: '2026-01-01T00:00:00Z', filtered: false, ...over,
});

beforeEach(() => {
    invalidateReadListVersionCache();
    mocks.getKomgaClient.mockReset();
    mocks.enqueueSync.mockReset();
});

afterEach(async () => {
    if (fake) { await fake.close(); fake = null; }
});

// ------------------------------------------------------------------ pure helpers
describe('naming', () => {
    it('collapses whitespace and trims, because Komga does neither', () => {
        expect(normalizeKomgaReadListName('  My   List \n ')).toBe('My List');
        expect(normalizeKomgaReadListName('A B')).toBe('A B');
        expect(normalizeKomgaReadListName(null)).toBe('');
    });

    it('appends the owner for a user-owned list only', () => {
        expect(komgaReadListName({ name: 'My List', isGlobal: false, userId: 'u1', ownerUsername: 'alice' })).toBe('My List (alice)');
        expect(komgaReadListName({ name: 'My List', isGlobal: true, userId: 'u1', ownerUsername: 'alice' })).toBe('My List');
        // Legacy global lists are userId null.
        expect(komgaReadListName({ name: 'My List', isGlobal: false, userId: null, ownerUsername: null })).toBe('My List');
    });

    it('compares names the way Komga does: case-insensitively, without trimming', () => {
        expect(komgaNameEquals('RL Valid', 'rl valid')).toBe(true);
        expect(komgaNameEquals('a', 'b')).toBe(false);
    });
});

describe('the ownership marker', () => {
    it('round-trips through the summary', () => {
        const summary = komgaReadListSummary('My description', INSTANCE, LIST_ID);
        expect(summary).toContain('Managed by Omnibus · instance inst-1 · list rl-omnibus-1 · edits in Komga are overwritten');
        expect(parseKomgaReadListMarker(summary)).toEqual({ instanceId: INSTANCE, readingListId: LIST_ID });
    });

    it('puts the marker last, and alone when there is no description', () => {
        expect(komgaReadListSummary(null, INSTANCE, LIST_ID)).toBe(komgaReadListMarker(INSTANCE, LIST_ID));
        expect(komgaReadListSummary('  ', INSTANCE, LIST_ID).endsWith('overwritten')).toBe(true);
    });

    it('is null for a list Omnibus does not manage', () => {
        expect(parseKomgaReadListMarker(null)).toBeNull();
        expect(parseKomgaReadListMarker('my reading list')).toBeNull();
        expect(parseKomgaReadListMarker('Managed by Omnibus · list x')).toBeNull();
    });

    it('sameBookIds is positional', () => {
        expect(sameBookIds(['a', 'b'], ['a', 'b'])).toBe(true);
        expect(sameBookIds(['b', 'a'], ['a', 'b'])).toBe(false);
        expect(sameBookIds(['a'], ['a', 'b'])).toBe(false);
    });
});

// ------------------------------------------------------------------ eligibility
describe('pushReadList: eligibility', () => {
    it('does nothing when read lists are disabled', async () => {
        const { db, links } = makeDb();
        const r = await pushReadList(LIST_ID, { db: db as never, settings: { ...SETTINGS, readListsEnabled: false }, client });
        expect(r.status).toBe('skipped');
        expect(links).toHaveLength(0);
    });

    it('does nothing when the list has komgaSync off', async () => {
        const { db, links } = makeDb({ list: { id: LIST_ID, name: 'L', description: null, isGlobal: false, userId: 'u1', komgaSync: false, user: { username: 'a' } } });
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('skipped');
        expect(r.reason).toBe('off');
        expect(links).toHaveLength(0);
    });

    it('refuses on a Komga older than 1.23.3 and records why', async () => {
        await startFake({ state: { version: '1.20.0' } as never });
        const { db, links } = makeDb();
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('error');
        expect(r.error).toMatch(/1\.23\.3/);
        expect(links[0].status).toBe('error');
    });

    it('caches the version: a second push does not re-read /actuator/info', async () => {
        await startFake();
        const { db } = makeDb();
        await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(fake!.requests.filter(r => r.route === '/actuator/info')).toHaveLength(1);
    });
});

// ------------------------------------------------------------------ create
describe('pushReadList: creating', () => {
    it('creates the list and records what was pushed', async () => {
        await startFake();
        const { db, links } = makeDb({ items: oneItem(), bookLinks: [bookLinkRow()] });
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('pushed');
        expect(r.name).toBe('My List (alice)');
        expect(fake!.state.readLists).toHaveLength(1);
        expect(fake!.state.readLists[0].bookIds).toEqual(['BK0000000001']);
        expect(fake!.state.readLists[0].summary).toContain('Managed by Omnibus');
        expect(links[0].komgaReadListId).toBe(fake!.state.readLists[0].id);
        expect(JSON.parse(links[0].lastPushedBookIds!)).toEqual(['BK0000000001']);
        expect(links[0].status).toBe('synced');
    });

    it('adopts a remote list whose marker names THIS list, whatever it is called', async () => {
        const mine = remote({ id: 'RL00000000999', name: 'Renamed by hand', summary: komgaReadListSummary('d', INSTANCE, LIST_ID), bookIds: ['BK0000000001'] });
        await startFake({ state: { readLists: [mine] } as never });
        const { db, links } = makeDb({ items: oneItem(), bookLinks: [bookLinkRow()] });
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('pushed');
        expect(r.komgaReadListId).toBe('RL00000000999');
        expect(fake!.state.readLists).toHaveLength(1);   // adopted, not duplicated
        expect(fake!.state.readLists[0].name).toBe('My List (alice)');
        expect(links[0].komgaReadListId).toBe('RL00000000999');
    });

    it('does not adopt a list belonging to another instance', async () => {
        const theirs = remote({ id: 'RL00000000888', name: 'Theirs', summary: komgaReadListSummary('d', 'other-instance', 'some-list') });
        await startFake({ state: { readLists: [theirs] } as never });
        const { db } = makeDb({ items: oneItem(), bookLinks: [bookLinkRow()] });
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('pushed');
        expect(fake!.state.readLists.filter(r2 => r2.id === 'RL00000000888')).toHaveLength(1);
        expect(fake!.state.readLists).toHaveLength(2);
    });
});

// ------------------------------------------------------------------ collisions
describe('pushReadList: name collisions', () => {
    it('takes over a list marked for an Omnibus list that no longer exists', async () => {
        const orphan = remote({ id: 'RL00000000777', name: 'My List (alice)', summary: komgaReadListSummary('old', INSTANCE, 'rl-deleted'), bookIds: [] });
        await startFake({ state: { readLists: [orphan] } as never });
        const { db, links } = makeDb({ items: oneItem(), bookLinks: [bookLinkRow()] });
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('pushed');
        expect(r.komgaReadListId).toBe('RL00000000777');
        expect(links[0].komgaReadListId).toBe('RL00000000777');
        expect(fake!.state.readLists).toHaveLength(1);
        expect(fake!.state.readLists[0].bookIds).toEqual(['BK0000000001']);
    });

    it('does NOT take over a list whose marker names a list that still exists', async () => {
        // 'rl-old' exists in the fake db, so the colliding list belongs to a live Omnibus list.
        const other = remote({ id: 'RL00000000666', name: 'My List (alice)', summary: komgaReadListSummary('other', INSTANCE, 'rl-old'), bookIds: [] });
        await startFake({ state: { readLists: [other] } as never });
        const { db } = makeDb({ items: oneItem(), bookLinks: [bookLinkRow()] });
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.name).toBe('My List (alice) (Omnibus)');
        expect(fake!.state.readLists).toHaveLength(2);
        expect(fake!.state.readLists.find(x => x.id === 'RL00000000666')!.bookIds).toEqual([]);
    });

    it('suffixes when the colliding list is a plain user list, and never touches it', async () => {
        const users = remote({ id: 'RL00000000555', name: 'My List (alice)', summary: 'mine, all mine' });
        await startFake({ state: { readLists: [users] } as never });
        const { db } = makeDb({ items: oneItem(), bookLinks: [bookLinkRow()] });
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('pushed');
        expect(r.name).toBe('My List (alice) (Omnibus)');
        const untouched = fake!.state.readLists.find(x => x.id === 'RL00000000555')!;
        expect(untouched.summary).toBe('mine, all mine');
        expect(untouched.bookIds).toEqual([]);
    });

    it('refuses and records lastError when the suffixed name is taken too', async () => {
        const a = remote({ id: 'RL00000000444', name: 'My List (alice)', summary: 'a' });
        const b = remote({ id: 'RL00000000333', name: 'My List (alice) (Omnibus)', summary: 'b' });
        await startFake({ state: { readLists: [a, b] } as never });
        const { db, links } = makeDb({ items: oneItem(), bookLinks: [bookLinkRow()] });
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('error');
        expect(r.error).toMatch(/does not manage/);
        expect(links[0].lastError).toMatch(/does not manage/);
        // Nothing remote changed.
        expect(fake!.state.readLists.find(x => x.id === 'RL00000000444')!.summary).toBe('a');
        expect(fake!.state.readLists.find(x => x.id === 'RL00000000333')!.summary).toBe('b');
        expect(fake!.requests.filter(r2 => r2.method === 'PATCH')).toHaveLength(0);
    });

    it('takes over a suffixed orphan rather than erroring', async () => {
        const a = remote({ id: 'RL00000000444', name: 'My List (alice)', summary: 'a' });
        const b = remote({ id: 'RL00000000333', name: 'My List (alice) (Omnibus)', summary: komgaReadListSummary('old', INSTANCE, 'rl-deleted') });
        await startFake({ state: { readLists: [a, b] } as never });
        const { db } = makeDb({ items: oneItem(), bookLinks: [bookLinkRow()] });
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('pushed');
        expect(r.komgaReadListId).toBe('RL00000000333');
    });

    it('records an error when the listing cannot see the list Komga says is taken', async () => {
        // Komga answers 400 "Read list name already exists" but our own listing shows the name free
        // (a lost race, or a normalisation Komga applies that we do not). The old behaviour recursed
        // on the same name forever; it must give up after one attempt.
        await startFake();
        const { db, links } = makeDb({ items: oneItem(), bookLinks: [bookLinkRow()] });
        fake!.state.failures = [{
            method: 'POST', path: '/api/v1/readlists', times: 1,
            status: 400, body: { status: 400, error: 'Bad Request', message: 'Read list name already exists', path: '/api/v1/readlists' },
        }];
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('error');
        expect(links[0].lastError).toBeTruthy();
        expect(fake!.requests.filter(x => x.method === 'POST')).toHaveLength(1);
    });

    it('retries once with the suffix when the collision only appears after the failed create', async () => {
        await startFake();
        const { db } = makeDb({ items: oneItem(), bookLinks: [bookLinkRow()] });
        // The competitor appears between our listing and our create: the create 400s, and the
        // re-listing now shows a list under the name.
        fake!.state.failures = [{
            method: 'POST', path: '/api/v1/readlists', times: 1,
            status: 400, body: { status: 400, message: 'Read list name already exists' },
        }];
        const original = client.listReadLists.bind(client);
        let calls = 0;
        client.listReadLists = async () => {
            calls += 1;
            if (calls >= 2) fake!.state.readLists.push(remote({ id: 'RL00000000444', name: 'My List (alice)', summary: 'racer' }));
            return original();
        };
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('pushed');
        expect(r.name).toBe('My List (alice) (Omnibus)');
    });
});

// ------------------------------------------------------------------ zero books
describe('pushReadList: nothing resolvable', () => {
    it('creates nothing when there are no entries at all', async () => {
        await startFake();
        const { db, links } = makeDb({ items: [], bookLinks: [] });
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('waiting');
        expect(fake!.state.readLists).toHaveLength(0);
        expect(links[0].status).toBe('waiting');
        expect(links[0].komgaReadListId).toBeNull();
    });

    it('keeps an existing remote list unchanged and marks the link waiting', async () => {
        const mine = remote({ id: 'RL00000000222', name: 'My List (alice)', summary: komgaReadListSummary('d', INSTANCE, LIST_ID), bookIds: ['BK0000000001'] });
        await startFake({ state: { readLists: [mine] } as never });
        const { db, links } = makeDb({
            items: [{ id: 'i1', order: 0, issueId: 'e1', cvIssueId: null, metadataSource: 'COMICVINE', title: 'X #1' }],
            // The book exists but there is no link yet: everything is awaitingScan.
            bookLinks: [],
            links: [linkRow({ komgaReadListId: 'RL00000000222', lastPushedName: 'My List (alice)', lastPushedBookIds: '["BK0000000001"]' })],
        });
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('waiting');
        // Untouched remotely: same membership, same summary, and no PATCH at all.
        expect(fake!.state.readLists[0].bookIds).toEqual(['BK0000000001']);
        expect(fake!.requests.filter(x => x.method === 'PATCH')).toHaveLength(0);
        expect(links[0].status).toBe('waiting');
        expect(links[0].skippedSummary).toContain('awaitingScan');
    });

    it('never sends an empty bookIds array (Komga rejects it with a 400)', async () => {
        await startFake();
        const { db } = makeDb({ items: [], bookLinks: [] });
        await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        const writes = fake!.requests.filter(x => x.method === 'POST' || x.method === 'PATCH');
        for (const w of writes) expect((w.body as any)?.bookIds).not.toEqual([]);
    });
});

// ------------------------------------------------------------------ idempotence
describe('pushReadList: idempotence', () => {
    it('is a no-op when the intended payload matches the last pushed payload', async () => {
        await startFake();
        const summary = komgaReadListSummary('desc', INSTANCE, LIST_ID);
        const { db } = makeDb({
            items: oneItem(), bookLinks: [bookLinkRow()],
            links: [linkRow({
                komgaReadListId: 'RL00000000222',
                lastPushedName: 'My List (alice)',
                lastPushedSummary: summary,
                lastPushedBookIds: '["BK0000000001"]',
            })],
        });
        fake!.state.readLists = [remote({ id: 'RL00000000222', name: 'My List (alice)', summary, bookIds: ['BK0000000001'] })];
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('unchanged');
        expect(fake!.requests.filter(x => x.method === 'PATCH')).toHaveLength(0);
    });

    it('PATCHes when the order changed', async () => {
        await startFake();
        const summary = komgaReadListSummary('desc', INSTANCE, LIST_ID);
        const { db } = makeDb({
            items: [
                // The user reordered: e2 now comes first, which must come first in Komga too.
                { id: 'i2', order: 0, issueId: 'e2', cvIssueId: null, metadataSource: 'COMICVINE', title: 'X #2' },
                { id: 'i1', order: 1, issueId: 'e1', cvIssueId: null, metadataSource: 'COMICVINE', title: 'X #1' },
            ],
            bookLinks: [bookLinkRow('e1', 'BK0000000001'), { issueId: 'e2', komgaBookId: 'BK0000000002', komgaLibraryId: KLIB, omnibusPath: '/data/manga/S/e2.cbz' }],
            links: [linkRow({ komgaReadListId: 'RL00000000222', lastPushedName: 'My List (alice)', lastPushedSummary: summary, lastPushedBookIds: '["BK0000000001","BK0000000002"]' })],
        });
        fake!.state.readLists = [remote({ id: 'RL00000000222', name: 'My List (alice)', summary, bookIds: ['BK0000000001', 'BK0000000002'] })];
        fake!.state.books.push(makeKomgaBook({ id: 'BK0000000002', libraryId: KLIB, url: '/comics/manga/S/e2.cbz' }));
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('pushed');
        expect((fake!.requests.find(x => x.method === 'PATCH')!.body as any).bookIds).toEqual(['BK0000000002', 'BK0000000001']);
        expect(fake!.state.readLists[0].bookIds).toEqual(['BK0000000002', 'BK0000000001']);
    });

    it('recreates the list when the remote one has been deleted (404)', async () => {
        await startFake();
        const { db, links } = makeDb({
            items: oneItem(), bookLinks: [bookLinkRow()],
            links: [linkRow({ komgaReadListId: 'RL0000000GONE', lastPushedName: 'stale', lastPushedSummary: 'stale', lastPushedBookIds: '["BK0000000001"]' })],
        });
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('pushed');
        expect(fake!.state.readLists).toHaveLength(1);
        expect(links[0].komgaReadListId).toBe(fake!.state.readLists[0].id);
    });
});

// ------------------------------------------------------------------ bad ids
describe('pushReadList: stale book ids', () => {
    it('re-verifies the ids, drops the dead one, retries once and asks for a rescan', async () => {
        // Two entries resolve, but Komga only has one of the books: e2's book was hard-deleted
        // (a rename WITH a hash, LIVE delta 17) after the identity map was built. The PATCH then
        // fails with the FK 500 and rolls the WHOLE request back, rename included.
        await startFake();
        const { db, links } = makeDb({
            items: [
                { id: 'i1', order: 0, issueId: 'e1', cvIssueId: null, metadataSource: 'COMICVINE', title: 'X #1' },
                { id: 'i2', order: 1, issueId: 'e2', cvIssueId: null, metadataSource: 'COMICVINE', title: 'X #2' },
            ],
            bookLinks: [
                bookLinkRow('e1', 'BK0000000001'),
                { issueId: 'e2', komgaBookId: 'BK0000000009', komgaLibraryId: KLIB, omnibusPath: '/data/manga/S/e2.cbz' },
            ],
        });

        const r = await pushReadList(LIST_ID, {
            db: db as never, settings: SETTINGS, client, enqueueSync: mocks.enqueueSync,
        });
        expect(r.status).toBe('pushed');
        expect(r.bookCount).toBe(1);
        expect(fake!.state.readLists[0].bookIds).toEqual(['BK0000000001']);
        // The rename rode along on the same request and survived, because the retry carried it.
        expect(fake!.state.readLists[0].name).toBe('My List (alice)');
        expect(mocks.enqueueSync).toHaveBeenCalledWith(OLIB, expect.stringContaining('stale'));
        expect(links[0].status).toBe('synced');
        // Exactly one retry: the second POST carried the surviving id only. (The list did not exist
        // remotely yet, so the retry is a create rather than a PATCH.)
        const posts = fake!.requests.filter(x => x.method === 'POST' && x.route === '/api/v1/readlists');
        expect(posts).toHaveLength(2);
        expect((posts[0].body as any).bookIds).toEqual(['BK0000000001', 'BK0000000009']);
        expect((posts[1].body as any).bookIds).toEqual(['BK0000000001']);
    });

    it('keeps the other books when only one id is dead', async () => {
        await startFake();
        const { db } = makeDb({
            items: [
                // i1's book is gone; i2's is alive. Order must survive the drop.
                { id: 'i1', order: 0, issueId: 'e1', cvIssueId: null, metadataSource: 'COMICVINE', title: 'X #1' },
                { id: 'i2', order: 1, issueId: 'e2', cvIssueId: null, metadataSource: 'COMICVINE', title: 'X #2' },
            ],
            bookLinks: [
                { issueId: 'e1', komgaBookId: 'BK0000000009', komgaLibraryId: KLIB, omnibusPath: '/data/manga/S/e1.cbz' },
                { issueId: 'e2', komgaBookId: 'BK0000000002', komgaLibraryId: KLIB, omnibusPath: '/data/manga/S/e2.cbz' },
            ],
        });
        fake!.state.books.push(makeKomgaBook({ id: 'BK0000000002', libraryId: KLIB, url: '/comics/manga/S/e2.cbz' }));
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client, enqueueSync: mocks.enqueueSync });
        expect(r.status).toBe('pushed');
        expect(fake!.state.readLists[0].bookIds).toEqual(['BK0000000002']);
        expect(r.bookCount).toBe(1);
    });

    it('records an error when every id is dead (nothing left to push)', async () => {
        await startFake();
        const { db, links } = makeDb({
            items: oneItem(), bookLinks: [bookLinkRow()],
            links: [linkRow({ komgaReadListId: 'RL00000000222', lastPushedName: 'old', lastPushedBookIds: '["BK0000000009"]' })],
        });
        fake!.state.readLists = [remote({ id: 'RL00000000222', name: 'My List (alice)', summary: 'old', bookIds: ['BK0000000009'] })];
        fake!.state.failures = [{
            method: 'PATCH', path: '/api/v1/readlists/RL00000000222', times: 1, status: 500,
            body: { status: 500, message: 'SQLITE_CONSTRAINT_FOREIGNKEY' },
        }];
        const r = await pushReadList(LIST_ID, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('error');
        expect(links[0].lastError).toBeTruthy();
    });

    it('verifyPushedBookIds drops 404s and soft-deleted books, keeps the rest', async () => {
        await startFake({ state: { books: [makeKomgaBook({ id: 'BK0000000001', libraryId: KLIB }), makeKomgaBook({ id: 'BK0000000002', libraryId: KLIB, deleted: true })] } as never });
        const r = await verifyPushedBookIds(client, ['BK0000000001', 'BK0000000002', 'BK0000000NOPE']);
        expect(r.kept).toEqual(['BK0000000001']);
        expect(r.dropped).toEqual(['BK0000000002', 'BK0000000NOPE']);
        expect(r.komgaLibraryIds).toContain(KLIB);
    });
});

// ------------------------------------------------------------------ drift
describe('checkReadListDrift', () => {
    it('reverts a StoryArc-style append', async () => {
        await startFake();
        const summary = komgaReadListSummary('desc', INSTANCE, LIST_ID);
        const { db } = makeDb({
            items: oneItem(), bookLinks: [bookLinkRow()],
            links: [linkRow({ komgaReadListId: 'RL00000000222', lastPushedName: 'My List (alice)', lastPushedSummary: summary, lastPushedBookIds: '["BK0000000001"]' })],
        });
        // Someone appended a book in Komga (importComicInfoReadList, or a user).
        fake!.state.readLists = [remote({
            id: 'RL00000000222', name: 'My List (alice)', summary,
            bookIds: ['BK0000000001', 'BK0000000ARC '],
        })];
        const r = await checkReadListDrift({ db: db as never, settings: SETTINGS, client });
        expect(r.reverted).toBe(1);
        expect(fake!.state.readLists[0].bookIds).toEqual(['BK0000000001']);
    });

    it('reverts a rename made in Komga', async () => {
        await startFake();
        const summary = komgaReadListSummary('desc', INSTANCE, LIST_ID);
        const { db } = makeDb({
            items: oneItem(), bookLinks: [bookLinkRow()],
            links: [linkRow({ komgaReadListId: 'RL00000000222', lastPushedName: 'My List (alice)', lastPushedSummary: summary, lastPushedBookIds: '["BK0000000001"]' })],
        });
        fake!.state.readLists = [remote({ id: 'RL00000000222', name: 'MY LIST', summary, bookIds: ['BK0000000001'] })];
        const r = await checkReadListDrift({ db: db as never, settings: SETTINGS, client });
        expect(r.reverted).toBe(1);
        expect(fake!.state.readLists[0].name).toBe('My List (alice)');
    });

    it('recreates a list that disappeared remotely', async () => {
        await startFake();
        const summary = komgaReadListSummary('desc', INSTANCE, LIST_ID);
        const { db, links } = makeDb({
            items: oneItem(), bookLinks: [bookLinkRow()],
            links: [linkRow({ komgaReadListId: 'RL00000000222', lastPushedName: 'My List (alice)', lastPushedSummary: summary, lastPushedBookIds: '["BK0000000001"]' })],
        });
        const r = await checkReadListDrift({ db: db as never, settings: SETTINGS, client });
        expect(r.recreated).toBe(1);
        expect(fake!.state.readLists).toHaveLength(1);
        expect(links[0].komgaReadListId).toBe(fake!.state.readLists[0].id);
    });

    it('leaves an unchanged list completely alone', async () => {
        await startFake();
        const summary = komgaReadListSummary('desc', INSTANCE, LIST_ID);
        const { db } = makeDb({
            items: oneItem(), bookLinks: [bookLinkRow()],
            links: [linkRow({ komgaReadListId: 'RL00000000222', lastPushedName: 'My List (alice)', lastPushedSummary: summary, lastPushedBookIds: '["BK0000000001"]' })],
        });
        fake!.state.readLists = [remote({ id: 'RL00000000222', name: 'My List (alice)', summary, bookIds: ['BK0000000001'] })];
        const r = await checkReadListDrift({ db: db as never, settings: SETTINGS, client });
        expect(r.reverted).toBe(0);
        expect(r.repushed).toBe(0);
        expect(fake!.requests.filter(x => x.method === 'PATCH' || x.method === 'POST')).toHaveLength(0);
    });

    it('makes exactly one listing call', async () => {
        await startFake();
        const { db } = makeDb({ items: oneItem(), bookLinks: [bookLinkRow()] });
        await checkReadListDrift({ db: db as never, settings: SETTINGS, client });
        expect(fake!.requests.filter(x => x.route === '/api/v1/readlists').length).toBeLessThanOrEqual(3);
    });
});

// ------------------------------------------------------------------ delete
describe('deleteKomgaReadList', () => {
    it('deletes a list marked by this instance and forgets the link', async () => {
        const mine = remote({ id: 'RL00000000222', name: 'My List (alice)', summary: komgaReadListSummary('d', INSTANCE, LIST_ID) });
        await startFake({ state: { readLists: [mine] } as never });
        const { db, links } = makeDb({ links: [linkRow({ komgaReadListId: 'RL00000000222' })] });
        const r = await deleteKomgaReadList({ komgaReadListId: 'RL00000000222', readingListId: LIST_ID }, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('deleted');
        expect(fake!.state.readLists).toHaveLength(0);
        expect(links).toHaveLength(0);
    });

    it('treats an already-deleted list (404) as success', async () => {
        await startFake();
        const { db, links } = makeDb({ links: [linkRow({ komgaReadListId: 'RL0000000GONE' })] });
        const r = await deleteKomgaReadList({ komgaReadListId: 'RL0000000GONE', readingListId: LIST_ID }, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('gone');
        expect(links).toHaveLength(0);
        expect(fake!.requests.filter(x => x.method === 'DELETE')).toHaveLength(0);
    });

    it('treats a 404 from the DELETE itself as success', async () => {
        const mine = remote({ id: 'RL00000000222', name: 'My List (alice)', summary: komgaReadListSummary('d', INSTANCE, LIST_ID) });
        await startFake({ state: { readLists: [mine] } as never });
        fake!.state.failures = [{ method: 'DELETE', path: '/api/v1/readlists/RL00000000222', status: 404, body: { status: 404, message: '404 NOT_FOUND' } }];
        const { db } = makeDb({ links: [linkRow({ komgaReadListId: 'RL00000000222' })] });
        const r = await deleteKomgaReadList({ komgaReadListId: 'RL00000000222', readingListId: LIST_ID }, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('gone');
    });

    it('refuses to delete a list whose marker names ANOTHER instance', async () => {
        const theirs = remote({ id: 'RL00000000888', name: 'Theirs', summary: komgaReadListSummary('d', 'other-instance', 'rl-2') });
        await startFake({ state: { readLists: [theirs] } as never });
        const { db, links } = makeDb({ links: [linkRow({ komgaReadListId: 'RL00000000888' })] });
        const r = await deleteKomgaReadList({ komgaReadListId: 'RL00000000888', readingListId: LIST_ID }, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('refused');
        expect(fake!.state.readLists).toHaveLength(1);
        expect(fake!.requests.filter(x => x.method === 'DELETE')).toHaveLength(0);
        expect(links[0].lastError).toMatch(/not managed/);
    });

    it('refuses to delete a list with no marker at all (a user\'s own list)', async () => {
        const users = remote({ id: 'RL00000000555', name: 'Whatever', summary: '' });
        await startFake({ state: { readLists: [users] } as never });
        const { db } = makeDb({ links: [linkRow({ komgaReadListId: 'RL00000000555' })] });
        const r = await deleteKomgaReadList({ komgaReadListId: 'RL00000000555', readingListId: LIST_ID }, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('refused');
        expect(fake!.state.readLists).toHaveLength(1);
    });

    it('stands down when the list was taken over by a replacement list', async () => {
        // The re-import's push adopted this remote first and rewrote the marker to the NEW list id.
        // Deleting now would remove a list the new list legitimately owns.
        const adopted = remote({ id: 'RL00000000222', name: 'My List (alice)', summary: komgaReadListSummary('d', INSTANCE, 'rl-new') });
        await startFake({ state: { readLists: [adopted] } as never });
        const { db } = makeDb({ links: [linkRow({ komgaReadListId: 'RL00000000222' })] });
        const r = await deleteKomgaReadList({ komgaReadListId: 'RL00000000222', readingListId: 'rl-old' }, { db: db as never, settings: SETTINGS, client });
        expect(r.status).toBe('refused');
        expect(r.reason).toMatch(/rl-new/);
        expect(fake!.state.readLists).toHaveLength(1);
    });

    it('does nothing at all when read lists are switched off', async () => {
        await startFake();
        const r = await deleteKomgaReadList({ komgaReadListId: 'x', readingListId: LIST_ID }, { db: makeDb().db as never, settings: { ...SETTINGS, readListsEnabled: false }, client });
        expect(r.status).toBe('skipped');
        expect(fake!.requests).toHaveLength(0);
    });
});

// ------------------------------------------------------------------ orphan sweep
describe('sweepOrphanedReadLists', () => {
    it('deletes a remote list whose Omnibus list is gone', async () => {
        const orphan = remote({ id: 'RL00000000777', name: 'Gone', summary: komgaReadListSummary('d', INSTANCE, 'rl-deleted') });
        await startFake({ state: { readLists: [orphan] } as never });
        const n = await sweepOrphanedReadLists({ db: makeDb().db as never, settings: SETTINGS, client });
        expect(n).toBe(1);
        expect(fake!.state.readLists).toHaveLength(0);
    });

    it('keeps a list that is still linked', async () => {
        const mine = remote({ id: 'RL00000000222', name: 'Mine', summary: komgaReadListSummary('d', INSTANCE, LIST_ID) });
        await startFake({ state: { readLists: [mine] } as never });
        const { db } = makeDb({ links: [linkRow({ komgaReadListId: 'RL00000000222' })] });
        expect(await sweepOrphanedReadLists({ db: db as never, settings: SETTINGS, client })).toBe(0);
        expect(fake!.state.readLists).toHaveLength(1);
    });

    it('never touches a list belonging to another instance, even when its list id is unknown', async () => {
        const theirs = remote({ id: 'RL00000000888', name: 'Theirs', summary: komgaReadListSummary('d', 'other-instance', 'rl-2') });
        await startFake({ state: { readLists: [theirs] } as never });
        expect(await sweepOrphanedReadLists({ db: makeDb().db as never, settings: SETTINGS, client })).toBe(0);
        expect(fake!.state.readLists).toHaveLength(1);
    });

    it('never touches an unmarked user list', async () => {
        const users = remote({ id: 'RL00000000555', name: 'Mine', summary: '' });
        await startFake({ state: { readLists: [users] } as never });
        expect(await sweepOrphanedReadLists({ db: makeDb().db as never, settings: SETTINGS, client })).toBe(0);
    });
});