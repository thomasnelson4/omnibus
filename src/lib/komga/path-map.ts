// src/lib/komga/path-map.ts
//
// Omnibus <-> Komga path translation and Komga's own "would the scanner index this file?" rule.
// Pure (no DB, no logger) so the hot-path settings module and client components can import it.
//
// Every path comparison in the Komga integration goes through normalizeKomgaPath: Komga runs in
// its own container with its own mounts, and a single unnormalized comparison (trailing slash,
// NFD file name from a macOS share, a Windows backslash) silently breaks book identity. Unlike
// isPathWithinRoots, comparisons here are CASE-SENSITIVE — both sides are Linux file systems in
// the common deployment, and Komga itself matches books by exact URL.
//
// Mapping rules follow Shelfmark's core/path_mappings.py: longest prefix first, folder boundary
// only (/data/comics never matches /data/comics2), and no '..' traversal out of a prefix.

export interface KomgaPathMapping { omnibus: string; komga: string }

/**
 * Canonical form of a path for comparison: '\' → '/', repeated '/' collapsed, '.' segments
 * dropped, trailing '/' trimmed ('/' itself kept), Unicode NFC. Returns null for empty input or
 * any '..' segment. Komga's BookDto.url / LibraryDto.root are plain file-system paths
 * (`URL.toFilePath()` in infrastructure/web/Utils.kt), but a `file:` URL is accepted too.
 */
export function normalizeKomgaPath(p: string | null | undefined): string | null {
    if (typeof p !== 'string' || p.trim() === '' || p.includes('\0')) return null;
    let s = p;
    if (/^file:/i.test(s)) {
        const fromUrl = filePathFromUrl(s);
        if (fromUrl === null) return null;
        s = fromUrl;
    }
    s = s.replace(/\\/g, '/').normalize('NFC');
    const absolute = s.startsWith('/');
    const segments: string[] = [];
    for (const seg of s.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') return null;
        segments.push(seg);
    }
    if (segments.length === 0) return absolute ? '/' : null;
    return (absolute ? '/' : '') + segments.join('/');
}

// file:///a/b, file://localhost/a/b and Java's file:/a/b → /a/b (percent-decoded). A remote
// authority (UNC share) has no meaning on this side of the mapping, so it is rejected.
function filePathFromUrl(url: string): string | null {
    const m = /^file:(?:\/\/([^/]*))?(\/.*)?$/i.exec(url);
    if (!m) return null;
    const authority = m[1] ?? '';
    if (authority !== '' && authority.toLowerCase() !== 'localhost') return null;
    let decoded: string;
    try {
        decoded = decodeURIComponent(m[2] ?? '');
    } catch {
        return null;
    }
    // file:/C:/comics → C:/comics
    return /^\/[A-Za-z]:(\/|$)/.test(decoded) ? decoded.slice(1) : decoded;
}

/**
 * Tolerant parse of the stored `komga_path_mappings` JSON. Junk JSON, a non-array, rows without
 * both string sides, and rows whose side does not normalize are dropped; both sides come back
 * normalized, exact duplicates removed. Also accepts an already-parsed array (route bodies).
 */
export function parsePathMappings(raw: unknown): KomgaPathMapping[] {
    let rows: unknown = raw;
    if (typeof raw === 'string') {
        if (raw.trim() === '') return [];
        try {
            rows = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(rows)) return [];
    const out: KomgaPathMapping[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const { omnibus, komga } = row as Record<string, unknown>;
        if (typeof omnibus !== 'string' || typeof komga !== 'string') continue;
        const o = normalizeKomgaPath(omnibus.trim());
        const k = normalizeKomgaPath(komga.trim());
        if (!o || !k) continue;
        const key = `${o}\0${k}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ omnibus: o, komga: k });
    }
    return out;
}

/** Stored form. Keeps rows as given (only the two keys) so a half-edited row is not lost. */
export function serializePathMappings(m: KomgaPathMapping[]): string {
    return JSON.stringify(m.map(r => ({ omnibus: String(r.omnibus ?? ''), komga: String(r.komga ?? '') })));
}

// Both arguments already normalized.
function isUnderNormalized(child: string, parent: string): boolean {
    if (child === parent) return true;
    return child.startsWith(parent === '/' ? '/' : parent + '/');
}

/** True when `child` equals `parent` or lies below it at a folder boundary (normalized, case-sensitive). */
export function isPathUnder(child: string, parent: string): boolean {
    const c = normalizeKomgaPath(child);
    const p = normalizeKomgaPath(parent);
    if (!c || !p) return false;
    return isUnderNormalized(c, p);
}

// Swap the `from` prefix of `path` (normalized, known to be under `from`) for `to`.
function rebase(path: string, from: string, to: string): string | null {
    const remainder = from === '/' ? path.slice(1) : path.slice(from.length + 1);
    if (remainder === '') return to;
    return normalizeKomgaPath(to === '/' ? `/${remainder}` : `${to}/${remainder}`);
}

function translate(input: string, mappings: KomgaPathMapping[], fromSide: 'omnibus' | 'komga'): string | null {
    const path = normalizeKomgaPath(input);
    if (!path) return null;
    if (mappings.length === 0) return path;
    const toSide = fromSide === 'omnibus' ? 'komga' : 'omnibus';
    // Callers may hand in rows that never went through parsePathMappings — normalize defensively.
    const candidates: { from: string; to: string }[] = [];
    for (const m of mappings) {
        const from = normalizeKomgaPath(m?.[fromSide]);
        const to = normalizeKomgaPath(m?.[toSide]);
        if (from && to) candidates.push({ from, to });
    }
    // Stable sort: on an exact tie the earlier row wins.
    candidates.sort((a, b) => b.from.length - a.from.length);
    for (const c of candidates) {
        if (isUnderNormalized(path, c.from)) return rebase(path, c.from, c.to);
    }
    return null;
}

/**
 * Omnibus path → the path Komga sees. Empty mappings = identity (same mounts on both sides);
 * with mappings, a path no prefix covers is not visible to Komga → null.
 */
export function toKomgaPath(omnibusPath: string, mappings: KomgaPathMapping[]): string | null {
    return translate(omnibusPath, mappings, 'omnibus');
}

/** Komga path (BookDto.url, LibraryDto.root) → the Omnibus path. Same rules as toKomgaPath. */
export function toOmnibusPath(komgaPath: string, mappings: KomgaPathMapping[]): string | null {
    return translate(komgaPath, mappings, 'komga');
}

export interface KomgaScanSettings { root: string; scanCbx: boolean; scanPdf: boolean; scanEpub: boolean; scanDirectoryExclusions: string[] }

// Kotlin's Char.equals(other, ignoreCase = true), per UTF-16 unit: upper-case compare, then the
// lower case of the upper case. A JS case mapping that changes length ('ß' → 'SS') is not a
// Char mapping on the JVM, so the character is kept as is.
function charUpper(c: string): string {
    const u = c.toUpperCase();
    return u.length === 1 ? u : c;
}
function charLower(c: string): string {
    const l = c.toLowerCase();
    return l.length === 1 ? l : c;
}
function charEqualsIgnoreCase(a: string, b: string): boolean {
    if (a === b) return true;
    const ua = charUpper(a);
    const ub = charUpper(b);
    return ua === ub || charLower(ua) === charLower(ub);
}

// Kotlin's String.contains(other, ignoreCase = true). An empty needle matches (as in Kotlin).
function containsIgnoreCase(haystack: string, needle: string): boolean {
    const last = haystack.length - needle.length;
    for (let i = 0; i <= last; i++) {
        let j = 0;
        while (j < needle.length && charEqualsIgnoreCase(haystack[i + j], needle[j])) j++;
        if (j === needle.length) return true;
    }
    return false;
}

// Replicated from Komga's FileSystemScanner.scanRootFolder
// (komga/src/main/kotlin/org/gotson/komga/domain/service/FileSystemScanner.kt, unchanged in this
// respect from 1.10.0 to 1.28.1; LibraryContentLifecycle.scanRootFolder passes the library's flags):
// - preVisitDirectory skips a directory whose NAME starts with '.' — the root folder included,
//   folders above the root not — and visitFile skips files whose name starts with '.'.
// - preVisitDirectory also skips a directory whose full path string contains any
//   scanDirectoryExclusions entry, case-insensitively: a substring, not a segment match. Each
//   directory's path is a prefix of its children's, so testing a directory's own path is
//   equivalent to testing every directory from the root down to it.
// - visitFile keeps a file when its lower-cased extension is enabled: scanCbx → cbz, zip, cbr AND
//   rar (the flag gates all four, not just RAR); scanPdf → pdf; scanEpub → epub. Never cb7/7z —
//   Komga cannot read 7z archives.

export type KomgaDirectorySkip = { reason: 'outside' } | { reason: 'hidden' } | { reason: 'excluded'; exclusion: string };

/**
 * Why Komga's scanner would not walk this Komga-side directory (the library root or below it),
 * or null when it does. 'outside' = not under the library root at all.
 */
export function komgaDirectorySkip(komgaDir: string, lib: Pick<KomgaScanSettings, 'root' | 'scanDirectoryExclusions'>): KomgaDirectorySkip | null {
    const dir = normalizeKomgaPath(komgaDir);
    const root = normalizeKomgaPath(lib.root);
    if (!dir || !root || !isUnderNormalized(dir, root)) return { reason: 'outside' };

    const names = [root === '/' ? '' : root.slice(root.lastIndexOf('/') + 1)];
    if (dir !== root) names.push(...(root === '/' ? dir.slice(1) : dir.slice(root.length + 1)).split('/'));
    if (names.some(name => name.startsWith('.'))) return { reason: 'hidden' };

    // Exclusions get the same separator/Unicode treatment as the path, nothing more: trimming or
    // collapsing would change which directories Komga's substring match hits.
    for (const exclusion of lib.scanDirectoryExclusions ?? []) {
        if (typeof exclusion !== 'string') continue;
        if (containsIgnoreCase(dir, exclusion.replace(/\\/g, '/').normalize('NFC'))) return { reason: 'excluded', exclusion };
    }
    return null;
}

/** Would Komga's scanner index this file? `komgaPath` and `lib.root` are Komga-side paths. */
export function isKomgaScannable(komgaPath: string, lib: KomgaScanSettings): boolean {
    const path = normalizeKomgaPath(komgaPath);
    const root = normalizeKomgaPath(lib.root);
    if (!path || !root || path === root || !isUnderNormalized(path, root)) return false;

    const slash = path.lastIndexOf('/');
    const fileName = path.slice(slash + 1);
    if (fileName.startsWith('.')) return false;
    if (komgaDirectorySkip(slash <= 0 ? '/' : path.slice(0, slash), lib)) return false;

    const dot = fileName.lastIndexOf('.');
    const extension = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
    switch (extension) {
        case 'cbz': case 'zip': case 'cbr': case 'rar': return lib.scanCbx;
        case 'pdf': return lib.scanPdf;
        case 'epub': return lib.scanEpub;
        default: return false;
    }
}
