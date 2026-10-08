// src/lib/utils/archive-pages.ts
//
// Persistent page counting for comic archives. OPDS-PSE clients (Panels, Chunky) decide whether an
// issue is readable from the advertised pse:count, so Issue.pageCount must be populated everywhere a
// file enters or changes in the library — the web reader hides a missing count because it re-lists
// the archive on every open, but OPDS cannot.
//
// The counter and the reader's page lister read ONLY the zip End-Of-Central-Directory + central
// directory (a tail seek of at most ~64KB plus the directory itself) instead of loading the whole
// archive like AdmZip does — cheap enough to run across thousands of issues in a scan sweep, and the
// only way to open a compendium over 2 GB at all (AdmZip reads the file into one buffer). ZIP64
// archives (over 4 GB) are read from their ZIP64 end record. AdmZip remains the fallback for archives
// the index reader can't parse (odd trailers).
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import AdmZip from 'adm-zip';
import { IMAGE_EXT_REGEX } from '@/lib/utils/formats';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';

// Zip-family archives the reader can open directly (matches the reader's isZip check).
const ZIP_PAGE_EXT_REGEX = /\.(cbz|zip|epub)$/i;
// Archives Node can't open but the engine reads natively: RAR via unrar, 7z (.cb7) via the pure-Rust
// sevenz-rust2 decoder. Both are listed/counted through countArchivePagesViaEngine below.
const ENGINE_PAGE_EXT_REGEX = /\.(cbr|rar|cb7)$/i;

export function isPageCountable(filePath: string | null | undefined): boolean {
    return !!filePath && ZIP_PAGE_EXT_REGEX.test(filePath);
}

export function isEngineCountable(filePath: string | null | undefined): boolean {
    return !!filePath && ENGINE_PAGE_EXT_REGEX.test(filePath);
}

/**
 * Page count for engine-native archives (RAR via unrar, 7z via sevenz-rust2) through the engine's
 * listing — the same entry filter + natural sort as the zip counter, so OPDS-PSE indexes line up.
 * Returns 0 when the engine is unreachable or the archive is unreadable; never throws (same
 * contract as countArchivePages).
 */
export async function countArchivePagesViaEngine(filePath: string | null | undefined): Promise<number> {
    if (!filePath || !fs.existsSync(filePath)) return 0;
    try {
        const res = await fetch(ENGINE_URL + '/api/reader/entries', {
            method: 'POST',
            headers: engineHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ path: filePath }),
        });
        if (!res.ok) return 0;
        const data = await res.json();
        return Array.isArray(data.pages) ? data.pages.length : 0;
    } catch {
        return 0;
    }
}

// MUST mirror the entry filter used by the reader (reader/pages) and the OPDS page streamer
// (opds/page/[issueId]/[pageIndex]) — the persisted count has to agree with the indexes they serve.
function isPageEntry(entryName: string): boolean {
    const lower = entryName.toLowerCase();
    return !lower.endsWith('/') && !lower.includes('__macosx') && IMAGE_EXT_REGEX.test(lower);
}

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const MAX_COMMENT = 65535;

const LOCAL_HEADER_SIG = 0x04034b50;

/** One entry of a zip's central directory: where its bytes live and how they're stored. */
type ZipEntryInfo = {
    name: string;
    flags: number;
    method: number;
    compressedSize: number;
    localHeaderOffset: number;
};

/**
 * Every entry name in a zip, read from its central directory alone (ZIP64-aware). Names are decoded
 * as UTF-8, exactly like AdmZip's default decoder, because the reader looks pages up by the names
 * the page list returns. Throws when the index can't be parsed — callers pick their fallback.
 */
export async function readZipEntryNames(filePath: string): Promise<string[]> {
    return (await readZipIndex(filePath)).map(e => e.name);
}

async function readZipIndex(filePath: string): Promise<ZipEntryInfo[]> {
    const fd = await fs.promises.open(filePath, 'r');
    try {
        const { size } = await fd.stat();
        if (size < 22) throw new Error('too small to be a zip');

        // EOCD sits in the last 22 + comment bytes; scan backwards for its signature.
        const tailLen = Math.min(size, 22 + MAX_COMMENT);
        const tail = Buffer.alloc(tailLen);
        await fd.read(tail, 0, tailLen, size - tailLen);
        let eocd = -1;
        for (let i = tailLen - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
        }
        if (eocd === -1) throw new Error('EOCD signature not found');

        let totalEntries = tail.readUInt16LE(eocd + 10);
        let cdSize = tail.readUInt32LE(eocd + 12);
        let cdOffset = tail.readUInt32LE(eocd + 16);
        if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
            // ZIP64: the locator sits just before the classic end record and points at the ZIP64 end
            // record, which carries the real 64-bit entry count, directory size and offset.
            const eocdPos = size - tailLen + eocd;
            if (eocdPos < 20) throw new Error('ZIP64 locator missing');
            const locator = Buffer.alloc(20);
            await fd.read(locator, 0, 20, eocdPos - 20);
            if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIG) throw new Error('ZIP64 locator missing');
            const z64 = Buffer.alloc(56);
            await fd.read(z64, 0, 56, Number(locator.readBigUInt64LE(8)));
            if (z64.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new Error('ZIP64 end record missing');
            totalEntries = Number(z64.readBigUInt64LE(32));
            cdSize = Number(z64.readBigUInt64LE(40));
            cdOffset = Number(z64.readBigUInt64LE(48));
        }
        if (cdOffset + cdSize > size) throw new Error('central directory out of range');

        const cd = Buffer.alloc(cdSize);
        await fd.read(cd, 0, cdSize, cdOffset);

        const entries: ZipEntryInfo[] = [];
        let pos = 0;
        while (entries.length < totalEntries && pos + 46 <= cdSize) {
            if (cd.readUInt32LE(pos) !== CDFH_SIG) throw new Error('corrupt central directory');
            const nameLen = cd.readUInt16LE(pos + 28);
            const extraLen = cd.readUInt16LE(pos + 30);
            const commentLen = cd.readUInt16LE(pos + 32);
            let uncompressedSize = cd.readUInt32LE(pos + 24);
            let compressedSize = cd.readUInt32LE(pos + 20);
            let localHeaderOffset = cd.readUInt32LE(pos + 42);
            // ZIP64: each field that reads 0xFFFFFFFF here has its real value in the ZIP64 extra
            // field (id 0x0001), in this order: uncompressed size, compressed size, header offset.
            if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
                let x = pos + 46 + nameLen;
                const end = x + extraLen;
                while (x + 4 <= end) {
                    const id = cd.readUInt16LE(x);
                    const len = cd.readUInt16LE(x + 2);
                    if (id === 0x0001) {
                        let f = x + 4;
                        if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(cd.readBigUInt64LE(f)); f += 8; }
                        if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(f)); f += 8; }
                        if (localHeaderOffset === 0xffffffff) { localHeaderOffset = Number(cd.readBigUInt64LE(f)); }
                        break;
                    }
                    x += 4 + len;
                }
            }
            entries.push({
                name: cd.toString('utf8', pos + 46, pos + 46 + nameLen),
                flags: cd.readUInt16LE(pos + 8),
                method: cd.readUInt16LE(pos + 10),
                compressedSize,
                localHeaderOffset,
            });
            pos += 46 + nameLen + extraLen + commentLen;
        }
        return entries;
    } finally {
        await fd.close();
    }
}

// The reader's page lookup, unchanged: the exact entry name, then its backslash form (archives made
// on Windows), then the first entry with the same file name.
const baseName = (p: string) => p.split(/[/\\]/).pop() || p;
function findPageEntry<T extends { name: string }>(entries: T[], pageName: string): T | undefined {
    return entries.find(e => e.name === pageName)
        || entries.find(e => e.name === pageName.replace(/\//g, '\\'))
        || entries.find(e => baseName(e.name) === baseName(pageName));
}

/**
 * One entry's bytes, read through the zip's index: the central directory says where the entry
 * starts, its local header says where the data begins, and only that data is read and inflated.
 * Stored and deflated entries (what comic archives use); throws for anything else or an unreadable
 * index, so callers can fall back. Returns null when the archive has no such page.
 */
export async function readZipEntry(filePath: string, pageName: string): Promise<Buffer | null> {
    const entry = findPageEntry(await readZipIndex(filePath), pageName);
    if (!entry) return null;
    if (entry.flags & 0x1) throw new Error('encrypted entry');
    if (entry.method !== 0 && entry.method !== 8) throw new Error(`unsupported compression method ${entry.method}`);

    const fd = await fs.promises.open(filePath, 'r');
    try {
        const header = Buffer.alloc(30);
        await fd.read(header, 0, 30, entry.localHeaderOffset);
        if (header.readUInt32LE(0) !== LOCAL_HEADER_SIG) throw new Error('corrupt local header');
        const dataStart = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        const { size } = await fd.stat();
        if (dataStart + entry.compressedSize > size) throw new Error('entry out of range');

        const data = Buffer.alloc(entry.compressedSize);
        await fd.read(data, 0, entry.compressedSize, dataStart);
        return entry.method === 8 ? zlib.inflateRawSync(data) : data;
    } finally {
        await fd.close();
    }
}

/**
 * A page's bytes for the reader when the engine is down: read through the zip's index (one entry,
 * never the whole archive); AdmZip only for an archive the index reader can't handle. Same lookup
 * as the reader always used. Null when the page isn't in the archive.
 */
export async function readArchivePage(filePath: string, pageName: string): Promise<Buffer | null> {
    try {
        return await readZipEntry(filePath, pageName);
    } catch (indexErr) {
        Logger.log(`[archive-pages] Index read failed for ${path.basename(filePath)} (${getErrorMessage(indexErr)}); reading it with AdmZip.`, 'debug');
        const zip = new AdmZip(filePath);
        const entry = findPageEntry(zip.getEntries().map(e => ({ name: e.entryName, e })), pageName);
        return entry ? entry.e.getData() : null;
    }
}

/**
 * The readable page entries of a zip-family archive, in archive order (callers sort). Reads the
 * index only; AdmZip is the fallback for an archive the index reader can't parse. Throws when
 * neither can read it, so the reader can report a broken archive.
 */
export async function listArchivePages(filePath: string): Promise<string[]> {
    try {
        return (await readZipEntryNames(filePath)).filter(isPageEntry);
    } catch (indexErr) {
        try {
            return new AdmZip(filePath).getEntries().filter(e => !e.isDirectory && isPageEntry(e.entryName)).map(e => e.entryName);
        } catch (zipErr) {
            throw new Error(`${getErrorMessage(zipErr)} (index: ${getErrorMessage(indexErr)})`);
        }
    }
}

/**
 * Count the readable image pages inside a zip-family comic archive. Returns 0 for formats Node
 * can't open directly (.cbr/.rar/.cb7 — count those via countArchivePagesViaEngine), missing
 * files, or unreadable archives; it never throws, so callers can use it inline in scan/import/
 * rename flows.
 */
export async function countArchivePages(filePath: string | null | undefined): Promise<number> {
    if (!filePath || !isPageCountable(filePath) || !fs.existsSync(filePath)) return 0;
    try {
        return (await readZipEntryNames(filePath)).filter(isPageEntry).length;
    } catch (fastErr) {
        try {
            const zip = new AdmZip(filePath);
            return zip.getEntries().filter(e => !e.isDirectory && isPageEntry(e.entryName)).length;
        } catch (zipErr) {
            Logger.log(`[archive-pages] Could not count pages in ${path.basename(filePath)}: ${getErrorMessage(zipErr)} (fast path: ${getErrorMessage(fastErr)})`, 'warn');
            return 0;
        }
    }
}
