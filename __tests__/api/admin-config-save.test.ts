import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/admin/config/route';
import { loggerLog, auditLog } from '../helpers/setup-global';

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
