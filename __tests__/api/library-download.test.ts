import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import { GET } from '@/app/api/library/download/route';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    findUniqueUser: vi.fn(),
    findManyLibraries: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn(),
    createReadStream: vi.fn(),
    rememberForPath: vi.fn(async () => undefined),
    log: vi.fn()
}));

vi.mock('@/lib/koreader-documents', () => ({ rememberKoreaderDocumentForPath: mocks.rememberForPath }));

// 2. Mock NextAuth
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));

// 3. Mock Prisma
vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findUnique: mocks.findUniqueUser },
        library: { findMany: mocks.findManyLibraries }
    }
}));

// 4. Mock fs (native, not fs-extra, in this route)
vi.mock('fs', () => ({
    default: {
        existsSync: mocks.existsSync,
        statSync: mocks.statSync,
        createReadStream: mocks.createReadStream
    }
}));


const createReq = (filePath: string) =>
    new Request(`http://localhost/api/library/download?path=${encodeURIComponent(filePath)}`);

describe('API Route: Library File Download Permissions', () => {
    beforeEach(() => {
        mocks.findManyLibraries.mockResolvedValue([{ path: '/library' }]);
    });

    it('should reject requests with no resolvable user', async () => {
        mocks.getServerSession.mockResolvedValueOnce(null);

        const res = await GET(createReq('/library/Batman/issue1.cbz'));
        expect(res.status).toBe(401);
    });

    it('should reject authenticated users without the download permission', async () => {
        mocks.getServerSession.mockResolvedValueOnce({ user: { id: 'user_1' } });
        mocks.findUniqueUser.mockResolvedValueOnce({ id: 'user_1', role: 'USER', canDownload: false });

        const res = await GET(createReq('/library/Batman/issue1.cbz'));
        expect(res.status).toBe(403);
    });

    it('should allow users with the canDownload permission through to the file lookup', async () => {
        mocks.getServerSession.mockResolvedValueOnce({ user: { id: 'user_2' } });
        mocks.findUniqueUser.mockResolvedValueOnce({ id: 'user_2', role: 'USER', canDownload: true });
        // The permission gate passed; the missing file proves we reached the fs stage
        mocks.existsSync.mockReturnValueOnce(false);

        const res = await GET(createReq('/library/Batman/issue1.cbz'));
        expect(res.status).toBe(404);
    });

    it('should allow admins regardless of their canDownload flag', async () => {
        mocks.getServerSession.mockResolvedValueOnce({ user: { id: 'admin_1' } });
        mocks.findUniqueUser.mockResolvedValueOnce({ id: 'admin_1', role: 'ADMIN', canDownload: false });
        mocks.existsSync.mockReturnValueOnce(false);

        const res = await GET(createReq('/library/Batman/issue1.cbz'));
        expect(res.status).toBe(404);
    });

    it('should still reject paths outside the configured library roots for permitted users', async () => {
        mocks.getServerSession.mockResolvedValueOnce({ user: { id: 'admin_1' } });
        mocks.findUniqueUser.mockResolvedValueOnce({ id: 'admin_1', role: 'ADMIN', canDownload: true });

        const res = await GET(createReq('/etc/passwd'));
        expect(res.status).toBe(403);
    });

    // #211 follow-up: a book downloaded here and copied to a KOReader device by hand syncs to its issue
    // too - the download records KOReader's document IDs for the file.
    it('records the KOReader document IDs of the file it serves', async () => {
        mocks.getServerSession.mockResolvedValueOnce({ user: { id: 'user_2' } });
        mocks.findUniqueUser.mockResolvedValueOnce({ id: 'user_2', role: 'USER', canDownload: true });
        mocks.existsSync.mockReturnValueOnce(true);
        const fs = (await import('fs')).default as any;
        fs.statSync.mockReturnValueOnce({ size: 1234, mtime: new Date('2026-01-01T00:00:00Z') });
        fs.createReadStream.mockReturnValueOnce(Readable.from([]));

        const res = await GET(createReq('/library/Batman/issue1.cbz'));

        expect(res.status).toBe(200);
        expect(mocks.rememberForPath).toHaveBeenCalledWith('/library/Batman/issue1.cbz');
    });
});

// #219/#220: the web download shares lib/file-download.ts with the OPDS acquisition download, so it
// answers the same way — extension media type, RFC 6266 disposition, and Range support.
describe('API Route: Library File Download - response shape', () => {
    const PATH = '/library/Batman/Batman #001.cbz';
    const SIZE = 2048;
    const MTIME = new Date('2026-01-01T00:00:00Z');
    const withRange = (range: string) =>
        GET(new Request(
            `http://localhost/api/library/download?path=${encodeURIComponent(PATH)}`,
            { headers: { Range: range } },
        ));

    beforeEach(() => {
        mocks.findManyLibraries.mockResolvedValue([{ path: '/library' }]);
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_2' } });
        mocks.findUniqueUser.mockResolvedValue({ id: 'user_2', role: 'USER', canDownload: true });
        mocks.existsSync.mockReturnValue(true);
        mocks.statSync.mockReturnValue({ size: SIZE, mtime: MTIME });
        mocks.createReadStream.mockReturnValue(Readable.from([]));
    });

    it('declares the media type from the file extension', async () => {
        const res = await GET(createReq(PATH));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/vnd.comicbook+zip');
    });

    it('emits an unencoded ASCII filename plus filename*', async () => {
        const res = await GET(createReq(PATH));

        expect(res.headers.get('Content-Disposition'))
            .toBe(`attachment; filename="Batman #001.cbz"; filename*=UTF-8''Batman%20%23001.cbz`);
    });

    it('advertises and honours byte ranges', async () => {
        expect((await GET(createReq(PATH))).headers.get('Accept-Ranges')).toBe('bytes');

        const res = await withRange('bytes=0-511');
        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe(`bytes 0-511/${SIZE}`);
        expect(mocks.createReadStream).toHaveBeenCalledWith(PATH, { start: 0, end: 511 });
    });
});
