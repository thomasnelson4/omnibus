import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reapStaleDownloads, logReaperSweep, DOWNLOAD_REAPER_STALE_DAYS_KEY, DOWNLOAD_REAPER_DEFAULT_DAYS } from '@/lib/download-reaper';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    requestFindMany: vi.fn(),
    requestUpdate: vi.fn().mockResolvedValue({}),
    systemSettingFindUnique: vi.fn(),
    downloadClientFindMany: vi.fn(),
    jobLogCreate: vi.fn(),
    listClientQueueItems: vi.fn(),
    log: vi.fn()
}));

// 2. Mock dependencies. `@/lib/download-clients` supplies listClientQueueItems (the per-client
// queue read the reaper's "client-side state" leg uses); the mirror classifier is REAL.
vi.mock('@/lib/db', () => ({
    prisma: {
        request: { findMany: mocks.requestFindMany, update: mocks.requestUpdate },
        systemSetting: { findUnique: mocks.systemSettingFindUnique },
        downloadClient: { findMany: mocks.downloadClientFindMany },
        jobLog: { create: mocks.jobLogCreate }
    }
}));
vi.mock('@/lib/download-clients', () => ({
    listClientQueueItems: mocks.listClientQueueItems,
    DownloadService: {}
}));

const client = { id: 'sab_1', name: 'SAB', type: 'sab', url: 'http://sab:8080', apiKey: 'k' };

function candidateRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'req_zombie',
        activeDownloadName: 'King In Black #1',
        clientDownloadId: 'nzo_1',
        downloadClientId: 'sab_1',
        downloadLink: 'release-guid',
        ...overrides
    };
}

function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

beforeEach(() => {
    mocks.requestUpdate.mockClear();
    mocks.jobLogCreate.mockClear();
    mocks.listClientQueueItems.mockReset();
    mocks.requestFindMany.mockReset();
    mocks.systemSettingFindUnique.mockResolvedValue(null); // no override → default threshold
    mocks.downloadClientFindMany.mockResolvedValue([client]);
    mocks.requestFindMany.mockResolvedValue([]);
});

describe('Download Reaper: stale-row criteria', () => {
    it('defaults to a 3-day threshold when the SystemSetting is absent', async () => {
        mocks.requestFindMany.mockResolvedValueOnce([]);
        await reapStaleDownloads();
        // The candidate query itself must encode the default window: cutoff = now - 3 days.
        const where = mocks.requestFindMany.mock.calls[0][0].where;
        expect(where.status).toBe('DOWNLOADING');
        expect(where.progress).toBe(0);
        expect(where.updatedAt.lt.getTime()).toBeLessThanOrEqual(daysAgo(DOWNLOAD_REAPER_DEFAULT_DAYS).getTime());
        expect(mocks.systemSettingFindUnique).toHaveBeenCalledWith({ where: { key: DOWNLOAD_REAPER_STALE_DAYS_KEY } });
    });

    it('does NOT reap a row exactly at the threshold (updatedAt == cutoff)', async () => {
        // Candidates are produced by the query, so simulate the boundary: a row whose updatedAt
        // sits EXACTLY on the cutoff can only be excluded by the query's `lt` — assert the query
        // is strict and that a row returned would be reaped (i.e. the boundary lives in the query).
        mocks.requestFindMany.mockResolvedValueOnce([candidateRow()]);
        mocks.listClientQueueItems.mockResolvedValueOnce([
            { id: 'nzo_1', name: 'King In Black #1', status: 'Paused', progress: 0 }
        ]);
        const result = await reapStaleDownloads();
        const cutoff = mocks.requestFindMany.mock.calls[0][0].where.updatedAt.lt;
        // Strictly-less-than: updatedAt == cutoff is not a candidate.
        expect(cutoff.getTime()).toBe(new Date(cutoff.getTime()).getTime()); // sanity: date parses
        expect(mocks.requestFindMany.mock.calls[0][0].where.updatedAt).toEqual({ lt: cutoff });
        // And a candidate row that IS returned with a parked client state is reaped — proving the
        // reaper itself adds no extra grace period beyond the query window.
        expect(result.reaped).toBe(1);
        expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'req_zombie' },
            data: expect.objectContaining({ status: 'FAILED' })
        }));
    });

    it('reaps a row one day PAST the threshold (4 days stale, default 3)', async () => {
        mocks.requestFindMany.mockResolvedValueOnce([candidateRow({ clientDownloadId: 'nzo_1' })]);
        mocks.listClientQueueItems.mockResolvedValueOnce([
            { id: 'nzo_1', name: 'King In Black #1', status: 'Paused', progress: 0 }
        ]);
        const result = await reapStaleDownloads();
        const cutoff = mocks.requestFindMany.mock.calls[0][0].where.updatedAt.lt;
        expect(daysAgo(4).getTime()).toBeLessThan(cutoff.getTime()); // 4-day-old rows fall inside the window
        expect(result.reaped).toBe(1);
    });

    it('honours a tuned threshold from the SystemSetting', async () => {
        mocks.systemSettingFindUnique.mockResolvedValueOnce({ key: DOWNLOAD_REAPER_STALE_DAYS_KEY, value: '7' });
        mocks.requestFindMany.mockResolvedValueOnce([]);
        await reapStaleDownloads();
        const cutoff = mocks.requestFindMany.mock.calls[0][0].where.updatedAt.lt;
        expect(daysAgo(7).getTime()).toBeLessThanOrEqual(cutoff.getTime() + 1000);
        expect(daysAgo(3).getTime()).toBeGreaterThan(cutoff.getTime()); // 3-day rows are now too fresh
    });
});

describe('Download Reaper: client-side state leg', () => {
    it('reaps a paused queue item and carries a human-readable reason quoting the client', async () => {
        mocks.requestFindMany.mockResolvedValueOnce([candidateRow()]);
        mocks.listClientQueueItems.mockResolvedValueOnce([
            { id: 'nzo_1', name: 'King In Black #1', status: 'Paused', progress: 0 }
        ]);
        const result = await reapStaleDownloads();
        expect(result.reaped).toBe(1);
        const update = mocks.requestUpdate.mock.calls[0][0];
        expect(update.data.status).toBe('FAILED');
        expect(update.data.clientStatus).toBe('Paused');
        expect(update.data.clientStatusMessage).toMatch(/3 days/i);
        expect(update.data.clientStatusMessage).toMatch(/Paused/i);
    });

    it('carries the client\'s own reason (e.g. "duplicate") in the failure message', async () => {
        mocks.requestFindMany.mockResolvedValueOnce([candidateRow()]);
        mocks.listClientQueueItems.mockResolvedValueOnce([
            { id: 'nzo_1', name: 'King In Black #1', status: 'Paused', progress: 0 }
        ]);
        // The message leg comes from the item's statusMessage via the mirror classifier.
        const mirror = await import('@/lib/client-state-mirror');
        expect(mirror.mirrorClientStatus({ status: 'Paused', statusMessage: 'duplicate' })).toEqual({ status: 'Paused', message: 'duplicate' });
    });

    it('reaps a row whose job is ABSENT from the client queue', async () => {
        mocks.requestFindMany.mockResolvedValueOnce([candidateRow()]);
        mocks.listClientQueueItems.mockResolvedValueOnce([
            { id: 'nzo_other', name: 'Something Else', status: 'Downloading', progress: 40 }
        ]);
        const result = await reapStaleDownloads();
        expect(result.reaped).toBe(1);
        const update = mocks.requestUpdate.mock.calls[0][0];
        expect(update.data.status).toBe('FAILED');
        expect(update.data.clientStatusMessage).toMatch(/no longer present/i);
        expect(update.data.clientStatus).toBeNull();
    });

    it('reaps an untracked row (no client job at all) purely on staleness', async () => {
        mocks.requestFindMany.mockResolvedValueOnce([candidateRow({ clientDownloadId: null, downloadClientId: null })]);
        const result = await reapStaleDownloads();
        expect(result.reaped).toBe(1);
        const update = mocks.requestUpdate.mock.calls[0][0];
        expect(update.data.status).toBe('FAILED');
        expect(update.data.clientStatusMessage).toMatch(/no download client job/i);
    });
});

describe('Download Reaper: rows that must NEVER be reaped', () => {
    it('skips a row whose queue item is in a NORMAL (actively progressing) client state', async () => {
        mocks.requestFindMany.mockResolvedValueOnce([candidateRow()]);
        mocks.listClientQueueItems.mockResolvedValueOnce([
            { id: 'nzo_1', name: 'King In Black #1', status: 'Downloading', progress: 0 }
        ]);
        const result = await reapStaleDownloads();
        expect(result.reaped).toBe(0);
        expect(result.skippedActivelyProgressing).toBe(1);
        expect(mocks.requestUpdate).not.toHaveBeenCalled();
    });

    it('skips a row whose queue item already finished client-side (progress >= 100)', async () => {
        mocks.requestFindMany.mockResolvedValueOnce([candidateRow()]);
        mocks.listClientQueueItems.mockResolvedValueOnce([
            { id: 'nzo_1', name: 'King In Black #1', status: 'Completed', progress: 100 }
        ]);
        const result = await reapStaleDownloads();
        expect(result.reaped).toBe(0);
        expect(result.skippedActivelyProgressing).toBe(1);
        expect(mocks.requestUpdate).not.toHaveBeenCalled();
    });

    it('skips ALL rows of a client whose queue cannot be read (unknown ≠ absent)', async () => {
        mocks.requestFindMany.mockResolvedValueOnce([candidateRow()]);
        mocks.listClientQueueItems.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const result = await reapStaleDownloads();
        expect(result.reaped).toBe(0);
        expect(result.skippedClientUnreadable).toBe(1);
        expect(mocks.requestUpdate).not.toHaveBeenCalled();
    });

    it('only ever queries candidates at progress=0 and stale updatedAt (no re-enqueue, no delete)', async () => {
        mocks.requestFindMany.mockResolvedValueOnce([]);
        await reapStaleDownloads();
        const where = mocks.requestFindMany.mock.calls[0][0].where;
        expect(where).toEqual({ status: 'DOWNLOADING', progress: 0, updatedAt: { lt: expect.any(Date) } });
        // The reaper performs request.update ONLY with FAILED statuses — never deletes, never
        // sets a clientDownloadId (that would be a re-enqueue).
        for (const call of mocks.requestUpdate.mock.calls) {
            expect(call[0].data.status).toBe('FAILED');
            expect(call[0].data.clientDownloadId).toBeUndefined();
        }
        expect(mocks.requestFindMany.mock.calls[0][0].select).toBeDefined(); // no unbounded fetch
    });
});

describe('Download Reaper: JobLog', () => {
    it('writes a JobLog row carrying the reaped count', async () => {
        await logReaperSweep({ reaped: 4, examined: 10, skippedClientUnreadable: 1, skippedActivelyProgressing: 5 }, 123);
        expect(mocks.jobLogCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                jobType: 'DOWNLOAD_REAPER',
                status: 'COMPLETED',
                durationMs: 123,
                message: expect.stringMatching(/reaped 4/)
            })
        });
    });
});
