import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/admin/test/route';
import { makePostJson } from '../helpers/request';
import { adminSession, userSession } from '../helpers/session';
import { loggerLog } from '../helpers/setup-global';

// "Test connection" on the Komga card: POST /api/admin/test {type:'komga', config} — the page sends
// its whole (unsaved) config bag. '********' resolves to the stored, decrypted key; the reply is
// {success, message} and never carries the key.

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    settingFindUnique: vi.fn(),
    customHeaderFindMany: vi.fn(),
    testKomgaConnection: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findUnique: mocks.settingFindUnique },
        customHeader: { findMany: mocks.customHeaderFindMany },
    }
}));
vi.mock('@/lib/encryption', () => ({ decryptSecret: vi.fn(async (v: string) => v) }));
vi.mock('@/lib/annas-test', () => ({ testAnnasArchiveKey: vi.fn() }));
vi.mock('@/lib/mailer', () => ({ Mailer: {} }));
vi.mock('@/lib/komga/connection-test', () => ({ testKomgaConnection: mocks.testKomgaConnection }));

const createReq = makePostJson('http://localhost/api/admin/test');

const STORED_KEY = 'stored-komga-key-abcdef';

const settingsRows = (rows: Record<string, string>) =>
    mocks.settingFindUnique.mockImplementation(async ({ where }: any) =>
        where.key in rows ? { key: where.key, value: rows[where.key] } : null);

const okResult = (over: Record<string, any> = {}) => ({
    success: true,
    message: 'Connected to Komga 1.28.1 as admin@example.com: 2 libraries, 2 mapped to Omnibus.',
    version: '1.28.1',
    warnings: [],
    user: { email: 'admin@example.com', roles: ['ADMIN'], sharedAllLibraries: true },
    ...over,
});

const komgaConfig = (over: Record<string, any> = {}) => ({
    komga_url: 'http://komga:25600',
    komga_api_key: 'typed-key-123456',
    komga_path_mappings: '[{"omnibus":"/data/comics","komga":"/comics"}]',
    custom_headers: '[]',
    ...over,
});

describe('POST /api/admin/test — komga', () => {
    beforeEach(() => {
        settingsRows({ setup_complete: 'true', komga_api_key: STORED_KEY });
        mocks.getServerSession.mockResolvedValue(adminSession());
        mocks.customHeaderFindMany.mockResolvedValue([]);
        mocks.testKomgaConnection.mockResolvedValue(okResult());
    });

    it('401 for a non-admin session, without testing', async () => {
        mocks.getServerSession.mockResolvedValue(userSession());

        const res = await POST(createReq({ type: 'komga', config: komgaConfig() }));

        expect(res.status).toBe(401);
        expect((await res.json()).success).toBe(false);
        expect(mocks.testKomgaConnection).not.toHaveBeenCalled();
    });

    it('401 before setup completes too — the stored key is never testable anonymously', async () => {
        settingsRows({ komga_api_key: STORED_KEY });
        mocks.getServerSession.mockResolvedValue(null);

        const res = await POST(createReq({ type: 'komga', config: komgaConfig({ komga_api_key: '********', komga_url: 'http://elsewhere' }) }));

        expect(res.status).toBe(401);
        expect(mocks.testKomgaConnection).not.toHaveBeenCalled();
    });

    it('other setup-time tests still run without a session before setup completes', async () => {
        settingsRows({});
        mocks.getServerSession.mockResolvedValue(null);

        const res = await POST(createReq({ type: 'mapping', config: { remote: '/r', local: '/l' } }));

        expect(res.status).toBe(200);
        expect((await res.json()).success).toBe(true);
    });

    it("resolves a masked '********' key through the stored, decrypted key", async () => {
        const res = await POST(createReq({ type: 'komga', config: komgaConfig({ komga_api_key: '********' }) }));

        expect(res.status).toBe(200);
        expect(mocks.settingFindUnique).toHaveBeenCalledWith({ where: { key: 'komga_api_key' } });
        expect(mocks.testKomgaConnection).toHaveBeenCalledWith('http://komga:25600', STORED_KEY, {
            pathMappings: [{ omnibus: '/data/comics', komga: '/comics' }],
            includeLibraries: false,
        });
    });

    it('uses a newly typed (unsaved) key and URL as given, trimmed', async () => {
        await POST(createReq({ type: 'komga', config: komgaConfig({ komga_url: ' http://komga:25600/komga ', komga_api_key: ' typed-key-123456 ' }) }));

        expect(mocks.testKomgaConnection).toHaveBeenCalledWith('http://komga:25600/komga', 'typed-key-123456', expect.objectContaining({ includeLibraries: false }));
    });

    it('accepts path mappings as an array and treats a missing value as identity', async () => {
        await POST(createReq({ type: 'komga', config: komgaConfig({ komga_path_mappings: [{ omnibus: '/a/', komga: '/b' }] }) }));
        expect(mocks.testKomgaConnection.mock.calls[0][2].pathMappings).toEqual([{ omnibus: '/a', komga: '/b' }]);

        await POST(createReq({ type: 'komga', config: komgaConfig({ komga_path_mappings: undefined }) }));
        expect(mocks.testKomgaConnection.mock.calls[1][2].pathMappings).toEqual([]);
    });

    it('passes an empty key through when nothing is stored, so the test explains what is missing', async () => {
        settingsRows({ setup_complete: 'true' });
        mocks.testKomgaConnection.mockResolvedValue({ success: false, message: 'Enter a Komga API key (Komga → Account settings → API keys).', version: null, warnings: [] });

        const res = await POST(createReq({ type: 'komga', config: komgaConfig({ komga_api_key: '********' }) }));

        expect(mocks.testKomgaConnection).toHaveBeenCalledWith('http://komga:25600', '', expect.anything());
        expect(await res.json()).toEqual({ success: false, message: expect.stringContaining('Enter a Komga API key') });
    });

    it('success: the summary with the version', async () => {
        const res = await POST(createReq({ type: 'komga', config: komgaConfig() }));

        expect(await res.json()).toEqual({
            success: true,
            message: 'Connected to Komga 1.28.1 as admin@example.com: 2 libraries, 2 mapped to Omnibus.',
        });
    });

    it('success: adds the version when the summary lacks it', async () => {
        mocks.testKomgaConnection.mockResolvedValue(okResult({ message: 'Connected.' }));
        const { message } = await (await POST(createReq({ type: 'komga', config: komgaConfig() }))).json();
        expect(message).toBe('Connected. (Komga 1.28.1)');
    });

    it('success with warnings: a count and the first three', async () => {
        mocks.testKomgaConnection.mockResolvedValue(okResult({
            warnings: ['w1 hashFiles is off.', 'w2 scanCbx is off.', 'w3 unmapped.', 'w4 cb7.', 'w5 trash.'],
        }));

        const { success, message } = await (await POST(createReq({ type: 'komga', config: komgaConfig() }))).json();

        expect(success).toBe(true);
        expect(message).toContain('1.28.1');
        expect(message).toContain('5 warnings: w1 hashFiles is off.; w2 scanCbx is off.; w3 unmapped. (+2 more)');
        expect(message).not.toContain('w4');
    });

    it('success with one warning uses the singular', async () => {
        mocks.testKomgaConnection.mockResolvedValue(okResult({ warnings: ['Komga 1.23.0 is older than the recommended 1.23.5.'] }));
        const { message } = await (await POST(createReq({ type: 'komga', config: komgaConfig() }))).json();
        expect(message).toMatch(/1 warning: Komga 1\.23\.0 is older/);
    });

    it("failure: {success:false} with the test's specific message", async () => {
        mocks.testKomgaConnection.mockResolvedValue({
            success: false, message: 'Invalid API key, or Komga is older than 1.20.0 (no API-key support)', version: null, warnings: [],
        });

        const res = await POST(createReq({ type: 'komga', config: komgaConfig() }));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: false, message: 'Invalid API key, or Komga is older than 1.20.0 (no API-key support)' });
    });

    it('never returns the key, even if an upstream message echoed it', async () => {
        mocks.testKomgaConnection.mockResolvedValue({
            success: false, message: `Komga said: bad key ${STORED_KEY}`, version: null, warnings: [],
        });

        const res = await POST(createReq({ type: 'komga', config: komgaConfig({ komga_api_key: '********' }) }));
        const raw = await res.text();

        expect(raw).not.toContain(STORED_KEY);
        expect(JSON.parse(raw).message).toBe('Komga said: bad key ********');
    });

    it('an unexpected throw becomes {success:false}, with the key scrubbed from reply and log', async () => {
        mocks.testKomgaConnection.mockRejectedValue(new Error(`socket hang up (key ${STORED_KEY})`));

        const res = await POST(createReq({ type: 'komga', config: komgaConfig({ komga_api_key: '********' }) }));
        const raw = await res.text();

        expect(JSON.parse(raw).success).toBe(false);
        expect(raw).not.toContain(STORED_KEY);
        expect(loggerLog).toHaveBeenCalledWith(expect.stringMatching(/^\[Komga\]/), 'error');
        for (const [msg] of loggerLog.mock.calls) expect(String(msg)).not.toContain(STORED_KEY);
    });
});
