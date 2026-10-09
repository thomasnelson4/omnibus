import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST } from '@/app/api/admin/config/route';
import { SECRET_SETTING_KEYS } from '@/lib/secret-keys';
import { loggerLog } from '../helpers/setup-global';
import { adminSession } from '../helpers/session';

// Komga settings in the admin config route (PLAN §5, §6 P1, §8): the API key is a secret at rest
// and masked to the browser; the enable gate runs before encryption and can only refuse the
// false→true transition; the change hook runs after the commit and can never fail the save.

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    settingFindUnique: vi.fn(),
    settingFindMany: vi.fn(),
    settingUpsert: vi.fn(),
    transaction: vi.fn(),
    emptyFindMany: vi.fn(),
    syncSchedules: vi.fn(),
    encryptSecret: vi.fn(),
    runKomgaEnableGate: vi.fn(),
    applyKomgaSettingsChange: vi.fn(),
    testKomgaConnection: vi.fn(),
    actualGate: null as null | ((...args: any[]) => Promise<void>),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));

vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findUnique: mocks.settingFindUnique, findMany: mocks.settingFindMany },
        library: { findMany: mocks.emptyFindMany },
        downloadClient: { findMany: mocks.emptyFindMany },
        hosterAccount: { findMany: mocks.emptyFindMany },
        indexer: { findMany: mocks.emptyFindMany },
        customHeader: { findMany: mocks.emptyFindMany },
        searchAcronym: { findMany: mocks.emptyFindMany },
        discordWebhook: { findMany: mocks.emptyFindMany },
        $transaction: mocks.transaction,
    }
}));

// The real queue module dials Redis at import time — never load it in a unit test.
vi.mock('@/lib/queue', () => ({ syncSchedules: mocks.syncSchedules }));
vi.mock('@/lib/encryption', () => ({
    encryptSecret: mocks.encryptSecret,
    decryptSecret: vi.fn(async (v: string) => v),
}));
vi.mock('@/lib/annas-test', () => ({ testAnnasArchiveKey: vi.fn() }));
// The hooks are spies; one wiring test swaps the REAL gate back in (over a mocked connection test).
vi.mock('@/lib/komga/settings-hooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/komga/settings-hooks')>();
    mocks.actualGate = actual.runKomgaEnableGate;
    return {
        runKomgaEnableGate: mocks.runKomgaEnableGate,
        applyKomgaSettingsChange: mocks.applyKomgaSettingsChange,
    };
});
vi.mock('@/lib/komga/connection-test', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/komga/connection-test')>()),
    testKomgaConnection: mocks.testKomgaConnection,
}));

const mockReq = (body: any) => ({
    json: async () => body,
    url: 'http://localhost/api/admin/config',
    headers: new Headers({ 'content-type': 'application/json' }),
}) as unknown as Request;

const flush = () => new Promise(r => setTimeout(r, 0));

/** key → value of every systemSetting.upsert the save transaction made. */
const upserted = (): Record<string, string> =>
    Object.fromEntries(mocks.settingUpsert.mock.calls.map(([args]: any[]) => [args.where.key, args.update.value]));

const PRIOR_ROWS = [
    { key: 'komga_enabled', value: 'false' },
    { key: 'komga_url', value: 'http://komga:25600' },
    { key: 'komga_api_key', value: 'stored-plaintext-key' }, // decrypted by the db.ts extension
    { key: 'komga_path_mappings', value: '[]' },
    { key: 'komga_instance_id', value: 'inst-1' },
];

describe('komga_api_key is a secret setting', () => {
    it('is in SECRET_SETTING_KEYS, so it is encrypted at rest and decrypted on read', () => {
        expect(SECRET_SETTING_KEYS.has('komga_api_key')).toBe(true);
        // URLs are not secrets.
        expect(SECRET_SETTING_KEYS.has('komga_url')).toBe(false);
    });
});

describe('GET /api/admin/config masks the Komga API key', () => {
    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue(adminSession());
        mocks.emptyFindMany.mockResolvedValue([]);
    });

    it("returns '********' for a stored komga_api_key and never the decrypted value", async () => {
        mocks.settingFindMany.mockResolvedValue([
            { key: 'komga_api_key', value: 'super-secret-komga-key' },
            { key: 'komga_url', value: 'http://komga:25600' },
            { key: 'komga_enabled', value: 'true' },
        ]);

        const res = await GET(new Request('http://localhost/api/admin/config'));
        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toContain('super-secret-komga-key');

        const settings = JSON.parse(raw).settings as Array<{ key: string; value: string }>;
        const byKey = Object.fromEntries(settings.map(s => [s.key, s.value]));
        expect(byKey.komga_api_key).toBe('********');
        expect(byKey.komga_url).toBe('http://komga:25600');
        expect(byKey.komga_enabled).toBe('true');
    });

    it('leaves an empty key empty, so the UI can tell "not set" from "set"', async () => {
        mocks.settingFindMany.mockResolvedValue([{ key: 'komga_api_key', value: '' }]);
        const res = await GET(new Request('http://localhost/api/admin/config'));
        const { settings } = await res.json();
        expect(settings.find((s: any) => s.key === 'komga_api_key').value).toBe('');
    });

    it('is admin-only', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', role: 'USER' } });
        const res = await GET(new Request('http://localhost/api/admin/config'));
        expect(res.status).toBe(401);
        expect(mocks.settingFindMany).not.toHaveBeenCalled();
    });
});

describe('POST /api/admin/config — Komga settings', () => {
    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue(adminSession({ name: 'boss' }));
        mocks.settingFindUnique.mockResolvedValue({ key: 'setup_complete', value: 'true' });
        mocks.settingFindMany.mockResolvedValue(PRIOR_ROWS);
        mocks.transaction.mockImplementation(async (fn: any) =>
            fn({ systemSetting: { upsert: mocks.settingUpsert } }));
        mocks.syncSchedules.mockResolvedValue(undefined);
        mocks.encryptSecret.mockImplementation(async (v: string) => `enc:v2:${v}`);
        mocks.runKomgaEnableGate.mockResolvedValue(undefined);
        mocks.applyKomgaSettingsChange.mockResolvedValue(undefined);
    });

    it('encrypts komga_api_key at rest and leaves the URL in plaintext', async () => {
        const res = await POST(mockReq({ settings: { komga_url: 'http://komga:25600', komga_api_key: 'new-key-123' } }));

        expect(res.status).toBe(200);
        expect(mocks.encryptSecret).toHaveBeenCalledWith('new-key-123');
        expect(upserted().komga_api_key).toBe('enc:v2:new-key-123');
        expect(upserted().komga_url).toBe('http://komga:25600');
    });

    it("keeps the stored key on a masked '********' re-save (no upsert, no encryption)", async () => {
        await POST(mockReq({ settings: { komga_enabled: 'false', komga_api_key: '********' } }));

        expect('komga_api_key' in upserted()).toBe(false);
        expect(mocks.encryptSecret).not.toHaveBeenCalled();
    });

    it('runs the enable gate with the prior values BEFORE the secret-encryption loop', async () => {
        const res = await POST(mockReq({ settings: { komga_enabled: 'true', komga_url: 'http://komga:25600', komga_api_key: 'new-key-123' } }));

        expect(res.status).toBe(200);
        expect(mocks.settingFindMany).toHaveBeenCalledWith({ where: { key: { in: expect.arrayContaining(['komga_enabled', 'komga_api_key', 'komga_url']) } } });
        expect(mocks.runKomgaEnableGate).toHaveBeenCalledTimes(1);
        const [incoming, prior, warnings] = mocks.runKomgaEnableGate.mock.calls[0];
        expect(incoming).toMatchObject({ komga_enabled: 'true', komga_api_key: 'new-key-123' });
        expect(prior).toMatchObject({ komga_enabled: 'false', komga_api_key: 'stored-plaintext-key' });
        expect(Array.isArray(warnings)).toBe(true);

        const gateAt = mocks.runKomgaEnableGate.mock.invocationCallOrder[0];
        const encryptAt = mocks.encryptSecret.mock.invocationCallOrder[0];
        expect(gateAt).toBeLessThan(encryptAt);
        expect(gateAt).toBeLessThan(mocks.transaction.mock.invocationCallOrder[0]);
    });

    it('a failed gate refuses the false→true transition: saved as false, with a warning', async () => {
        mocks.runKomgaEnableGate.mockImplementation(async (incoming: any, _prior: any, warnings: string[]) => {
            incoming.komga_enabled = 'false';
            warnings.push('Komga was not enabled: Invalid API key, or Komga is older than 1.20.0 (no API-key support)');
        });

        const res = await POST(mockReq({ settings: { komga_enabled: 'true', komga_url: 'http://komga:25600', komga_api_key: '********' } }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.warnings).toEqual([expect.stringContaining('Komga was not enabled')]);
        expect(upserted().komga_enabled).toBe('false');
        // The hook sees what was actually saved.
        await flush();
        expect(mocks.applyKomgaSettingsChange.mock.calls[0][1]).toMatchObject({ komga_enabled: 'false' });
    });

    it('wiring with the real gate: a masked key is tested with the stored key; a failed test saves komga_enabled=false', async () => {
        mocks.runKomgaEnableGate.mockImplementation(mocks.actualGate!);
        mocks.testKomgaConnection.mockResolvedValue({
            success: false, message: 'Invalid API key, or Komga is older than 1.20.0 (no API-key support)', version: null, warnings: [],
        });

        const res = await POST(mockReq({ settings: {
            komga_enabled: 'true', komga_url: 'http://komga:25600', komga_api_key: '********',
            komga_path_mappings: '[{"omnibus":"/data/comics","komga":"/comics"}]',
        } }));

        expect(res.status).toBe(200);
        expect(mocks.testKomgaConnection).toHaveBeenCalledWith('http://komga:25600', 'stored-plaintext-key', expect.objectContaining({
            pathMappings: [{ omnibus: '/data/comics', komga: '/comics' }],
        }));
        expect((await res.json()).warnings).toEqual(['Komga was not enabled: Invalid API key, or Komga is older than 1.20.0 (no API-key support)']);
        expect(upserted().komga_enabled).toBe('false');
    });

    it('wiring with the real gate: a passing test saves komga_enabled=true', async () => {
        mocks.runKomgaEnableGate.mockImplementation(mocks.actualGate!);
        mocks.testKomgaConnection.mockResolvedValue({ success: true, message: 'Connected to Komga 1.28.1', version: '1.28.1', warnings: [] });

        const res = await POST(mockReq({ settings: { komga_enabled: true, komga_url: 'http://komga:25600', komga_api_key: 'new-key-123' } }));

        expect((await res.json()).warnings).toEqual([]);
        expect(mocks.testKomgaConnection.mock.calls[0][1]).toBe('new-key-123');
        expect(upserted()).toMatchObject({ komga_enabled: 'true', komga_api_key: 'enc:v2:new-key-123' });
    });

    it('a gate that throws fails closed on the enable transition — and never fails the save', async () => {
        mocks.runKomgaEnableGate.mockRejectedValue(new Error('boom'));

        const res = await POST(mockReq({ settings: { komga_enabled: 'true', komga_api_key: 'new-key-123' } }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.warnings).toEqual([expect.stringContaining('Komga was not enabled')]);
        expect(upserted().komga_enabled).toBe('false');
        expect(JSON.stringify(body)).not.toContain('new-key-123');
    });

    it('a gate that throws leaves an already-enabled Komga enabled', async () => {
        mocks.settingFindMany.mockResolvedValue([{ key: 'komga_enabled', value: 'true' }]);
        mocks.runKomgaEnableGate.mockRejectedValue(new Error('boom'));

        const res = await POST(mockReq({ settings: { komga_enabled: 'true' } }));

        expect(res.status).toBe(200);
        expect((await res.json()).warnings).toEqual([]);
        expect(upserted().komga_enabled).toBe('true');
    });

    it('runs the change hook after the commit with prior/next values and the actor', async () => {
        const res = await POST(mockReq({ settings: { komga_enabled: 'true', komga_url: 'http://new-komga:25600/', komga_api_key: '********', komga_scan_on_change: 'true' } }));
        expect(res.status).toBe(200);
        await flush();

        expect(mocks.applyKomgaSettingsChange).toHaveBeenCalledTimes(1);
        const [prior, next, actor] = mocks.applyKomgaSettingsChange.mock.calls[0];
        expect(prior).toEqual({
            komga_enabled: 'false', komga_url: 'http://komga:25600', komga_api_key: 'stored-plaintext-key',
            komga_path_mappings: '[]', komga_instance_id: 'inst-1',
        });
        expect(next).toEqual({
            komga_enabled: 'true', komga_url: 'http://new-komga:25600/',
            // masked → the stored (decrypted) key, never the '********' placeholder or ciphertext
            komga_api_key: 'stored-plaintext-key',
            komga_path_mappings: '[]', komga_instance_id: 'inst-1', komga_scan_on_change: 'true',
        });
        expect(actor).toEqual({ id: 'admin_1', username: 'boss' });

        const lastUpsertAt = Math.max(...mocks.settingUpsert.mock.invocationCallOrder);
        expect(mocks.applyKomgaSettingsChange.mock.invocationCallOrder[0]).toBeGreaterThan(lastUpsertAt);
    });

    it('passes the plaintext of a newly typed key to the hook (so a key change is detectable)', async () => {
        await POST(mockReq({ settings: { komga_api_key: 'rotated-key-456' } }));
        await flush();
        expect(mocks.applyKomgaSettingsChange.mock.calls[0][1].komga_api_key).toBe('rotated-key-456');
    });

    it('a rejecting change hook does not fail the save (logged as a [Komga] warning)', async () => {
        mocks.applyKomgaSettingsChange.mockRejectedValue(new Error('redis down'));

        const res = await POST(mockReq({ settings: { komga_enabled: 'false' } }));

        expect(res.status).toBe(200);
        expect((await res.json()).success).toBe(true);
        await flush();
        expect(loggerLog).toHaveBeenCalledWith(expect.stringMatching(/^\[Komga\].*redis down/), 'warn');
    });

    it('a synchronously throwing change hook does not fail the save', async () => {
        mocks.applyKomgaSettingsChange.mockImplementation(() => { throw new Error('sync throw'); });

        const res = await POST(mockReq({ settings: { komga_enabled: 'false' } }));

        expect(res.status).toBe(200);
        await flush();
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('sync throw'), 'warn');
    });

    it('never waits on the change hook (a hook that never settles cannot stall the response)', async () => {
        mocks.applyKomgaSettingsChange.mockReturnValue(new Promise(() => {}));

        const res = await POST(mockReq({ settings: { komga_url: 'http://komga:25600' } }));

        expect(res.status).toBe(200);
    });

    it('does not run the hook when the save itself fails', async () => {
        mocks.transaction.mockRejectedValue(new Error('SQLITE_BUSY'));

        const res = await POST(mockReq({ settings: { komga_enabled: 'false' } }));

        expect(res.status).toBe(500);
        await flush();
        expect(mocks.applyKomgaSettingsChange).not.toHaveBeenCalled();
    });

    it('a save without komga_* keys never touches Komga', async () => {
        const res = await POST(mockReq({ settings: { usenet_delete_after_import: 'true' } }));
        expect(res.status).toBe(200);
        await flush();
        expect(mocks.settingFindMany).not.toHaveBeenCalled();
        expect(mocks.runKomgaEnableGate).not.toHaveBeenCalled();
        expect(mocks.applyKomgaSettingsChange).not.toHaveBeenCalled();
    });

    it("normalises boolean komga flags to 'true'/'false' strings like every other flag", async () => {
        await POST(mockReq({ settings: { komga_enabled: true, komga_scan_on_change: false, komga_readlists_enabled: 'TRUE' } }));

        expect(mocks.runKomgaEnableGate.mock.calls[0][0].komga_enabled).toBe('true');
        expect(upserted()).toMatchObject({ komga_enabled: 'true', komga_scan_on_change: 'false', komga_readlists_enabled: 'true' });
    });

    it('never lets the browser overwrite the server-managed komga_instance_id', async () => {
        await POST(mockReq({ settings: { komga_enabled: 'false', komga_instance_id: 'forged' } }));
        await flush();

        expect('komga_instance_id' in upserted()).toBe(false);
        expect(mocks.applyKomgaSettingsChange.mock.calls[0][1].komga_instance_id).toBe('inst-1');
    });

    it('saves path mappings given as an array as a JSON string', async () => {
        const rows = [{ omnibus: '/data/comics', komga: '/comics' }];
        await POST(mockReq({ settings: { komga_path_mappings: rows } }));
        expect(upserted().komga_path_mappings).toBe(JSON.stringify(rows));
    });

    it('drops malformed path mappings (keeping the stored ones) with a warning instead of failing', async () => {
        const res = await POST(mockReq({ settings: { komga_path_mappings: '{not json', komga_url: 'http://komga:25600' } }));

        expect(res.status).toBe(200);
        expect((await res.json()).warnings).toEqual([expect.stringContaining('Komga path mappings were not saved')]);
        expect('komga_path_mappings' in upserted()).toBe(false);
        expect(upserted().komga_url).toBe('http://komga:25600');
    });

    it('an unreadable prior state still gates (fail closed) but skips the hook and never fails the save', async () => {
        mocks.settingFindMany.mockRejectedValue(new Error('database is locked'));

        const res = await POST(mockReq({ settings: { komga_enabled: 'true', komga_api_key: 'new-key-123' } }));

        expect(res.status).toBe(200);
        expect(mocks.runKomgaEnableGate).toHaveBeenCalledWith(expect.anything(), {}, expect.any(Array));
        await flush();
        expect(mocks.applyKomgaSettingsChange).not.toHaveBeenCalled();
        expect(loggerLog).toHaveBeenCalledWith(expect.stringMatching(/^\[Komga\].*database is locked/), 'warn');
    });

    it('never logs the API key', async () => {
        mocks.runKomgaEnableGate.mockRejectedValue(new Error('gate exploded'));
        mocks.applyKomgaSettingsChange.mockRejectedValue(new Error('hook exploded'));

        await POST(mockReq({ settings: { komga_enabled: 'true', komga_api_key: 'never-log-this-key' } }));
        await flush();

        for (const [msg] of loggerLog.mock.calls) expect(String(msg)).not.toContain('never-log-this-key');
    });
});
