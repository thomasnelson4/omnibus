// Komga library discovery: Omnibus <-> Komga library resolution, the setup warnings the Media
// Servers tab shows, and the KomgaLibrary cache table (mocked Prisma — no test uses a real DB).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loggerLog } from '../../helpers/setup-global';

vi.mock('@/lib/db', () => ({
    prisma: {
        $transaction: vi.fn(),
        komgaLibrary: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
        issue: { count: vi.fn() },
        library: { findMany: vi.fn() },
    },
}));

import { prisma } from '@/lib/db';
import type { KomgaLibraryDto } from '@/lib/komga/types';
import type { KomgaClient } from '@/lib/komga/client';
import {
    snapshotLibrarySettings, resolveKomgaLibraries, komgaLibrariesForOmnibusLibrary,
    computeLibraryWarnings, computeGlobalWarnings, countCb7InLibraries,
    persistKomgaLibraries, loadCachedKomgaLibraries, refreshKomgaLibraries,
    type ResolvedKomgaLibrary, type OmnibusLibraryRef, type KomgaLibrarySettingsSnapshot,
} from '@/lib/komga/libraries';

const db = prisma as any;

function dto(over: Partial<KomgaLibraryDto> = {}): KomgaLibraryDto {
    return {
        id: 'k1', name: 'Comics', root: '/comics',
        importComicInfoBook: true, importComicInfoSeries: true, importComicInfoCollection: true,
        importComicInfoReadList: false, importComicInfoSeriesAppendVolume: true, importEpubBook: true,
        importEpubSeries: true, importMylarSeries: true, importLocalArtwork: true, importBarcodeIsbn: true,
        scanForceModifiedTime: false, scanInterval: 'EVERY_6H', scanOnStartup: false,
        scanCbx: true, scanPdf: true, scanEpub: true, scanDirectoryExclusions: ['#recycle', '@eaDir'],
        repairExtensions: false, convertToCbz: false, emptyTrashAfterScan: false, seriesCover: 'FIRST',
        hashFiles: true, hashPages: false, hashKoreader: false, analyzeDimensions: true,
        oneshotsDirectory: null, unavailable: false,
        ...over,
    };
}

// A Komga library with every warning-relevant flag in its "good" position.
const QUIET: KomgaLibrarySettingsSnapshot = {
    hashFiles: true, importComicInfoBook: true, importComicInfoReadList: false, emptyTrashAfterScan: false,
    scanForceModifiedTime: false, convertToCbz: false, repairExtensions: false,
    scanCbx: true, scanPdf: true, scanEpub: true, scanDirectoryExclusions: [], oneshotsDirectory: null,
};

function resolved(over: Partial<ResolvedKomgaLibrary> = {}, settings: Partial<KomgaLibrarySettingsSnapshot> = {}): ResolvedKomgaLibrary {
    return {
        komgaLibraryId: 'k1', name: 'Comics', root: '/comics', translatedRoot: '/data/comics',
        omnibusLibraryId: 'o1', settings: { ...QUIET, ...settings }, unavailable: false,
        ...over,
    };
}

const lib = (id: string, path: string, name = id): OmnibusLibraryRef => ({ id, name, path });

beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockResolvedValue([]);
    db.komgaLibrary.upsert.mockImplementation((args: unknown) => ({ op: 'upsert', args }));
    db.komgaLibrary.deleteMany.mockImplementation((args: unknown) => ({ op: 'deleteMany', args }));
});

describe('snapshotLibrarySettings', () => {
    it('keeps exactly the flags the integration reasons about', () => {
        expect(snapshotLibrarySettings(dto({ oneshotsDirectory: '_oneshots' }))).toEqual({
            hashFiles: true, importComicInfoBook: true, importComicInfoReadList: false, emptyTrashAfterScan: false,
            scanForceModifiedTime: false, convertToCbz: false, repairExtensions: false,
            scanCbx: true, scanPdf: true, scanEpub: true, scanDirectoryExclusions: ['#recycle', '@eaDir'],
            oneshotsDirectory: '_oneshots',
        });
    });

    it('fills Komga defaults for missing or mistyped fields', () => {
        const partial = { id: 'k', name: 'n', root: '/r', hashFiles: 'yes', scanDirectoryExclusions: ['a', 3] } as unknown as KomgaLibraryDto;
        const s = snapshotLibrarySettings(partial);
        expect(s.hashFiles).toBe(true);
        expect(s.importComicInfoReadList).toBe(true);
        expect(s.convertToCbz).toBe(false);
        expect(s.scanDirectoryExclusions).toEqual(['a']);
        expect(s.oneshotsDirectory).toBeNull();
    });
});

describe('resolveKomgaLibraries', () => {
    const mappings = [{ omnibus: '/data/comics', komga: '/comics' }];

    it('maps a Komga library whose translated root equals an Omnibus library', () => {
        const [r] = resolveKomgaLibraries([dto()], mappings, [lib('o1', '/data/comics'), lib('o2', '/data/manga')]);
        expect(r).toEqual(expect.objectContaining({
            komgaLibraryId: 'k1', name: 'Comics', root: '/comics', translatedRoot: '/data/comics', omnibusLibraryId: 'o1', unavailable: false,
        }));
        expect(r.settings.scanDirectoryExclusions).toEqual(['#recycle', '@eaDir']);
    });

    it('normalizes both sides before comparing', () => {
        const [r] = resolveKomgaLibraries([dto({ root: '\\comics\\' })], mappings, [lib('o1', '/data/comics/')]);
        expect(r.root).toBe('/comics');
        expect(r.omnibusLibraryId).toBe('o1');
    });

    it('prefers an exact match over containment', () => {
        const [r] = resolveKomgaLibraries([dto()], mappings, [lib('parent', '/data'), lib('exact', '/data/comics'), lib('child', '/data/comics/x')]);
        expect(r.omnibusLibraryId).toBe('exact');
    });

    it('maps a Komga root above several Omnibus libraries to the one closest to it', () => {
        const [r] = resolveKomgaLibraries([dto({ root: '/srv' })], [{ omnibus: '/data', komga: '/srv' }],
            [lib('deep', '/data/a/b'), lib('manga', '/data/manga'), lib('comics', '/data/comics')]);
        expect(r.translatedRoot).toBe('/data');
        // '/data/comics' and '/data/manga' are both one level down: alphabetical breaks the tie.
        expect(r.omnibusLibraryId).toBe('comics');
        const [r2] = resolveKomgaLibraries([dto({ root: '/srv' })], [{ omnibus: '/data', komga: '/srv' }],
            [lib('deep', '/data/a/b'), lib('long', '/data/a-very-long-folder-name')]);
        expect(r2.omnibusLibraryId).toBe('long');
    });

    it('maps a Komga library inside an Omnibus library to its deepest container', () => {
        const [r] = resolveKomgaLibraries([dto({ root: '/comics/Marvel' })], mappings,
            [lib('top', '/data'), lib('comics', '/data/comics'), lib('sibling', '/data/comics2')]);
        expect(r.translatedRoot).toBe('/data/comics/Marvel');
        expect(r.omnibusLibraryId).toBe('comics');
    });

    it('leaves a Komga library unmapped when no mapping covers its root', () => {
        const [r] = resolveKomgaLibraries([dto({ root: '/elsewhere' })], mappings, [lib('o1', '/data/comics')]);
        expect(r.translatedRoot).toBeNull();
        expect(r.omnibusLibraryId).toBeNull();
    });

    it('leaves it unmapped when the translated root overlaps no Omnibus library', () => {
        const [r] = resolveKomgaLibraries([dto()], mappings, [lib('o1', '/data/comics2'), lib('o2', '/data/manga')]);
        expect(r.translatedRoot).toBe('/data/comics');
        expect(r.omnibusLibraryId).toBeNull();
    });

    it('uses identity with no mappings', () => {
        const [r] = resolveKomgaLibraries([dto({ root: '/data/comics' })], [], [lib('o1', '/data/comics')]);
        expect(r.translatedRoot).toBe('/data/comics');
        expect(r.omnibusLibraryId).toBe('o1');
    });

    it('handles the empty root a non-admin key sees, and unavailable libraries', () => {
        const [r] = resolveKomgaLibraries([dto({ root: '', unavailable: true })], [], [lib('o1', '/data/comics')]);
        expect(r.root).toBe('');
        expect(r.translatedRoot).toBeNull();
        expect(r.omnibusLibraryId).toBeNull();
        expect(r.unavailable).toBe(true);
    });

    it('ignores Omnibus libraries with an unusable path', () => {
        const [r] = resolveKomgaLibraries([dto({ root: '/data/comics' })], [], [lib('bad', ''), lib('o1', '/data')]);
        expect(r.omnibusLibraryId).toBe('o1');
    });
});

describe('komgaLibrariesForOmnibusLibrary', () => {
    const komga = [
        resolved({ komgaLibraryId: 'equal', translatedRoot: '/data/comics' }),
        resolved({ komgaLibraryId: 'parent', translatedRoot: '/data' }),
        resolved({ komgaLibraryId: 'child', translatedRoot: '/data/comics/Marvel' }),
        resolved({ komgaLibraryId: 'sibling', translatedRoot: '/data/comics2' }),
        resolved({ komgaLibraryId: 'unmapped', translatedRoot: null }),
    ];

    it('returns every Komga library that equals, contains or lies inside the Omnibus path', () => {
        expect(komgaLibrariesForOmnibusLibrary(lib('o1', '/data/comics/'), komga).map(k => k.komgaLibraryId))
            .toEqual(['equal', 'parent', 'child']);
    });

    it('lets one Komga library over a parent folder serve several Omnibus libraries', () => {
        const one = [resolved({ komgaLibraryId: 'all', translatedRoot: '/data', omnibusLibraryId: 'comics' })];
        expect(komgaLibrariesForOmnibusLibrary(lib('comics', '/data/comics'), one)).toHaveLength(1);
        expect(komgaLibrariesForOmnibusLibrary(lib('manga', '/data/manga'), one)).toHaveLength(1);
    });

    it('is empty for an Omnibus library no Komga library covers', () => {
        expect(komgaLibrariesForOmnibusLibrary(lib('o9', '/mnt/other'), komga)).toEqual([]);
        expect(komgaLibrariesForOmnibusLibrary(lib('bad', ''), komga)).toEqual([]);
    });
});

describe('computeLibraryWarnings', () => {
    const ctx = { mappedOmnibusPaths: ['/data/comics'] };

    it('is silent for a well-configured, mapped library', () => {
        expect(computeLibraryWarnings(resolved(), ctx)).toEqual([]);
    });

    it.each([
        [{ hashFiles: false }, /File hashing is off/],
        [{ importComicInfoBook: false }, /Import ComicInfo book metadata/],
        [{ importComicInfoReadList: true }, /Import ComicInfo read lists/],
        [{ emptyTrashAfterScan: true }, /Empty trash after scan/],
        [{ scanCbx: false }, /no cbz, zip, cbr or rar/],
    ] as const)('warns on %o', (settings, pattern) => {
        const warnings = computeLibraryWarnings(resolved({}, settings), ctx);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(pattern);
        expect(warnings[0]).not.toMatch(/^Strongly discouraged:/);
    });

    it('warns strongly when Komga would rewrite Omnibus files', () => {
        const warnings = computeLibraryWarnings(resolved({}, { convertToCbz: true, repairExtensions: true }), ctx);
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toMatch(/^Strongly discouraged: "Convert to CBZ"/);
        expect(warnings[1]).toMatch(/^Strongly discouraged: "Repair extensions"/);
    });

    it('warns when Komga reports the library unavailable', () => {
        expect(computeLibraryWarnings(resolved({ unavailable: true }), ctx)).toEqual([expect.stringMatching(/unavailable/)]);
    });

    it('warns about an unmapped Komga library — no mapping, or no overlapping Omnibus library', () => {
        expect(computeLibraryWarnings(resolved({ translatedRoot: null, omnibusLibraryId: null }), ctx))
            .toEqual([expect.stringMatching(/^No path mapping covers the Komga folder \/comics/)]);
        expect(computeLibraryWarnings(resolved({ omnibusLibraryId: null }), { mappedOmnibusPaths: [] }))
            .toEqual([expect.stringMatching(/^No Omnibus library overlaps \/data\/comics/)]);
        expect(computeLibraryWarnings(resolved({ root: '', translatedRoot: null, omnibusLibraryId: null }), ctx))
            .toEqual([expect.stringMatching(/did not report this library's root folder/)]);
    });

    it('warns when an exclusion hides the whole library root', () => {
        const warnings = computeLibraryWarnings(resolved({}, { scanDirectoryExclusions: ['#recycle', 'COMICS'] }), ctx);
        expect(warnings).toEqual([expect.stringMatching(/^Directory exclusion "COMICS" matches the library root \/comics/)]);
    });

    it('warns when the library root is a hidden folder', () => {
        const warnings = computeLibraryWarnings(resolved({ root: '/srv/.comics' }), ctx);
        expect(warnings).toEqual([expect.stringMatching(/hidden folder/)]);
    });

    it('warns when an exclusion or hidden folder hides a mapped Omnibus library below the Komga root', () => {
        const parent = resolved({ root: '/srv', translatedRoot: '/data', omnibusLibraryId: 'o1' },
            { scanDirectoryExclusions: ['#recycle', 'manga'] });
        const warnings = computeLibraryWarnings(parent, {
            mappedOmnibusPaths: ['/data/comics', '/data/Manga', '/data/.private/comics', '/data/Manga/', '/elsewhere'],
        });
        expect(warnings).toEqual([
            expect.stringMatching(/^Directory exclusion "manga" matches \/data\/Manga: Komga skips that folder/),
            expect.stringMatching(/^\/data\/\.private\/comics is inside a hidden folder/),
        ]);
    });

    it('does not warn about ordinary exclusions below a mapped library', () => {
        const warnings = computeLibraryWarnings(resolved({}, { scanDirectoryExclusions: ['#recycle', '@eaDir'] }),
            { mappedOmnibusPaths: ['/data/comics', '/data'] });
        expect(warnings).toEqual([]);
    });

    it('honours a more specific mapping row when the mappings are passed in', () => {
        const parent = resolved({ root: '/srv', translatedRoot: '/data' }, { scanDirectoryExclusions: ['@special'] });
        const mappings = [{ omnibus: '/data', komga: '/srv' }, { omnibus: '/data/manga', komga: '/srv/@special/manga' }];
        expect(computeLibraryWarnings(parent, { mappedOmnibusPaths: ['/data/manga'] })).toEqual([]);
        expect(computeLibraryWarnings(parent, { mappedOmnibusPaths: ['/data/manga'], mappings }))
            .toEqual([expect.stringMatching(/^Directory exclusion "@special" matches \/data\/manga/)]);
    });
});

describe('computeGlobalWarnings', () => {
    const komga = [resolved({ translatedRoot: '/data/comics' })];

    it('is silent when every Omnibus library is served and there are no .cb7 files', () => {
        expect(computeGlobalWarnings(komga, [lib('o1', '/data/comics', 'Comics')], 0)).toEqual([]);
    });

    it('names each Omnibus library no Komga library serves', () => {
        expect(computeGlobalWarnings(komga, [lib('o1', '/data/comics', 'Comics'), lib('o2', '/data/manga', 'Manga')], 0))
            .toEqual([expect.stringMatching(/^Omnibus library "Manga" \(\/data\/manga\) is not inside any Komga library/)]);
    });

    it('counts .cb7 files', () => {
        expect(computeGlobalWarnings(komga, [], 1)).toEqual([expect.stringMatching(/^1 \.cb7 file in /)]);
        expect(computeGlobalWarnings(komga, [], 3)).toEqual([expect.stringMatching(/^3 \.cb7 files in .*cannot read 7z archives/)]);
    });
});

describe('countCb7InLibraries', () => {
    it('runs one count over every case variant of .cb7 under the library paths (folder boundary)', async () => {
        db.issue.count.mockResolvedValue(4);
        expect(await countCb7InLibraries(['/data/comics/', '/data/manga', '/data/comics'])).toBe(4);
        expect(db.issue.count).toHaveBeenCalledTimes(1);
        const where = db.issue.count.mock.calls[0][0].where;
        expect(where.AND[0].OR).toEqual([
            { filePath: { endsWith: '.cb7' } }, { filePath: { endsWith: '.CB7' } },
            { filePath: { endsWith: '.Cb7' } }, { filePath: { endsWith: '.cB7' } },
        ]);
        expect(where.AND[1].OR).toEqual([
            { filePath: { startsWith: '/data/comics/' } }, { filePath: { startsWith: '/data/manga/' } },
        ]);
    });

    it('handles a "/" library path', async () => {
        db.issue.count.mockResolvedValue(0);
        await countCb7InLibraries(['/']);
        expect(db.issue.count.mock.calls[0][0].where.AND[1].OR).toEqual([{ filePath: { startsWith: '/' } }]);
    });

    it('skips the query with no paths', async () => {
        expect(await countCb7InLibraries([])).toBe(0);
        expect(await countCb7InLibraries(['', '  '])).toBe(0);
        expect(db.issue.count).not.toHaveBeenCalled();
    });

    it('counts 0 and logs when the DB fails', async () => {
        db.issue.count.mockRejectedValue(new Error('database is locked'));
        expect(await countCb7InLibraries(['/data/comics'])).toBe(0);
        expect(loggerLog).toHaveBeenCalledWith(expect.stringMatching(/^\[Komga\].*database is locked/), 'warn');
    });
});

describe('persistKomgaLibraries', () => {
    it('upserts every library and deletes the rest in one array-form transaction', async () => {
        const a = resolved({ komgaLibraryId: 'a' });
        const b = resolved({ komgaLibraryId: 'b', translatedRoot: null, omnibusLibraryId: null, unavailable: true });
        await persistKomgaLibraries([a, b]);

        expect(db.$transaction).toHaveBeenCalledTimes(1);
        const ops = db.$transaction.mock.calls[0][0];
        expect(Array.isArray(ops)).toBe(true);
        expect(ops.map((o: { op: string }) => o.op)).toEqual(['upsert', 'upsert', 'deleteMany']);

        const upsertB = db.komgaLibrary.upsert.mock.calls[1][0];
        expect(upsertB.where).toEqual({ komgaLibraryId: 'b' });
        expect(upsertB.create).toEqual(expect.objectContaining({
            komgaLibraryId: 'b', name: 'Comics', root: '/comics', translatedRoot: null, omnibusLibraryId: null, unavailable: true,
        }));
        expect(JSON.parse(upsertB.create.settings)).toEqual(b.settings);
        expect(upsertB.create.lastSeenAt).toBeInstanceOf(Date);
        expect(upsertB.update).toEqual(expect.objectContaining({ translatedRoot: null, unavailable: true }));
        expect(upsertB.update.komgaLibraryId).toBeUndefined();

        expect(db.komgaLibrary.deleteMany).toHaveBeenCalledWith({ where: { komgaLibraryId: { notIn: ['a', 'b'] } } });
    });

    it('clears the cache when Komga has no libraries', async () => {
        await persistKomgaLibraries([]);
        expect(db.$transaction.mock.calls[0][0]).toHaveLength(1);
        expect(db.komgaLibrary.deleteMany).toHaveBeenCalledWith({ where: { komgaLibraryId: { notIn: [] } } });
    });

    it('de-duplicates library ids', async () => {
        await persistKomgaLibraries([resolved({ komgaLibraryId: 'a' }), resolved({ komgaLibraryId: 'a', name: 'Renamed' })]);
        expect(db.komgaLibrary.upsert).toHaveBeenCalledTimes(1);
        expect(db.komgaLibrary.upsert.mock.calls[0][0].update.name).toBe('Renamed');
    });

    it('never throws, logging the failure instead', async () => {
        db.$transaction.mockRejectedValue(new Error('SQLITE_BUSY'));
        await expect(persistKomgaLibraries([resolved()])).resolves.toBeUndefined();
        expect(loggerLog).toHaveBeenCalledWith(expect.stringMatching(/^\[Komga\].*SQLITE_BUSY/), 'warn');
    });
});

describe('loadCachedKomgaLibraries', () => {
    it('round-trips what persist wrote', async () => {
        const original = resolved({}, { scanDirectoryExclusions: ['#recycle'], oneshotsDirectory: '_os' });
        await persistKomgaLibraries([original]);
        const row = db.komgaLibrary.upsert.mock.calls[0][0].create;
        db.komgaLibrary.findMany.mockResolvedValue([row]);

        expect(await loadCachedKomgaLibraries()).toEqual([original]);
        expect(db.komgaLibrary.findMany).toHaveBeenCalledWith({ orderBy: { name: 'asc' } });
    });

    it('falls back to Komga defaults for a corrupt or partial settings column', async () => {
        db.komgaLibrary.findMany.mockResolvedValue([
            { komgaLibraryId: 'a', name: 'A', root: '/a', translatedRoot: null, omnibusLibraryId: null, settings: '{not json', unavailable: false, lastSeenAt: new Date() },
            { komgaLibraryId: 'b', name: 'B', root: '/b', translatedRoot: '/b', omnibusLibraryId: 'o', settings: '{"hashFiles":false,"scanDirectoryExclusions":"x"}', unavailable: true, lastSeenAt: new Date() },
            { komgaLibraryId: 'c', name: 'C', root: '/c', translatedRoot: null, omnibusLibraryId: null, settings: 'null', unavailable: false, lastSeenAt: new Date() },
        ]);
        const [a, b, c] = await loadCachedKomgaLibraries();
        expect(a.settings).toEqual(expect.objectContaining({ hashFiles: true, scanCbx: true, convertToCbz: false, scanDirectoryExclusions: [] }));
        expect(b.settings.hashFiles).toBe(false);
        expect(b.settings.scanDirectoryExclusions).toEqual([]);
        expect(b.unavailable).toBe(true);
        expect(c.settings.importComicInfoReadList).toBe(true);
    });

    it('lets DB errors propagate', async () => {
        db.komgaLibrary.findMany.mockRejectedValue(new Error('no such table'));
        await expect(loadCachedKomgaLibraries()).rejects.toThrow('no such table');
    });
});

describe('refreshKomgaLibraries', () => {
    it('lists, resolves against the Omnibus libraries, persists, and returns', async () => {
        const listLibraries = vi.fn().mockResolvedValue([dto()]);
        const client = { listLibraries } as unknown as KomgaClient;
        db.library.findMany.mockResolvedValue([lib('o1', '/data/comics')]);

        const out = await refreshKomgaLibraries(client, [{ omnibus: '/data/comics', komga: '/comics' }]);

        expect(out).toEqual([expect.objectContaining({ komgaLibraryId: 'k1', translatedRoot: '/data/comics', omnibusLibraryId: 'o1' })]);
        expect(db.library.findMany).toHaveBeenCalledWith({ select: { id: true, name: true, path: true } });
        expect(db.$transaction).toHaveBeenCalledTimes(1);
        // The HTTP call is finished before any DB write starts.
        expect(listLibraries.mock.invocationCallOrder[0])
            .toBeLessThan(db.$transaction.mock.invocationCallOrder[0]);
    });

    it('propagates a Komga failure without touching the cache', async () => {
        const client = { listLibraries: vi.fn().mockRejectedValue(new Error('unreachable')) } as unknown as KomgaClient;
        await expect(refreshKomgaLibraries(client, [])).rejects.toThrow('unreachable');
        expect(db.$transaction).not.toHaveBeenCalled();
    });
});
