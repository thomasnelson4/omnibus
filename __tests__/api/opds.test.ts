import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/opds/route';
import * as apiAuth from '@/lib/api-auth';

// 1. Mock the API Auth module
vi.mock('@/lib/api-auth', () => ({
    validateApiKey: vi.fn()
}));

// 2. The root feed's <updated> (#218) is the newest Series.updatedAt the caller may see, so the DB
// and the per-library access chokepoint need mocking.
const mocks = vi.hoisted(() => ({ newestSeries: vi.fn(), libraryCount: vi.fn() }));
vi.mock('@/lib/db', () => ({
    prisma: { series: { findFirst: mocks.newestSeries }, library: { count: mocks.libraryCount } },
}));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryIds: vi.fn(async () => 'ALL'),
    seriesAccessWhere: vi.fn(() => ({})),
}));

const SERIES_UPDATED = new Date('2026-09-29T00:41:35.117Z');

/** `validateApiKey`'s success shape, without standing up a whole Prisma User row. */
const authorized = {
    valid: true,
    user: { username: 'TestUser', role: 'USER' },
    keyType: 'OPDS_KEY',
} as unknown as Awaited<ReturnType<typeof apiAuth.validateApiKey>>;

describe('API Route: OPDS Root Catalog', () => {
    beforeEach(() => {
        mocks.newestSeries.mockResolvedValue({ updatedAt: SERIES_UPDATED });
        mocks.libraryCount.mockResolvedValue(1);
    });

    it('should reject unauthorized requests with a 401 and Basic Auth challenge', async () => {
        // Simulate a bad API key
        vi.mocked(apiAuth.validateApiKey).mockResolvedValueOnce({ valid: false, user: null, keyType: null });
        
        const req = new Request('http://localhost/api/opds');
        const res = await GET(req) as Response;
        
        expect(res.status).toBe(401);
        
        // This specific header is REQUIRED to trigger the password prompt in external apps like Panels or Chunky!
        expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Omnibus OPDS"');
    });

    it('should return valid Atom XML for an authorized user', async () => {
        // Simulate a valid API key
        vi.mocked(apiAuth.validateApiKey).mockResolvedValueOnce({ 
            valid: true, 
            user: { username: 'TestUser', role: 'USER' }, 
            keyType: 'OPDS_KEY' 
        } as any);

        const req = new Request('http://localhost/api/opds');
        const res = await GET(req) as Response;

        expect(res.status).toBe(200);
        
        // Ensure the content type is correct for OPDS clients
        expect(res.headers.get('Content-Type')).toContain('application/atom+xml');
        
        // Ensure the XML feed generates properly
        const xml = await res.text();
        expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
        expect(xml).toContain('<title>Omnibus Catalog</title>');
        expect(xml).toContain('urn:omnibus:root');
    });

    // #218: the response's own Content-Type must carry the OPDS kind, and the feed's <updated> must be
    // a real, stable timestamp — "now" moved on every fetch of an unchanged catalog and told a
    // syncing client nothing.
    it('declares kind=navigation and stamps a stable <updated> from the catalog', async () => {
        vi.mocked(apiAuth.validateApiKey).mockResolvedValue(authorized);

        const first = await GET(new Request('http://localhost/api/opds')) as Response;
        const xml = await first.text();
        const second = await GET(new Request('http://localhost/api/opds')) as Response;

        expect(first.headers.get('Content-Type'))
            .toBe('application/atom+xml;profile=opds-catalog;kind=navigation; charset=utf-8');
        expect(xml).toContain(`<updated>${SERIES_UPDATED.toISOString()}</updated>`);
        expect(await second.text()).toBe(xml);
    });

    // #221 point 1: a client only offers a search box when the root advertises the OpenSearch
    // description document.
    it('advertises search and the home-screen sections', async () => {
        vi.mocked(apiAuth.validateApiKey).mockResolvedValue(authorized);
        const xml = await (await GET(new Request('http://localhost/api/opds')) as Response).text();

        expect(xml).toMatch(/<link rel="search" type="application\/opensearchdescription\+xml" href="[^"]*\/api\/opds\/opensearch" title="Search Omnibus"\/>/);
        expect(xml).toContain('<title>Continue Reading</title>');
        expect(xml).toContain('<title>Recently Added</title>');
        expect(xml).toContain('<title>On Deck</title>');
        expect(xml).toMatch(/href="[^"]*\/api\/opds\/sections\/continue"/);
        expect(xml).toMatch(/href="[^"]*\/api\/opds\/sections\/recent"/);
        expect(xml).toMatch(/href="[^"]*\/api\/opds\/sections\/ondeck"/);
    });

    // #221 point 2: "Libraries" is only worth showing when there is more than one to choose between.
    it('shows the Libraries entry only when the caller can see more than one library', async () => {
        vi.mocked(apiAuth.validateApiKey).mockResolvedValue(authorized);

        const single = await (await GET(new Request('http://localhost/api/opds')) as Response).text();
        expect(single).not.toContain('<title>Libraries</title>');

        mocks.libraryCount.mockResolvedValue(3);
        const many = await (await GET(new Request('http://localhost/api/opds')) as Response).text();
        expect(many).toContain('<title>Libraries</title>');
        expect(many).toMatch(/href="[^"]*\/api\/opds\/sections\/libraries"/);
    });

    // Continue Reading, Recently Added and On Deck lead to acquisition feeds — their entries are
    // publications — so their subsection link has to say `kind=acquisition`; Libraries leads to
    // another navigation feed and All Series stays navigation.
    it('declares each entry\'s own kind on its subsection link', async () => {
        vi.mocked(apiAuth.validateApiKey).mockResolvedValue(authorized);
        mocks.libraryCount.mockResolvedValue(3);

        const xml = await (await GET(new Request('http://localhost/api/opds')) as Response).text();
        const kindOf = (path: string) =>
            xml.match(new RegExp(`href="[^"]*/api/opds/${path}" type="([^"]+)"`))?.[1];

        expect(kindOf('sections/continue')).toBe('application/atom+xml;profile=opds-catalog;kind=acquisition');
        expect(kindOf('sections/recent')).toBe('application/atom+xml;profile=opds-catalog;kind=acquisition');
        expect(kindOf('sections/ondeck')).toBe('application/atom+xml;profile=opds-catalog;kind=acquisition');
        expect(kindOf('sections/libraries')).toBe('application/atom+xml;profile=opds-catalog;kind=navigation');
        expect(kindOf('series')).toBe('application/atom+xml;profile=opds-catalog;kind=navigation');
    });
});