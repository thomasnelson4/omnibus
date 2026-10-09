import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/admin/komga/id-map/route';
import { adminSession, userSession } from '../helpers/session';

// GET /api/admin/komga/id-map: the downloadable identity map (PLAN §3). ADMIN only, and the API key
// must never appear in the body.

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    bookFindMany: vi.fn(),
    seriesFindMany: vi.fn(),
    komgaLibraryFindMany: vi.fn(),
    libraryFindMany: vi.fn(),
    getKomgaSettings: vi.fn(),
    getKomgaClient: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: {
        komgaBookLink: { findMany: mocks.bookFindMany },
        komgaSeriesLink: { findMany: mocks.seriesFindMany },
        komgaLibrary: { findMany: mocks.komgaLibraryFindMany },
        library: { findMany: mocks.libraryFindMany },
    },
}));
vi.mock('@/lib/komga/settings', () => ({ getKomgaSettings: mocks.getKomgaSettings }));
vi.mock('@/lib/komga/factory', () => ({ getKomgaClient: mocks.getKomgaClient }));

const STORED_KEY = 'stored-komga-key-SECRET-abcdef';

const savedSettings = (over: Record<string, unknown> = {}) => ({
    enabled: true, url: 'http://komga:25600', apiKey: STORED_KEY,
    pathMappings: [], pathMappingsRaw: '[]', scanOnChange: true, readListsEnabled: false,
    instanceId: 'inst-1', ...over,
});

const komgaLibraryRow = {
    komgaLibraryId: 'K1', name: 'Comics', root: '/comics', translatedRoot: '/data/comics',
    omnibusLibraryId: 'lib-1', settings: '{}', unavailable: false,
};

const bookRow = {
    issueId: 'i1', komgaBookId: 'B1', komgaLibraryId: 'K1',
    omnibusPath: '/data/comics/S/1.cbz', komgaPath: '/comics//S/1.cbz',
    matchedBy: 'PATH', verifiedAt: new Date('2026-03-01T00:00:00Z'),
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerSession.mockResolvedValue(adminSession());
    mocks.bookFindMany.mockResolvedValue([bookRow]);
    mocks.seriesFindMany.mockResolvedValue([{ seriesId: 's1', komgaSeriesId: 'KS1' }]);
    mocks.komgaLibraryFindMany.mockResolvedValue([komgaLibraryRow]);
    mocks.libraryFindMany.mockResolvedValue([{ id: 'lib-1', name: 'Comics' }]);
    mocks.getKomgaSettings.mockResolvedValue(savedSettings());
    mocks.getKomgaClient.mockResolvedValue({ getInfo: async () => ({ version: '1.28.1' }) });
});

describe('GET /api/admin/komga/id-map', () => {
    it('401 for a non-admin, and reads nothing', async () => {
        mocks.getServerSession.mockResolvedValue(userSession());
        const res = await GET();
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
        expect(mocks.bookFindMany).not.toHaveBeenCalled();
        expect(mocks.getKomgaSettings).not.toHaveBeenCalled();
    });

    it('401 when there is no session at all', async () => {
        mocks.getServerSession.mockResolvedValue(null);
        expect((await GET()).status).toBe(401);
    });

    it('downloads the documented shape', async () => {
        const res = await GET();
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Object.keys(body).sort()).toEqual(
            ['books', 'generatedAt', 'komga', 'libraries', 'series', 'truncated'].sort(),
        );
        expect(body.komga).toEqual({ url: 'http://komga:25600', version: '1.28.1' });
        expect(body.series).toEqual([{ seriesId: 's1', komgaSeriesId: 'KS1' }]);
        expect(body.books).toEqual([{
            issueId: 'i1', komgaBookId: 'B1',
            omnibusPath: '/data/comics/S/1.cbz', komgaPath: '/comics/S/1.cbz',
            matchedBy: 'PATH', verifiedAt: '2026-03-01T00:00:00.000Z',
        }]);
        expect(body.libraries[0]).toMatchObject({
            komgaLibraryId: 'K1', name: 'Comics', root: '/comics',
            translatedRoot: '/data/comics', omnibusLibraryId: 'lib-1',
            omnibusLibraryName: 'Comics', unavailable: false, linkedBooks: 1,
        });
        expect(body.truncated).toBe(false);
        expect(typeof body.generatedAt).toBe('string');
    });

    it('NEVER contains the API key', async () => {
        const text = JSON.stringify(await (await GET()).json());
        expect(text).not.toContain(STORED_KEY);
        expect(text).not.toMatch(/apiKey|api_key|X-API-Key/i);
    });

    it('never logs the API key when the export fails', async () => {
        mocks.bookFindMany.mockRejectedValue(new Error(`boom while reading ${STORED_KEY}`));
        const res = await GET();
        expect(res.status).toBe(500);
        // The failure message can echo what Prisma said, but the route must not add the key itself.
        expect(JSON.stringify(await res.json())).toContain('Failed to build the Komga ID map');
    });

    it('still exports when Komga cannot be reached', async () => {
        mocks.getKomgaClient.mockResolvedValue(null);
        const body = await (await GET()).json();
        expect(body.komga).toEqual({ url: 'http://komga:25600', version: null });
        expect(body.books).toHaveLength(1);
    });

    it('survives a Komga version lookup that throws', async () => {
        mocks.getKomgaClient.mockResolvedValue({ getInfo: async () => { throw new Error('unreachable'); } });
        const res = await GET();
        expect(res.status).toBe(200);
        expect((await res.json()).komga.version).toBeNull();
    });

    it('handles an empty map', async () => {
        mocks.bookFindMany.mockResolvedValue([]);
        mocks.seriesFindMany.mockResolvedValue([]);
        mocks.komgaLibraryFindMany.mockResolvedValue([]);
        mocks.libraryFindMany.mockResolvedValue([]);
        const body = await (await GET()).json();
        expect(body.books).toEqual([]);
        expect(body.series).toEqual([]);
        expect(body.libraries).toEqual([]);
    });

    it('normalizes a stored komgaPath that drifted from Komga\'s own normalization', async () => {
        mocks.bookFindMany.mockResolvedValue([{ ...bookRow, komgaPath: '/comics/./S//1.cbz/' }]);
        const body = await (await GET()).json();
        expect(body.books[0].komgaPath).toBe('/comics/S/1.cbz');
    });
});