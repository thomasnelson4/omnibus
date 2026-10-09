// __tests__/api/admin-jobs-trigger-komga.test.ts
//
// The three Komga admin triggers (PLAN Phase 5) and, above all, WHERE they land.
//
// The failure mode this file exists to prevent: a Komga trigger that "works" because a job was
// enqueued, while the job sits on `omnibusQueue`, whose worker has no case for a Komga name and
// throws `Unknown job type`. So every assertion here is about the QUEUE NAME, not about "something
// was added": bullmq is mocked to tag each add with the queue it went to, and every test both
// checks the tag and checks that omnibusQueue.add was never touched.
//
// The REAL @/lib/komga/queue module runs (only bullmq/ioredis underneath it are faked), so this
// proves the route's own lazy import reaches the Komga queue rather than re-asserting the mock's
// own setup.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    omnibusAdd: vi.fn(),
    queueCtor: vi.fn(),
    /** Every add, tagged with the queue name it went to. Plain array: not a spy, so reset it by hand. */
    adds: [] as { queue: string; name: string; data: any }[],
    settingFindMany: vi.fn(),
    libraryFindMany: vi.fn(),
    komgaLibraryFindMany: vi.fn(),
    readingListFindMany: vi.fn(),
    // The push trigger re-reads each list with findUnique (it is the only place that may learn the
    // list was un-opted between the route's count and the enqueue), so the mock needs it too.
    readingListFindUnique: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/queue', () => ({ omnibusQueue: { add: mocks.omnibusAdd } }));
vi.mock('ioredis', () => ({ default: class { constructor() { /* no connection in tests */ } } }));
vi.mock('bullmq', () => ({
    Queue: class {
        on = vi.fn();
        private queueName: string;
        constructor(name: string, _opts?: unknown) {
            this.queueName = name;
            mocks.queueCtor(name);
        }
        async add(name: string, data: unknown) {
            mocks.adds.push({ queue: this.queueName, name, data });
            return { id: '1' };
        }
    },
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findMany: mocks.settingFindMany },
        library: { findMany: mocks.libraryFindMany },
        komgaLibrary: { findMany: mocks.komgaLibraryFindMany },
        readingList: { findMany: mocks.readingListFindMany, findUnique: mocks.readingListFindUnique },
    },
}));

import { POST } from '@/app/api/admin/jobs/trigger/route';
import { KOMGA_QUEUE_NAME } from '@/lib/komga/constants';
import { auditLog, loggerLog } from '../helpers/setup-global';
import { adminSession } from '../helpers/session';

const g = globalThis as Record<string, unknown>;

const post = (job: string) =>
    POST(new Request('http://localhost/api/admin/jobs/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job }),
    }));

const komgaLibraryRow = (over: Record<string, unknown> = {}) => ({
    komgaLibraryId: 'K1', name: 'Comics', root: '/comics', translatedRoot: '/data/comics',
    omnibusLibraryId: 'lib-1', settings: '{}', unavailable: false, ...over,
});

beforeEach(() => {
    // The Komga queue is a globalThis singleton (one connection per process) — clear it so each
    // test observes its own Queue construction.
    delete g.__komgaQueue;
    delete g.__komgaRedis;
    delete g.__komgaQueueErrorAt;
    delete g.__komgaHotFlags;
    delete g.__komgaHotFlagsInflight;

    mocks.adds.length = 0;
    mocks.getServerSession.mockResolvedValue(adminSession());
    mocks.omnibusAdd.mockResolvedValue({ id: 'omnibus-1' });
    // komga_readlists_enabled is read separately by the read-list trigger's own hot flags, and
    // defaults OFF when absent — so it has to be on here for that trigger to enqueue anything.
    mocks.settingFindMany.mockResolvedValue([
        { key: 'komga_enabled', value: 'true' },
        { key: 'komga_readlists_enabled', value: 'true' },
    ]);
    mocks.komgaLibraryFindMany.mockResolvedValue([komgaLibraryRow()]);
    mocks.libraryFindMany.mockResolvedValue([
        { id: 'lib-1', name: 'Main', path: '/data/comics' },
        { id: 'lib-2', name: 'Manga', path: '/data/manga' },
    ]);
    mocks.readingListFindMany.mockResolvedValue([{ id: 'rl-1' }, { id: 'rl-2' }]);
    // Every listed list is opted in by default; a test overrides this to simulate an un-opt.
    mocks.readingListFindUnique.mockResolvedValue({ komgaSync: true });
});

/** The queue every Komga job must be on, asserted by name. */
const komgaAdds = () => mocks.adds.filter(a => a.queue === KOMGA_QUEUE_NAME);

describe('admin job trigger — Komga jobs are routed, not dumped on omnibusQueue', () => {
    it('the Komga queue is named omnibus-komga, and it is not the omnibus queue', () => {
        expect(KOMGA_QUEUE_NAME).toBe('omnibus-komga');
        expect(KOMGA_QUEUE_NAME).not.toBe('omnibus');
    });

    it('"Komga: sync mapped libraries" enqueues KOMGA_SYNC on omnibus-komga only', async () => {
        const res = await post('komga_sync');

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ success: true });
        // One job per MAPPED library. lib-2 (/data/manga) is outside the Komga library root
        // (/data/comics), so it is deliberately absent.
        expect(komgaAdds()).toHaveLength(1);
        expect(komgaAdds()[0]).toMatchObject({ queue: 'omnibus-komga', name: 'KOMGA_SYNC', data: { omnibusLibraryId: 'lib-1' } });
        // THE assertion: nothing may reach the queue whose worker throws `Unknown job type`.
        expect(mocks.omnibusAdd).not.toHaveBeenCalled();
        expect(mocks.adds.every(a => a.queue === 'omnibus-komga')).toBe(true);
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('[Komga] Admin trigger "komga_sync" → KOMGA_SYNC'), 'info');
    });

    it('a Komga library serving two Omnibus libraries queues one sync for each', async () => {
        mocks.komgaLibraryFindMany.mockResolvedValue([komgaLibraryRow({ root: '/', translatedRoot: '/' })]);
        await post('komga_sync');

        expect(komgaAdds().map(a => a.name)).toEqual(['KOMGA_SYNC', 'KOMGA_SYNC']);
        expect(komgaAdds().map(a => a.data.omnibusLibraryId).sort()).toEqual(['lib-1', 'lib-2']);
        expect(mocks.omnibusAdd).not.toHaveBeenCalled();
    });

    it('"Komga: rebuild ID map" enqueues KOMGA_RECONCILE on omnibus-komga only', async () => {
        const res = await post('komga_rebuild_id_map');

        expect(res.status).toBe(200);
        expect(komgaAdds()).toHaveLength(1);
        expect(komgaAdds()[0].name).toBe('KOMGA_RECONCILE');
        expect(komgaAdds()[0].queue).toBe('omnibus-komga');
        expect(mocks.omnibusAdd).not.toHaveBeenCalled();
        expect(mocks.adds.some(a => a.name === 'KOMGA_SYNC')).toBe(false);
    });

    it('"Komga: push reading lists" enqueues one debounced KOMGA_READLIST_PUSH per opted-in list', async () => {
        // The trigger is fire-and-forget, so wait for the queued microtasks to drain.
        const res = await post('komga_readlist_push');
        expect(res.status).toBe(200);

        await vi.waitFor(() => expect(komgaAdds()).toHaveLength(2));
        expect(komgaAdds().map(a => a.name)).toEqual(['KOMGA_READLIST_PUSH', 'KOMGA_READLIST_PUSH']);
        expect(komgaAdds().map(a => a.data.readingListId).sort()).toEqual(['rl-1', 'rl-2']);
        expect(komgaAdds().every(a => a.queue === 'omnibus-komga')).toBe(true);
        expect(mocks.omnibusAdd).not.toHaveBeenCalled();
    });

    it('a non-Komga job still goes to omnibusQueue, and never to omnibus-komga', async () => {
        const res = await post('health_check');

        expect(res.status).toBe(200);
        expect(mocks.omnibusAdd).toHaveBeenCalledWith('SYSTEM_HEALTH_CHECK', { type: 'SYSTEM_HEALTH_CHECK' }, expect.anything());
        // The guard is two-sided: the existing queue must not start receiving Komga traffic either.
        expect(komgaAdds()).toHaveLength(0);
        expect(mocks.queueCtor).not.toHaveBeenCalled();
    });

    it('an unknown job is still a 400 and reaches neither queue', async () => {
        const res = await post('not_a_job');

        expect(res.status).toBe(400);
        expect(mocks.omnibusAdd).not.toHaveBeenCalled();
        expect(mocks.adds).toHaveLength(0);
    });

    it('audits a manual Komga trigger under its own action, without any secret', async () => {
        await post('komga_rebuild_id_map');

        expect(auditLog).toHaveBeenCalledWith(
            'KOMGA_ADMIN_TRIGGERED',
            expect.objectContaining({ trigger: 'komga_rebuild_id_map', jobType: 'KOMGA_RECONCILE' }),
            'admin_1',
        );
        const [, details] = auditLog.mock.calls[0];
        expect(JSON.stringify(details)).not.toMatch(/apiKey|api_key|password/i);
    });

    it('does not audit when there is no user (a schedule/heartbeat trigger)', async () => {
        mocks.getServerSession.mockResolvedValue(null);
        await post('komga_rebuild_id_map');

        expect(komgaAdds()).toHaveLength(1);
        expect(auditLog).not.toHaveBeenCalled();
    });

    it('refuses the trigger while the integration is disabled — the worker would drop it silently', async () => {
        mocks.settingFindMany.mockResolvedValue([{ key: 'komga_enabled', value: 'false' }]);
        const res = await post('komga_sync');

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('disabled') });
        expect(mocks.adds).toHaveLength(0);
        expect(mocks.omnibusAdd).not.toHaveBeenCalled();
    });

    it('answers honestly when nothing is mapped, instead of claiming a sync happened', async () => {
        mocks.komgaLibraryFindMany.mockResolvedValue([]);
        const res = await post('komga_sync');

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ message: expect.stringContaining('No Omnibus library is mapped') });
        expect(komgaAdds()).toHaveLength(0);
        expect(mocks.omnibusAdd).not.toHaveBeenCalled();
    });

    it('never opens Redis for a non-Komga trigger (the Komga queue is imported lazily)', async () => {
        await post('library');
        expect(mocks.queueCtor).not.toHaveBeenCalled();
        expect(mocks.omnibusAdd).toHaveBeenCalled();
    });
});
