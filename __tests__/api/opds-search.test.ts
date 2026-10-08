// __tests__/api/opds-search.test.ts
//
// #221 point 1: search. The root advertises an OpenSearch description document, and the search feed
// answers matching series first (as navigation entries) then matching issues (as acquisition ones).
// The library grants are the first clause of both queries, so a search term can never widen what a
// key may see.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as search } from '@/app/api/opds/search/route';
import { GET as opensearch } from '@/app/api/opds/opensearch/route';

const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    seriesFindMany: vi.fn(),
    issueFindMany: vi.fn(),
    readProgress: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findMany: mocks.seriesFindMany },
        issue: { findMany: mocks.issueFindMany },
        readProgress: { findMany: mocks.readProgress },
    },
}));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryIds: vi.fn(async () => ['lib_1']),
    seriesAccessWhere: vi.fn(() => ({ libraryId: { in: ['lib_1'] } })),
    nestedSeriesAccessWhere: vi.fn(() => ({ series: { libraryId: { in: ['lib_1'] } } })),
}));

const searchReq = (q: string) => new Request(`http://localhost/api/opds/search?q=${encodeURIComponent(q)}`);
const whereOf = (mock: { mock: { calls: unknown[][] } }) =>
    JSON.stringify((mock.mock.calls[0]?.[0] as { where?: unknown })?.where ?? '');

const issueRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'iss_1', seriesId: 'ser_1', number: '1', name: 'Chapter One', isAnnual: false, description: null,
    filePath: '/comics/Saga/Saga 001.cbz', pageCount: 22, writers: null, artists: null,
    releaseDate: null, updatedAt: new Date('2026-09-02T00:00:00Z'),
    series: { id: 'ser_1', name: 'Saga', publisher: 'Image', writers: '["Brian K. Vaughan"]', artists: null },
    ...overrides,
});

describe('GET /api/opds/search', () => {
    beforeEach(() => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', role: 'USER' }, keyType: 'OPDS_KEY' });
        mocks.readProgress.mockResolvedValue([]);
    });

    it('challenges a client without a valid OPDS key', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: false, user: null, keyType: null });

        const res = await search(searchReq('saga'));

        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Omnibus OPDS"');
        expect(mocks.seriesFindMany).not.toHaveBeenCalled();
    });

    it('answers matching series as navigation entries, then matching issues as acquisition entries', async () => {
        mocks.seriesFindMany.mockResolvedValue([
            {
                id: 'ser_1', name: 'Saga', publisher: 'Image', description: null, folderPath: '/comics/Saga',
                coverUrl: null, writers: '["Brian K. Vaughan"]', artists: null, updatedAt: new Date('2026-09-01T00:00:00Z'),
            },
        ]);
        mocks.issueFindMany.mockResolvedValue([issueRow()]);

        const res = await search(searchReq('saga'));
        const xml = await res.text();

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type'))
            .toBe('application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8');
        expect(xml).toContain('<title>Search: saga</title>');
        // The series comes first, with a subsection link into its own feed.
        expect(xml.indexOf('<title>Saga</title>')).toBeGreaterThan(-1);
        expect(xml.indexOf('<title>Saga</title>')).toBeLessThan(xml.indexOf('<title>Saga #1 - Chapter One</title>'));
        expect(xml).toMatch(/rel="subsection" href="[^"]*\/api\/opds\/series\/ser_1"/);
        expect(xml).toMatch(/rel="http:\/\/opds-spec\.org\/acquisition" href="[^"]*\/api\/opds\/download\?issueId=iss_1" type="application\/vnd\.comicbook\+zip"/);
        expect(xml).toContain('<author><name>Brian K. Vaughan</name></author>');
    });

    it('keeps the library grants as the first clause of both queries', async () => {
        mocks.seriesFindMany.mockResolvedValue([]);
        mocks.issueFindMany.mockResolvedValue([]);

        await search(searchReq('saga'));

        expect(whereOf(mocks.seriesFindMany)).toContain('lib_1');
        expect(whereOf(mocks.issueFindMany)).toContain('lib_1');
        // The term is ANDed with the grants, never instead of them.
        expect(whereOf(mocks.seriesFindMany)).toContain('saga');
    });

    // `number` is a string column, so the query's own order puts #10 before #2. The feed is a reading
    // list: it goes back through the series' comparator (the run by number, annuals after it).
    it('orders matched issues in reading order, not by the number string', async () => {
        mocks.seriesFindMany.mockResolvedValue([]);
        mocks.issueFindMany.mockResolvedValue([
            issueRow({ id: 'iss_10', number: '10', name: null }),
            issueRow({ id: 'iss_2', number: '2', name: null }),
            issueRow({ id: 'iss_annual', number: '1', name: null, isAnnual: true }),
        ]);

        const xml = await (await search(searchReq('saga'))).text();

        const at = (title: string) => xml.indexOf(`<title>${title}</title>`);
        expect(at('Saga #2')).toBeGreaterThan(-1);
        expect(at('Saga #2')).toBeLessThan(at('Saga #10'));
        expect(at('Saga #10')).toBeLessThan(at('Saga Annual #1'));
    });

    it('carries the caller\'s own position in a matched issue, like the other issue feeds', async () => {
        mocks.seriesFindMany.mockResolvedValue([]);
        mocks.issueFindMany.mockResolvedValue([issueRow()]);
        mocks.readProgress.mockResolvedValue([
            { issueId: 'iss_1', currentPage: 6, isCompleted: false, updatedAt: new Date('2026-09-27T21:10:00.000Z') },
        ]);

        const xml = await (await search(searchReq('saga'))).text();

        expect(mocks.readProgress).toHaveBeenCalledWith({
            where: { userId: 'u1', issueId: { in: ['iss_1'] } },
            select: { issueId: true, currentPage: true, isCompleted: true, updatedAt: true },
        });
        expect(xml).toContain('pse:lastRead="7" pse:lastReadDate="2026-09-27T21:10:00.000Z"');
    });

    it('answers an empty feed (not an error) when no terms are given', async () => {
        const res = await search(new Request('http://localhost/api/opds/search'));

        expect(res.status).toBe(200);
        expect(mocks.seriesFindMany).not.toHaveBeenCalled();
        const xml = await res.text();
        expect(xml).not.toContain('<entry>');
        expect(xml).toContain('rel="search" type="application/opensearchdescription+xml"');
    });
});

describe('GET /api/opds/opensearch', () => {
    beforeEach(() => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', role: 'USER' }, keyType: 'OPDS_KEY' });
    });

    it('describes the search template a client substitutes {searchTerms} into', async () => {
        const res = await opensearch(new Request('http://localhost/api/opds/opensearch'));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/opensearchdescription+xml; charset=utf-8');
        const xml = await res.text();
        expect(xml).toContain('<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">');
        expect(xml).toMatch(/template="[^"]*\/api\/opds\/search\?q=\{searchTerms\}"/);
    });

    it('challenges a client without a valid OPDS key', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: false, user: null, keyType: null });

        expect((await opensearch(new Request('http://localhost/api/opds/opensearch'))).status).toBe(401);
    });
});
