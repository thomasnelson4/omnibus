import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    settingFindMany: vi.fn(),
    headerFindMany: vi.fn(),
    clientCtor: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findMany: mocks.settingFindMany },
        customHeader: { findMany: mocks.headerFindMany },
    },
}));

// factory.ts is the only consumer of the client here; a stub keeps this file independent of client.ts.
vi.mock('@/lib/komga/client', () => ({
    KomgaClient: class {
        opts: unknown;
        constructor(opts: unknown) { this.opts = opts; mocks.clientCtor(opts); }
    },
}));

import {
    parseKomgaSettings,
    getKomgaSettings,
    getKomgaHotFlags,
    invalidateKomgaSettingsCache,
    getKomgaCustomHeaders,
    type KomgaSettings,
} from '@/lib/komga/settings';
import { getKomgaClient, createKomgaClientFor } from '@/lib/komga/factory';
import { KOMGA_SETTING_KEYS, KOMGA_SETTINGS_CACHE_TTL_MS } from '@/lib/komga/constants';

const rows = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value }));

beforeEach(() => {
    invalidateKomgaSettingsCache();
    mocks.settingFindMany.mockResolvedValue([]);
    mocks.headerFindMany.mockResolvedValue([]);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('parseKomgaSettings', () => {
    it('defaults: everything off except scan-on-change, empty mappings', () => {
        expect(parseKomgaSettings([])).toEqual({
            enabled: false,
            url: null,
            apiKey: null,
            pathMappings: [],
            pathMappingsRaw: '[]',
            scanOnChange: true,
            readListsEnabled: false,
            instanceId: null,
        });
    });

    it('parses every key and normalizes the path mappings', () => {
        const s = parseKomgaSettings(rows({
            komga_enabled: 'true',
            komga_url: '  http://komga:25600/komga/ ',
            komga_api_key: ' abc123 ',
            komga_path_mappings: '[{"omnibus":"/data/comics/","komga":"/comics"}]',
            komga_scan_on_change: 'false',
            komga_readlists_enabled: 'true',
            komga_instance_id: 'inst-1',
        }));
        expect(s).toEqual({
            enabled: true,
            url: 'http://komga:25600/komga/',
            apiKey: 'abc123',
            pathMappings: [{ omnibus: '/data/comics', komga: '/comics' }],
            pathMappingsRaw: '[{"omnibus":"/data/comics/","komga":"/comics"}]',
            scanOnChange: false,
            readListsEnabled: true,
            instanceId: 'inst-1',
        });
    });

    it('bad mappings JSON yields [] but keeps the raw string', () => {
        const s = parseKomgaSettings(rows({ komga_path_mappings: '{not json' }));
        expect(s.pathMappings).toEqual([]);
        expect(s.pathMappingsRaw).toBe('{not json');
        expect(parseKomgaSettings(rows({ komga_path_mappings: '{"omnibus":"/a"}' })).pathMappings).toEqual([]);
    });

    it('scan-on-change: blank means default on, only an explicit value decides', () => {
        expect(parseKomgaSettings(rows({ komga_scan_on_change: '' })).scanOnChange).toBe(true);
        expect(parseKomgaSettings(rows({ komga_scan_on_change: 'true' })).scanOnChange).toBe(true);
        expect(parseKomgaSettings(rows({ komga_scan_on_change: 'false' })).scanOnChange).toBe(false);
    });

    it('blank url / key / instance id are null, and non-"true" flags are off', () => {
        const s = parseKomgaSettings(rows({ komga_url: '   ', komga_api_key: '', komga_instance_id: ' ', komga_enabled: 'yes', komga_readlists_enabled: 'false' }));
        expect(s.url).toBeNull();
        expect(s.apiKey).toBeNull();
        expect(s.instanceId).toBeNull();
        expect(s.enabled).toBe(false);
        expect(s.readListsEnabled).toBe(false);
    });
});

describe('getKomgaSettings', () => {
    it('reads exactly the Komga keys, fresh every call', async () => {
        mocks.settingFindMany.mockResolvedValue(rows({ komga_enabled: 'true', komga_url: 'http://k' }));
        const s = await getKomgaSettings();
        expect(s.enabled).toBe(true);
        expect(s.url).toBe('http://k');
        await getKomgaSettings();
        expect(mocks.settingFindMany).toHaveBeenCalledTimes(2);
        const where = mocks.settingFindMany.mock.calls[0][0].where;
        expect([...where.key.in].sort()).toEqual([...KOMGA_SETTING_KEYS].sort());
        expect(where.key.in).toHaveLength(7);
    });

    it('propagates DB errors (callers are not hot paths)', async () => {
        mocks.settingFindMany.mockRejectedValue(new Error('db down'));
        await expect(getKomgaSettings()).rejects.toThrow('db down');
    });
});

describe('getKomgaHotFlags', () => {
    it('returns effective flags: sub-flags are off while Komga is disabled', async () => {
        mocks.settingFindMany.mockResolvedValue(rows({ komga_enabled: 'false', komga_scan_on_change: 'true', komga_readlists_enabled: 'true' }));
        expect(await getKomgaHotFlags()).toEqual({ enabled: false, scanOnChange: false, readListsEnabled: false });
        invalidateKomgaSettingsCache();
        mocks.settingFindMany.mockResolvedValue(rows({ komga_enabled: 'true', komga_readlists_enabled: 'true' }));
        expect(await getKomgaHotFlags()).toEqual({ enabled: true, scanOnChange: true, readListsEnabled: true });
    });

    it('reads only the three flag keys', async () => {
        await getKomgaHotFlags();
        const keys = mocks.settingFindMany.mock.calls[0][0].where.key.in;
        expect([...keys].sort()).toEqual(['komga_enabled', 'komga_readlists_enabled', 'komga_scan_on_change']);
    });

    it('caches for the TTL, then re-reads', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        mocks.settingFindMany.mockResolvedValue(rows({ komga_enabled: 'true' }));
        await getKomgaHotFlags();
        await getKomgaHotFlags();
        expect(mocks.settingFindMany).toHaveBeenCalledTimes(1);

        mocks.settingFindMany.mockResolvedValue(rows({ komga_enabled: 'false' }));
        vi.advanceTimersByTime(KOMGA_SETTINGS_CACHE_TTL_MS - 1);
        expect((await getKomgaHotFlags()).enabled).toBe(true);
        expect(mocks.settingFindMany).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(2);
        expect((await getKomgaHotFlags()).enabled).toBe(false);
        expect(mocks.settingFindMany).toHaveBeenCalledTimes(2);
    });

    it('invalidateKomgaSettingsCache forces the next read', async () => {
        mocks.settingFindMany.mockResolvedValue(rows({ komga_enabled: 'true' }));
        expect((await getKomgaHotFlags()).enabled).toBe(true);
        mocks.settingFindMany.mockResolvedValue(rows({ komga_enabled: 'false' }));
        invalidateKomgaSettingsCache();
        expect((await getKomgaHotFlags()).enabled).toBe(false);
        expect(mocks.settingFindMany).toHaveBeenCalledTimes(2);
    });

    it('a DB error yields all-false without throwing (and is cached for the TTL)', async () => {
        mocks.settingFindMany.mockRejectedValue(new Error('SQLITE_BUSY'));
        expect(await getKomgaHotFlags()).toEqual({ enabled: false, scanOnChange: false, readListsEnabled: false });
        await getKomgaHotFlags();
        expect(mocks.settingFindMany).toHaveBeenCalledTimes(1);
    });

    it('concurrent callers share one DB read', async () => {
        let release!: (v: unknown) => void;
        mocks.settingFindMany.mockReturnValue(new Promise(r => { release = r; }));
        const a = getKomgaHotFlags();
        const b = getKomgaHotFlags();
        release(rows({ komga_enabled: 'true' }));
        expect(await a).toEqual(await b);
        expect(mocks.settingFindMany).toHaveBeenCalledTimes(1);
    });

    it('a read in flight across an invalidate does not cache pre-save values', async () => {
        let release!: (v: unknown) => void;
        mocks.settingFindMany.mockReturnValueOnce(new Promise(r => { release = r; }));
        const stale = getKomgaHotFlags();
        invalidateKomgaSettingsCache();
        release(rows({ komga_enabled: 'true' }));
        expect((await stale).enabled).toBe(true);

        mocks.settingFindMany.mockResolvedValue(rows({ komga_enabled: 'false' }));
        expect((await getKomgaHotFlags()).enabled).toBe(false);
    });
});

describe('getKomgaCustomHeaders', () => {
    it('maps rows to trimmed headers and drops blank ones', async () => {
        mocks.headerFindMany.mockResolvedValue([
            { id: '1', key: ' CF-Access-Client-Id ', value: ' abc ' },
            { id: '2', key: 'X-Empty', value: '' },
            { id: '3', key: '', value: 'orphan' },
        ]);
        expect(await getKomgaCustomHeaders()).toEqual({ 'CF-Access-Client-Id': 'abc' });
    });

    it('returns {} on a DB error', async () => {
        mocks.headerFindMany.mockRejectedValue(new Error('nope'));
        expect(await getKomgaCustomHeaders()).toEqual({});
    });
});

describe('factory', () => {
    const base: KomgaSettings = {
        enabled: true, url: 'http://komga:25600', apiKey: 'key-1', pathMappings: [], pathMappingsRaw: '[]',
        scanOnChange: true, readListsEnabled: false, instanceId: null,
    };

    it('getKomgaClient returns null when disabled or the URL / key is missing', async () => {
        expect(await getKomgaClient({ ...base, enabled: false })).toBeNull();
        expect(await getKomgaClient({ ...base, url: null })).toBeNull();
        expect(await getKomgaClient({ ...base, apiKey: null })).toBeNull();
        expect(mocks.clientCtor).not.toHaveBeenCalled();
    });

    it('getKomgaClient builds a client with the saved custom headers', async () => {
        mocks.headerFindMany.mockResolvedValue([{ id: '1', key: 'X-Proxy', value: 'p' }]);
        const client = await getKomgaClient(base);
        expect(client).not.toBeNull();
        expect(mocks.clientCtor).toHaveBeenCalledWith({ baseUrl: 'http://komga:25600', apiKey: 'key-1', headers: { 'X-Proxy': 'p' } });
    });

    it('getKomgaClient reads the saved settings when none are passed', async () => {
        mocks.settingFindMany.mockResolvedValue(rows({ komga_enabled: 'true', komga_url: 'http://saved', komga_api_key: 'k' }));
        await getKomgaClient();
        expect(mocks.clientCtor).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'http://saved', apiKey: 'k' }));
    });

    it('createKomgaClientFor trims the unsaved url / key', async () => {
        await createKomgaClientFor(' http://x/komga ', ' k2 ');
        expect(mocks.clientCtor).toHaveBeenCalledWith({ baseUrl: 'http://x/komga', apiKey: 'k2', headers: {} });
    });
});
