import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '@/app/api/admin/config/route';
import { loggerLog, auditLog } from '../helpers/setup-global';
import { encryptSecret } from '@/lib/encryption';
import { pinPlatform } from '../helpers/platform';

// Settings-save response contract (2026-07-28 field repro on the dev box): once the settings
// transaction commits, NOTHING after it may stall or fail the response. With Redis down, the old
// `await syncSchedules()` ground through BullMQ command retries for minutes while the Save button
// sat disabled and the client silently skipped its saved-state bookkeeping — the save looked lost
// even though it had landed.

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    settingFindUnique: vi.fn(),
    settingUpsert: vi.fn(),
    transaction: vi.fn(),
    auditLog: vi.fn(),
    syncSchedules: vi.fn(),
    log: vi.fn(),
    keyTest: vi.fn(),
    hosterFindFirst: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));

vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findUnique: mocks.settingFindUnique },
        hosterAccount: { findFirst: mocks.hosterFindFirst },
        $transaction: mocks.transaction,
    }
}));

// The real queue module dials Redis at import time — never load it in a unit test.
vi.mock('@/lib/queue', () => ({ syncSchedules: mocks.syncSchedules }));
vi.mock('@/lib/encryption', () => ({
    encryptSecret: vi.fn(async (v: string) => v),
    decryptSecret: vi.fn(async (v: string) => v),
}));
vi.mock('@/lib/annas-test', () => ({ testAnnasArchiveKey: mocks.keyTest }));

const mockReq = (body: any) => ({
    json: async () => body,
    url: 'http://localhost/api/admin/config',
    headers: new Headers({ 'content-type': 'application/json' }),
}) as unknown as Request;

describe('Settings save: the response never waits on (or fails from) post-commit work', () => {
    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } });
        mocks.settingFindUnique.mockResolvedValue({ key: 'setup_complete', value: 'true' });
        mocks.transaction.mockImplementation(async (fn: any) =>
            fn({ systemSetting: { upsert: mocks.settingUpsert } }));
        auditLog.mockResolvedValue(undefined);
        mocks.syncSchedules.mockResolvedValue(undefined);
    });

    it('answers 200 immediately even when the schedule sync never settles (dead Redis)', async () => {
        // The exact field condition: BullMQ retrying against a dead Redis = a promise that never
        // resolves. If anyone re-awaits syncSchedules in the route, this test hangs and fails.
        mocks.syncSchedules.mockReturnValue(new Promise(() => {}));

        const res = await POST(mockReq({ settings: { usenet_delete_after_import: 'true' } }));

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ success: true });
        // The save itself committed…
        expect(mocks.settingUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { key: 'usenet_delete_after_import' }
        }));
        // …and the sync was still kicked off (fire-and-forget, not dropped).
        expect(mocks.syncSchedules).toHaveBeenCalledTimes(1);
    });

    it('answers 200 when the schedule sync rejects, logging instead of throwing', async () => {
        mocks.syncSchedules.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379'));

        const res = await POST(mockReq({ settings: { test_key: 'v' } }));

        expect(res.status).toBe(200);
        // Give the detached rejection a microtask to reach its .catch logger.
        await new Promise(r => setTimeout(r, 0));
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'), 'error');
    });

    it('a failed audit write cannot turn a committed save into a 500', async () => {
        auditLog.mockRejectedValue(new Error('audit table locked'));

        const res = await POST(mockReq({ settings: { test_key: 'v' } }));

        expect(res.status).toBe(200);
        expect(mocks.settingUpsert).toHaveBeenCalled();
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('audit table locked'), 'error');
    });

    it.each([
        { username: 'reader@example.com', password: '' },
        { username: '', password: 'password' },
        { username: 42, password: 'password' },
    ])('rejects incomplete or malformed active MEGA credentials before saving (%j)', async fields => {
        const response = await POST(mockReq({ hosterAccounts: [{ id: 'mega-1', hoster: 'mega', ...fields }] }));
        expect(response.status).toBe(400);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('encrypts a new MEGA password before persisting it', async () => {
        const upsert = vi.fn();
        mocks.transaction.mockImplementationOnce(async fn => fn({ hosterAccount: { findMany: vi.fn().mockResolvedValue([]), upsert } }));
        vi.mocked(encryptSecret).mockResolvedValueOnce('enc:v2:encrypted-password');
        const response = await POST(mockReq({ hosterAccounts: [{ id: 'mega-1', hoster: 'mega', username: 'reader@example.com', password: 'password' }] }));
        expect(response.status).toBe(200);
        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ password: 'enc:v2:encrypted-password' }) }));
    });

    it('preserves masked passwords and allows explicit clearing to anonymous mode', async () => {
        for (const fields of [{ username: 'reader@example.com', password: '********' }, { username: '', password: '' }]) {
            const upsert = vi.fn();
            mocks.transaction.mockImplementationOnce(async fn => fn({ hosterAccount: { findMany: vi.fn().mockResolvedValue([]), upsert } }));
            const response = await POST(mockReq({ hosterAccounts: [{ id: 'mega-1', hoster: 'mega', ...fields }] }));
            expect(response.status).toBe(200);
            const update = upsert.mock.calls[0][0].update;
            if (fields.password) expect(update).not.toHaveProperty('password');
            else expect(update.password).toBe('');
        }
    });

    it('saves normalized fallback mirrors and passes them to the automation connection test', async () => {
        mocks.hosterFindFirst.mockResolvedValueOnce({ apiKey: 'test-key' });
        mocks.keyTest.mockResolvedValueOnce({ success: true });
        const res = await POST(mockReq({ settings: {
            annas_archive_base_url: 'https://PRIMARY.example/',
            annas_archive_mirrors: ' https://one.example/\r\nhttps://two.example,https://one.example',
            search_source_priority: JSON.stringify([{ source: 'annas_archive', enabled: true }]),
        } }));
        expect(res.status).toBe(200);
        expect(mocks.keyTest).toHaveBeenCalledWith('test-key', 'https://primary.example', 'https://one.example\nhttps://two.example');
        expect(mocks.settingUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { key: 'annas_archive_mirrors' },
            update: { value: 'https://one.example\nhttps://two.example' },
        }));
    });

    it('rejects invalid mirror configuration before saving or making API calls', async () => {
        const res = await POST(mockReq({ settings: { annas_archive_mirrors: 'ftp://invalid.example' } }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toContain("Invalid Anna's Archive mirror URL");
        expect(mocks.transaction).not.toHaveBeenCalled();
        expect(mocks.keyTest).not.toHaveBeenCalled();
    });
});

// Discord field report (2026-10-13, Docker Desktop on Windows): a library saved as `C:\…` made every
// Smart Match fail with "EACCES: permission denied, mkdir 'C:'". The Settings page and the Setup
// Wizard both save here, so this is where a path the server can't use gets turned away - before
// anything is written.
describe('Settings save: folders must be paths the server itself can use', () => {
    let restorePlatform: (() => void) | null = null;
    const tx = {
        systemSetting: { upsert: mocks.settingUpsert },
        library: { findMany: vi.fn(), create: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
        downloadClient: { findMany: vi.fn(), create: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    };
    const lib = (path: string, name = 'Standard Comics') =>
        ({ id: 'tmp_1', name, path, isManga: false, isDefault: true });

    beforeEach(() => {
        restorePlatform = pinPlatform('linux'); // the Docker image
        mocks.getServerSession.mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } });
        mocks.settingFindUnique.mockResolvedValue({ key: 'setup_complete', value: 'true' });
        mocks.transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
        tx.library.findMany.mockResolvedValue([]);
        tx.downloadClient.findMany.mockResolvedValue([]);
        auditLog.mockResolvedValue(undefined);
        mocks.syncSchedules.mockResolvedValue(undefined);
    });
    afterEach(() => { restorePlatform?.(); restorePlatform = null; });

    it('turns away a Windows library path with the fix, and writes nothing', async () => {
        const res = await POST(mockReq({ libraries: [lib('C:\\Comics')], settings: { download_path: '/data/downloads' } }));

        expect(res.status).toBe(400);
        const { error } = await res.json();
        expect(error).toContain('Root Path of library "Standard Comics": "C:\\Comics" is a Windows path');
        expect(error).toContain('C:/Comics:/data/comics');
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it.each([
        { path: 'comics', expected: '"comics" isn\'t a full path' },
        { path: '', expected: 'No folder is set.' },
    ])('turns away a library path of "$path"', async ({ path, expected }) => {
        const res = await POST(mockReq({ libraries: [lib(path, 'Manga')] }));

        expect(res.status).toBe(400);
        expect((await res.json()).error).toContain(`Root Path of library "Manga": ${expected}`);
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('checks the Download Scan Root too, when one is set', async () => {
        const res = await POST(mockReq({ settings: { download_path: 'C:\\Downloads\\Comics' } }));

        expect(res.status).toBe(400);
        const { error } = await res.json();
        expect(error).toContain('Download Scan Root: "C:\\Downloads\\Comics" is a Windows path');
        expect(error).toContain('C:/Downloads/Comics:/data/downloads');
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('checks a download client\'s Omnibus-side path, never its client-side one', async () => {
        const client = { id: 'tmp_c', name: 'qBittorrent', type: 'qbit', url: 'http://qbit:8080', remotePath: 'D:\\Torrents', localPath: 'downloads' };
        const res = await POST(mockReq({ downloadClients: [client] }));

        expect(res.status).toBe(400);
        const { error } = await res.json();
        expect(error).toContain('Local Path of download client "qBittorrent": "downloads" isn\'t a full path');
        expect(error).not.toContain('D:\\Torrents');
    });

    it('lists every problem in one answer', async () => {
        const res = await POST(mockReq({
            libraries: [lib('C:\\Comics'), { ...lib('/data/manga', 'Manga'), id: 'tmp_2', isManga: true }, { ...lib('', 'Spare'), id: 'tmp_3' }],
            settings: { download_path: 'downloads' },
        }));

        const { error } = await res.json();
        expect(error).toContain('library "Standard Comics"');
        expect(error).toContain('library "Spare"');
        expect(error).toContain('Download Scan Root');
        expect(error).not.toContain('"Manga"');
    });

    it('saves container paths, an empty Download Scan Root and unmapped clients', async () => {
        const client = { id: 'tmp_c', name: 'SABnzbd', type: 'sab', url: 'http://sab:8080', remotePath: '/downloads', localPath: '/data/downloads' };
        const res = await POST(mockReq({
            libraries: [lib('/data/comics')],
            downloadClients: [client, { ...client, id: 'tmp_d', name: 'qBittorrent', localPath: null, remotePath: null }],
            settings: { download_path: '' },
        }));

        expect(res.status).toBe(200);
        expect(tx.library.create).toHaveBeenCalledWith({ data: expect.objectContaining({ path: '/data/comics' }) });
    });

    // beta.018 follow-up: the check trims, so " /data/comics" passed - but the raw value was stored,
    // and with its leading space it's a RELATIVE path. What's stored is now what was checked.
    it('stores the folders trimmed, exactly as they were checked', async () => {
        const client = { id: 'tmp_c', name: 'SABnzbd', type: 'sab', url: 'http://sab:8080', remotePath: '/downloads', localPath: ' /data/downloads ' };
        const res = await POST(mockReq({
            libraries: [lib(' /data/comics ')],
            downloadClients: [client],
            settings: { download_path: '/data/downloads  ' },
        }));

        expect(res.status).toBe(200);
        expect(tx.library.create).toHaveBeenCalledWith({ data: expect.objectContaining({ path: '/data/comics' }) });
        expect(tx.downloadClient.create).toHaveBeenCalledWith({ data: expect.objectContaining({ localPath: '/data/downloads' }) });
        expect(mocks.settingUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { key: 'download_path' },
            create: expect.objectContaining({ value: '/data/downloads' }),
        }));
    });

    it('keeps drive-letter paths working on a native Windows install', async () => {
        restorePlatform?.();
        restorePlatform = pinPlatform('win32');
        const res = await POST(mockReq({
            libraries: [lib('C:\\Users\\adam\\LIBRARIES\\comics')],
            settings: { download_path: 'C:\\Users\\adam\\Downloads' },
        }));

        expect(res.status).toBe(200);
    });
});
