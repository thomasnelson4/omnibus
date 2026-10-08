// __tests__/api/opds-sections.test.ts
//
// #221 point 2: the root's sections — continue | recent | ondeck | libraries. Continue Reading and
// On Deck reuse the Komga facade's loaders; Recently Added reads Issue.fileAddedAt (a download that
// fills a monitored placeholder keeps the skeleton's older createdAt); Libraries lists what the
// caller may browse, each entry linking into `?library=<id>`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/opds/sections/[name]/route';

const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    issueFindMany: vi.fn(),
    libraryFindMany: vi.fn(),
    seriesGroupBy: vi.fn(),
    readProgress: vi.fn(),
    inProgressBooks: vi.fn(),
    onDeckBooks: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findMany: mocks.issueFindMany },
        library: { findMany: mocks.libraryFindMany },
        series: { groupBy: mocks.seriesGroupBy },
        readProgress: { findMany: mocks.readProgress },
    },
}));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryIds: vi.fn(async () => 'ALL'),
    seriesAccessWhere: vi.fn(() => ({})),
    nestedSeriesAccessWhere: vi.fn(() => ({})),
}));
vi.mock('@/lib/komga/data', () => ({
    inProgressBooks: mocks.inProgressBooks,
    onDeckBooks: mocks.onDeckBooks,
}));

const get = (name: string) =>
    GET(new Request(`http://localhost/api/opds/sections/${name}`), { params: Promise.resolve({ name }) });

/** The `<series>` relation each row carries, so an entry can be composed from it. */
const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'iss_1', number: '1', name: 'Chapter One', isAnnual: false, description: null,
    filePath: '/comics/Saga/Saga 001.cbz', pageCount: 22, writers: null, artists: null,
    updatedAt: new Date('2026-09-02T00:00:00Z'),
    series: { id: 'ser_1', name: 'Saga', publisher: 'Image', writers: null, artists: null },
    ...overrides,
});

describe('GET /api/opds/sections/[name]', () => {
    beforeEach(() => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', role: 'USER' }, keyType: 'OPDS_KEY' });
        mocks.issueFindMany.mockResolvedValue([]);
        mocks.libraryFindMany.mockResolvedValue([]);
        mocks.seriesGroupBy.mockResolvedValue([]);
        mocks.readProgress.mockResolvedValue([]);
        mocks.inProgressBooks.mockResolvedValue({ content: [] });
        mocks.onDeckBooks.mockResolvedValue({ content: [] });
    });

    it('challenges a client without a valid OPDS key and 404s an unknown section', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: false, user: null, keyType: null });
        expect((await get('continue')).status).toBe(401);

        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', role: 'USER' }, keyType: 'OPDS_KEY' });
        expect((await get('nonsense')).status).toBe(404);
    });

    it('Continue Reading takes the facade\'s selection and re-reads those rows as acquisition entries', async () => {
        mocks.inProgressBooks.mockResolvedValue({ content: [{ id: 'iss_1' }] });
        mocks.issueFindMany.mockResolvedValue([row()]);

        const res = await get('continue');
        const xml = await res.text();

        expect(res.status).toBe(200);
        expect(mocks.inProgressBooks).toHaveBeenCalledWith('u1', 'ALL', 0, 20);
        expect(res.headers.get('Content-Type'))
            .toBe('application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8');
        expect(xml).toContain('<title>Continue Reading</title>');
        expect(xml).toContain('<title>Saga #1 - Chapter One</title>');
        expect(xml).toMatch(/rel="http:\/\/opds-spec\.org\/acquisition" href="[^"]*\/api\/opds\/download\?issueId=iss_1"/);
    });

    // #221: a page-streaming client resumes where this user stopped — including in the section that
    // exists for exactly that. currentPage is the app's 0-based index, so lastRead is 1-based.
    it('carries the caller\'s own progress as pse:lastRead on every section entry', async () => {
        mocks.inProgressBooks.mockResolvedValue({ content: [{ id: 'iss_1' }] });
        mocks.issueFindMany.mockResolvedValue([row()]);
        mocks.readProgress.mockResolvedValue([
            { issueId: 'iss_1', currentPage: 6, updatedAt: new Date('2026-09-27T21:10:00.000Z') },
        ]);

        const xml = await (await get('continue')).text();

        expect(mocks.readProgress).toHaveBeenCalledWith({
            where: { userId: 'u1', issueId: { in: ['iss_1'] } },
            select: { issueId: true, currentPage: true, isCompleted: true, updatedAt: true },
        });
        expect(xml).toContain('pse:lastRead="7" pse:lastReadDate="2026-09-27T21:10:00.000Z"');
    });

    it('On Deck uses the facade\'s loader, not the Continue Reading one', async () => {
        mocks.onDeckBooks.mockResolvedValue({ content: [{ id: 'iss_1' }] });
        mocks.issueFindMany.mockResolvedValue([row()]);

        const xml = await (await get('ondeck')).text();

        expect(mocks.onDeckBooks).toHaveBeenCalledWith('u1', 'ALL', 20);
        expect(mocks.inProgressBooks).not.toHaveBeenCalled();
        expect(xml).toContain('<title>On Deck</title>');
    });

    it('Recently Added ranks by fileAddedAt, which createdAt would miss', async () => {
        mocks.issueFindMany.mockResolvedValue([row()]);

        await get('recent');

        const args = mocks.issueFindMany.mock.calls[0][0] as { where: unknown; orderBy: unknown };
        expect(JSON.stringify(args.where)).toContain('fileAddedAt');
        expect(JSON.stringify(args.orderBy)).toContain('fileAddedAt');
    });

    it('Libraries is a navigation feed whose entries link into ?library=<id>', async () => {
        mocks.libraryFindMany.mockResolvedValue([
            { id: 'lib_1', name: 'Comics' },
            { id: 'lib_2', name: 'Mangas' },
        ]);
        mocks.seriesGroupBy.mockResolvedValue([
            { libraryId: 'lib_2', _max: { updatedAt: new Date('2026-09-20T00:00:00Z') } },
        ]);

        const res = await get('libraries');
        const xml = await res.text();

        expect(res.headers.get('Content-Type'))
            .toBe('application/atom+xml;profile=opds-catalog;kind=navigation; charset=utf-8');
        expect(xml).toContain('<title>Comics</title>');
        expect(xml).toContain('<title>Mangas</title>');
        expect(xml).toMatch(/rel="subsection" href="[^"]*\/api\/opds\/series\?library=lib_2"/);
        // A library's <updated> is its newest series': the moment it last changed.
        expect(xml).toContain('<updated>2026-09-20T00:00:00.000Z</updated>');
        expect(xml).toContain('<updated>1970-01-01T00:00:00.000Z</updated>');
    });
});
