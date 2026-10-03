import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    queueCtor: vi.fn(),
    redisCtor: vi.fn(),
    add: vi.fn(),
    on: vi.fn(),
}));

vi.mock('bullmq', () => ({
    Queue: class {
        add = mocks.add;
        on = mocks.on;
        constructor(name: string, opts: unknown) { mocks.queueCtor(name, opts); }
    },
}));

vi.mock('ioredis', () => ({
    default: class {
        constructor(url: string, opts: unknown) { mocks.redisCtor(url, opts); }
    },
}));

import { loggerLog } from '../../helpers/setup-global';

type QueueModule = typeof import('@/lib/komga/queue');
const g = globalThis as Record<string, unknown>;
const BASE = { removeOnComplete: true, removeOnFail: 100, attempts: 1 };

async function load(): Promise<QueueModule> {
    return import('@/lib/komga/queue');
}

beforeEach(() => {
    delete g.__komgaQueue;
    delete g.__komgaRedis;
    delete g.__komgaQueueErrorAt;
    mocks.add.mockResolvedValue({ id: '1' });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('komga queue — laziness and singleton', () => {
    it('importing the module opens no Redis connection and builds no queue', async () => {
        vi.resetModules();
        const mod = await load();
        expect(mod.KOMGA_JOB.SYNC).toBe('KOMGA_SYNC');
        expect(mocks.redisCtor).not.toHaveBeenCalled();
        expect(mocks.queueCtor).not.toHaveBeenCalled();
    });

    it('getKomgaQueue builds one omnibus-komga queue on its own connection', async () => {
        vi.stubEnv('OMNIBUS_REDIS_URL', 'redis://redis.test:6380');
        const { getKomgaQueue } = await load();
        const q1 = getKomgaQueue();
        const q2 = getKomgaQueue();
        expect(q1).toBe(q2);
        expect(mocks.redisCtor).toHaveBeenCalledTimes(1);
        expect(mocks.redisCtor).toHaveBeenCalledWith('redis://redis.test:6380', { maxRetriesPerRequest: null });
        expect(mocks.queueCtor).toHaveBeenCalledTimes(1);
        const [name, opts] = mocks.queueCtor.mock.calls[0];
        expect(name).toBe('omnibus-komga');
        expect(opts.defaultJobOptions).toEqual(BASE);
        expect(opts.connection).toBeDefined();
    });

    it('defaults to localhost Redis', async () => {
        vi.stubEnv('OMNIBUS_REDIS_URL', '');
        const { getKomgaQueue } = await load();
        getKomgaQueue();
        expect(mocks.redisCtor).toHaveBeenCalledWith('redis://localhost:6379', { maxRetriesPerRequest: null });
    });

    it('the queue lives on globalThis, so a second copy of the module reuses it', async () => {
        const first = (await load()).getKomgaQueue();
        vi.resetModules();
        const second = (await load()).getKomgaQueue();
        expect(second).toBe(first);
        expect(mocks.queueCtor).toHaveBeenCalledTimes(1);
    });

    it('logs queue connection errors at most once a minute', async () => {
        vi.useFakeTimers();
        try {
            const { getKomgaQueue } = await load();
            getKomgaQueue();
            const [event, handler] = mocks.on.mock.calls[0];
            expect(event).toBe('error');
            handler(new Error('ECONNREFUSED'));
            handler(new Error('ECONNREFUSED'));
            expect(loggerLog).toHaveBeenCalledTimes(1);
            expect(loggerLog).toHaveBeenCalledWith('[Komga] Queue connection error: ECONNREFUSED', 'warn');
            vi.advanceTimersByTime(60_001);
            handler(new Error('ECONNREFUSED'));
            expect(loggerLog).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('komga queue — enqueue helpers', () => {
    it('enqueueKomgaSync dedupes per Omnibus library by default', async () => {
        const { enqueueKomgaSync } = await load();
        await enqueueKomgaSync({ omnibusLibraryId: 'lib1', reason: 'flush' });
        expect(mocks.add).toHaveBeenCalledWith('KOMGA_SYNC', { omnibusLibraryId: 'lib1', reason: 'flush' }, {
            ...BASE,
            deduplication: { id: 'komga-sync-lib1' },
        });
    });

    it('enqueueKomgaSync with a delay and without dedupe (stage continuation)', async () => {
        const { enqueueKomgaSync } = await load();
        await enqueueKomgaSync({ omnibusLibraryId: 'lib1', stage: 'settle' }, { delayMs: 20_000, dedupe: false });
        const [, , opts] = mocks.add.mock.calls[0];
        expect(opts).toEqual({ ...BASE, delay: 20_000 });
        expect(opts.deduplication).toBeUndefined();
    });

    it('enqueueKomgaSync ignores a non-positive delay and requires a library id', async () => {
        const { enqueueKomgaSync } = await load();
        await enqueueKomgaSync({ omnibusLibraryId: 'lib2' }, { delayMs: 0 });
        expect(mocks.add.mock.calls[0][2].delay).toBeUndefined();
        await expect(enqueueKomgaSync({ omnibusLibraryId: '' })).rejects.toThrow(/omnibusLibraryId/);
    });

    it('enqueueKomgaReconcile uses one dedup id and keeps the latest request while one is running', async () => {
        const { enqueueKomgaReconcile } = await load();
        await enqueueKomgaReconcile('settings changed (url)');
        expect(mocks.add).toHaveBeenCalledWith('KOMGA_RECONCILE', { reason: 'settings changed (url)' }, {
            ...BASE,
            deduplication: { id: 'komga-reconcile', keepLastIfActive: true },
        });
    });

    it('enqueueKomgaReadListPush is a 10 s debounce per list', async () => {
        const { enqueueKomgaReadListPush } = await load();
        await enqueueKomgaReadListPush('rl-1');
        expect(mocks.add).toHaveBeenCalledWith('KOMGA_READLIST_PUSH', { readingListId: 'rl-1' }, {
            ...BASE,
            delay: 10_000,
            deduplication: { id: 'komga-rl-rl-1', ttl: 10_000, extend: true, replace: true },
        });
        await expect(enqueueKomgaReadListPush('')).rejects.toThrow(/readingListId/);
    });

    it('enqueueKomgaReadListDelete is not deduplicated and carries only the two ids', async () => {
        const { enqueueKomgaReadListDelete } = await load();
        await enqueueKomgaReadListDelete({ komgaReadListId: 'K9', readingListId: 'rl-1', extra: 'x' } as never);
        expect(mocks.add).toHaveBeenCalledWith('KOMGA_READLIST_DELETE', { komgaReadListId: 'K9', readingListId: 'rl-1' }, { ...BASE });
        await expect(enqueueKomgaReadListDelete({ komgaReadListId: '', readingListId: 'rl-1' })).rejects.toThrow();
    });

    it('propagates queue errors to the caller (callers decide whether to swallow)', async () => {
        mocks.add.mockRejectedValue(new Error('Connection is closed.'));
        const { enqueueKomgaReconcile } = await load();
        await expect(enqueueKomgaReconcile('x')).rejects.toThrow('Connection is closed.');
    });
});
