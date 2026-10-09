// Read-only local evidence. IDs are never dynamically resolved while reading archives.
import fs from 'fs/promises';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { prisma } from '@/lib/db';
import { UNMATCHED_DIR } from '@/lib/utils/paths';
import { COMIC_EXT_REGEX } from '@/lib/utils/formats';
import { parseSeriesJson, notesIssueIds } from '@/lib/utils/match-prefill';
import { canonicalNumber, isAnnualFormat, isCollectedFormat, parseSignals, titleSimilarity, type ExactId, type MatchEvidence, type ParsedSignals } from './signals';

const execute = promisify(execFile);
const MAX_FILES = 64;
const MAX_XML = 1024 * 1024;
const EVIDENCE_DEADLINE_MS = 8000;
const localCache = new Map<string, { stamp: string; info: Record<string, unknown> | null }>();

export async function readComicSignals(file: string, timeout = 5000): Promise<Record<string, unknown> | null> {
    let xml: string;
    if (/\.(cbz|zip|epub)$/i.test(file)) {
        // Streaming stdout avoids loading every large ZIP into Node just to read a small XML.
        const result = await execute('unzip', ['-p', '-qq', file, '*[Cc][Oo][Mm][Ii][Cc][Ii][Nn][Ff][Oo].[Xx][Mm][Ll]'], { timeout, maxBuffer: MAX_XML }).catch((error) => {
            if (error.code === 11) return null;
            throw error;
        });
        if (!result?.stdout.trim()) return null;
        xml = result.stdout;
    } else if (/\.(cbr|rar)$/i.test(file)) {
        // Read one entry through stdout; never extract, rewrite or convert the archive.
        const result = await execute('unrar', ['p', '-inul', file, 'ComicInfo.xml'], { timeout, maxBuffer: MAX_XML }).catch((error) => {
            if (error.code === 10) return null; // no matching XML entry
            throw error;
        });
        if (!result || !result.stdout.trim()) return null;
        xml = result.stdout;
    } else return null;
    xml = xml.replace(/&(?!amp;|lt;|gt;|quot;|apos;#\d+;|#x[\da-f]+;)/gi, '&amp;');
    return new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml)?.ComicInfo || null;
}

export function comicInfoEvidence(info: Record<string, unknown>, filename: string): { parsed: ParsedSignals; ids: ExactId[] } {
    const text = (key: string) => info[key] == null ? '' : String(info[key]).trim();
    const parsed = parseSignals(filename, 'filename', text('Series') || undefined);
    if (text('Series')) parsed.title = text('Series');
    if (text('Number') && parsed.issue && canonicalNumber(text('Number')) !== parsed.issue.value) parsed.warnings.push('ComicInfo Number contradicts the filename issue number');
    if (text('Year') && parsed.publicationYear && Math.abs(Number(text('Year')) - parsed.publicationYear.value) > 1) parsed.warnings.push('ComicInfo Year contradicts the filename publication year');
    if (text('Number')) parsed.issue = { value: canonicalNumber(text('Number').replace(/^annual\s*/i, '')), source: 'ComicInfo Number', confidence: 'high' };
    if (/^(?:19|20)\d{2}$/.test(text('Year'))) parsed.publicationYear = { value: Number(text('Year')), source: 'ComicInfo Year', confidence: 'high' };
    if (/^\d+$/.test(text('Volume'))) {
        const volume = Number(text('Volume'));
        if (volume >= 1900) parsed.seriesYear = { value: volume, source: 'ComicInfo Volume year', confidence: 'high' };
        else if (volume > 0) parsed.run = { value: volume, source: 'ComicInfo Volume ordinal', confidence: 'high' };
    }
    if (text('Publisher')) parsed.publisher = { value: text('Publisher'), source: 'ComicInfo Publisher', confidence: 'high' };
    if (text('Format')) parsed.format = { value: text('Format'), source: 'ComicInfo Format', confidence: 'high' };
    if (isAnnualFormat(text('Format') + ' ' + text('Number'))) parsed.domain = 'annual';
    else if (isCollectedFormat(text('Format'))) parsed.domain = 'collected';
    const ids: ExactId[] = [];
    const add = (provider: ExactId['provider'], kind: ExactId['kind'], value: unknown) => {
        if (/^[1-9]\d*$/.test(String(value))) ids.push({ provider, kind, id: String(value), source: `ComicInfo ${filename} ${kind} ID`, ...(kind === 'issue' ? { issueNumber: parsed.issue?.value, domain: parsed.domain } : {}) });
    };
    add('COMICVINE', 'series', info.ComicVineVolumeId); add('COMICVINE', 'issue', info.ComicVineIssueId);
    add('METRON', 'series', info.MetronId); add('METRON', 'issue', info.MetronIssueId);
    const web = text('Web');
    add('COMICVINE', 'series', web.match(/comicvine(?:\.gamespot)?\.com\/.*4050-(\d+)/i)?.[1]);
    add('COMICVINE', 'issue', web.match(/comicvine(?:\.gamespot)?\.com\/.*4000-(\d+)/i)?.[1]);
    add('METRON', 'series', web.match(/metron\.cloud\/series\/(\d+)/i)?.[1]);
    add('METRON', 'issue', web.match(/metron\.cloud\/issue\/(\d+)/i)?.[1]);
    const notes = notesIssueIds(text('Notes'));
    add('COMICVINE', 'issue', notes.cvIssueId); add('METRON', 'issue', notes.metronIssueId);
    return { parsed, ids };
}

/** Resolve server-owned paths from IDs; never accept an arbitrary path from a scan request. */
export async function collectEvidence(itemId: string, refresh = false): Promise<MatchEvidence & { folderPath: string; ignored: boolean; locked: boolean }> {
    const deadline = Date.now() + EVIDENCE_DEADLINE_MS;
    let row: any;
    let folderPath: string;
    const raw = itemId.startsWith('raw_');
    if (raw) {
        const filename = Buffer.from(itemId.slice(4), 'base64').toString('utf8');
        if (!filename || path.basename(filename) !== filename || /[\\/\0]/.test(filename) || !COMIC_EXT_REGEX.test(filename)) throw new Error('Invalid unmatched file ID');
        folderPath = path.join(UNMATCHED_DIR, filename);
        row = { name: filename };
    } else {
        row = await prisma.series.findUnique({ where: { id: itemId } });
        if (!row?.folderPath) throw new Error('Unmatched series not found');
        folderPath = row.folderPath;
    }
    // Realpath containment excludes symlinks escaping library/unmatched roots.
    const libraries = await prisma.library.findMany({ select: { path: true } });
    const rootPaths = await Promise.all([UNMATCHED_DIR, ...libraries.map(l => l.path)].map(p => fs.realpath(p).catch(() => path.resolve(p))));
    const real = await fs.realpath(folderPath);
    if (!rootPaths.some(r => real === r || real.startsWith(r + path.sep))) throw new Error('Source is outside configured libraries');
    const rootStat = await fs.stat(real);
    const parsed = parseSignals(row.name, raw ? 'filename' : 'series');
    if (!raw && row.year > 0 && !parsed.seriesYear) parsed.seriesYear = { value: row.year, source: 'scanned series year (unconfirmed provenance)', confidence: 'low' };
    if (row.publisher && !/^(unknown|other)$/i.test(row.publisher)) parsed.publisher = { value: row.publisher, source: 'scanned publisher', confidence: 'medium' };
    const evidence: MatchEvidence = { parsed, files: [], ids: [], incomplete: false };
    const stamps: unknown[] = [{ path: real, mtime: rootStat.mtimeMs, size: rootStat.size }];
    let files: string[];
    if (rootStat.isDirectory()) {
        const entries = await fs.readdir(real, { withFileTypes: true });
        files = entries.filter(e => e.isFile() && COMIC_EXT_REGEX.test(e.name)).map(e => e.name).sort();
        evidence.incomplete = files.length > MAX_FILES || entries.some(e => e.isDirectory() || e.isSymbolicLink());
        try {
            const sidecar = await fs.readFile(path.join(real, 'series.json'), 'utf8');
            stamps.push({ sidecar });
            const sj = parseSeriesJson(sidecar);
            if (sj?.comicid) evidence.ids.push({ provider: 'COMICVINE', kind: 'series', id: String(sj.comicid), source: 'series.json' });
            if (sj?.name) parsed.title = sj.name;
            if (sj?.year) parsed.seriesYear = { value: sj.year, source: 'series.json year', confidence: 'high' };
            if (sj?.publisher && !/^(unknown|other)$/i.test(sj.publisher)) parsed.publisher = { value: sj.publisher, source: 'series.json publisher', confidence: 'high' };
            if (sj?.booktype) {
                parsed.format = { value: sj.booktype, source: 'series.json booktype', confidence: 'high' };
                if (isCollectedFormat(sj.booktype)) parsed.domain = 'collected';
            }
        } catch (error: any) { if (error.code !== 'ENOENT') evidence.incomplete = true; }
    } else files = [path.basename(real)];
    for (const filename of files.slice(0, MAX_FILES)) {
        if (Date.now() >= deadline) { evidence.incomplete = true; break; }
        const target = rootStat.isDirectory() ? path.join(real, filename) : real;
        const stat = await fs.stat(target);
        stamps.push({ filename, mtime: stat.mtimeMs, size: stat.size });
        try {
            const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
            const cached = !refresh && localCache.get(target);
            const info = cached && cached.stamp === stamp ? cached.info : await readComicSignals(target, Math.max(1, Math.min(5000, deadline - Date.now())));
            if (localCache.size >= 512) localCache.delete(localCache.keys().next().value!);
            localCache.set(target, { stamp, info });
            const local = info ? comicInfoEvidence(info, filename) : { parsed: parseSignals(filename, 'filename', raw ? undefined : parsed.title), ids: [] };
            evidence.files.push(local.parsed);
            evidence.ids.push(...local.ids);
            stamps.push(info);
        } catch { evidence.incomplete = true; evidence.files.push(parseSignals(filename, 'filename', raw ? undefined : parsed.title)); }
    }
    if (raw && evidence.files[0]) evidence.parsed = evidence.files[0];
    evidence.ids = [...new Map(evidence.ids.map(i => [`${i.provider}:${i.kind}:${i.id}:${i.issueNumber}:${i.domain}`, i])).values()];
    if (evidence.ids.length > 8) evidence.incomplete = true;
    if (!raw && evidence.files.some(f => titleSimilarity(f.title, parsed.title) < .7)) {
        parsed.warnings.push('Mixed or contradictory series titles in folder metadata');
    }
    evidence.fingerprintData = { itemId, name: row.name, year: row.year, publisher: row.publisher, metadataId: row.metadataId, metadataSource: row.metadataSource,
        matchState: row.matchState, hasCustomMetadata: row.hasCustomMetadata, updatedAt: row.updatedAt, stamps, files, parsed: evidence.parsed, signals: evidence.files, ids: evidence.ids };
    return { ...evidence, folderPath, ignored: row.matchState === 'IGNORED' || !raw && row.matchState !== 'UNMATCHED' && row.metadataId && !row.metadataId.startsWith('unmatched'), locked: !!row.hasCustomMetadata };
}
