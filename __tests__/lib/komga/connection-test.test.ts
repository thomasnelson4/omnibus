import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    libraryFindMany: vi.fn(),
    persistKomgaLibraries: vi.fn(),
    countCb7InLibraries: vi.fn(),
    createKomgaClientFor: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { library: { findMany: mocks.libraryFindMany } } }));

// Real pure resolution/warning logic; only the DB-touching helpers are stubbed.
vi.mock('@/lib/komga/libraries', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/komga/libraries')>()),
    persistKomgaLibraries: mocks.persistKomgaLibraries,
    countCb7InLibraries: mocks.countCb7InLibraries,
}));

vi.mock('@/lib/komga/factory', () => ({ createKomgaClientFor: mocks.createKomgaClientFor }));

import { testKomgaConnection, compareKomgaVersions } from '@/lib/komga/connection-test';
import { KomgaError, type KomgaLibraryDto, type KomgaUserDto } from '@/lib/komga/types';
import type { KomgaClient } from '@/lib/komga/client';

const KEY = 'secret-api-key-0123456789';

function libDto(over: Partial<KomgaLibraryDto> = {}): KomgaLibraryDto {
    return {
        id: 'L1', name: 'Comics', root: '/comics',
        importComicInfoBook: true, importComicInfoSeries: true, importComicInfoCollection: true,
        importComicInfoReadList: false, importEpubBook: true, importEpubSeries: true, importMylarSeries: true,
        importLocalArtwork: true, importBarcodeIsbn: false, scanForceModifiedTime: false, scanOnStartup: false,
        scanCbx: true, scanPdf: true, scanEpub: true, scanDirectoryExclusions: ['#recycle', '@eaDir'],
        repairExtensions: false, convertToCbz: false, emptyTrashAfterScan: false, hashFiles: true, hashPages: false,
        analyzeDimensions: true, oneshotsDirectory: null, unavailable: false,
        ...over,
    };
}

// Komga's UserDto is @JsonInclude(NON_NULL): an unrestricted user has no ageRestriction field.
const ADMIN = {
    id: 'u1', email: 'admin@example.com', roles: ['ADMIN', 'USER'], sharedAllLibraries: true,
    sharedLibrariesIds: [], labelsAllow: [], labelsExclude: [],
} as unknown as KomgaUserDto;

function fakeClient(over: Partial<Record<'health' | 'getMe' | 'getInfo' | 'listLibraries', ReturnType<typeof vi.fn>>> = {}) {
    const c = {
        health: vi.fn().mockResolvedValue({ status: 'UP' }),
        getMe: vi.fn().mockResolvedValue(ADMIN),
        getInfo: vi.fn().mockResolvedValue({ version: '1.28.1' }),
        listLibraries: vi.fn().mockResolvedValue([libDto()]),
        ...over,
    };
    return { c, client: c as unknown as KomgaClient };
}

const MAPPINGS = [{ omnibus: '/data/comics', komga: '/comics' }];

beforeEach(() => {
    mocks.libraryFindMany.mockResolvedValue([{ id: 'o1', name: 'Main', path: '/data/comics' }]);
    mocks.persistKomgaLibraries.mockResolvedValue(undefined);
    mocks.countCb7InLibraries.mockResolvedValue(0);
});

describe('testKomgaConnection — input', () => {
    it('rejects a missing URL, a non-http URL and a missing key without any request', async () => {
        const { c, client } = fakeClient();
        expect((await testKomgaConnection('', KEY, { client })).success).toBe(false);
        expect((await testKomgaConnection('komga:25600', KEY, { client })).message).toMatch(/http:\/\/ or https:\/\//);
        expect((await testKomgaConnection('http://komga', '  ', { client })).message).toMatch(/API key/);
        expect(c.health).not.toHaveBeenCalled();
    });

    it('rejects an undecryptable stored key', async () => {
        const { client } = fakeClient();
        const r = await testKomgaConnection('http://komga', 'enc:v2:abc:def:ghi', { client });
        expect(r.success).toBe(false);
        expect(r.message).toMatch(/could not be decrypted/);
    });

    it('builds a client from the url/key with createKomgaClientFor when none is injected', async () => {
        const { client } = fakeClient();
        mocks.createKomgaClientFor.mockResolvedValue(client);
        const r = await testKomgaConnection(' http://komga/komga ', ` ${KEY} `, { pathMappings: MAPPINGS });
        expect(mocks.createKomgaClientFor).toHaveBeenCalledWith('http://komga/komga', KEY);
        expect(r.success).toBe(true);
    });
});

describe('testKomgaConnection — step 1 health', () => {
    it('unreachable', async () => {
        const { c, client } = fakeClient({ health: vi.fn().mockRejectedValue(new KomgaError('unreachable', null, 'Cannot connect to Komga (ECONNREFUSED)')) });
        const r = await testKomgaConnection('http://komga', KEY, { client });
        expect(r).toMatchObject({ success: false, version: null });
        expect(r.message).toMatch(/^Cannot reach Komga at this URL: .*ECONNREFUSED/);
        expect(c.getMe).not.toHaveBeenCalled();
    });

    it('timeout and 404 get specific messages', async () => {
        let { client } = fakeClient({ health: vi.fn().mockRejectedValue(new KomgaError('timeout', null, 'timed out')) });
        expect((await testKomgaConnection('http://komga', KEY, { client })).message).toMatch(/did not answer within 10 s/);
        ({ client } = fakeClient({ health: vi.fn().mockRejectedValue(new KomgaError('notFound', 404, 'HTTP 404')) }));
        expect((await testKomgaConnection('http://komga', KEY, { client })).message).toMatch(/No Komga server found.*sub-path/);
    });

    it('a proxy in front of the anonymous health endpoint is called out', async () => {
        const { client } = fakeClient({ health: vi.fn().mockRejectedValue(new KomgaError('unauthorized', 401, 'HTTP 401')) });
        expect((await testKomgaConnection('http://komga', KEY, { client })).message).toMatch(/Custom Request Headers/);
    });

    it('a DOWN status or a non-Komga answer fails', async () => {
        let { client } = fakeClient({ health: vi.fn().mockResolvedValue({ status: 'DOWN' }) });
        expect((await testKomgaConnection('http://komga', KEY, { client })).message).toMatch(/status as DOWN/);
        ({ client } = fakeClient({ health: vi.fn().mockResolvedValue({ status: 'UNKNOWN' }) }));
        expect((await testKomgaConnection('http://komga', KEY, { client })).message).toMatch(/does not look like Komga/);
    });
});

describe('testKomgaConnection — step 2 user', () => {
    it('401 → invalid key or Komga < 1.20.0', async () => {
        const { c, client } = fakeClient({ getMe: vi.fn().mockRejectedValue(new KomgaError('unauthorized', 401, 'HTTP 401')) });
        const r = await testKomgaConnection('http://komga', KEY, { client });
        expect(r.success).toBe(false);
        expect(r.message).toBe('Invalid API key, or Komga is older than 1.20.0 (no API-key support)');
        expect(c.getInfo).not.toHaveBeenCalled();
    });

    it('a non-admin user fails and is reported', async () => {
        const { c, client } = fakeClient({ getMe: vi.fn().mockResolvedValue({ ...ADMIN, email: 'reader@x', roles: ['USER', 'PAGE_STREAMING'], sharedAllLibraries: false }) });
        const r = await testKomgaConnection('http://komga', KEY, { client });
        expect(r.success).toBe(false);
        expect(r.message).toMatch(/reader@x.*not a Komga admin/);
        expect(r.user).toEqual({ email: 'reader@x', roles: ['USER', 'PAGE_STREAMING'], sharedAllLibraries: false });
        expect(c.getInfo).not.toHaveBeenCalled();
    });

    it.each([
        ['ageRestriction', { ageRestriction: { age: 16, restriction: 'ALLOW_ONLY' } }, /age restriction \(allow only 16\+\)/],
        ['labelsAllow', { labelsAllow: ['kids'] }, /allowed labels: kids/],
        ['labelsExclude', { labelsExclude: ['adult', 'nsfw'] }, /excluded labels: adult, nsfw/],
    ])('content restriction %s fails even for an admin', async (_name, over, pattern) => {
        const { c, client } = fakeClient({ getMe: vi.fn().mockResolvedValue({ ...ADMIN, ...over }) });
        const r = await testKomgaConnection('http://komga', KEY, { client });
        expect(r.success).toBe(false);
        expect(r.message).toMatch(/content restrictions/);
        expect(r.message).toMatch(pattern);
        expect(c.getInfo).not.toHaveBeenCalled();
    });

    it('an explicit null ageRestriction is "no restriction"', async () => {
        const { client } = fakeClient({ getMe: vi.fn().mockResolvedValue({ ...ADMIN, ageRestriction: null }) });
        expect((await testKomgaConnection('http://komga', KEY, { client, pathMappings: MAPPINGS })).success).toBe(true);
    });
});

describe('testKomgaConnection — step 3 version', () => {
    it('< 1.20.0 fails before listing libraries', async () => {
        const { c, client } = fakeClient({ getInfo: vi.fn().mockResolvedValue({ version: '1.19.2' }) });
        const r = await testKomgaConnection('http://komga', KEY, { client });
        expect(r.success).toBe(false);
        expect(r.version).toBe('1.19.2');
        expect(r.message).toMatch(/Komga 1\.19\.2 is not supported.*1\.20\.0/);
        expect(c.listLibraries).not.toHaveBeenCalled();
    });

    it('< 1.23.5 succeeds with a warning; < 1.23.3 also mentions reading lists', async () => {
        let { client } = fakeClient({ getInfo: vi.fn().mockResolvedValue({ version: '1.23.4' }) });
        let r = await testKomgaConnection('http://komga', KEY, { client, pathMappings: MAPPINGS });
        expect(r.success).toBe(true);
        expect(r.warnings.some(w => /older than the recommended 1\.23\.5/.test(w))).toBe(true);
        expect(r.warnings.some(w => /Reading-list sync/.test(w))).toBe(false);

        ({ client } = fakeClient({ getInfo: vi.fn().mockResolvedValue({ version: '1.21.0' }) }));
        r = await testKomgaConnection('http://komga', KEY, { client, pathMappings: MAPPINGS });
        expect(r.success).toBe(true);
        expect(r.warnings.some(w => /Reading-list sync needs 1\.23\.3/.test(w))).toBe(true);
    });

    it('a current version has no version warning', async () => {
        const { client } = fakeClient({ getInfo: vi.fn().mockResolvedValue({ version: '1.28.1-SNAPSHOT' }) });
        const r = await testKomgaConnection('http://komga', KEY, { client, pathMappings: MAPPINGS });
        expect(r.success).toBe(true);
        expect(r.version).toBe('1.28.1-SNAPSHOT');
        expect(r.warnings).toEqual([]);
    });

    it('an unknown version only warns (an accepted API key already implies >= 1.20.0)', async () => {
        const { client } = fakeClient({ getInfo: vi.fn().mockResolvedValue({ version: null }) });
        const r = await testKomgaConnection('http://komga', KEY, { client, pathMappings: MAPPINGS });
        expect(r.success).toBe(true);
        expect(r.warnings[0]).toMatch(/Could not determine the Komga version/);
    });

    it('a failing /actuator/info fails the test', async () => {
        const { client } = fakeClient({ getInfo: vi.fn().mockRejectedValue(new KomgaError('server', 500, 'Komga returned HTTP 500')) });
        const r = await testKomgaConnection('http://komga', KEY, { client });
        expect(r.success).toBe(false);
        expect(r.message).toMatch(/Could not read the Komga version: Komga returned HTTP 500/);
    });
});

describe('testKomgaConnection — step 4 libraries', () => {
    it('success: message, user, mapped library', async () => {
        const { client } = fakeClient();
        const r = await testKomgaConnection('http://komga', KEY, { client, pathMappings: MAPPINGS });
        expect(r.success).toBe(true);
        expect(r.message).toBe('Connected to Komga 1.28.1 as admin@example.com: 1 library, 1 mapped to Omnibus.');
        expect(r.user).toEqual({ email: 'admin@example.com', roles: ['ADMIN', 'USER'], sharedAllLibraries: true });
        expect(r.libraries).toEqual([{
            id: 'L1', name: 'Comics', root: '/comics', translatedRoot: '/data/comics',
            omnibusLibrary: { id: 'o1', name: 'Main', path: '/data/comics' }, warnings: [],
        }]);
        expect(r.warnings).toEqual([]);
    });

    it('per-library warnings live on the library, or fold into warnings when libraries are not returned', async () => {
        const dto = libDto({ hashFiles: false, convertToCbz: true });
        let { client } = fakeClient({ listLibraries: vi.fn().mockResolvedValue([dto]) });
        let r = await testKomgaConnection('http://komga', KEY, { client, pathMappings: MAPPINGS });
        const libWarnings = r.libraries![0].warnings;
        expect(libWarnings.some(w => /^Strongly discouraged:.*Convert to CBZ/.test(w))).toBe(true);
        expect(libWarnings.some(w => /File hashing is off/.test(w))).toBe(true);
        expect(r.warnings).toEqual([]);

        ({ client } = fakeClient({ listLibraries: vi.fn().mockResolvedValue([dto]) }));
        r = await testKomgaConnection('http://komga', KEY, { client, pathMappings: MAPPINGS, includeLibraries: false });
        expect(r.libraries).toBeUndefined();
        expect(r.warnings).toEqual(libWarnings.map(w => `Komga library "Comics": ${w}`));
    });

    it('surfaces unmapped libraries on both sides and .cb7 files in served libraries', async () => {
        mocks.libraryFindMany.mockResolvedValue([
            { id: 'o1', name: 'Main', path: '/data/comics' },
            { id: 'o2', name: 'Manga', path: '/data/manga' },
        ]);
        mocks.countCb7InLibraries.mockResolvedValue(3);
        const { client } = fakeClient({ listLibraries: vi.fn().mockResolvedValue([libDto(), libDto({ id: 'L2', name: 'Other', root: '/elsewhere' })]) });
        const r = await testKomgaConnection('http://komga', KEY, { client, pathMappings: MAPPINGS });
        expect(r.success).toBe(true);
        expect(r.message).toMatch(/2 libraries, 1 mapped/);
        expect(r.warnings.some(w => /Omnibus library "Manga".*not inside any Komga library/.test(w))).toBe(true);
        expect(r.warnings.some(w => /3 \.cb7 files/.test(w))).toBe(true);
        expect(mocks.countCb7InLibraries).toHaveBeenCalledWith(['/data/comics']);
        const other = r.libraries!.find(l => l.id === 'L2')!;
        expect(other.omnibusLibrary).toBeNull();
        expect(other.warnings.some(w => /No path mapping covers/.test(w))).toBe(true);
    });

    it('persist=true writes the library cache; the default does not', async () => {
        let { client } = fakeClient();
        await testKomgaConnection('http://komga', KEY, { client, pathMappings: MAPPINGS });
        expect(mocks.persistKomgaLibraries).not.toHaveBeenCalled();

        ({ client } = fakeClient());
        await testKomgaConnection('http://komga', KEY, { client, pathMappings: MAPPINGS, persist: true });
        expect(mocks.persistKomgaLibraries).toHaveBeenCalledTimes(1);
        const [resolved] = mocks.persistKomgaLibraries.mock.calls[0];
        expect(resolved).toEqual([expect.objectContaining({ komgaLibraryId: 'L1', translatedRoot: '/data/comics', omnibusLibraryId: 'o1' })]);
    });

    it('a failing cache write does not fail the test', async () => {
        mocks.persistKomgaLibraries.mockRejectedValue(new Error('SQLITE_BUSY'));
        const { client } = fakeClient();
        expect((await testKomgaConnection('http://komga', KEY, { client, pathMappings: MAPPINGS, persist: true })).success).toBe(true);
    });

    it('a failing listLibraries fails the test with the version kept', async () => {
        const { client } = fakeClient({ listLibraries: vi.fn().mockRejectedValue(new KomgaError('forbidden', 403, 'Komga denied GET /api/v1/libraries (HTTP 403)')) });
        const r = await testKomgaConnection('http://komga', KEY, { client });
        expect(r).toMatchObject({ success: false, version: '1.28.1' });
        expect(r.message).toMatch(/Could not list the Komga libraries/);
        expect(mocks.persistKomgaLibraries).not.toHaveBeenCalled();
    });

    it('an unreadable Omnibus library table only warns', async () => {
        mocks.libraryFindMany.mockRejectedValue(new Error('db down'));
        const { client } = fakeClient();
        const r = await testKomgaConnection('http://komga', KEY, { client, pathMappings: MAPPINGS });
        expect(r.success).toBe(true);
        expect(r.warnings.some(w => /Could not read the Omnibus libraries/.test(w))).toBe(true);
    });
});

describe('testKomgaConnection — never throws, never echoes the key', () => {
    it('unexpected errors at any step become a failed result', async () => {
        for (const step of ['health', 'getMe', 'getInfo', 'listLibraries'] as const) {
            const { client } = fakeClient({ [step]: vi.fn().mockRejectedValue(new TypeError(`boom in ${step}`)) });
            const r = await testKomgaConnection('http://komga', KEY, { client });
            expect(r.success).toBe(false);
            expect(r.message).toContain(`boom in ${step}`);
        }
    });

    it('a throwing client factory becomes a failed result', async () => {
        mocks.createKomgaClientFor.mockRejectedValue(new Error('headers table missing'));
        const r = await testKomgaConnection('http://komga', KEY);
        expect(r.success).toBe(false);
        expect(r.message).toMatch(/headers table missing/);
    });

    it('scrubs the API key out of any message', async () => {
        const { client } = fakeClient({ getMe: vi.fn().mockRejectedValue(new Error(`proxy said: bad key ${KEY}`)) });
        const r = await testKomgaConnection('http://komga', KEY, { client });
        expect(r.success).toBe(false);
        expect(r.message).not.toContain(KEY);
        expect(r.message).toContain('***');
    });
});

describe('compareKomgaVersions', () => {
    it.each([
        ['1.20.0', '1.20.0', 0],
        ['1.19.9', '1.20.0', -1],
        ['1.23.5', '1.23.4', 1],
        ['1.100.0', '1.23.5', 1],
        ['v1.28.1', '1.28.1', 0],
        ['1.28.1-SNAPSHOT', '1.28.1', 0],
        ['1.28.1+build.7', '1.28.0', 1],
        ['1.24', '1.24.0', 0],
        ['2.0.0', '1.99.99', 1],
        ['garbage', '0.0.0', 0],
    ])('%s vs %s → %i', (a, b, expected) => {
        expect(compareKomgaVersions(a, b)).toBe(expected);
    });
});
