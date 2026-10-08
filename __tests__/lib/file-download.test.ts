// __tests__/lib/file-download.test.ts
//
// The pure half of the shared download helper (#219, #220): extension → media type, the RFC 6266
// Content-Disposition form, and single-range resolution. The route-level behaviour (200/206/416 and
// the headers) is pinned in __tests__/api/opds-download-koreader.test.ts and library-download.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    mediaTypeForFile,
    contentDisposition,
    fileValidators,
    parseByteRange,
    ifRangeMatches,
    sendFileResponse,
} from '@/lib/file-download';

describe('mediaTypeForFile', () => {
    it('maps the comic-book extensions to their real media types', () => {
        expect(mediaTypeForFile('/comics/Saga #001.cbz')).toBe('application/vnd.comicbook+zip');
        expect(mediaTypeForFile('/comics/Saga #001.cbr')).toBe('application/vnd.comicbook-rar');
        expect(mediaTypeForFile('/comics/Saga #001.cb7')).toBe('application/x-cb7');
        expect(mediaTypeForFile('/comics/Saga #001.epub')).toBe('application/epub+zip');
        expect(mediaTypeForFile('/comics/Saga #001.pdf')).toBe('application/pdf');
    });

    it('is case-insensitive and falls back to octet-stream for anything unknown', () => {
        expect(mediaTypeForFile('/comics/Saga #001.CBZ')).toBe('application/vnd.comicbook+zip');
        expect(mediaTypeForFile('/comics/notes.txt')).toBe('application/octet-stream');
        expect(mediaTypeForFile('/comics/no-extension')).toBe('application/octet-stream');
    });
});

describe('contentDisposition', () => {
    it('keeps the ASCII filename plain and puts the encoded form in filename*', () => {
        expect(contentDisposition('Saga #001.cbz'))
            .toBe(`attachment; filename="Saga #001.cbz"; filename*=UTF-8''Saga%20%23001.cbz`);
    });

    it('percent-encodes the RFC 5987 excluded characters in filename* only', () => {
        expect(contentDisposition("Saga's (2012).cbz"))
            .toBe(`attachment; filename="Saga's (2012).cbz"; filename*=UTF-8''Saga%27s%20%282012%29.cbz`);
    });

    it('substitutes non-ASCII characters in the ASCII filename and never leaves a raw quote', () => {
        expect(contentDisposition('Saga – Tome 1.cbz'))
            .toBe(`attachment; filename="Saga _ Tome 1.cbz"; filename*=UTF-8''Saga%20%E2%80%93%20Tome%201.cbz`);
        expect(contentDisposition('a"b.cbz')).toContain('filename="a\\"b.cbz"');
    });
});

describe('parseByteRange', () => {
    it('returns null when there is nothing to honour', () => {
        expect(parseByteRange(null, 100)).toBeNull();
        expect(parseByteRange('bytes=0-1,5-6', 100)).toBeNull(); // multi-range: serve the whole file
        expect(parseByteRange('items=0-1', 100)).toBeNull();     // unknown unit
    });

    it('resolves closed, open-ended and suffix ranges', () => {
        expect(parseByteRange('bytes=0-1023', 4096)).toEqual({ start: 0, end: 1023 });
        expect(parseByteRange('bytes=1024-', 4096)).toEqual({ start: 1024, end: 4095 });
        expect(parseByteRange('bytes=-100', 4096)).toEqual({ start: 3996, end: 4095 });
    });

    it('clamps an end past EOF to the last byte', () => {
        expect(parseByteRange('bytes=100-99999', 4096)).toEqual({ start: 100, end: 4095 });
    });

    it('reports a syntactically valid range that starts past EOF as unsatisfiable', () => {
        expect(parseByteRange('bytes=4096-', 4096)).toBe('unsatisfiable');
        expect(parseByteRange('bytes=5000-6000', 4096)).toBe('unsatisfiable');
        expect(parseByteRange('bytes=-100', 0)).toBe('unsatisfiable');
    });
});

describe('fileValidators / ifRangeMatches', () => {
    const stat = { size: 4096, mtime: new Date('2026-01-02T03:04:05Z') };

    it('derives a quoted ETag and the mtime as Last-Modified', () => {
        const v = fileValidators(stat);
        expect(v.etag).toBe(`"1000-${Math.floor(stat.mtime.getTime() / 1000).toString(16)}"`);
        expect(v.lastModified).toBe('Fri, 02 Jan 2026 03:04:05 GMT');
    });

    it('accepts an absent If-Range and either validator, rejects a stale one', () => {
        const v = fileValidators(stat);
        expect(ifRangeMatches(null, v)).toBe(true);
        expect(ifRangeMatches(undefined, v)).toBe(true);
        expect(ifRangeMatches(v.etag, v)).toBe(true);
        expect(ifRangeMatches(v.lastModified, v)).toBe(true);
        expect(ifRangeMatches('"stale"', v)).toBe(false);
    });
});

// Real filesystem, real bytes — no fs mock. Proves the response actually carries the slice it claims.
describe('sendFileResponse (real file)', () => {
    const bytes = Buffer.from('0123456789abcdefghij', 'utf8'); // 20 bytes
    let dir: string;
    let file: string;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-file-download-'));
        file = path.join(dir, 'Saga #001.cbz');
        fs.writeFileSync(file, bytes);
    });
    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const body = async (res: Response) => Buffer.from(await res.arrayBuffer());

    it('serves the whole file with no Range', async () => {
        const res = sendFileResponse(new Request('http://localhost/file'), file);

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Length')).toBe('20');
        expect(await body(res)).toEqual(bytes);
    });

    it('serves exactly the requested slice with 206', async () => {
        const res = sendFileResponse(new Request('http://localhost/file', { headers: { Range: 'bytes=5-9' } }), file);

        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe('bytes 5-9/20');
        expect(res.headers.get('Content-Length')).toBe('5');
        expect((await body(res)).toString()).toBe('56789');
    });

    it('serves a suffix range', async () => {
        const res = sendFileResponse(new Request('http://localhost/file', { headers: { Range: 'bytes=-4' } }), file);

        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe('bytes 16-19/20');
        expect((await body(res)).toString()).toBe('ghij');
    });

    it('answers 416 for a range past EOF without streaming anything', async () => {
        const res = sendFileResponse(new Request('http://localhost/file', { headers: { Range: 'bytes=100-200' } }), file);

        expect(res.status).toBe(416);
        expect(res.headers.get('Content-Range')).toBe('bytes */20');
        expect((await body(res)).length).toBe(0);
    });

    it('falls back to the whole file when If-Range is stale', async () => {
        const res = sendFileResponse(
            new Request('http://localhost/file', { headers: { Range: 'bytes=0-4', 'If-Range': '"stale"' } }),
            file,
        );

        expect(res.status).toBe(200);
        expect((await body(res)).length).toBe(20);
    });

    it('honours If-Range when it still matches, and declares the real validators', async () => {
        const { etag, lastModified } = fileValidators(fs.statSync(file));
        const res = sendFileResponse(
            new Request('http://localhost/file', { headers: { Range: 'bytes=0-4', 'If-Range': etag } }),
            file,
        );

        expect(res.status).toBe(206);
        expect(res.headers.get('ETag')).toBe(etag);
        expect(res.headers.get('Last-Modified')).toBe(lastModified);
        expect((await body(res)).toString()).toBe('01234');
    });
});
