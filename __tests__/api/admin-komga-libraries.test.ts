import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/admin/komga/libraries/route';
import { makePostJson } from '../helpers/request';
import { adminSession, userSession } from '../helpers/session';
import { loggerLog } from '../helpers/setup-global';

// Detected-libraries table (Settings → Media Servers): POST /api/admin/komga/libraries with the
// UNSAVED {url, apiKey, pathMappings}. Persists the KomgaLibrary cache only when url + mappings
// match the saved ones; the API key never appears in a response.

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    testKomgaConnection: vi.fn(),
    getKomgaSettings: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/komga/connection-test', () => ({ testKomgaConnection: mocks.testKomgaConnection }));
vi.mock('@/lib/komga/settings', () => ({ getKomgaSettings: mocks.getKomgaSettings }));

const createReq = makePostJson('http://localhost/api/admin/komga/libraries');

const STORED_KEY = 'stored-komga-key-abcdef';
const SAVED_MAPPINGS = [{ omnibus: '/data/comics', komga: '/comics' }];

const savedSettings = (over: Record<string, any> = {}) => ({
    enabled: true,
    url: 'http://komga:25600',
    apiKey: STORED_KEY,
    pathMappings: SAVED_MAPPINGS,
    pathMappingsRaw: JSON.stringify(SAVED_MAPPINGS),
    scanOnChange: true,
    readListsEnabled: false,
    instanceId: 'inst-1',
    ...over,
});

const detected = {
    id: 'LIB1',
    name: 'Comics',
    root: '/comics',
    translatedRoot: '/data/comics',
    omnibusLibrary: { id: 'olib1', name: 'Comics', path: '/data/comics', extra: 'not in the contract' },
    warnings: ['File hashing is off.'],
    internal: 'not in the contract',
};

const okResult = (over: Record<string, any> = {}) => ({
    success: true,
    message: 'Connected to Komga 1.28.1 as admin@example.com: 1 library, 1 mapped to Omnibus.',
    version: '1.28.1',
    warnings: ['Omnibus library "Manga" has no Komga library.'],
    user: { email: 'admin@example.com', roles: ['ADMIN'], sharedAllLibraries: true },
    libraries: [detected],
    ...over,
});

const body = (over: Record<string, any> = {}) => ({
    url: 'http://komga:25600',
    apiKey: '********',
    pathMappings: JSON.stringify(SAVED_MAPPINGS),
    ...over,
});

describe('POST /api/admin/komga/libraries', () => {
    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue(adminSession());
        mocks.getKomgaSettings.mockResolvedValue(savedSettings());
        mocks.testKomgaConnection.mockResolvedValue(okResult());
    });

    describe('admin check', () => {
        it('401 for a non-admin', async () => {
            mocks.getServerSession.mockResolvedValue(userSession());
            const res = await POST(createReq(body()));
            expect(res.status).toBe(401);
            expect(await res.json()).toEqual({ error: 'Unauthorized' });
            expect(mocks.testKomgaConnection).not.toHaveBeenCalled();
            expect(mocks.getKomgaSettings).not.toHaveBeenCalled();
        });

        it('401 with no session', async () => {
            mocks.getServerSession.mockResolvedValue(null);
            const res = await POST(createReq(body()));
            expect(res.status).toBe(401);
            expect(mocks.testKomgaConnection).not.toHaveBeenCalled();
        });
    });

    it('returns the documented shape — exactly these fields', async () => {
        const res = await POST(createReq(body()));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            libraries: [{
                id: 'LIB1',
                name: 'Comics',
                root: '/comics',
                translatedRoot: '/data/comics',
                omnibusLibrary: { id: 'olib1', name: 'Comics', path: '/data/comics' },
                warnings: ['File hashing is off.'],
            }],
            warnings: ['Omnibus library "Manga" has no Komga library.'],
            version: '1.28.1',
        });
    });

    it('an unmapped Komga library has omnibusLibrary null; no libraries is an empty list', async () => {
        mocks.testKomgaConnection.mockResolvedValue(okResult({ libraries: [{ ...detected, omnibusLibrary: null, translatedRoot: null }] }));
        let json = await (await POST(createReq(body()))).json();
        expect(json.libraries[0]).toMatchObject({ omnibusLibrary: null, translatedRoot: null });

        mocks.testKomgaConnection.mockResolvedValue(okResult({ libraries: undefined }));
        json = await (await POST(createReq(body()))).json();
        expect(json.libraries).toEqual([]);
    });

    it("resolves a masked '********' key through the stored, decrypted key and asks for libraries", async () => {
        await POST(createReq(body()));

        expect(mocks.testKomgaConnection).toHaveBeenCalledWith('http://komga:25600', STORED_KEY, {
            pathMappings: SAVED_MAPPINGS,
            includeLibraries: true,
            persist: true,
        });
    });

    it('uses an unsaved typed key as given', async () => {
        await POST(createReq(body({ apiKey: '  typed-key-123456 ' })));
        expect(mocks.testKomgaConnection.mock.calls[0][1]).toBe('typed-key-123456');
    });

    describe('persist only for the saved url + mappings', () => {
        it('persists when both match (trailing slashes and mapping normalisation ignored)', async () => {
            await POST(createReq(body({ url: 'http://komga:25600/', pathMappings: [{ omnibus: '/data/comics/', komga: '/comics' }] })));
            expect(mocks.testKomgaConnection.mock.calls[0][2].persist).toBe(true);
        });

        it('does not persist an unsaved URL', async () => {
            await POST(createReq(body({ url: 'http://other-komga:25600' })));
            expect(mocks.testKomgaConnection.mock.calls[0][2].persist).toBe(false);
        });

        it('does not persist unsaved mappings', async () => {
            await POST(createReq(body({ pathMappings: '[{"omnibus":"/mnt/comics","komga":"/comics"}]' })));
            expect(mocks.testKomgaConnection.mock.calls[0][2].persist).toBe(false);
        });

        it('does not persist when no URL is saved yet', async () => {
            mocks.getKomgaSettings.mockResolvedValue(savedSettings({ url: null }));
            await POST(createReq(body({ apiKey: 'typed-key-123456' })));
            expect(mocks.testKomgaConnection.mock.calls[0][2].persist).toBe(false);
        });

        it('identity (no mappings) on both sides persists', async () => {
            mocks.getKomgaSettings.mockResolvedValue(savedSettings({ pathMappings: [], pathMappingsRaw: '[]' }));
            await POST(createReq(body({ pathMappings: undefined })));
            expect(mocks.testKomgaConnection.mock.calls[0][2]).toMatchObject({ pathMappings: [], persist: true });
        });
    });

    describe('error mapping', () => {
        it('400 for a missing URL', async () => {
            const res = await POST(createReq(body({ url: '' })));
            expect(res.status).toBe(400);
            expect((await res.json()).error).toMatch(/URL is required/);
            expect(mocks.testKomgaConnection).not.toHaveBeenCalled();
        });

        it('400 for a non-http(s) URL', async () => {
            const res = await POST(createReq(body({ url: 'ftp://komga' })));
            expect(res.status).toBe(400);
            expect((await res.json()).error).toMatch(/http:\/\/ or https:\/\//);
        });

        it('400 for a missing key, including a masked key with nothing stored', async () => {
            let res = await POST(createReq(body({ apiKey: '' })));
            expect(res.status).toBe(400);
            expect((await res.json()).error).toMatch(/API key is required/);

            mocks.getKomgaSettings.mockResolvedValue(savedSettings({ apiKey: null }));
            res = await POST(createReq(body({ apiKey: '********' })));
            expect(res.status).toBe(400);
            expect(mocks.testKomgaConnection).not.toHaveBeenCalled();
        });

        it('400 for path mappings that are not a JSON list', async () => {
            for (const pathMappings of ['{not json', '{"omnibus":"/a"}', 42]) {
                const res = await POST(createReq(body({ pathMappings })));
                expect(res.status).toBe(400);
                expect((await res.json()).error).toMatch(/Path mappings/);
            }
            expect(mocks.testKomgaConnection).not.toHaveBeenCalled();
        });

        it('400 for a body that is not JSON', async () => {
            const req = new Request('http://localhost/api/admin/komga/libraries', { method: 'POST', body: 'nope' });
            const res = await POST(req);
            expect(res.status).toBe(400);
        });

        it("502 with the test's message when Komga refuses (never 401, which reads as a session expiry)", async () => {
            mocks.testKomgaConnection.mockResolvedValue({
                success: false, message: 'Invalid API key, or Komga is older than 1.20.0 (no API-key support)', version: null, warnings: [],
            });
            const res = await POST(createReq(body()));
            expect(res.status).toBe(502);
            expect(await res.json()).toEqual({ error: 'Invalid API key, or Komga is older than 1.20.0 (no API-key support)' });
        });

        it('500 with a useful message when something unexpected throws', async () => {
            mocks.getKomgaSettings.mockRejectedValue(new Error('database is locked'));
            const res = await POST(createReq(body()));
            expect(res.status).toBe(500);
            expect((await res.json()).error).toMatch(/Failed to load Komga libraries: database is locked/);
            expect(loggerLog).toHaveBeenCalledWith(expect.stringMatching(/^\[Komga\]/), 'error');
        });
    });

    describe('the key never reaches the response', () => {
        it('not in a success response', async () => {
            const raw = await (await POST(createReq(body()))).text();
            expect(raw).not.toContain(STORED_KEY);
        });

        it('scrubbed from an upstream failure message', async () => {
            mocks.testKomgaConnection.mockResolvedValue({ success: false, message: `rejected ${STORED_KEY}`, version: null, warnings: [] });
            const raw = await (await POST(createReq(body()))).text();
            expect(raw).not.toContain(STORED_KEY);
            expect(JSON.parse(raw).error).toBe('rejected ********');
        });

        it('scrubbed from warnings', async () => {
            mocks.testKomgaConnection.mockResolvedValue(okResult({
                warnings: [`global ${STORED_KEY}`],
                libraries: [{ ...detected, warnings: [`lib ${STORED_KEY}`] }],
            }));
            const raw = await (await POST(createReq(body()))).text();
            expect(raw).not.toContain(STORED_KEY);
        });

        it('scrubbed from an unexpected error and its log line', async () => {
            mocks.testKomgaConnection.mockRejectedValue(new Error(`boom ${STORED_KEY}`));
            const res = await POST(createReq(body()));
            const raw = await res.text();
            expect(res.status).toBe(500);
            expect(raw).not.toContain(STORED_KEY);
            for (const [msg] of loggerLog.mock.calls) expect(String(msg)).not.toContain(STORED_KEY);
        });
    });
});
