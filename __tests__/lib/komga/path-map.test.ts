// Komga path translation: every comparison between an Omnibus path and a Komga path goes through
// this normalizer + prefix mapper, and isKomgaScannable mirrors Komga's FileSystemScanner rules.
import { describe, it, expect } from 'vitest';
import {
    normalizeKomgaPath, parsePathMappings, serializePathMappings, isPathUnder,
    toKomgaPath, toOmnibusPath, isKomgaScannable, komgaDirectorySkip,
    type KomgaPathMapping, type KomgaScanSettings,
} from '@/lib/komga/path-map';

const NFD_E = 'e\u0301'; // "é" decomposed, as macOS / SMB shares often hand it over
const NFC_E = '\u00e9';

describe('normalizeKomgaPath', () => {
    it('turns backslashes into slashes, collapses repeats and trims trailing slashes', () => {
        expect(normalizeKomgaPath('\\data\\comics\\')).toBe('/data/comics');
        expect(normalizeKomgaPath('/data//comics///Batman/')).toBe('/data/comics/Batman');
        expect(normalizeKomgaPath('C:\\Comics\\Batman')).toBe('C:/Comics/Batman');
    });

    it('keeps the root slash itself and drops "." segments', () => {
        expect(normalizeKomgaPath('/')).toBe('/');
        expect(normalizeKomgaPath('///')).toBe('/');
        expect(normalizeKomgaPath('/data/./comics/.')).toBe('/data/comics');
    });

    it('converts to Unicode NFC', () => {
        expect(normalizeKomgaPath(`/data/Pok${NFD_E}mon`)).toBe(`/data/Pok${NFC_E}mon`);
    });

    it('rejects any ".." segment, empty input and NUL bytes', () => {
        expect(normalizeKomgaPath('/data/comics/../etc')).toBeNull();
        expect(normalizeKomgaPath('..\\secret')).toBeNull();
        expect(normalizeKomgaPath('')).toBeNull();
        expect(normalizeKomgaPath('   ')).toBeNull();
        expect(normalizeKomgaPath(null)).toBeNull();
        expect(normalizeKomgaPath(undefined)).toBeNull();
        expect(normalizeKomgaPath('/data/a\0b')).toBeNull();
    });

    it('keeps names that merely contain dots', () => {
        expect(normalizeKomgaPath('/data/..hidden/...')).toBe('/data/..hidden/...');
    });

    it('is case-sensitive', () => {
        expect(normalizeKomgaPath('/Data/Comics')).toBe('/Data/Comics');
    });

    it('accepts file: URLs (Java and RFC forms), percent-decoded', () => {
        expect(normalizeKomgaPath('file:/comics/Batman%20001.cbz')).toBe('/comics/Batman 001.cbz');
        expect(normalizeKomgaPath('file:///comics/a.cbz')).toBe('/comics/a.cbz');
        expect(normalizeKomgaPath('file://localhost/comics/a.cbz')).toBe('/comics/a.cbz');
        expect(normalizeKomgaPath('file:/C:/Comics/a.cbz')).toBe('C:/Comics/a.cbz');
        expect(normalizeKomgaPath('file://server/share/a.cbz')).toBeNull();
        expect(normalizeKomgaPath('file:/comics/%E0%A4%A')).toBeNull();
    });

    it('does not percent-decode plain paths', () => {
        expect(normalizeKomgaPath('/comics/100%25 Batman')).toBe('/comics/100%25 Batman');
    });
});

describe('isPathUnder', () => {
    it('matches equal paths and folder-boundary prefixes only', () => {
        expect(isPathUnder('/data/comics', '/data/comics')).toBe(true);
        expect(isPathUnder('/data/comics/Batman/1.cbz', '/data/comics/')).toBe(true);
        expect(isPathUnder('/data/comics2/Batman', '/data/comics')).toBe(false);
        expect(isPathUnder('/data', '/data/comics')).toBe(false);
    });

    it('treats "/" as the parent of every absolute path', () => {
        expect(isPathUnder('/anything/here', '/')).toBe(true);
    });

    it('is case-sensitive and Unicode-normalized', () => {
        expect(isPathUnder('/Data/comics/x', '/data/comics')).toBe(false);
        expect(isPathUnder(`/data/Pok${NFD_E}mon/1.cbz`, `/data/Pok${NFC_E}mon`)).toBe(true);
    });

    it('is false when either side is invalid', () => {
        expect(isPathUnder('/data/../etc', '/data')).toBe(false);
        expect(isPathUnder('/data/x', '')).toBe(false);
    });
});

describe('toKomgaPath / toOmnibusPath', () => {
    const mappings: KomgaPathMapping[] = [
        { omnibus: '/data/comics', komga: '/comics' },
        { omnibus: '/data/comics/manga', komga: '/manga' },
        { omnibus: '/mnt/other', komga: '/' },
    ];

    it('translates in both directions', () => {
        expect(toKomgaPath('/data/comics/Batman/Batman 001.cbz', mappings)).toBe('/comics/Batman/Batman 001.cbz');
        expect(toOmnibusPath('/comics/Batman/Batman 001.cbz', mappings)).toBe('/data/comics/Batman/Batman 001.cbz');
    });

    it('maps the prefix itself', () => {
        expect(toKomgaPath('/data/comics/', mappings)).toBe('/comics');
        expect(toOmnibusPath('/comics', mappings)).toBe('/data/comics');
    });

    it('uses the longest matching prefix, whatever the row order', () => {
        expect(toKomgaPath('/data/comics/manga/One Piece/1.cbz', mappings)).toBe('/manga/One Piece/1.cbz');
        expect(toOmnibusPath('/manga/One Piece/1.cbz', mappings)).toBe('/data/comics/manga/One Piece/1.cbz');
        // On the Komga side '/' is the shortest prefix, so '/comics' and '/manga' win over it.
        expect(toOmnibusPath('/other/x.cbz', mappings)).toBe('/mnt/other/other/x.cbz');
    });

    it('matches only at folder boundaries', () => {
        expect(toKomgaPath('/data/comics2/Batman/1.cbz', mappings)).toBeNull();
        expect(toOmnibusPath('/comicsX/1.cbz', [{ omnibus: '/data/comics', komga: '/comics' }])).toBeNull();
    });

    it('rebases a "/" prefix on either side', () => {
        expect(toKomgaPath('/mnt/other/a/b.cbz', mappings)).toBe('/a/b.cbz');
        expect(toKomgaPath('/x/y.cbz', [{ omnibus: '/', komga: '/srv' }])).toBe('/srv/x/y.cbz');
        expect(toKomgaPath('/', [{ omnibus: '/', komga: '/srv' }])).toBe('/srv');
    });

    it('normalizes the input before matching (NFD, backslashes, trailing slashes)', () => {
        const m = [{ omnibus: `/data/Pok${NFC_E}mon`, komga: '/pokemon' }];
        expect(toKomgaPath(`/data/Pok${NFD_E}mon/1.cbz`, m)).toBe('/pokemon/1.cbz');
        expect(toOmnibusPath('\\comics\\Batman\\1.cbz', mappings)).toBe('/data/comics/Batman/1.cbz');
        expect(toOmnibusPath('/comics/Batman//', mappings)).toBe('/data/comics/Batman');
    });

    it('normalizes mapping rows that never went through parsePathMappings', () => {
        const raw = [{ omnibus: '\\data\\comics\\', komga: '/comics/' }];
        expect(toKomgaPath('/data/comics/a.cbz', raw)).toBe('/comics/a.cbz');
        // An invalid row is ignored rather than matched.
        expect(toKomgaPath('/x/a.cbz', [{ omnibus: '/x/../y', komga: '/y' }])).toBeNull();
    });

    it('rejects ".." traversal', () => {
        expect(toKomgaPath('/data/comics/../../etc/passwd', mappings)).toBeNull();
        expect(toOmnibusPath('/comics/../etc', mappings)).toBeNull();
    });

    it('is case-sensitive', () => {
        expect(toKomgaPath('/Data/Comics/a.cbz', mappings)).toBeNull();
    });

    it('is the (normalized) identity with no mappings', () => {
        expect(toKomgaPath('/data/comics/a.cbz/', [])).toBe('/data/comics/a.cbz');
        expect(toOmnibusPath(`\\comics\\Pok${NFD_E}mon`, [])).toBe(`/comics/Pok${NFC_E}mon`);
        expect(toKomgaPath('/a/../b', [])).toBeNull();
    });

    it('returns null for a path no mapping covers', () => {
        expect(toKomgaPath('/elsewhere/a.cbz', [{ omnibus: '/data', komga: '/comics' }])).toBeNull();
        expect(toOmnibusPath('/elsewhere/a.cbz', [{ omnibus: '/data', komga: '/comics' }])).toBeNull();
    });

    it('lets the first of two identical prefixes win', () => {
        const dup = [{ omnibus: '/a', komga: '/first' }, { omnibus: '/a', komga: '/second' }];
        expect(toKomgaPath('/a/x', dup)).toBe('/first/x');
    });
});

describe('parsePathMappings / serializePathMappings', () => {
    it('parses and normalizes both sides', () => {
        expect(parsePathMappings('[{"omnibus":" /data/comics/ ","komga":"\\\\comics\\\\"}]'))
            .toEqual([{ omnibus: '/data/comics', komga: '/comics' }]);
    });

    it('tolerates junk', () => {
        expect(parsePathMappings('not json')).toEqual([]);
        expect(parsePathMappings('{"omnibus":"/a","komga":"/b"}')).toEqual([]);
        expect(parsePathMappings('')).toEqual([]);
        expect(parsePathMappings(null)).toEqual([]);
        expect(parsePathMappings(undefined)).toEqual([]);
        expect(parsePathMappings('42')).toEqual([]);
    });

    it('drops invalid rows and exact duplicates, keeping the rest in order', () => {
        const raw = JSON.stringify([
            null, 'str', 7, [],
            { omnibus: '/a' },
            { omnibus: '/a', komga: 5 },
            { omnibus: '', komga: '/b' },
            { omnibus: '/x/../y', komga: '/b' },
            { omnibus: '/a', komga: '/b' },
            { omnibus: '/a/', komga: '/b/' },
            { omnibus: '/c', komga: '/d', extra: true },
        ]);
        expect(parsePathMappings(raw)).toEqual([
            { omnibus: '/a', komga: '/b' },
            { omnibus: '/c', komga: '/d' },
        ]);
    });

    it('accepts an already-parsed array', () => {
        expect(parsePathMappings([{ omnibus: '/a', komga: '/b' }])).toEqual([{ omnibus: '/a', komga: '/b' }]);
    });

    it('serializes only the two keys and round-trips', () => {
        const rows = [{ omnibus: '/data/comics', komga: '/comics', extra: 1 } as KomgaPathMapping];
        const json = serializePathMappings(rows);
        expect(JSON.parse(json)).toEqual([{ omnibus: '/data/comics', komga: '/comics' }]);
        expect(parsePathMappings(json)).toEqual([{ omnibus: '/data/comics', komga: '/comics' }]);
    });

    it('keeps a half-edited row when serializing', () => {
        expect(JSON.parse(serializePathMappings([{ omnibus: '/a', komga: '' }]))).toEqual([{ omnibus: '/a', komga: '' }]);
    });
});

describe('isKomgaScannable', () => {
    const lib: KomgaScanSettings = { root: '/comics', scanCbx: true, scanPdf: true, scanEpub: true, scanDirectoryExclusions: [] };

    it.each(['cbz', 'zip', 'cbr', 'rar', 'pdf', 'epub', 'CBZ', 'Cbr', 'PDF', 'EPUB', 'ZIP', 'RAR'])(
        'indexes .%s when every type is on', ext => {
            expect(isKomgaScannable(`/comics/Batman/Batman 001.${ext}`, lib)).toBe(true);
        });

    it.each(['cb7', '7z', 'CB7', 'cbt', 'tar', 'jpg', 'xml', 'txt', 'json'])('never indexes .%s', ext => {
        expect(isKomgaScannable(`/comics/Batman/Batman 001.${ext}`, lib)).toBe(false);
    });

    it('needs an extension after the last dot', () => {
        expect(isKomgaScannable('/comics/Batman/cbz', lib)).toBe(false);
        expect(isKomgaScannable('/comics/Batman/Batman.', lib)).toBe(false);
        expect(isKomgaScannable('/comics/Batman/Batman.v2.cbz', lib)).toBe(true);
    });

    it('gates cbz, zip, cbr and rar together on scanCbx (Komga 1.10+)', () => {
        const off = { ...lib, scanCbx: false };
        for (const ext of ['cbz', 'zip', 'cbr', 'rar']) expect(isKomgaScannable(`/comics/a.${ext}`, off)).toBe(false);
        expect(isKomgaScannable('/comics/a.pdf', off)).toBe(true);
        expect(isKomgaScannable('/comics/a.epub', off)).toBe(true);
    });

    it('gates pdf on scanPdf and epub on scanEpub', () => {
        expect(isKomgaScannable('/comics/a.pdf', { ...lib, scanPdf: false })).toBe(false);
        expect(isKomgaScannable('/comics/a.epub', { ...lib, scanPdf: false })).toBe(true);
        expect(isKomgaScannable('/comics/a.epub', { ...lib, scanEpub: false })).toBe(false);
        expect(isKomgaScannable('/comics/a.cbz', { ...lib, scanPdf: false, scanEpub: false })).toBe(true);
    });

    it('skips hidden files and anything inside hidden folders below the root', () => {
        expect(isKomgaScannable('/comics/Batman/.Batman 001.cbz', lib)).toBe(false);
        expect(isKomgaScannable('/comics/.hidden/Batman 001.cbz', lib)).toBe(false);
        expect(isKomgaScannable('/comics/.hidden/sub/Batman 001.cbz', lib)).toBe(false);
        expect(isKomgaScannable('/comics/Batman/..cbz', lib)).toBe(false);
    });

    it('skips everything when the root folder itself is hidden, but ignores folders above the root', () => {
        expect(isKomgaScannable('/data/.comics/a.cbz', { ...lib, root: '/data/.comics' })).toBe(false);
        expect(isKomgaScannable('/home/.config/comics/a.cbz', { ...lib, root: '/home/.config/comics' })).toBe(true);
    });

    it('applies exclusions as case-insensitive substrings of the directory path', () => {
        const ex = { ...lib, scanDirectoryExclusions: ['#recycle', '@eaDir'] };
        expect(isKomgaScannable('/comics/#recycle/a.cbz', ex)).toBe(false);
        expect(isKomgaScannable('/comics/Batman/@EADIR/sub/a.cbz', ex)).toBe(false);
        // A substring, not a segment: "old#recycled" contains "#recycle".
        expect(isKomgaScannable('/comics/old#recycled/a.cbz', ex)).toBe(false);
        expect(isKomgaScannable('/comics/Batman/a.cbz', ex)).toBe(true);
    });

    it('matches exclusions against directories only, never the file name', () => {
        expect(isKomgaScannable('/comics/Batman/#recycle.cbz', { ...lib, scanDirectoryExclusions: ['#recycle'] })).toBe(true);
    });

    it('matches exclusions across the whole directory path, root included', () => {
        expect(isKomgaScannable('/comics/Marvel/Spider-Man/a.cbz', { ...lib, scanDirectoryExclusions: ['marvel/spider'] })).toBe(false);
        expect(isKomgaScannable('/comics/a.cbz', { ...lib, scanDirectoryExclusions: ['COMICS'] })).toBe(false);
        // An empty exclusion matches every path in Komga, so nothing is indexed.
        expect(isKomgaScannable('/comics/a.cbz', { ...lib, scanDirectoryExclusions: [''] })).toBe(false);
    });

    it('requires a path strictly under the (normalized) root', () => {
        expect(isKomgaScannable('/comics', lib)).toBe(false);
        expect(isKomgaScannable('/comics2/a.cbz', lib)).toBe(false);
        expect(isKomgaScannable('/other/a.cbz', lib)).toBe(false);
        expect(isKomgaScannable('\\comics\\Batman\\a.cbz', { ...lib, root: '/comics/' })).toBe(true);
        expect(isKomgaScannable('/comics/../etc/a.cbz', lib)).toBe(false);
        expect(isKomgaScannable('/comics/a.cbz', { ...lib, root: '' })).toBe(false);
    });

    it('works with "/" as the root', () => {
        expect(isKomgaScannable('/a.cbz', { ...lib, root: '/' })).toBe(true);
        expect(isKomgaScannable('/x/a.cbz', { ...lib, root: '/' })).toBe(true);
        expect(isKomgaScannable('/.x/a.cbz', { ...lib, root: '/' })).toBe(false);
    });

    it('compares exclusions after Unicode normalization', () => {
        expect(isKomgaScannable(`/comics/Pok${NFD_E}mon/a.cbz`, { ...lib, scanDirectoryExclusions: [`pok${NFC_E}mon`] })).toBe(false);
    });
});

describe('komgaDirectorySkip', () => {
    const lib = { root: '/comics', scanDirectoryExclusions: ['@eaDir'] };

    it('reports why a directory is not walked', () => {
        expect(komgaDirectorySkip('/comics/Batman', lib)).toBeNull();
        expect(komgaDirectorySkip('/comics', lib)).toBeNull();
        expect(komgaDirectorySkip('/comics/.git', lib)).toEqual({ reason: 'hidden' });
        expect(komgaDirectorySkip('/comics/x/@eadir', lib)).toEqual({ reason: 'excluded', exclusion: '@eaDir' });
        expect(komgaDirectorySkip('/elsewhere', lib)).toEqual({ reason: 'outside' });
    });
});
