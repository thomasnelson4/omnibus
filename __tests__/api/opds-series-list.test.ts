// __tests__/api/opds-series-list.test.ts
//
// The OPDS series list (a navigation feed listing series). #218: each series entry carries its
// creators as <author>, its publisher in <dc:publisher>, and a real <updated>; the response declares
// kind=navigation, and the link to each series' own feed — which is an acquisition feed — says so.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { XMLValidator } from 'fast-xml-parser';
import * as access from '@/lib/library-access';
import { GET } from '@/app/api/opds/series/route';

const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    seriesFindMany: vi.fn(),
    libraryFindUnique: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('@/lib/db', () => ({
    prisma: { series: { findMany: mocks.seriesFindMany }, library: { findUnique: mocks.libraryFindUnique } },
}));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryIds: vi.fn(async () => 'ALL'),
    canAccessLibraryId: vi.fn(() => true),
    seriesAccessWhere: vi.fn(() => ({})),
}));

const request = () => GET(new Request('http://localhost/api/opds/series'));

const EARLIER = new Date('2026-09-01T00:00:00.000Z');
const LATER = new Date('2026-09-25T08:30:00.000Z');

describe('API Route: OPDS Series List (/api/opds/series)', () => {
    beforeEach(() => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', role: 'USER' }, keyType: 'OPDS_KEY' });
        mocks.libraryFindUnique.mockResolvedValue({ name: 'Comics' });
    });

    it('is a navigation feed and links each series to its acquisition feed', async () => {
        mocks.seriesFindMany.mockResolvedValue([
            { id: 'ser_1', name: 'Batman', publisher: 'DC Comics', description: null, folderPath: '/comics/Batman', coverUrl: null, updatedAt: LATER },
        ]);

        const res = await request();

        expect(res.headers.get('Content-Type'))
            .toBe('application/atom+xml;profile=opds-catalog;kind=navigation; charset=utf-8');
        const xml = await res.text();
        expect(xml).toMatch(/<link rel="subsection" href="[^"]*\/api\/opds\/series\/ser_1" type="application\/atom\+xml;profile=opds-catalog;kind=acquisition"\/>/);
    });

    it('publishes the creators as authors, the publisher as dc:publisher and a real updated', async () => {
        mocks.seriesFindMany.mockResolvedValue([
            {
                id: 'ser_1', name: 'Batman', publisher: 'DC Comics', description: null,
                folderPath: '/comics/Batman', coverUrl: null, updatedAt: LATER,
                writers: '["Tom King"]', artists: '["Mikel Janín", "David Finch"]',
            },
        ]);

        const xml = await (await request()).text();

        expect(xml).toContain('<author><name>Tom King</name></author>');
        expect(xml).toContain('<author><name>Mikel Janín</name></author>');
        expect(xml).toContain('<author><name>David Finch</name></author>');
        expect(xml).toContain('<dc:publisher>DC Comics</dc:publisher>');
        expect(xml).not.toContain('<author><name>DC Comics</name></author>');
        expect(xml).toContain(`<updated>${LATER.toISOString()}</updated>`);
    });

    it('sets the feed <updated> to the newest entry, and falls back to a stable stamp when empty', async () => {
        mocks.seriesFindMany.mockResolvedValue([
            { id: 'ser_1', name: 'Batman', publisher: null, description: null, folderPath: '/comics/Batman', coverUrl: null, updatedAt: EARLIER },
            { id: 'ser_2', name: 'Saga', publisher: null, description: null, folderPath: '/comics/Saga', coverUrl: null, updatedAt: LATER },
        ]);

        const xml = await (await request()).text();
        const feedHead = xml.slice(xml.indexOf('<feed'), xml.indexOf('<entry'));
        expect(feedHead).toContain(`<updated>${LATER.toISOString()}</updated>`);

        mocks.seriesFindMany.mockResolvedValue([]);
        const empty = await (await request()).text();
        expect(empty).toContain('<updated>1970-01-01T00:00:00.000Z</updated>');
    });

    it('emits no <author> for a series without creators, but keeps the feed valid with its own', async () => {
        mocks.seriesFindMany.mockResolvedValue([
            { id: 'ser_1', name: 'Unknown', publisher: null, description: null, folderPath: '/comics/Unknown', coverUrl: null, updatedAt: LATER },
        ]);

        const xml = await (await request()).text();

        const entry = xml.slice(xml.indexOf('<entry>'), xml.indexOf('</entry>'));
        expect(entry).not.toContain('<author>');
        expect(xml).toContain('<author><name>Omnibus</name></author>');
    });

    // #221 point 2, "Libraries": the section links into one library, and that filter runs inside the
    // caller's grants — the web UI's library query has no access clause of its own.
    it('narrows to one library when ?library= is given', async () => {
        mocks.seriesFindMany.mockResolvedValue([]);

        const res = await GET(new Request('http://localhost/api/opds/series?library=lib_2'));
        const xml = await res.text();

        expect(res.status).toBe(200);
        const where = JSON.stringify((mocks.seriesFindMany.mock.calls[0][0] as { where: unknown }).where);
        expect(where).toContain('lib_2');
        expect(xml).toContain('<id>urn:omnibus:series:library:lib_2</id>');
        // A single library's list is titled with the library's own name, not the whole catalog's.
        expect(xml).toContain('<title>Comics</title>');
        // The pagination links keep the filter, so "next" cannot silently widen back to everything.
        expect(xml).toMatch(/href="[^"]*\/api\/opds\/series\?page=1&amp;library=lib_2"/);
        // ...and the second query parameter is why the href has to be escaped: a raw `&` in an
        // attribute is a fatal error for a strict XML parser, and OPDS clients are strict.
        expect(XMLValidator.validate(xml)).toBe(true);
    });

    it('escapes the library id it echoes, and ignores an empty one', async () => {
        mocks.seriesFindMany.mockResolvedValue([]);

        const injected = await (await GET(new Request(
            `http://localhost/api/opds/series?library=${encodeURIComponent('"><script>')}`
        ))).text();
        expect(injected).not.toContain('<script>');

        const blank = await (await GET(new Request('http://localhost/api/opds/series?library='))).text();
        expect(blank).toContain('<id>urn:omnibus:series</id>');
    });

    // The id comes from the request: a library the caller cannot see must not even have its name read
    // back out of the database.
    it('keeps the generic title, and never reads the name, for a library the caller cannot see', async () => {
        mocks.seriesFindMany.mockResolvedValue([]);
        vi.mocked(access.canAccessLibraryId).mockReturnValueOnce(false);

        const xml = await (await GET(new Request('http://localhost/api/opds/series?library=lib_secret'))).text();

        expect(mocks.libraryFindUnique).not.toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'lib_secret' } }),
        );
        expect(xml).toContain('<title>All Series</title>');
    });
});
