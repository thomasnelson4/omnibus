// __tests__/api/opds-covers.test.ts
//
// OPDS clients authenticate with an OPDS key (Basic or ?apiKey=), never a web session. The feeds used
// to link every non-remote cover as `/api/library/cover?path=…`, which the middleware answers with a
// 401 for a client without a session cookie — so custom and local covers were broken in every OPDS
// client, and the links exposed server folder paths. Covers now go through API-key routes under
// /api/opds/cover that hand off to the cover route in-process (the Komga facade's approach, #206),
// with a real thumbnail width for image/thumbnail (#221).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as getSeriesCover } from '@/app/api/opds/cover/series/[id]/route';
import { GET as getIssueCover } from '@/app/api/opds/cover/issue/[id]/route';
import { GET as getSeriesFeed } from '@/app/api/opds/series/route';
import { GET as getSeriesDetailFeed } from '@/app/api/opds/series/[id]/route';

const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    seriesFindUnique: vi.fn(),
    seriesFindMany: vi.fn(),
    issueFindUnique: vi.fn(),
    issueUpdate: vi.fn(),
    readProgress: vi.fn().mockResolvedValue([]),
    canAccessLibraryId: vi.fn(),
    coverGet: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findUnique: mocks.seriesFindUnique, findMany: mocks.seriesFindMany },
        issue: { findUnique: mocks.issueFindUnique, update: mocks.issueUpdate },
        readProgress: { findMany: mocks.readProgress },
    },
}));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryIds: vi.fn().mockResolvedValue('ALL'),
    canAccessLibraryId: mocks.canAccessLibraryId,
    seriesAccessWhere: vi.fn().mockReturnValue({}),
}));
vi.mock('@/app/api/library/cover/route', () => ({ GET: mocks.coverGet }));
vi.mock('@/lib/utils/archive-pages', () => ({
    countArchivePages: vi.fn().mockResolvedValue(0),
    countArchivePagesViaEngine: vi.fn().mockResolvedValue(0),
    isPageCountable: () => false,
    isEngineCountable: () => false,
}));

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const delegated = () => new URL(mocks.coverGet.mock.calls[0][0].url);

beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', role: 'USER' }, keyType: 'OPDS_KEY' });
    mocks.canAccessLibraryId.mockReturnValue(true);
    mocks.coverGet.mockResolvedValue(new Response('cover-bytes', { headers: { 'Content-Type': 'image/webp' } }));
    mocks.issueUpdate.mockResolvedValue({});
});

describe('GET /api/opds/cover/series/[id]', () => {
    const req = (query = '') => new Request(`http://localhost/api/opds/cover/series/ser_1${query}`);

    it('challenges a client without a valid OPDS key and never reaches the cover route', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: false, user: null, keyType: null });
        const res = await getSeriesCover(req(), params('ser_1'));
        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Omnibus OPDS"');
        expect(mocks.coverGet).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown series and 403 for a library the user cannot see', async () => {
        mocks.seriesFindUnique.mockResolvedValue(null);
        expect((await getSeriesCover(req(), params('nope'))).status).toBe(404);

        mocks.seriesFindUnique.mockResolvedValue({ id: 'ser_1', libraryId: 'lib_2', folderPath: '/comics/X', coverUrl: null });
        mocks.canAccessLibraryId.mockReturnValue(false);
        expect((await getSeriesCover(req(), params('ser_1'))).status).toBe(403);
        expect(mocks.coverGet).not.toHaveBeenCalled();
    });

    it('serves a local cover through the cover route at the full 1024px width by default', async () => {
        mocks.seriesFindUnique.mockResolvedValue({
            id: 'ser_1', libraryId: 'lib_1', folderPath: '/comics/Batman (2016)',
            coverUrl: '/api/library/cover?path=%2Fcomics%2FBatman%20(2016)%2Fcover.jpg&v=3',
        });
        const res = await getSeriesCover(req(), params('ser_1'));
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('cover-bytes');
        expect(delegated().pathname).toBe('/api/library/cover');
        expect(delegated().searchParams.get('path')).toBe('/comics/Batman (2016)/cover.jpg');
        expect(delegated().searchParams.get('w')).toBe('1024');
    });

    it('honours an allowed ?w= and falls back to 1024 for anything else', async () => {
        mocks.seriesFindUnique.mockResolvedValue({ id: 'ser_1', libraryId: 'lib_1', folderPath: '/comics/X', coverUrl: null });
        await getSeriesCover(req('?w=320'), params('ser_1'));
        expect(delegated().searchParams.get('w')).toBe('320');

        mocks.coverGet.mockClear();
        await getSeriesCover(req('?w=999'), params('ser_1'));
        expect(delegated().searchParams.get('w')).toBe('1024');
    });

    it('falls back to the series folder, and passes provider art through the cover route', async () => {
        mocks.seriesFindUnique.mockResolvedValue({ id: 'ser_1', libraryId: 'lib_1', folderPath: '/comics/X', coverUrl: null });
        await getSeriesCover(req(), params('ser_1'));
        expect(delegated().searchParams.get('path')).toBe('/comics/X');

        mocks.coverGet.mockClear();
        mocks.seriesFindUnique.mockResolvedValue({ id: 'ser_1', libraryId: 'lib_1', folderPath: '/comics/X', coverUrl: 'https://comicvine.gamespot.com/a/cover.jpg' });
        await getSeriesCover(req(), params('ser_1'));
        expect(delegated().searchParams.get('path')).toBe('https://comicvine.gamespot.com/a/cover.jpg');
    });

    it('answers 404 when the series has neither a cover nor a folder', async () => {
        mocks.seriesFindUnique.mockResolvedValue({ id: 'ser_1', libraryId: 'lib_1', folderPath: '', coverUrl: null });
        expect((await getSeriesCover(req(), params('ser_1'))).status).toBe(404);
        expect(mocks.coverGet).not.toHaveBeenCalled();
    });
});

describe('GET /api/opds/cover/issue/[id]', () => {
    const req = (query = '') => new Request(`http://localhost/api/opds/cover/issue/iss_1${query}`);

    it('renders the issue\'s first page when it has no cover of its own, else uses its cover', async () => {
        mocks.issueFindUnique.mockResolvedValue({ id: 'iss_1', coverUrl: null, series: { libraryId: 'lib_1' } });
        await getIssueCover(req(), params('iss_1'));
        expect(delegated().searchParams.get('issueId')).toBe('iss_1');
        expect(delegated().searchParams.get('path')).toBeNull();

        mocks.coverGet.mockClear();
        mocks.issueFindUnique.mockResolvedValue({ id: 'iss_1', coverUrl: 'https://comicvine.gamespot.com/a/1.jpg', series: { libraryId: 'lib_1' } });
        await getIssueCover(req('?w=320'), params('iss_1'));
        expect(delegated().searchParams.get('path')).toBe('https://comicvine.gamespot.com/a/1.jpg');
        expect(delegated().searchParams.get('w')).toBe('320');
    });

    it('answers 401 without a key, 404 for an unknown issue and 403 outside the user\'s libraries', async () => {
        mocks.validateApiKey.mockResolvedValueOnce({ valid: false, user: null, keyType: null });
        expect((await getIssueCover(req(), params('iss_1'))).status).toBe(401);

        mocks.issueFindUnique.mockResolvedValue(null);
        expect((await getIssueCover(req(), params('nope'))).status).toBe(404);

        mocks.issueFindUnique.mockResolvedValue({ id: 'iss_1', coverUrl: null, series: { libraryId: 'lib_2' } });
        mocks.canAccessLibraryId.mockReturnValue(false);
        expect((await getIssueCover(req(), params('iss_1'))).status).toBe(403);
        expect(mocks.coverGet).not.toHaveBeenCalled();
    });
});

describe('OPDS feeds link covers through the OPDS cover routes', () => {
    const linksFor = (xml: string, rel: string) =>
        [...xml.matchAll(new RegExp(`<link rel="${rel.replace(/\//g, '\\/')}" href="([^"]+)" type="([^"]+)"`, 'g'))].map(m => ({ href: m[1], type: m[2] }));

    it('series list: image + real thumbnail from Omnibus, with no library route, folder path or provider host', async () => {
        mocks.seriesFindMany.mockResolvedValue([
            { id: 'ser_local', name: 'Local', publisher: 'Image', description: null, folderPath: '/comics/Image/Local (2020)', coverUrl: '/api/library/cover?path=%2Fcomics%2FImage%2FLocal%20(2020)%2Fcover.jpg' },
            { id: 'ser_cv', name: 'Remote', publisher: 'DC', description: null, folderPath: '/comics/DC/Remote (2016)', coverUrl: 'https://comicvine.gamespot.com/a/cover.jpg' },
        ]);
        const xml = await (await getSeriesFeed(new Request('http://localhost/api/opds/series'))).text();

        const images = linksFor(xml, 'http://opds-spec.org/image');
        const thumbs = linksFor(xml, 'http://opds-spec.org/image/thumbnail');
        expect(images.map(l => l.href)).toEqual([
            expect.stringMatching(/\/api\/opds\/cover\/series\/ser_local$/),
            expect.stringMatching(/\/api\/opds\/cover\/series\/ser_cv$/),
        ]);
        expect(thumbs.map(l => l.href)).toEqual([
            expect.stringMatching(/\/api\/opds\/cover\/series\/ser_local\?w=320$/),
            expect.stringMatching(/\/api\/opds\/cover\/series\/ser_cv\?w=320$/),
        ]);
        expect([...images, ...thumbs].every(l => l.type === 'image/webp')).toBe(true);
        expect(xml).not.toContain('/api/library/cover');
        expect(xml).not.toContain('/comics/');
        expect(xml).not.toContain('comicvine');
    });

    it('series list: a series with no cover and no folder gets no image links', async () => {
        mocks.seriesFindMany.mockResolvedValue([
            { id: 'ser_bare', name: 'Bare', publisher: null, description: null, folderPath: '', coverUrl: null },
        ]);
        const xml = await (await getSeriesFeed(new Request('http://localhost/api/opds/series'))).text();
        expect(xml).not.toContain('opds-spec.org/image');
    });

    it('series detail: every issue links its own cover route, never the series folder or a provider URL', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', role: 'ADMIN' }, keyType: 'OPDS_KEY' });
        mocks.seriesFindUnique.mockResolvedValue({
            id: 'ser_1', name: 'Batman', publisher: 'DC Comics', folderPath: '/comics/DC Comics/Batman (2016)', libraryId: 'lib_1',
            coverUrl: '/api/library/cover?path=%2Fcomics%2FDC%20Comics%2FBatman%20(2016)%2Fcover.jpg',
            issues: [
                { id: 'iss_1', number: '1', name: 'Batman #1', filePath: '/comics/DC Comics/Batman (2016)/Batman 001.cbz', pageCount: 22, coverUrl: null, description: null },
                { id: 'iss_2', number: '2', name: 'Batman #2', filePath: '/comics/DC Comics/Batman (2016)/Batman 002.cbz', pageCount: 22, coverUrl: 'https://comicvine.gamespot.com/a/2.jpg', description: null },
            ],
        });
        const xml = await (await getSeriesDetailFeed(new Request('http://localhost/api/opds/series/ser_1'), params('ser_1'))).text();

        expect(linksFor(xml, 'http://opds-spec.org/image').map(l => l.href)).toEqual([
            expect.stringMatching(/\/api\/opds\/cover\/issue\/iss_1$/),
            expect.stringMatching(/\/api\/opds\/cover\/issue\/iss_2$/),
        ]);
        expect(linksFor(xml, 'http://opds-spec.org/image/thumbnail').map(l => l.href)).toEqual([
            expect.stringMatching(/\/api\/opds\/cover\/issue\/iss_1\?w=320$/),
            expect.stringMatching(/\/api\/opds\/cover\/issue\/iss_2\?w=320$/),
        ]);
        expect(xml).not.toContain('/api/library/cover');
        expect(xml).not.toContain('comicvine');
    });
});
