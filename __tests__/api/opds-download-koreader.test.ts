import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

// #211 follow-up: an OPDS download records the document IDs KOReader will send for that file (its
// partial-MD5 checksum and filename MD5), so the device's progress syncs find the issue on their own.

const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    issueFindUnique: vi.fn(),
    remember: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('@/lib/db', () => ({ prisma: { issue: { findUnique: mocks.issueFindUnique } } }));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryIds: vi.fn(async () => 'ALL'),
    canAccessLibraryId: vi.fn(() => true),
}));
vi.mock('@/lib/koreader-documents', () => ({ rememberKoreaderDocument: mocks.remember }));

// #219/#220: the shared download helper stats the file for its validators (Last-Modified/ETag), so
// the fs mock needs a controllable statSync/createReadStream alongside existsSync.
const fsMocks = vi.hoisted(() => ({
    existsSync: vi.fn(() => true),
    statSync: vi.fn(),
    createReadStream: vi.fn(),
}));
vi.mock('fs', () => ({
    default: {
        existsSync: fsMocks.existsSync,
        statSync: fsMocks.statSync,
        createReadStream: fsMocks.createReadStream,
    },
}));

import { GET } from '@/app/api/opds/download/route';

const FILE = '/library/Saga/Saga #001.cbz';
const SIZE = 240951661;
const MTIME = new Date('2026-09-29T10:00:00Z');
const ETAG = `"${SIZE.toString(16)}-${Math.floor(MTIME.getTime() / 1000).toString(16)}"`;
const download = (headers?: Record<string, string>) =>
    GET(new Request('http://localhost/api/opds/download?issueId=issue_1', { headers }));

describe('GET /api/opds/download - KOReader document IDs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', role: 'USER', canDownload: true } });
        mocks.issueFindUnique.mockResolvedValue({ id: 'issue_1', filePath: FILE, series: { libraryId: 'lib_1' } });
        mocks.remember.mockResolvedValue(undefined);
        fsMocks.statSync.mockReturnValue({ size: SIZE, mtime: MTIME });
        fsMocks.createReadStream.mockReturnValue(Readable.from([]));
    });

    it('records them for the issue it serves', async () => {
        const res = await download();

        expect(res.status).toBe(200);
        expect(mocks.remember).toHaveBeenCalledWith('issue_1', FILE);
    });

    it('records nothing for a download it refuses', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', role: 'USER', canDownload: false } });

        expect((await download()).status).toBe(403);
        expect(mocks.remember).not.toHaveBeenCalled();
    });
});

describe('GET /api/opds/download - media type, disposition and Range (#219, #220)', () => {
    beforeEach(() => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', role: 'USER', canDownload: true } });
        mocks.issueFindUnique.mockResolvedValue({ id: 'issue_1', filePath: FILE, series: { libraryId: 'lib_1' } });
        mocks.remember.mockResolvedValue(undefined);
        fsMocks.existsSync.mockReturnValue(true);
        fsMocks.statSync.mockReturnValue({ size: SIZE, mtime: MTIME });
        fsMocks.createReadStream.mockReturnValue(Readable.from([]));
    });

    it('answers 200 with the whole file and advertises byte ranges when no Range is sent', async () => {
        const res = await download();

        expect(res.status).toBe(200);
        expect(res.headers.get('Accept-Ranges')).toBe('bytes');
        expect(res.headers.get('Content-Length')).toBe(String(SIZE));
        expect(res.headers.get('Content-Range')).toBeNull();
        expect(res.headers.get('Last-Modified')).toBe(MTIME.toUTCString());
        expect(res.headers.get('ETag')).toBe(ETAG);
    });

    it('declares the media type from the extension, not a hard-coded CBZ type', async () => {
        expect((await download()).headers.get('Content-Type')).toBe('application/vnd.comicbook+zip');

        mocks.issueFindUnique.mockResolvedValue({ id: 'issue_2', filePath: '/library/Saga/Saga #002.cbr', series: { libraryId: 'lib_1' } });
        expect((await download()).headers.get('Content-Type')).toBe('application/vnd.comicbook-rar');
    });

    it('emits a plain ASCII filename plus the UTF-8 filename* (RFC 6266 §4.3)', async () => {
        const res = await download();

        expect(res.headers.get('Content-Disposition'))
            .toBe(`attachment; filename="Saga #001.cbz"; filename*=UTF-8''Saga%20%23001.cbz`);
    });

    it('answers a single range with 206, Content-Range and just that slice', async () => {
        const res = await download({ Range: 'bytes=0-1023' });

        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe(`bytes 0-1023/${SIZE}`);
        expect(res.headers.get('Content-Length')).toBe('1024');
        expect(fsMocks.createReadStream).toHaveBeenCalledWith(FILE, { start: 0, end: 1023 });
    });

    it('resolves an open-ended range to the end of the file', async () => {
        const res = await download({ Range: 'bytes=1024-' });

        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe(`bytes 1024-${SIZE - 1}/${SIZE}`);
        expect(fsMocks.createReadStream).toHaveBeenCalledWith(FILE, { start: 1024, end: SIZE - 1 });
    });

    it('answers an unsatisfiable range with 416 and bytes */<size>', async () => {
        const res = await download({ Range: `bytes=${SIZE + 10}-` });

        expect(res.status).toBe(416);
        expect(res.headers.get('Content-Range')).toBe(`bytes */${SIZE}`);
        expect(fsMocks.createReadStream).not.toHaveBeenCalled();
    });

    it('ignores the Range when If-Range does not match the file on disk', async () => {
        const res = await download({ Range: 'bytes=0-1023', 'If-Range': '"stale-validator"' });

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Length')).toBe(String(SIZE));
        expect(res.headers.get('Content-Range')).toBeNull();
    });

    it('honours the Range when If-Range matches the current ETag', async () => {
        const res = await download({ Range: 'bytes=0-1023', 'If-Range': ETAG });

        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe(`bytes 0-1023/${SIZE}`);
    });
});
