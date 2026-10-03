import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    workerCtor: vi.fn(),
    add: vi.fn(),
    upsertJobScheduler: vi.fn(),
    on: vi.fn(),
    settings: vi.fn(),
    komgaLibraryFindMany: vi.fn(),
    libraryFindMany: vi.fn(),
    enqueueKomgaSync: vi.fn(),
    enqueueKomgaReconcile: vi.fn(),
    runLibrarySync: vi.fn(),
    flushDueLibraries: vi.fn(),
}));

vi.unmock('@/lib/komga/changes');

vi.mock('bullmq', () => ({
    Worker: class {
        on = mocks.on;
        constructor(name: string, proc: unknown, opts: unknown) { mocks.workerCtor(name, proc, opts); }
    },
    Queue: class {
        add = mocks.add;
        upsertJobScheduler = mocks.upsertJobScheduler;
        on = mocks.on;
    },
}));
vi.mock('ioredis', () => ({ default: class { constructor() { /* no connection in tests */ } } }));
vi.mock('@/lib/komga/settings', () => ({ getKomgaSettings: mocks.settings }));
vi.mock('@/lib/komga/flush', () => ({ flushDueLibraries: mocks.flushDueLibraries }));
vi.mock('@/lib/komga/queue', () => ({
    getKomgaQueue: () => ({ add: mocks.add, upsertJobScheduler: mocks.upsertJobScheduler, on: mocks.on }),
    getKomgaRedisConnection: () => ({}),
    enqueueKomgaSync: mocks.enqueueKomgaSync,
    enqueueKomgaReconcile: mocks.enqueueKomgaReconcile,
    KOMGA_BASE_JOB_OPTIONS: { removeOnComplete: true, removeOnFail: 100, attempts: 1 },
    KOMGA_JOB: { SYNC: 'KOMGA_SYNC', RECONCILE: 'KOMGA_RECONCILE', READLIST_PUSH: 'KOMGA_READLIST_PUSH', READLIST_DELETE: 'KOMGA_READLIST_DELETE' },
}));
vi.mock('@/lib/komga/sync', () => ({ runLibrarySync: mocks.runLibrarySync }));
vi.mock('@/lib/db', () => ({ prisma: { komgaLibrary: { findMany: mocks.komgaLibraryFindMany }, library: { findMany: mocks.libraryFindMany } } }));

import { initKomgaWorker, processKomgaJob, scheduleKomgaReconcile } from '@/lib/komga/worker';
import { KOMGA_RECONCILE_INTERVAL_MS, KOMGA_FLUSH_INTERVAL_MS } from '@/lib/komga/constants';
import { loggerLog } from '../../helpers/setup-global';

const g = globalThis as Record<string, unknown>;
const ENABLED = { enabled: true, url: 'http://k', apiKey: 'k', pathMappings: [], pathMappingsRaw: '', scanOnChange: true, readListsEnabled: true, instanceId: null };

beforeEach(() => {
    delete g.__komgaWorker;
    delete g.__komgaFlushTimer;
    delete g.__komgaFlushing;
    delete g.__komgaRepeatableScheduled;
    vi.useFakeTimers();
    mocks.settings.mockResolvedValue(ENABLED);
    mocks.add.mockResolvedValue({ id: '1' });
    mocks.upsertJobScheduler.mockResolvedValue(undefined);
    mocks.komgaLibraryFindMany.mockResolvedValue([]);
    mocks.libraryFindMany.mockResolvedValue([]);
    mocks.enqueueKomgaSync.mockResolvedValue(undefined);
    mocks.runLibrarySync.mockResolvedValue({ done: true });
    mocks.flushDueLibraries.mockResolvedValue(0);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('processKomgaJob dispatch', () => {
    it('routes KOMGA_SYNC to runLibrarySync', async () => {
        await processKomgaJob({ name: 'KOMGA_SYNC', data: { omnibusLibraryId: 'lib-1' } });
        expect(mocks.runLibrarySync).toHaveBeenCalledWith({ omnibusLibraryId: 'lib-1' });
    });

    it('logs and returns for the read-list jobs (Phase 4)', async () => {
        await processKomgaJob({ name: 'KOMGA_READLIST_PUSH', data: { readingListId: 'rl-1' } });
        expect(mocks.runLibrarySync).not.toHaveBeenCalled();
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('not implemented until Phase 4'), 'debug');
    });

    it('never throws "Unknown job type" — attempts is 1, so a throw is just a dead job', async () => {
        await expect(processKomgaJob({ name: 'SOMETHING_ELSE', data: {} })).resolves.toBeUndefined();
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('unknown job type'), 'warn');
    });

    it('does nothing at all when Komga is disabled', async () => {
        mocks.settings.mockResolvedValue({ ...ENABLED, enabled: false });
        await processKomgaJob({ name: 'KOMGA_SYNC', data: { omnibusLibraryId: 'lib-1' } });
        expect(mocks.runLibrarySync).not.toHaveBeenCalled();
    });

    it('logs a handler failure instead of rethrowing', async () => {
        mocks.runLibrarySync.mockRejectedValue(new Error('boom'));
        await expect(processKomgaJob({ name: 'KOMGA_SYNC', data: {} })).resolves.toBeUndefined();
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('job KOMGA_SYNC failed'), 'warn');
    });
});

describe('the daily reconcile', () => {
    const komgaLib = (id: string, translatedRoot: string, over: Record<string, unknown> = {}) => ({
        komgaLibraryId: id, name: id, root: `/komga${translatedRoot}`, translatedRoot,
        omnibusLibraryId: null, settings: '{}', unavailable: false, ...over,
    });

    it('enqueues a full sync for every Omnibus library a Komga library serves', async () => {
        mocks.libraryFindMany.mockResolvedValue([
            { id: 'lib-1', name: 'A', path: '/data/a' },
            { id: 'lib-2', name: 'B', path: '/data/b' },
        ]);
        mocks.komgaLibraryFindMany.mockResolvedValue([komgaLib('K1', '/data')]);
        await processKomgaJob({ name: 'KOMGA_RECONCILE', data: { reason: 'daily' } });
        expect(mocks.enqueueKomgaSync).toHaveBeenCalledTimes(2);
        expect(mocks.enqueueKomgaSync).toHaveBeenCalledWith(
            expect.objectContaining({ omnibusLibraryId: 'lib-1', full: true, reason: 'reconcile:daily' }),
        );
    });

    it('covers a library whose cached best-match column points somewhere else', async () => {
        // One Komga library over /data is stored against the single best match (lib-1). lib-2 is
        // equally served and must still get its nightly pass — this is why selection uses runtime
        // containment rather than the omnibusLibraryId column.
        mocks.libraryFindMany.mockResolvedValue([
            { id: 'lib-1', name: 'A', path: '/data/a' },
            { id: 'lib-2', name: 'B', path: '/data/b' },
        ]);
        mocks.komgaLibraryFindMany.mockResolvedValue([komgaLib('K1', '/data', { omnibusLibraryId: 'lib-1' })]);
        await processKomgaJob({ name: 'KOMGA_RECONCILE', data: { reason: 'daily' } });
        expect(mocks.enqueueKomgaSync).toHaveBeenCalledTimes(2);
    });

    it('enqueues one job for a library served by two Komga libraries', async () => {
        mocks.libraryFindMany.mockResolvedValue([{ id: 'lib-1', name: 'A', path: '/data/a' }]);
        mocks.komgaLibraryFindMany.mockResolvedValue([komgaLib('K1', '/data/a'), komgaLib('K2', '/data/a2')]);
        await processKomgaJob({ name: 'KOMGA_RECONCILE', data: { reason: 'daily' } });
        expect(mocks.enqueueKomgaSync).toHaveBeenCalledTimes(1);
    });

    it('ignores libraries no Komga library serves', async () => {
        mocks.libraryFindMany.mockResolvedValue([{ id: 'lib-1', name: 'A', path: '/data/a' }]);
        mocks.komgaLibraryFindMany.mockResolvedValue([komgaLib('K1', '/other')]);
        await processKomgaJob({ name: 'KOMGA_RECONCILE', data: { reason: 'daily' } });
        expect(mocks.enqueueKomgaSync).not.toHaveBeenCalled();
    });

    it('skips a Komga library Komga reports as unavailable', async () => {
        mocks.libraryFindMany.mockResolvedValue([{ id: 'lib-1', name: 'A', path: '/data/a' }]);
        mocks.komgaLibraryFindMany.mockResolvedValue([komgaLib('K1', '/data/a', { unavailable: true })]);
        await processKomgaJob({ name: 'KOMGA_RECONCILE', data: { reason: 'daily' } });
        expect(mocks.enqueueKomgaSync).not.toHaveBeenCalled();
    });

    it('never throws when the query fails', async () => {
        mocks.komgaLibraryFindMany.mockRejectedValue(new Error('db down'));
        await expect(processKomgaJob({ name: 'KOMGA_RECONCILE', data: { reason: 'daily' } })).resolves.toBeUndefined();
    });
});

describe('scheduleKomgaReconcile', () => {
    it('uses the job-scheduler API when this bullmq has it', async () => {
        await scheduleKomgaReconcile();
        expect(mocks.upsertJobScheduler).toHaveBeenCalledWith(
            'repeat_komga_reconcile',
            { every: KOMGA_RECONCILE_INTERVAL_MS },
            expect.objectContaining({ name: 'KOMGA_RECONCILE', data: { reason: 'daily' } }),
        );
    });

    it('registers only once', async () => {
        await scheduleKomgaReconcile();
        await scheduleKomgaReconcile();
        expect(mocks.upsertJobScheduler).toHaveBeenCalledTimes(1);
    });

    it('does not throw when the scheduler is unavailable (no Redis in tests/CI)', async () => {
        mocks.upsertJobScheduler.mockRejectedValue(new Error('no redis'));
        await expect(scheduleKomgaReconcile()).resolves.toBeUndefined();
    });
});

describe('initKomgaWorker', () => {
    it('builds a concurrency-1 Worker on the komga queue', () => {
        initKomgaWorker();
        const [name, , opts] = mocks.workerCtor.mock.calls[0];
        expect(name).toBe('omnibus-komga');
        expect((opts as { concurrency: number }).concurrency).toBe(1);
    });

    it('is idempotent — a second call must not add a second Worker or interval', () => {
        initKomgaWorker();
        initKomgaWorker();
        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);
    });

    it('runs the flush on its interval', async () => {
        initKomgaWorker();
        await vi.advanceTimersByTimeAsync(KOMGA_FLUSH_INTERVAL_MS + 10);
        expect(mocks.flushDueLibraries).toHaveBeenCalled();
    });

    it('does not overlap flushes — a slow tick skips the next', async () => {
        initKomgaWorker();
        mocks.flushDueLibraries.mockImplementation(() => new Promise(() => { /* never resolves */ }));
        await vi.advanceTimersByTimeAsync(KOMGA_FLUSH_INTERVAL_MS * 3);
        expect(mocks.flushDueLibraries).toHaveBeenCalledTimes(1);
    });

    it('does not throw into Next when Redis is unavailable at boot', () => {
        mocks.workerCtor.mockImplementationOnce(() => { throw new Error('redis down'); });
        expect(() => initKomgaWorker()).not.toThrow();
    });

    it('schedules the daily reconcile on startup', async () => {
        initKomgaWorker();
        await vi.advanceTimersByTimeAsync(1);
        expect(mocks.upsertJobScheduler).toHaveBeenCalled();
    });
});
