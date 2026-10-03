import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    settingFindUnique: vi.fn(),
    settingUpsert: vi.fn(),
    transaction: vi.fn(),
    bookLinkDeleteMany: vi.fn(),
    seriesLinkDeleteMany: vi.fn(),
    libraryDeleteMany: vi.fn(),
    readListLinkUpdateMany: vi.fn(),
    testKomgaConnection: vi.fn(),
    createKomgaClientFor: vi.fn(),
    getInfo: vi.fn(),
    enqueueKomgaReconcile: vi.fn(),
    invalidate: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        $transaction: mocks.transaction,
        systemSetting: { findUnique: mocks.settingFindUnique, upsert: mocks.settingUpsert },
        komgaBookLink: { deleteMany: mocks.bookLinkDeleteMany },
        komgaSeriesLink: { deleteMany: mocks.seriesLinkDeleteMany },
        komgaLibrary: { deleteMany: mocks.libraryDeleteMany },
        komgaReadListLink: { updateMany: mocks.readListLinkUpdateMany },
    },
}));

vi.mock('@/lib/komga/connection-test', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/komga/connection-test')>()),
    testKomgaConnection: mocks.testKomgaConnection,
}));
vi.mock('@/lib/komga/factory', () => ({ createKomgaClientFor: mocks.createKomgaClientFor }));
vi.mock('@/lib/komga/queue', () => ({ enqueueKomgaReconcile: mocks.enqueueKomgaReconcile }));
vi.mock('@/lib/komga/settings', () => ({ invalidateKomgaSettingsCache: mocks.invalidate }));

import { runKomgaEnableGate, applyKomgaSettingsChange } from '@/lib/komga/settings-hooks';
import { auditLog, loggerLog } from '../../helpers/setup-global';

const OK = { success: true, message: 'Connected to Komga 1.28.1 as admin@x: 1 library, 1 mapped to Omnibus.', version: '1.28.1', warnings: [] };
const SAVED_KEY = 'stored-plaintext-key';

beforeEach(() => {
    mocks.testKomgaConnection.mockResolvedValue(OK);
    mocks.settingFindUnique.mockResolvedValue(null);
    mocks.settingUpsert.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (ops: unknown[]) => ops);
    mocks.bookLinkDeleteMany.mockReturnValue('book-op');
    mocks.seriesLinkDeleteMany.mockReturnValue('series-op');
    mocks.libraryDeleteMany.mockReturnValue('library-op');
    mocks.readListLinkUpdateMany.mockReturnValue('readlist-op');
    mocks.getInfo.mockResolvedValue({ version: '1.28.1' });
    mocks.createKomgaClientFor.mockResolvedValue({ getInfo: mocks.getInfo });
    mocks.enqueueKomgaReconcile.mockResolvedValue(undefined);
});

describe('runKomgaEnableGate', () => {
    const prior = { komga_enabled: 'false', komga_url: 'http://komga:25600', komga_api_key: SAVED_KEY, komga_path_mappings: '[]' };

    it('does nothing unless komga_enabled goes false → true', async () => {
        const warnings: string[] = [];
        await runKomgaEnableGate({ komga_enabled: 'true' }, { ...prior, komga_enabled: 'true' }, warnings);
        await runKomgaEnableGate({ komga_enabled: 'false' }, prior, warnings);
        await runKomgaEnableGate({ cv_api_key: 'x' }, prior, warnings);
        expect(mocks.testKomgaConnection).not.toHaveBeenCalled();
        expect(warnings).toEqual([]);
    });

    it('tests the effective url, the stored key for "********" and the incoming mappings', async () => {
        const incoming: Record<string, unknown> = {
            komga_enabled: 'true',
            komga_url: 'http://new-komga/komga',
            komga_api_key: '********',
            komga_path_mappings: '[{"omnibus":"/data/comics","komga":"/comics"}]',
        };
        const warnings: string[] = [];
        await runKomgaEnableGate(incoming, prior, warnings);
        expect(mocks.testKomgaConnection).toHaveBeenCalledWith('http://new-komga/komga', SAVED_KEY, {
            pathMappings: [{ omnibus: '/data/comics', komga: '/comics' }],
            includeLibraries: false,
        });
        expect(incoming.komga_enabled).toBe('true');
        expect(warnings).toEqual([]);
    });

    it('accepts a boolean true and falls back to the saved url / key when absent', async () => {
        await runKomgaEnableGate({ komga_enabled: true }, prior, []);
        expect(mocks.testKomgaConnection).toHaveBeenCalledWith('http://komga:25600', SAVED_KEY, { pathMappings: [], includeLibraries: false });
    });

    it('uses a newly typed key', async () => {
        await runKomgaEnableGate({ komga_enabled: 'true', komga_api_key: ' new-key ' }, prior, []);
        expect(mocks.testKomgaConnection.mock.calls[0][1]).toBe('new-key');
    });

    it('reads the stored (decrypted) key when the prior map does not carry it', async () => {
        mocks.settingFindUnique.mockResolvedValue({ key: 'komga_api_key', value: 'from-db' });
        await runKomgaEnableGate({ komga_enabled: 'true', komga_api_key: '********' }, { komga_url: 'http://k' }, []);
        expect(mocks.settingFindUnique).toHaveBeenCalledWith({ where: { key: 'komga_api_key' } });
        expect(mocks.testKomgaConnection.mock.calls[0][1]).toBe('from-db');
    });

    it('a failing test saves komga_enabled as false and explains why', async () => {
        mocks.testKomgaConnection.mockResolvedValue({ success: false, message: 'Invalid API key, or Komga is older than 1.20.0 (no API-key support)', version: null, warnings: [] });
        const incoming: Record<string, unknown> = { komga_enabled: 'true' };
        const warnings: string[] = ['earlier gate warning'];
        await runKomgaEnableGate(incoming, prior, warnings);
        expect(incoming.komga_enabled).toBe('false');
        expect(warnings).toEqual(['earlier gate warning', 'Komga was not enabled: Invalid API key, or Komga is older than 1.20.0 (no API-key support)']);
    });

    it('fails closed when the gate itself errors', async () => {
        mocks.testKomgaConnection.mockRejectedValue(new Error('unexpected'));
        const incoming: Record<string, unknown> = { komga_enabled: 'true' };
        const warnings: string[] = [];
        await expect(runKomgaEnableGate(incoming, prior, warnings)).resolves.toBeUndefined();
        expect(incoming.komga_enabled).toBe('false');
        expect(warnings[0]).toMatch(/^Komga was not enabled:/);
    });

    it('fails closed when the prior state could not be read (empty prior)', async () => {
        mocks.settingFindUnique.mockRejectedValue(new Error('db down'));
        const incoming: Record<string, unknown> = { komga_enabled: 'true', komga_api_key: '********' };
        const warnings: string[] = [];
        await runKomgaEnableGate(incoming, {}, warnings);
        expect(incoming.komga_enabled).toBe('false');
        expect(warnings).toHaveLength(1);
    });

    it('always strips the server-managed instance id from the incoming bag', async () => {
        const incoming: Record<string, unknown> = { komga_enabled: 'false', komga_instance_id: '' };
        await runKomgaEnableGate(incoming, prior, []);
        expect('komga_instance_id' in incoming).toBe(false);
    });

    it('refuses reading-list sync on a known Komga older than 1.23.3 when enabling', async () => {
        mocks.testKomgaConnection.mockResolvedValue({ ...OK, version: '1.23.2' });
        const incoming: Record<string, unknown> = { komga_enabled: 'true', komga_readlists_enabled: 'true' };
        const warnings: string[] = [];
        await runKomgaEnableGate(incoming, prior, warnings);
        expect(incoming.komga_enabled).toBe('true');
        expect(incoming.komga_readlists_enabled).toBe('false');
        expect(warnings[0]).toMatch(/reading-list sync was not enabled.*1\.23\.3.*1\.23\.2/);
    });

    it('keeps reading-list sync on a new enough Komga', async () => {
        mocks.testKomgaConnection.mockResolvedValue({ ...OK, version: '1.23.3' });
        const incoming: Record<string, unknown> = { komga_enabled: 'true', komga_readlists_enabled: 'true' };
        await runKomgaEnableGate(incoming, prior, []);
        expect(incoming.komga_readlists_enabled).toBe('true');
    });

    it('checks the version when reading lists are turned on while Komga stays enabled', async () => {
        const enabledPrior = { ...prior, komga_enabled: 'true', komga_readlists_enabled: 'false' };
        mocks.getInfo.mockResolvedValue({ version: '1.22.0' });
        const incoming: Record<string, unknown> = { komga_enabled: 'true', komga_readlists_enabled: 'true', komga_api_key: '********' };
        const warnings: string[] = [];
        await runKomgaEnableGate(incoming, enabledPrior, warnings);
        expect(mocks.testKomgaConnection).not.toHaveBeenCalled();
        expect(mocks.createKomgaClientFor).toHaveBeenCalledWith('http://komga:25600', SAVED_KEY);
        expect(incoming.komga_readlists_enabled).toBe('false');
        expect(warnings).toHaveLength(1);
    });

    it('allows reading lists when the version cannot be read (the push path re-checks)', async () => {
        const enabledPrior = { ...prior, komga_enabled: 'true' };
        mocks.getInfo.mockRejectedValue(new Error('unreachable'));
        const incoming: Record<string, unknown> = { komga_enabled: 'true', komga_readlists_enabled: 'true' };
        const warnings: string[] = [];
        await runKomgaEnableGate(incoming, enabledPrior, warnings);
        expect(incoming.komga_readlists_enabled).toBe('true');
        expect(warnings).toEqual([]);
    });
});

describe('applyKomgaSettingsChange', () => {
    const enabled = {
        komga_enabled: 'true', komga_url: 'http://komga:25600', komga_api_key: SAVED_KEY,
        komga_path_mappings: '[{"omnibus":"/data/comics","komga":"/comics"}]', komga_scan_on_change: 'true',
        komga_readlists_enabled: 'false', komga_instance_id: 'inst-1',
    };

    it('always invalidates the hot-flag cache', async () => {
        await applyKomgaSettingsChange(enabled, { ...enabled });
        expect(mocks.invalidate).toHaveBeenCalled();
    });

    it('a URL change wipes book/series/library links and detaches read lists', async () => {
        await applyKomgaSettingsChange(enabled, { ...enabled, komga_url: 'http://other-komga:25600' });
        expect(mocks.bookLinkDeleteMany).toHaveBeenCalledWith({});
        expect(mocks.seriesLinkDeleteMany).toHaveBeenCalledWith({});
        expect(mocks.libraryDeleteMany).toHaveBeenCalledWith({});
        expect(mocks.readListLinkUpdateMany).toHaveBeenCalledWith({
            where: { komgaReadListId: { not: null } },
            data: { komgaReadListId: null, status: 'pending' },
        });
        expect(mocks.transaction).toHaveBeenCalledWith(['book-op', 'series-op', 'library-op', 'readlist-op']);
        expect(mocks.enqueueKomgaReconcile).toHaveBeenCalledWith('settings changed (url)');
    });

    it('wipes on a URL change even while disabled, but queues nothing', async () => {
        const off = { ...enabled, komga_enabled: 'false' };
        await applyKomgaSettingsChange(off, { ...off, komga_url: 'http://other' });
        expect(mocks.transaction).toHaveBeenCalledTimes(1);
        expect(mocks.enqueueKomgaReconcile).not.toHaveBeenCalled();
    });

    it('a trailing slash or host case is not a server change', async () => {
        await applyKomgaSettingsChange(enabled, { ...enabled, komga_url: 'http://KOMGA:25600/' });
        expect(mocks.transaction).not.toHaveBeenCalled();
        expect(mocks.enqueueKomgaReconcile).not.toHaveBeenCalled();
    });

    it('generates the instance id once, on enable, when missing', async () => {
        const prior = { ...enabled, komga_enabled: 'false', komga_instance_id: undefined };
        await applyKomgaSettingsChange(prior, { ...prior, komga_enabled: 'true' });
        expect(mocks.settingFindUnique).toHaveBeenCalledWith({ where: { key: 'komga_instance_id' } });
        expect(mocks.settingUpsert).toHaveBeenCalledTimes(1);
        const arg = mocks.settingUpsert.mock.calls[0][0];
        expect(arg.where).toEqual({ key: 'komga_instance_id' });
        expect(arg.create.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(arg.update.value).toBe(arg.create.value);
    });

    it('never regenerates an existing instance id', async () => {
        await applyKomgaSettingsChange({ ...enabled, komga_enabled: 'false' }, { ...enabled });
        expect(mocks.settingUpsert).not.toHaveBeenCalled();

        // Snapshot lacks it, but the DB already has one (concurrent save).
        mocks.settingFindUnique.mockResolvedValue({ key: 'komga_instance_id', value: 'inst-db' });
        const prior = { ...enabled, komga_instance_id: undefined };
        await applyKomgaSettingsChange(prior, { ...prior });
        expect(mocks.settingUpsert).not.toHaveBeenCalled();
    });

    it('does not create an instance id while Komga stays disabled', async () => {
        const off = { ...enabled, komga_enabled: 'false', komga_instance_id: undefined };
        await applyKomgaSettingsChange(off, { ...off, komga_scan_on_change: 'false' });
        expect(mocks.settingFindUnique).not.toHaveBeenCalled();
        expect(mocks.settingUpsert).not.toHaveBeenCalled();
    });

    it.each([
        ['enabled false → true', { komga_enabled: 'false' }, {}, 'enabled'],
        ['url changed while enabled', {}, { komga_url: 'http://komga2:25600' }, 'settings changed (url)'],
        ['api key changed while enabled', {}, { komga_api_key: 'rotated-key' }, 'settings changed (apiKey)'],
        ['path mappings changed while enabled', {}, { komga_path_mappings: '[{"omnibus":"/data/comics","komga":"/library"}]' }, 'settings changed (pathMappings)'],
    ])('queues a reconcile: %s', async (_name, priorOver, nextOver, reason) => {
        const prior = { ...enabled, ...priorOver };
        await applyKomgaSettingsChange(prior, { ...enabled, ...nextOver });
        expect(mocks.enqueueKomgaReconcile).toHaveBeenCalledTimes(1);
        expect(mocks.enqueueKomgaReconcile).toHaveBeenCalledWith(reason);
    });

    it.each([
        ['nothing changed', {}, {}],
        ['only scan-on-change toggled', {}, { komga_scan_on_change: 'false' }],
        ['only reading lists toggled', {}, { komga_readlists_enabled: 'true' }],
        ['masked key re-saved', {}, { komga_api_key: '********' }],
        ['mappings re-serialized but identical', {}, { komga_path_mappings: '[ {"komga":"/comics/", "omnibus":"/data/comics"} ]' }],
        ['enabled true → false', {}, { komga_enabled: 'false' }],
        ['url changed while disabled', { komga_enabled: 'false' }, { komga_enabled: 'false', komga_url: 'http://x' }],
    ])('does not queue a reconcile: %s', async (_name, priorOver, nextOver) => {
        await applyKomgaSettingsChange({ ...enabled, ...priorOver }, { ...enabled, ...nextOver });
        expect(mocks.enqueueKomgaReconcile).not.toHaveBeenCalled();
    });

    it('an absent key in next means unchanged', async () => {
        const next: Record<string, string | undefined> = { ...enabled };
        delete next.komga_api_key;
        await applyKomgaSettingsChange(enabled, next);
        expect(mocks.enqueueKomgaReconcile).not.toHaveBeenCalled();
    });

    it('swallows an enqueue failure (Redis down) and logs a warning', async () => {
        mocks.enqueueKomgaReconcile.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
        await expect(applyKomgaSettingsChange({ ...enabled, komga_enabled: 'false' }, enabled)).resolves.toBeUndefined();
        expect(loggerLog).toHaveBeenCalledWith(expect.stringMatching(/^\[Komga\] Could not queue a reconcile.*ECONNREFUSED/), 'warn');
    });

    it('a failed wipe does not stop the reconcile enqueue', async () => {
        mocks.transaction.mockRejectedValue(new Error('SQLITE_BUSY'));
        await expect(applyKomgaSettingsChange(enabled, { ...enabled, komga_url: 'http://new' })).resolves.toBeUndefined();
        expect(mocks.enqueueKomgaReconcile).toHaveBeenCalledWith('settings changed (url)');
    });

    it('never throws, even on garbage input', async () => {
        mocks.invalidate.mockImplementationOnce(() => { throw new Error('boom'); });
        await expect(applyKomgaSettingsChange(enabled, enabled)).resolves.toBeUndefined();
        await expect(applyKomgaSettingsChange(undefined as never, undefined as never)).resolves.toBeUndefined();
    });

    it('audits which fields changed, never their values', async () => {
        await applyKomgaSettingsChange(enabled, { ...enabled, komga_api_key: 'rotated-key-value', komga_scan_on_change: 'false' }, { id: 'user-1', username: 'admin' });
        expect(auditLog).toHaveBeenCalledWith('KOMGA_SETTINGS_CHANGED', { enabled: true, changed: ['apiKey', 'scanOnChange'], by: 'admin' }, 'user-1');
        expect(JSON.stringify(auditLog.mock.calls)).not.toContain('rotated-key-value');
        expect(JSON.stringify(loggerLog.mock.calls)).not.toContain('rotated-key-value');
        expect(JSON.stringify(loggerLog.mock.calls)).not.toContain(SAVED_KEY);
    });

    it('writes no audit entry when nothing Komga-related changed', async () => {
        await applyKomgaSettingsChange(enabled, { ...enabled });
        expect(auditLog).not.toHaveBeenCalled();
    });
});
