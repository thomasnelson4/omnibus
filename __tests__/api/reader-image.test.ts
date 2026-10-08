import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/reader/image/route';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    libraryFindMany: vi.fn(),
    fsExistsSync: vi.fn(),
    fsStatSync: vi.fn(),
    fsReadFileSync: vi.fn(),
    fsUtimesSync: vi.fn(),
    fsMkdirSync: vi.fn(),
    fsReaddirSync: vi.fn().mockReturnValue([]),
    fsUnlinkSync: vi.fn(),
    // async fs.promises used on the request hot path
    fsPromisesStat: vi.fn(),
    fsPromisesReadFile: vi.fn(),
    fsPromisesUtimes: vi.fn().mockResolvedValue(true),
    // global fetch (engine page offload)
    fetch: vi.fn(),
    // Engine-down fallback: one page read from the zip's index (lib/utils/archive-pages).
    readArchivePage: vi.fn(),
    sharpResize: vi.fn().mockReturnThis(),
    sharpWebp: vi.fn().mockReturnThis(),
    sharpTrim: vi.fn().mockReturnThis(),
    sharpToBuffer: vi.fn().mockResolvedValue(Buffer.from('fake_image_data')),
    log: vi.fn(),
    mockSession: { user: { id: 'user_1', role: 'ADMIN' } } // Hoisted Auth
}));

vi.mock('@/lib/db', () => ({
    prisma: { library: { findMany: mocks.libraryFindMany } }
}));

vi.mock('fs', () => ({
    existsSync: mocks.fsExistsSync,
    statSync: mocks.fsStatSync,
    readFileSync: mocks.fsReadFileSync,
    utimesSync: mocks.fsUtimesSync,
    mkdirSync: mocks.fsMkdirSync,
    readdirSync: mocks.fsReaddirSync,
    unlinkSync: mocks.fsUnlinkSync,
    promises: { writeFile: vi.fn().mockResolvedValue(true), rename: vi.fn().mockResolvedValue(true), mkdir: vi.fn().mockResolvedValue(true), unlink: vi.fn().mockResolvedValue(true), stat: mocks.fsPromisesStat, readFile: mocks.fsPromisesReadFile, utimes: mocks.fsPromisesUtimes },
    default: {
        existsSync: mocks.fsExistsSync,
        statSync: mocks.fsStatSync,
        readFileSync: mocks.fsReadFileSync,
        utimesSync: mocks.fsUtimesSync,
        mkdirSync: mocks.fsMkdirSync,
        readdirSync: mocks.fsReaddirSync,
        unlinkSync: mocks.fsUnlinkSync,
        promises: { writeFile: vi.fn().mockResolvedValue(true), rename: vi.fn().mockResolvedValue(true), mkdir: vi.fn().mockResolvedValue(true), unlink: vi.fn().mockResolvedValue(true), stat: mocks.fsPromisesStat, readFile: mocks.fsPromisesReadFile, utimes: mocks.fsPromisesUtimes }
    }
}));

vi.mock('fs/promises', () => ({
    writeFile: vi.fn().mockResolvedValue(true),
    rename: vi.fn().mockResolvedValue(true),
    mkdir: vi.fn().mockResolvedValue(true),
    unlink: vi.fn().mockResolvedValue(true),
    default: { writeFile: vi.fn().mockResolvedValue(true), rename: vi.fn().mockResolvedValue(true), mkdir: vi.fn().mockResolvedValue(true), unlink: vi.fn().mockResolvedValue(true) }
}));

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn().mockResolvedValue(mocks.mockSession) }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn().mockResolvedValue(mocks.mockSession) }));
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn().mockResolvedValue(mocks.mockSession.user) }));
vi.mock('@/lib/auth', () => ({ getAuthSession: vi.fn().mockResolvedValue(mocks.mockSession) }));

vi.mock('@/lib/utils/archive-pages', () => ({ readArchivePage: mocks.readArchivePage }));

vi.mock('sharp', () => {
    return {
        default: vi.fn(() => ({
            resize: mocks.sharpResize,
            webp: mocks.sharpWebp,
            trim: mocks.sharpTrim,
            toBuffer: mocks.sharpToBuffer
        }))
    };
});


describe('API Route: Reader Image Serving', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.libraryFindMany.mockResolvedValue([{ path: '/data/comics' }]);
        mocks.fsExistsSync.mockReturnValue(true);
        mocks.fsStatSync.mockReturnValue({ mtimeMs: 12345, size: 50000 });
        // Source-file stat (async) resolves so the route proceeds; utimes is best-effort.
        mocks.fsPromisesStat.mockResolvedValue({ mtimeMs: 12345, size: 50000 });
        mocks.fsPromisesUtimes.mockResolvedValue(true);
        // Default: engine offload unavailable → the route falls back to local sharp extraction.
        vi.stubGlobal('fetch', mocks.fetch);
        mocks.fetch.mockRejectedValue(new Error('engine unavailable'));
    });

    it('should reject unauthorized paths outside the library root', async () => {
        const req = new NextRequest('http://localhost/api/reader/image?path=/etc/passwd&page=page1.jpg');
        const res = await GET(req);
        
        expect(res.status).toBe(403);
        expect(await res.text()).toBe('Unauthorized path access');
    });

    it('should serve a cached webp image if it already exists on disk', async () => {
        // The async cache read resolves → cache hit, served without touching the zip.
        mocks.fsPromisesReadFile.mockResolvedValue(Buffer.from('cached_data'));

        const req = new NextRequest('http://localhost/api/reader/image?path=/data/comics/batman.cbz&page=page1.jpg');
        const res = await GET(req);

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/webp');
        expect(mocks.fsPromisesReadFile).toHaveBeenCalled();
        expect(mocks.readArchivePage).not.toHaveBeenCalled();
    });

    it('with the engine down, reads just the one page from the zip and converts it to webp', async () => {
        // Async cache read rejects with ENOENT → cache miss → fall through to extraction.
        mocks.fsPromisesReadFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        mocks.readArchivePage.mockResolvedValue(Buffer.from('raw_zip_data'));

        const req = new NextRequest('http://localhost/api/reader/image?path=/data/comics/batman.cbz&page=page1.jpg');
        const res = await GET(req);

        expect(res.status).toBe(200);
        expect(mocks.readArchivePage).toHaveBeenCalledWith('/data/comics/batman.cbz', 'page1.jpg');
        expect(mocks.sharpToBuffer).toHaveBeenCalled();
    });

    it('with the engine down, answers 404 for a page the zip does not have', async () => {
        mocks.fsPromisesReadFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        mocks.readArchivePage.mockResolvedValue(null);

        const res = await GET(new NextRequest('http://localhost/api/reader/image?path=/data/comics/batman.cbz&page=nope.jpg'));
        expect(res.status).toBe(404);
        expect(await res.text()).toBe('Page Not Found');
    });

    it('should serve engine-produced webp bytes (non-crop) without touching the local zip/sharp path', async () => {
        // Cache miss, engine available and returns webp bytes.
        mocks.fsPromisesReadFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        const engineBytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;
        mocks.fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => engineBytes });

        const req = new NextRequest('http://localhost/api/reader/image?path=/data/comics/batman.cbz&page=page1.jpg');
        const res = await GET(req);

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/webp');
        expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({ entry: 'page1.jpg', width: 1600 }));
        // Offloaded → the local extraction/sharp path is never reached.
        expect(mocks.readArchivePage).not.toHaveBeenCalled();
        expect(mocks.sharpToBuffer).not.toHaveBeenCalled();
    });

    // Crop mode (auto-trim margins) used to skip the engine for zips and load the whole archive
    // locally - up to six kept in memory, a file over 1 GB re-read for every page, over 2 GB
    // unreadable. Every archive type now gets its page from the engine at a larger width, trimmed
    // here and fitted to the reader's 1600px (the engine never enlarges a page).
    it.each([
        ['a zip', '/data/comics/compendium.cbz'],
        ['a CBR', '/data/comics/batman.cbr'],
    ])('crop mode on %s asks the engine for a 2400px page, then trims it and fits it to 1600px', async (_label, file) => {
        mocks.fsPromisesReadFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        mocks.fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer });

        const res = await GET(new NextRequest(`http://localhost/api/reader/image?path=${encodeURIComponent(file)}&page=page1.jpg&crop=true`));

        expect(res.status).toBe(200);
        expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({ entry: 'page1.jpg', width: 2400 }));
        expect(mocks.sharpTrim).toHaveBeenCalled();
        expect(mocks.sharpResize).toHaveBeenCalledWith({ width: 1600, withoutEnlargement: true });
        expect(mocks.readArchivePage).not.toHaveBeenCalled();
    });

    it('crop mode serves a page it cannot trim (one solid colour) untrimmed instead of failing', async () => {
        mocks.fsPromisesReadFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        mocks.fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer });
        mocks.sharpToBuffer
            .mockRejectedValueOnce(new Error('Unexpected error while trimming'))
            .mockResolvedValueOnce(Buffer.from('untrimmed page'));

        const res = await GET(new NextRequest('http://localhost/api/reader/image?path=/data/comics/compendium.cbz&page=blank.jpg&crop=true'));

        expect(res.status).toBe(200);
        expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('untrimmed page');
        expect(mocks.readArchivePage).not.toHaveBeenCalled();
    });
});