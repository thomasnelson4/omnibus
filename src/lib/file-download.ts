// src/lib/file-download.ts
//
// One place that turns a library file into an HTTP response. Both acquisition paths serve the same
// bytes — the OPDS download (/api/opds/download) and the web-app download (/api/library/download) —
// so the media type, the Content-Disposition form and Range handling live here once. The extension →
// media type map is exported for the OPDS feeds, whose acquisition links must declare the same type
// as the response they point at (OPDS 1.2 §5.3).
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

/**
 * Extension → media type. `.cbz`/`.cbr`/`.cb7` use the comic-book types, the rest the standard
 * archive/document types; anything else is `application/octet-stream` rather than a wrong guess.
 */
const MEDIA_TYPES: Record<string, string> = {
    '.cbz': 'application/vnd.comicbook+zip',
    '.cbr': 'application/vnd.comicbook-rar',
    '.cb7': 'application/x-cb7',
    '.zip': 'application/zip',
    '.rar': 'application/vnd.rar',
    '.7z': 'application/x-7z-compressed',
    '.epub': 'application/epub+zip',
    '.pdf': 'application/pdf',
};

/** The media type for a file, from its extension. Unknown extensions become octet-stream. */
export function mediaTypeForFile(filePath: string): string {
    return MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Percent-encodes the characters RFC 5987 excludes from `attr-char` (encodeURIComponent keeps them). */
function rfc5987Encode(value: string): string {
    return encodeURIComponent(value).replace(/['()!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * RFC 6266 §4.3 disposition: a plain, unencoded ASCII `filename` plus the UTF-8 `filename*`.
 *
 * The ASCII form must NOT be percent-encoded (Appendix D) and must not carry `"` or `\` — KOReader
 * URL-decodes `filename` and would mangle a `%`-encoded basename, which is why the encoded value
 * stays in `filename*` only.
 */
export function contentDisposition(fileName: string): string {
    const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/(["\\])/g, '\\$1');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987Encode(fileName)}`;
}

/** The cache validators derived from the file — used for `Last-Modified`/`ETag` and for `If-Range`. */
export function fileValidators(stat: { size: number; mtime: Date }): { etag: string; lastModified: string } {
    return {
        // Quote-wrapped, so it is a strong validator (and compares byte-for-byte in If-Range).
        etag: `"${stat.size.toString(16)}-${Math.floor(stat.mtime.getTime() / 1000).toString(16)}"`,
        lastModified: stat.mtime.toUTCString(),
    };
}

/** A resolved single range, `unsatisfiable` (syntactically valid but out of bounds), or null (no range). */
export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * Resolves a single `bytes=` range against the file size. Anything else — a multi-range request, a
 * non-`bytes` unit, a malformed value — returns null, and the caller answers 200 with the whole
 * file: a server is allowed to ignore a Range it does not want to serve.
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange {
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return null;
    const [, first, last] = match;
    if (first === '' && last === '') return null;

    let start: number;
    let end: number;
    if (first === '') {
        // Suffix form: the last N bytes.
        const suffix = Number(last);
        if (!Number.isFinite(suffix) || suffix <= 0) return null;
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(first);
        end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
    }
    if (start >= size || start > end) return 'unsatisfiable';
    return { start, end };
}

/** Whether a sent `If-Range` still describes the file on disk (false = the client's copy is stale). */
export function ifRangeMatches(header: string | null | undefined, validators: { etag: string; lastModified: string }): boolean {
    if (!header) return true;
    const value = header.trim();
    return value === validators.etag || value === validators.lastModified;
}

function streamFile(filePath: string, range?: { start: number; end: number }): ReadableStream {
    // `Readable.toWeb` carries the read stream's own backpressure: the platform pulls a chunk only
    // when the response can take it. The previous `on('data')` handler enqueued every chunk whatever
    // the controller's `desiredSize`, so nothing ever paused the read — with a slow client the server
    // read the rest of the file into memory ahead of it, which a 1–2 GB compendium does not forgive.
    // Errors and cancellation are the wrapper's too, so a client that disconnects destroys the read.
    return Readable.toWeb(fs.createReadStream(filePath, range)) as unknown as ReadableStream;
}

/**
 * The response for a library file: full body, a single ranged slice, or 416. `If-Range` is honoured
 * against the file's validators, so a resumed download restarts cleanly when the file has changed.
 * The caller owns the permission checks and any side effects (e.g. recording KOReader document IDs).
 */
export function sendFileResponse(req: Request, filePath: string): Response {
    const stat = fs.statSync(filePath);
    const validators = fileValidators(stat);
    const headers: Record<string, string> = {
        'Content-Type': mediaTypeForFile(filePath),
        'Content-Disposition': contentDisposition(path.basename(filePath)),
        'Accept-Ranges': 'bytes',
        'Last-Modified': validators.lastModified,
        'ETag': validators.etag,
    };

    const conditional = req.headers.get('if-range');
    const range = ifRangeMatches(conditional, validators)
        ? parseByteRange(req.headers.get('range'), stat.size)
        : null;

    if (range === 'unsatisfiable') {
        return new Response(null, {
            status: 416,
            headers: { ...headers, 'Content-Range': `bytes */${stat.size}` },
        });
    }

    if (range) {
        return new Response(streamFile(filePath, range) as unknown as BodyInit, {
            status: 206,
            headers: {
                ...headers,
                'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
                'Content-Length': String(range.end - range.start + 1),
            },
        });
    }

    return new Response(streamFile(filePath) as unknown as BodyInit, {
        headers: { ...headers, 'Content-Length': String(stat.size) },
    });
}
