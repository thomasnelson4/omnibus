// @vitest-environment node
//
// CBL and CSV imports must carry the provider identity (metadataSource + cvIssueId) that the Komga
// identity map and the reading-list auto-link join on. Before this fix both routes created rows
// with neither, so an imported issue could only ever match by file path.
//
// What is asserted here:
//   - a matched Issue's OWN provider identity is copied onto the ReadingListItem (the common case);
//   - a CBL <Database Name=".." Issue=".."/> and a CSV provider-id column supply the id for rows
//     the library could not link — the rows auto-link / "Fix match" resolves later;
//   - a CBL/CBL with NO provider id anywhere still imports to byte-identical rows;
//   - a ComicVine VOLUME id (4050-…) is refused rather than silently stored as an issue id, and an
//     id beyond int4 is refused rather than truncated;
//   - a Metron id is stored in cvIssueId with metadataSource METRON (the house convention: the
//     column holds EITHER namespace, metadataSource says which).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    seriesFindMany: vi.fn(),
    issueFindMany: vi.fn(),
    readingListCreate: vi.fn().mockResolvedValue({ id: 'list_x' }),
    readingListItemCreateMany: vi.fn(),
    push: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findMany: mocks.seriesFindMany },
        issue: { findMany: mocks.issueFindMany },
        readingList: { create: mocks.readingListCreate },
        readingListItem: { createMany: mocks.readingListItemCreateMany },
    },
}));
vi.mock('next-auth/next', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'user_1', role: 'ADMIN' } }),
}));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn(async () => ({})) }));
vi.mock('@/lib/komga/readlist-trigger', () => ({ triggerReadListPushSoon: mocks.push }));

import { POST as importCbl } from '@/app/api/reading-lists/import-cbl/route';
import { POST as importCsv } from '@/app/api/reading-lists/import-csv/route';

const xmen = { id: 's_xmen', name: 'X-Men', coverUrl: null, folderPath: '/c/X-Men' };

const cblReq = (xml: string) => ({
    formData: async () => ({
        get: (k: string) => (k === 'file' ? { text: async () => xml } : k === 'name' ? 'List' : k === 'isGlobal' ? 'false' : null),
    }),
} as any);

const csvReq = (csv: string) => ({
    formData: async () => ({
        get: (k: string) => (k === 'file' ? { text: async () => csv } : k === 'name' ? 'List' : k === 'isGlobal' ? 'false' : null),
    }),
} as any);

/** The exact rows handed to createMany. */
const rows = () => mocks.readingListItemCreateMany.mock.calls[0][0].data;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.readingListCreate.mockResolvedValue({ id: 'list_x' });
    mocks.seriesFindMany.mockResolvedValue([xmen]);
});

describe('CBL import — provider identity', () => {
    it("copies the matched Issue's own ComicVine id onto the item", async () => {
        mocks.issueFindMany.mockResolvedValue([
            { id: 'iss_141', seriesId: 's_xmen', number: '141', metadataSource: 'COMICVINE', metadataId: '9141' },
        ]);
        const xml = `<?xml version="1.0"?><ReadingList><Books>
            <Book Series="X-Men" Number="141" /></Books></ReadingList>`;

        const res = await importCbl(cblReq(xml));
        expect((await res.json()).success).toBe(true);
        expect(rows()).toEqual([
            { listId: 'list_x', issueId: 'iss_141', title: 'X-Men #141', order: 0, metadataSource: 'COMICVINE', cvIssueId: 9141 },
        ]);
    });

    it('reads the real CBL <Database Name="cv" Issue=".."/> for an unlinked book', async () => {
        mocks.issueFindMany.mockResolvedValue([]);
        const xml = `<?xml version="1.0"?><ReadingList><Books>
            <Book Series="Wolverine" Number="5">
              <Database Name="cv" Series="4050-23079" Issue="cv-91391" />
            </Book></Books></ReadingList>`;

        await importCbl(cblReq(xml));
        expect(rows()).toEqual([
            { listId: 'list_x', issueId: null, title: 'Wolverine #5', order: 0, metadataSource: 'COMICVINE', cvIssueId: 91391 },
        ]);
    });

    it('accepts the <Databases/>-wrapped and Metron forms', async () => {
        mocks.issueFindMany.mockResolvedValue([]);
        const xml = `<?xml version="1.0"?><ReadingList><Books>
            <Book Series="A" Number="1"><Databases><Database Name="metron" Issue="5001" /></Databases></Book>
            <Book Series="B" Number="2"><Databases><Database Name="cv" Issue="6002" /></Databases></Book>
            </Books></ReadingList>`;

        await importCbl(cblReq(xml));
        expect(rows()).toEqual([
            { listId: 'list_x', issueId: null, title: 'A #1', order: 0, metadataSource: 'METRON', cvIssueId: 5001 },
            { listId: 'list_x', issueId: null, title: 'B #2', order: 1, metadataSource: 'COMICVINE', cvIssueId: 6002 },
        ]);
    });

    it('REFUSES a ComicVine volume id instead of storing it as an issue id', async () => {
        mocks.issueFindMany.mockResolvedValue([]);
        // `Series` is a VOLUME id (4050-…); a CBL may carry it and no Issue id.
        const xml = `<?xml version="1.0"?><ReadingList><Books>
            <Book Series="Batman" Number="1"><Database Name="cv" Series="4050-23079" /></Book>
            </Books></ReadingList>`;

        await importCbl(cblReq(xml));
        expect(rows()).toEqual([{ listId: 'list_x', issueId: null, title: 'Batman #1', order: 0 }]);
    });

    it('REFUSES an id beyond int4 rather than truncating it', async () => {
        mocks.issueFindMany.mockResolvedValue([
            { id: 'iss_1', seriesId: 's_xmen', number: '1', metadataSource: 'COMICVINE', metadataId: '99999999999999' },
        ]);
        const xml = `<?xml version="1.0"?><ReadingList><Books><Book Series="X-Men" Number="1" /></Books></ReadingList>`;

        await importCbl(cblReq(xml));
        expect(rows()[0]).not.toHaveProperty('cvIssueId');
    });

    it('a CBL with NO provider id anywhere still imports unchanged', async () => {
        mocks.issueFindMany.mockResolvedValue([
            { id: 'iss_141', seriesId: 's_xmen', number: '141', metadataSource: 'COMICVINE', metadataId: null },
        ]);
        const xml = `<?xml version="1.0"?><ReadingList><Books>
            <Book Series="X-Men" Number="141" />
            <Book Series="Wolverine" Number="5" /></Books></ReadingList>`;

        const res = await importCbl(cblReq(xml));
        expect((await res.json()).success).toBe(true);
        // Exactly the pre-fix shape: no identity keys at all, not null ones.
        expect(rows()).toEqual([
            { listId: 'list_x', issueId: 'iss_141', title: 'X-Men #141', order: 0 },
            { listId: 'list_x', issueId: null, title: 'Wolverine #5', order: 1 },
        ]);
        for (const r of rows()) {
            expect(Object.keys(r).sort()).toEqual(['issueId', 'listId', 'order', 'title']);
        }
    });
});

describe('CSV import — provider identity', () => {
    it('copies the matched Issue provider identity, including a Metron id', async () => {
        mocks.issueFindMany.mockResolvedValue([
            { id: 'iss_5', seriesId: 's_xmen', number: '5', metadataSource: 'METRON', metadataId: '8123' },
        ]);
        const csv = 'Series,Issue\nX-Men,5\n';

        const res = await importCsv(csvReq(csv));
        expect((await res.json()).success).toBe(true);
        // Metron ids live in cvIssueId too — metadataSource is what disambiguates the namespace.
        expect(rows()).toEqual([
            { listId: 'list_x', issueId: 'iss_5', title: 'X-Men #5', order: 0, metadataSource: 'METRON', cvIssueId: 8123 },
        ]);
    });

    it('reads a case-insensitive provider-id column for an unlinked row', async () => {
        mocks.issueFindMany.mockResolvedValue([]);
        const csv = 'Series,Issue,ComicVine ID\nWolverine,5,91391\nDazzler,1,6002\n';

        await importCsv(csvReq(csv));
        expect(rows()).toEqual([
            { listId: 'list_x', issueId: null, title: 'Wolverine #5', order: 0, metadataSource: 'COMICVINE', cvIssueId: 91391 },
            { listId: 'list_x', issueId: null, title: 'Dazzler #1', order: 1, metadataSource: 'COMICVINE', cvIssueId: 6002 },
        ]);
    });

    it('rejects an unparseable id rather than storing it', async () => {
        mocks.issueFindMany.mockResolvedValue([]);
        // A ComicVine VOLUME id, and a value that is not an id at all.
        const csv = 'Series,Issue,ComicVine ID\nBatman,1,4050-23079\nDazzler,1,n/a\n';

        await importCsv(csvReq(csv));
        expect(rows()).toEqual([
            { listId: 'list_x', issueId: null, title: 'Batman #1', order: 0 },
            { listId: 'list_x', issueId: null, title: 'Dazzler #1', order: 1 },
        ]);
    });

    it('honours a Metron column and never guesses a namespace for a bare "issue id"', async () => {
        mocks.issueFindMany.mockResolvedValue([]);
        const csv = 'Series,Issue,Metron Id\nWolverine,5,91391\n';

        await importCsv(csvReq(csv));
        expect(rows()).toEqual([
            { listId: 'list_x', issueId: null, title: 'Wolverine #5', order: 0, metadataSource: 'METRON', cvIssueId: 91391 },
        ]);

        mocks.issueFindMany.mockResolvedValue([]);
        mocks.readingListItemCreateMany.mockClear();
        await importCsv(csvReq('Series,Issue,Issue Id\nWolverine,5,91391\n'));
        expect(rows()).toEqual([{ listId: 'list_x', issueId: null, title: 'Wolverine #5', order: 0 }]);
    });

    it('a CSV with NO provider-id column still imports unchanged', async () => {
        mocks.issueFindMany.mockResolvedValue([
            { id: 'iss_141', seriesId: 's_xmen', number: '141', metadataSource: 'COMICVINE', metadataId: null },
        ]);
        const csv = 'Series,Issue\nX-Men,141\nWolverine,5\n';

        const res = await importCsv(csvReq(csv));
        expect((await res.json()).success).toBe(true);
        expect(rows()).toEqual([
            { listId: 'list_x', issueId: 'iss_141', title: 'X-Men #141', order: 0 },
            { listId: 'list_x', issueId: null, title: 'Wolverine #5', order: 1 },
        ]);
    });
});