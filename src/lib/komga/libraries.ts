// src/lib/komga/libraries.ts
//
// Komga's libraries as Omnibus sees them: the KomgaLibrary cache table (refreshed whenever
// listLibraries succeeds — connection test, sync, reconcile), the Omnibus <-> Komga library
// resolution, and the setup warnings the Media Servers tab shows. Omnibus never changes a Komga
// library's settings; it only reads and warns.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import type { KomgaClient } from './client';
import type { KomgaLibraryDto } from './types';
import {
    isPathUnder, komgaDirectorySkip, normalizeKomgaPath, toKomgaPath, toOmnibusPath,
    type KomgaPathMapping,
} from './path-map';

export interface KomgaLibrarySettingsSnapshot {
    hashFiles: boolean; importComicInfoBook: boolean; importComicInfoReadList: boolean;
    emptyTrashAfterScan: boolean; scanForceModifiedTime: boolean; convertToCbz: boolean; repairExtensions: boolean;
    scanCbx: boolean; scanPdf: boolean; scanEpub: boolean; scanDirectoryExclusions: string[]; oneshotsDirectory: string | null;
}
export interface ResolvedKomgaLibrary {
    komgaLibraryId: string; name: string; root: string; translatedRoot: string | null;
    omnibusLibraryId: string | null; settings: KomgaLibrarySettingsSnapshot; unavailable: boolean;
}
export interface OmnibusLibraryRef { id: string; name: string; path: string }

// Komga's own defaults (domain/model/Library.kt) — what a field means when the DTO or a cached
// row lacks it.
const DEFAULT_SETTINGS: KomgaLibrarySettingsSnapshot = {
    hashFiles: true, importComicInfoBook: true, importComicInfoReadList: true,
    emptyTrashAfterScan: false, scanForceModifiedTime: false, convertToCbz: false, repairExtensions: false,
    scanCbx: true, scanPdf: true, scanEpub: true, scanDirectoryExclusions: [], oneshotsDirectory: null,
};
const BOOLEAN_KEYS = [
    'hashFiles', 'importComicInfoBook', 'importComicInfoReadList', 'emptyTrashAfterScan', 'scanForceModifiedTime',
    'convertToCbz', 'repairExtensions', 'scanCbx', 'scanPdf', 'scanEpub',
] as const;

function coerceSettings(src: unknown): KomgaLibrarySettingsSnapshot {
    const o = (src && typeof src === 'object' ? src : {}) as Record<string, unknown>;
    const out: KomgaLibrarySettingsSnapshot = { ...DEFAULT_SETTINGS, scanDirectoryExclusions: [] };
    for (const key of BOOLEAN_KEYS) {
        if (typeof o[key] === 'boolean') out[key] = o[key] as boolean;
    }
    if (Array.isArray(o.scanDirectoryExclusions)) {
        out.scanDirectoryExclusions = o.scanDirectoryExclusions.filter((e): e is string => typeof e === 'string');
    }
    out.oneshotsDirectory = typeof o.oneshotsDirectory === 'string' ? o.oneshotsDirectory : null;
    return out;
}

/** The LibraryDto flags the integration reasons about (warnings, scannability), defaults filled in. */
export function snapshotLibrarySettings(dto: KomgaLibraryDto): KomgaLibrarySettingsSnapshot {
    return coerceSettings(dto);
}

const depth = (p: string) => (p === '/' ? 0 : p.split('/').length);

// Exact match, else the deepest Omnibus library containing the Komga folder (the Komga library
// lives inside it; containers are nested, so the longest path is the deepest), else the one
// inside the Komga folder closest to it — fewest segments, then alphabetical (a Komga library
// over a parent folder can serve several; komgaLibrariesForOmnibusLibrary finds them all).
function pickOmnibusLibrary(translatedRoot: string, libs: { id: string; path: string }[]): string | null {
    const exact = libs.find(l => l.path === translatedRoot);
    if (exact) return exact.id;
    const containers = libs.filter(l => isPathUnder(translatedRoot, l.path));
    if (containers.length > 0) {
        return containers.reduce((best, l) => (l.path.length > best.path.length ? l : best)).id;
    }
    const contained = libs.filter(l => isPathUnder(l.path, translatedRoot));
    if (contained.length > 0) {
        return contained.reduce((best, l) => {
            const d = depth(l.path) - depth(best.path);
            return d < 0 || (d === 0 && l.path < best.path) ? l : best;
        }).id;
    }
    return null;
}

/**
 * Pure: translate each Komga root to Omnibus space and attach the best-matching Omnibus library.
 * A Komga library maps when the translated root and an Omnibus library path are equal or one
 * contains the other.
 */
export function resolveKomgaLibraries(
    dtos: KomgaLibraryDto[], mappings: KomgaPathMapping[], omnibusLibraries: OmnibusLibraryRef[],
): ResolvedKomgaLibrary[] {
    const libs: { id: string; path: string }[] = [];
    for (const l of omnibusLibraries) {
        const path = normalizeKomgaPath(l.path);
        if (path) libs.push({ id: l.id, path });
    }
    return dtos.map(dto => {
        const root = normalizeKomgaPath(dto.root);
        const translatedRoot = root ? toOmnibusPath(root, mappings) : null;
        return {
            komgaLibraryId: dto.id,
            name: dto.name,
            root: root ?? (typeof dto.root === 'string' ? dto.root : ''),
            translatedRoot,
            omnibusLibraryId: translatedRoot ? pickOmnibusLibrary(translatedRoot, libs) : null,
            settings: snapshotLibrarySettings(dto),
            unavailable: dto.unavailable === true,
        };
    });
}

/**
 * Every Komga library that serves (part of) this Omnibus library: its translated root equals,
 * contains, or lies inside the Omnibus path. Runtime containment rather than the stored
 * omnibusLibraryId, because one Komga library over a parent folder serves several Omnibus
 * libraries. Unavailable libraries are included; the caller decides what to do with them.
 */
export function komgaLibrariesForOmnibusLibrary(
    omnibusLibrary: OmnibusLibraryRef, komgaLibs: ResolvedKomgaLibrary[],
): ResolvedKomgaLibrary[] {
    const path = normalizeKomgaPath(omnibusLibrary.path);
    if (!path) return [];
    return komgaLibs.filter(k => k.translatedRoot !== null
        && (isPathUnder(k.translatedRoot, path) || isPathUnder(path, k.translatedRoot)));
}

const STRONG = 'Strongly discouraged:';

/**
 * Setup warnings for one Komga library. `mappedOmnibusPaths` are the Omnibus library paths, used
 * to spot directory exclusions (and hidden folders) that hide them from Komga's scanner; pass the
 * saved `mappings` too when available so a more specific mapping row is honoured.
 */
export function computeLibraryWarnings(
    lib: ResolvedKomgaLibrary, ctx: { mappedOmnibusPaths: string[]; mappings?: KomgaPathMapping[] },
): string[] {
    const warnings: string[] = [];
    const s = lib.settings;
    const root = normalizeKomgaPath(lib.root);

    if (!root) {
        warnings.push('Komga did not report this library\'s root folder (the API key must belong to a Komga admin).');
    } else if (lib.translatedRoot === null) {
        warnings.push(`No path mapping covers the Komga folder ${root}: Omnibus cannot match this library's files.`);
    } else if (lib.omnibusLibraryId === null) {
        warnings.push(`No Omnibus library overlaps ${lib.translatedRoot} (Komga folder ${root}): check the path mappings.`);
    }
    if (lib.unavailable) {
        warnings.push('Komga reports this library\'s root folder as unavailable: its last scan could not read it.');
    }
    if (s.convertToCbz) {
        warnings.push(`${STRONG} "Convert to CBZ" is on. Komga rewrites and renames Omnibus's files, which breaks path matching and gives the books new Komga IDs.`);
    }
    if (s.repairExtensions) {
        warnings.push(`${STRONG} "Repair extensions" is on. Komga renames Omnibus's files, which breaks path matching and gives the books new Komga IDs.`);
    }
    if (!s.scanCbx) {
        warnings.push('Comic archive scanning (scanCbx) is off: Komga indexes no cbz, zip, cbr or rar file in this library.');
    }
    if (!s.hashFiles) {
        warnings.push('File hashing is off: Komga cannot carry read progress and read-list entries over when Omnibus renames, moves or converts a book.');
    }
    if (!s.importComicInfoBook) {
        warnings.push('"Import ComicInfo book metadata" is off: Komga ignores the ComicInfo.xml Omnibus writes, so books cannot be re-matched by their metadata links after a path change.');
    }
    if (s.importComicInfoReadList) {
        warnings.push('"Import ComicInfo read lists" is on: story-arc read lists Komga builds from ComicInfo.xml can collide with, or drift from, the reading lists Omnibus pushes.');
    }
    if (s.emptyTrashAfterScan) {
        warnings.push('"Empty trash after scan" is on: a book Omnibus renames or moves that Komga cannot match is deleted right after the scan, with its read progress and read-list entries.');
    }

    if (root) {
        const scan = { root, scanDirectoryExclusions: s.scanDirectoryExclusions };
        const rootSkip = komgaDirectorySkip(root, scan);
        if (rootSkip?.reason === 'excluded') {
            warnings.push(`Directory exclusion "${rootSkip.exclusion}" matches the library root ${root}: Komga indexes nothing in this library.`);
        } else if (rootSkip?.reason === 'hidden') {
            warnings.push(`The library root ${root} is a hidden folder (its name starts with "."): Komga indexes nothing in it.`);
        } else if (lib.translatedRoot !== null) {
            const translatedRoot = lib.translatedRoot;
            const seen = new Set<string>();
            for (const raw of ctx.mappedOmnibusPaths) {
                const path = normalizeKomgaPath(raw);
                // A mapped library above the Komga root reaches Komga only through the root,
                // which was checked above.
                if (!path || path === translatedRoot || seen.has(path) || !isPathUnder(path, translatedRoot)) continue;
                seen.add(path);
                const komgaDir = ctx.mappings
                    ? toKomgaPath(path, ctx.mappings)
                    : toKomgaPath(path, [{ omnibus: translatedRoot, komga: root }]);
                if (!komgaDir) continue;
                const skip = komgaDirectorySkip(komgaDir, scan);
                if (skip?.reason === 'excluded') {
                    warnings.push(`Directory exclusion "${skip.exclusion}" matches ${path}: Komga skips that folder.`);
                } else if (skip?.reason === 'hidden') {
                    warnings.push(`${path} is inside a hidden folder (a name starting with "."): Komga skips it.`);
                }
            }
        }
    }
    return warnings;
}

/** Warnings that span libraries: Omnibus libraries Komga never sees, and unreadable `.cb7` files. */
export function computeGlobalWarnings(
    komgaLibs: ResolvedKomgaLibrary[], omnibusLibraries: OmnibusLibraryRef[], cb7Count: number,
): string[] {
    const warnings: string[] = [];
    for (const lib of omnibusLibraries) {
        if (komgaLibrariesForOmnibusLibrary(lib, komgaLibs).length === 0) {
            warnings.push(`Omnibus library "${lib.name}" (${lib.path}) is not inside any Komga library: Komga will not see its files.`);
        }
    }
    if (cb7Count > 0) {
        warnings.push(`${cb7Count} .cb7 file${cb7Count === 1 ? '' : 's'} in libraries Komga serves will never appear in Komga: it cannot read 7z archives.`);
    }
    return warnings;
}

// Postgres LIKE is case-sensitive (SQLite's is not), and Prisma's `mode: 'insensitive'` does not
// exist on SQLite — so spell out the case variants of the extension.
const CB7_SUFFIXES = ['.cb7', '.CB7', '.Cb7', '.cB7'];

/**
 * Number of `.cb7` issues under the given Omnibus library paths — one indexed count, no file
 * system access. A DB failure only loses the warning, so it counts as 0.
 */
export async function countCb7InLibraries(paths: string[]): Promise<number> {
    const prefixes = new Set<string>();
    for (const p of paths) {
        if (typeof p !== 'string' || p.trim() === '') continue;
        const trimmed = p.replace(/\/+$/, '');
        prefixes.add(trimmed === '' ? '/' : `${trimmed}/`);
    }
    if (prefixes.size === 0) return 0;
    try {
        return await prisma.issue.count({
            where: {
                AND: [
                    { OR: CB7_SUFFIXES.map(suffix => ({ filePath: { endsWith: suffix } })) },
                    { OR: Array.from(prefixes, prefix => ({ filePath: { startsWith: prefix } })) },
                ],
            },
        });
    } catch (e) {
        Logger.log(`[Komga] Could not count .cb7 files: ${getErrorMessage(e)}`, 'warn');
        return 0;
    }
}

/**
 * Replace the KomgaLibrary cache with `resolved` (upsert each, delete the rest) in one array-form
 * transaction. Never throws: a stale cache is refreshed on the next successful listLibraries.
 */
export async function persistKomgaLibraries(resolved: ResolvedKomgaLibrary[]): Promise<void> {
    const byId = new Map<string, ResolvedKomgaLibrary>();
    for (const lib of resolved) byId.set(lib.komgaLibraryId, lib);
    const lastSeenAt = new Date();
    try {
        await prisma.$transaction([
            ...Array.from(byId.values(), lib => {
                const data = {
                    name: lib.name,
                    root: lib.root,
                    translatedRoot: lib.translatedRoot,
                    omnibusLibraryId: lib.omnibusLibraryId,
                    settings: JSON.stringify(lib.settings),
                    unavailable: lib.unavailable,
                    lastSeenAt,
                };
                return prisma.komgaLibrary.upsert({
                    where: { komgaLibraryId: lib.komgaLibraryId },
                    create: { komgaLibraryId: lib.komgaLibraryId, ...data },
                    update: data,
                });
            }),
            prisma.komgaLibrary.deleteMany({ where: { komgaLibraryId: { notIn: Array.from(byId.keys()) } } }),
        ]);
    } catch (e) {
        Logger.log(`[Komga] Could not cache the Komga library list: ${getErrorMessage(e)}`, 'warn');
    }
}

/** The cached libraries (DB errors propagate). A corrupt settings column falls back to Komga's defaults. */
export async function loadCachedKomgaLibraries(): Promise<ResolvedKomgaLibrary[]> {
    const rows = await prisma.komgaLibrary.findMany({ orderBy: { name: 'asc' } });
    return rows.map(row => {
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(row.settings);
        } catch {
            // fall through to defaults
        }
        return {
            komgaLibraryId: row.komgaLibraryId,
            name: row.name,
            root: row.root,
            translatedRoot: row.translatedRoot,
            omnibusLibraryId: row.omnibusLibraryId,
            settings: coerceSettings(parsed),
            unavailable: row.unavailable,
        };
    });
}

/**
 * listLibraries → resolve against the Omnibus libraries → persist → return. HTTP errors
 * (KomgaError) propagate; the DB write happens after the HTTP call, never inside a transaction
 * that waits on it.
 */
export async function refreshKomgaLibraries(client: KomgaClient, mappings: KomgaPathMapping[]): Promise<ResolvedKomgaLibrary[]> {
    const dtos = await client.listLibraries();
    const omnibusLibraries = await prisma.library.findMany({ select: { id: true, name: true, path: true } });
    const resolved = resolveKomgaLibraries(dtos, mappings, omnibusLibraries);
    await persistKomgaLibraries(resolved);
    return resolved;
}
