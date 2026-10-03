import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// sync.ts is the stage machine. These tests use in-memory fakes for the DB and the real
// __tests__/helpers/fake-komga.ts for the HTTP side, so the settle logic is exercised against
// genuine SSE framing rather than a hand-rolled stub.
const mocks = vi.hoisted(() => ({
    settings: vi.fn(),
    komgaSettings: vi.fn(),
    stateFindUnique: vi.fn(),
    stateCreate: vi.fn(),
    stateUpdate: vi.fn(),
    stateUpdateMany: vi.fn(),
    komgaLibraryFindMany: vi.fn(),
    libraryFindUnique: vi.fn(),
    jobLogCreate: vi.fn(),
    getClient: vi.fn(),
}));

vi.unmock('@/lib/komga/changes');

vi.mock('@/lib/komga/settings', () => ({ getKomgaSettings: mocks.komgaSettings }));
vi.mock('@/lib/komga/factory', () => ({ getKomgaClient: mocks.getClient }));
vi.mock('@/lib/komga/queue', () => ({ enqueueKomgaSync: vi.fn() }));
vi.mock('@/lib/db', () => ({
    prisma: {
        komgaSyncState: {
            findUnique: mocks.stateFindUnique,
            create: mocks.stateCreate,
            update: mocks.stateUpdate,
            updateMany: mocks.stateUpdateMany,
        },
        komgaLibrary: { findMany: mocks.komgaLibraryFindMany },
        library: { findUnique: mocks.libraryFindUnique },
        jobLog: { create: mocks.jobLogCreate },
    },
}));

import { runLibrarySync, SYNC_STEPS } from '@/lib/komga/sync';
import { KomgaClient } from '@/lib/komga/client';
import { startFakeKomga, makeKomgaLibrary, waitUntil, type FakeKomga } from '../../helpers/fake-komga';
import {
    KOMGA_LEASE_MS,
    KOMGA_SETTLE_CAP_MS,
    KOMGA_SETTLE_FIXED_FALLBACK_MS,
} from '@/lib/komga/constants';

const OMNIBUS_LIB = 'lib-1';

const SETTINGS = {
    enabled: true,
    url: 'http://komga.local',
    apiKey: 'key',
    // Maps the fake Komga root onto the Omnibus library path, without which nothing resolves and
    // every stage short-circuits to 'no Komga library mapped'.
    pathMappings: [{ omnibus: '/data/manga', komga: '/komga/manga' }],
    pathMappingsRaw: JSON.stringify([{ omnibus: '/data/manga', komga: '/komga/manga' }]),
    scanOnChange: true,
    readListsEnabled: false,
    instanceId: null,
};

/** An in-memory KomgaSyncState row. */
function stateRow(over: Record<string, unknown> = {}) {
    return {
        omnibusLibraryId: OMNIBUS_LIB,
        dirtySince: new Date(Date.now() - 120_000),
        lastChangeAt: new Date(Date.now() - 120_000),
        pendingPaths: JSON.stringify(['/data/manga/S/1.cbz']),
        pendingOverflow: false,
        lastScanRequestedAt: null,
        lastSyncCompletedAt: null,
        syncLeaseUntil: null,
        nextEligibleAt: null,
        retryCount: 0,
        consecutiveFailures: 0,
        lastError: null,
        ...over,
    };
}

const K_L = '0RT15AAAAAAK';
const KOMGA_LIB_ROW = { komgaLibraryId: K_L, name: 'Manga', root: '/komga/manga', translatedRoot: '/data/manga', omnibusLibraryId: OMNIBUS_LIB, settings: '{}', unavailable: false };

/** The db fake: one row, every mutation visible in `writes`. */
function makeDb(row = stateRow(), komgaLibraries: any[] = [KOMGA_LIB_ROW]) {
    const writes: any[] = [];
    const db: any = {
        komgaSyncState: {
            findUnique: vi.fn(async () => row),
            create: vi.fn(async () => row),
            update: vi.fn(async ({ data }: any) => { writes.push(data); Object.assign(row, data); return row; }),
            updateMany: vi.fn(async ({ data }: any) => { writes.push(data); Object.assign(row, data); return { count: 1 }; }),
        },
        komgaLibrary: { findMany: vi.fn(async () => komgaLibraries) },
        library: { findUnique: vi.fn(async () => ({ id: OMNIBUS_LIB, name: 'Manga', path: '/data/manga' })) },
        jobLog: { create: vi.fn(async () => ({})) },
    };
    return { db, row, writes };
}

let fake: FakeKomga | null = null;

async function clientFor(fakeKomga: FakeKomga, timeoutMs?: number) {
    // The fake rejects any key but its own (helper doc line 20).
    return new KomgaClient({ baseUrl: fakeKomga.url, apiKey: fakeKomga.state.apiKey, timeoutMs });
}

beforeEach(() => {
    mocks.komgaSettings.mockResolvedValue(SETTINGS);
    mocks.getClient.mockResolvedValue(null); // overridden per-test via deps.client
});

afterEach(async () => {
    if (fake) { await fake.close(); fake = null; }
});

describe('the stage list', () => {
    it('is ordered start → preIdle → scan → settle', () => {
        expect(SYNC_STEPS.map(s => s.stage)).toEqual(['start', 'preIdle', 'scan', 'settle']);
    });

    it('ends every stage in a declared StepResult', () => {
        for (const step of SYNC_STEPS) {
            expect(typeof step.run).toBe('function');
        }
    });
});

describe('runLibrarySync: entry guards', () => {
    it('does nothing when Komga is disabled', async () => {
        mocks.komgaSettings.mockResolvedValue({ ...SETTINGS, enabled: false });
        const { db } = makeDb();
        const result = await runLibrarySync({ omnibusLibraryId: OMNIBUS_LIB }, { db, client: {} as never });
        expect(result).toEqual({ done: true });
        expect(db.komgaSyncState.update).not.toHaveBeenCalled();
    });

    it('returns done when no client can be built', async () => {
        mocks.getClient.mockResolvedValue(null);
        const { db } = makeDb();
        expect(await runLibrarySync({ omnibusLibraryId: OMNIBUS_LIB }, { db })).toEqual({ done: true });
    });
});

describe('runLibrarySync: start stage', () => {
    it('takes the lease and moves to preIdle', async () => {
        fake = await startFakeKomga({ state: { libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga', name: 'Manga' })] } });
        const { db, writes } = makeDb();
        const enqueue = vi.fn().mockResolvedValue(undefined);
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue, now: () => new Date() },
        );
        expect(writes.some(w => w.syncLeaseUntil instanceof Date)).toBe(true);
        expect(enqueue).toHaveBeenCalled();
    });

    it('exits when another sync already holds a LIVE lease', async () => {
        fake = await startFakeKomga();
        const { db, writes } = makeDb(stateRow({ syncLeaseUntil: new Date(Date.now() + KOMGA_LEASE_MS) }));
        const enqueue = vi.fn().mockResolvedValue(undefined);
        const result = await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue },
        );
        expect(result).toEqual({ done: true });
        // It must not steal the lease.
        expect(writes.some(w => w.syncLeaseUntil === null)).toBe(false);
    });

    it('proceeds when the lease has EXPIRED', async () => {
        fake = await startFakeKomga({ state: { libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })] } });
        const { db } = makeDb(stateRow({ syncLeaseUntil: new Date(Date.now() - 1000) }));
        const enqueue = vi.fn().mockResolvedValue(undefined);
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue },
        );
        expect(enqueue).toHaveBeenCalled();
    });

    it('clears the dirty state when no Komga library is mapped', async () => {
        // Komga has no libraries at all → nothing to scan. Leaving it dirty would make the flush
        // re-enqueue it forever.
        fake = await startFakeKomga({ state: { libraries: [] } });
        const { db, writes } = makeDb(stateRow(), []);
        const result = await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue: vi.fn() },
        );
        expect(result).toEqual({ done: true });
        const w = writes.at(-1);
        expect(w.dirtySince).toBeNull();
        expect(w.lastError).toBe('no Komga library mapped');
        expect(w.syncLeaseUntil).toBeNull();
    });
});

describe('runLibrarySync: scan stage', () => {
    it('POSTs a scan for the mapped library and clears the pending state in ONE write', async () => {
        fake = await startFakeKomga({ state: { libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })] } });
        const { db, writes } = makeDb();
        const enqueue = vi.fn().mockResolvedValue(undefined);
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'scan', komgaLibraryIds: [K_L] },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue },
        );
        expect(fake.state.scans).toHaveLength(1);
        expect(fake.state.scans[0]).toEqual({ libraryId: K_L, deep: false });
        const w = writes.find(x => x.lastScanRequestedAt instanceof Date);
        expect(w.pendingPaths).toBeNull();
        expect(w.pendingOverflow).toBe(false);
        expect(w.consecutiveFailures).toBe(0);
        expect(w.nextEligibleAt).toBeNull();
        expect(w.lastError).toBeNull();
    });

    it('snapshots the pending paths into the job data BEFORE clearing the column', async () => {
        fake = await startFakeKomga({ state: { libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })] } });
        const { db } = makeDb();
        const enqueue = vi.fn().mockResolvedValue(undefined);
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'scan', komgaLibraryIds: [K_L] },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue },
        );
        const cont = enqueue.mock.calls[0][0];
        expect(cont.snapshotPaths).toEqual(['/data/manga/S/1.cbz']);
        expect(cont.stage).toBe('settle');
    });

    it('keeps dirtySince when a change landed after the scan request', async () => {
        // A change during the scan is NOT covered by it, so the library must stay dirty.
        fake = await startFakeKomga({ state: { libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })] } });
        const futureChange = new Date(Date.now() + 60_000);
        const { db, writes } = makeDb(stateRow({ lastChangeAt: futureChange }));
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'scan', komgaLibraryIds: [K_L] },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue: vi.fn() },
        );
        const w = writes.find(x => x.lastScanRequestedAt instanceof Date);
        expect(w.dirtySince).not.toBeNull();
    });

    it('uses deep=true once retryCount reaches 2', async () => {
        fake = await startFakeKomga({ state: { libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })] } });
        const { db } = makeDb(stateRow({ retryCount: 2 }));
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'scan', komgaLibraryIds: [K_L] },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue: vi.fn() },
        );
        expect(fake.state.scans[0].deep).toBe(true);
    });

    it('backs off and does NOT advance lastScanRequestedAt when the scan POST fails', async () => {
        fake = await startFakeKomga({
            state: {
                libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })],
                failures: [{ method: 'POST', path: `/api/v1/libraries/${K_L}/scan`, status: 500 }],
            },
        });
        const { db, writes } = makeDb();
        const result = await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'scan', komgaLibraryIds: [K_L] },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue: vi.fn() },
        );
        expect(result).toEqual({ done: true });
        expect(writes.some(w => w.lastScanRequestedAt instanceof Date)).toBe(false);
        const w = writes.find(x => x.consecutiveFailures === 1);
        expect(w.nextEligibleAt).toBeInstanceOf(Date);
        expect(w.lastError).toContain('scan failed');
        // The lease is released by a separate write after the failure is recorded.
        expect(writes.at(-1).syncLeaseUntil).toBeNull();
    });

    it('writes a FAILED JobLog on a scan failure', async () => {
        fake = await startFakeKomga({
            state: {
                libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })],
                failures: [{ method: 'POST', path: `/api/v1/libraries/${K_L}/scan`, status: 500 }],
            },
        });
        const { db } = makeDb();
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'scan', komgaLibraryIds: [K_L] },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue: vi.fn() },
        );
        expect(db.jobLog.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ jobType: 'KOMGA_SCAN', status: 'FAILED' }),
        }));
    });

    it('never lets the API key reach the JobLog or the error', async () => {
        fake = await startFakeKomga({
            state: {
                libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })],
                failures: [{ method: 'POST', path: `/api/v1/libraries/${K_L}/scan`, status: 401 }],
            },
        });
        const { db } = makeDb();
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'scan', komgaLibraryIds: [K_L] },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue: vi.fn() },
        );
        const logged = JSON.stringify(db.jobLog.create.mock.calls);
        expect(logged).not.toContain('key');
    });
});

describe('runLibrarySync: settle stage', () => {
    it('settles on an idle SSE frame that arrived after the POST', async () => {
        fake = await startFakeKomga({
            state: {
                libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })],
                // A short scan finishes between ticks, so ScanLibrary is never seen — only an idle
                // frame after the POST. This is the case that must settle.
                taskQueueFrames: [{ count: 0, countByType: {} }],
            },
        });
        const { db } = makeDb();
        const enqueue = vi.fn().mockResolvedValue(undefined);
        const result = await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'settle', komgaLibraryIds: [K_L], scanRequestedAt: Date.now(), settleStartedAt: Date.now(), metricsBefore: 0 },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue },
        );
        expect(result).toEqual({ done: true });
        const log = JSON.parse(db.jobLog.create.mock.calls[0][0].data.message);
        expect(log.detection).toBe('sse');
        expect(log.timedOut).toBe(false);
    });

    it('waits while a ScanLibrary is still present, then re-enqueues', async () => {
        fake = await startFakeKomga({
            state: {
                libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })],
                taskQueueFrames: [{ count: 1, countByType: { ScanLibrary: 1 } }],
            },
        });
        const { db } = makeDb();
        const enqueue = vi.fn().mockResolvedValue(undefined);
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'settle', komgaLibraryIds: [K_L], scanRequestedAt: Date.now(), settleStartedAt: Date.now() },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue },
        );
        expect(enqueue).toHaveBeenCalled();
        expect(enqueue.mock.calls[0][0].stage).toBe('settle');
        expect(db.jobLog.create).not.toHaveBeenCalled();
    });

    it('does NOT settle when other work is running but no ScanLibrary is present', async () => {
        // A frame full of RefreshBookMetadata is not our scan; 'count > 0' alone must not settle it.
        fake = await startFakeKomga({
            state: {
                libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })],
                taskQueueFrames: [{ count: 40, countByType: { RefreshBookMetadata: 40 } }],
            },
        });
        const { db } = makeDb();
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'settle', komgaLibraryIds: [K_L], scanRequestedAt: Date.now(), settleStartedAt: Date.now() },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue: vi.fn() },
        );
        // No ScanLibrary in the frame → settled. (Other task types must NOT block.)
        expect(db.jobLog.create).toHaveBeenCalled();
    });

    it('tolerates unknown countByType keys', async () => {
        fake = await startFakeKomga({
            state: {
                libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })],
                taskQueueFrames: [{ count: 3, countByType: { FindBooksToConvert: 1, RebuildIndex: 2 } } as never],
            },
        });
        const { db } = makeDb();
        const result = await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'settle', komgaLibraryIds: [K_L], scanRequestedAt: Date.now(), settleStartedAt: Date.now() },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue: vi.fn() },
        );
        expect(result).toEqual({ done: true });
    });

    it('does NOT treat metric 0 → 0 as proof that the scan finished', async () => {
        // LIVE delta 6: 404 means 0, and 0 could be "no scan since start" or "metrics not exposed".
        fake = await startFakeKomga({
            state: {
                libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })],
                // 404 on the SSE stream is the documented "SSE unavailable" path, and returns
                // immediately — the fake's 'none' frames leave the stream open, which would make
                // readTaskQueue wait out its full 25 s timeout.
                failures: [{ method: 'GET', path: '/sse/v1/events', status: 404 }],
                scanMetricsCount: 0,
            },
        });
        const { db } = makeDb();
        const enqueue = vi.fn().mockResolvedValue(undefined);
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'settle', komgaLibraryIds: [K_L], scanRequestedAt: Date.now(), settleStartedAt: Date.now(), metricsBefore: 0 },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue },
        );
        // Falls through to the fixed-delay fallback rather than settling immediately.
        expect(db.jobLog.create).not.toHaveBeenCalled();
    });

    it('settles on the metric when the before-count is proven non-zero', async () => {
        fake = await startFakeKomga({
            state: {
                libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })],
                failures: [{ method: 'GET', path: '/sse/v1/events', status: 404 }],
                scanMetricsCount: 12,
            },
        });
        const { db } = makeDb();
        const result = await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'settle', komgaLibraryIds: [K_L], scanRequestedAt: Date.now(), settleStartedAt: Date.now(), metricsBefore: 11 },
            { db, client: await clientFor(fake, 400), settings: SETTINGS, enqueue: vi.fn() },
        );
        expect(result).toEqual({ done: true });
        expect(JSON.parse(db.jobLog.create.mock.calls[0][0].data.message).detection).toBe('metrics');
    });

    it('releases the lease and stamps lastSyncCompletedAt on success', async () => {
        fake = await startFakeKomga({
            state: { libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })], taskQueueFrames: [{ count: 0, countByType: {} }] },
        });
        const { db, writes } = makeDb();
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'settle', komgaLibraryIds: [K_L], scanRequestedAt: Date.now(), settleStartedAt: Date.now() },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue: vi.fn() },
        );
        const w = writes.at(-1);
        expect(w.syncLeaseUntil).toBeNull();
        expect(w.lastSyncCompletedAt).toBeInstanceOf(Date);
    });

    it('records COMPLETED_WITH_ERRORS and reports timeout past the settle cap', async () => {
        fake = await startFakeKomga({
            state: {
                libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })],
                taskQueueFrames: [{ count: 1, countByType: { ScanLibrary: 1 } }],
            },
        });
        const { db } = makeDb();
        const longAgo = Date.now() - KOMGA_SETTLE_CAP_MS - 1_000;
        const result = await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'settle', komgaLibraryIds: [K_L], scanRequestedAt: longAgo, settleStartedAt: longAgo },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue: vi.fn() },
        );
        expect(result).toEqual({ done: true });
        const call = db.jobLog.create.mock.calls[0][0].data;
        expect(call.status).toBe('COMPLETED_WITH_ERRORS');
        expect(JSON.parse(call.message).detection).toBe('timeout');
    });

    it('names the Omnibus library as the related item', async () => {
        fake = await startFakeKomga({
            state: { libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })], taskQueueFrames: [{ count: 0, countByType: {} }] },
        });
        const { db } = makeDb();
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'settle', komgaLibraryIds: [K_L], scanRequestedAt: Date.now(), settleStartedAt: Date.now() },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue: vi.fn() },
        );
        expect(db.jobLog.create.mock.calls[0][0].data.relatedItem).toBe('Manga');
    });
});

describe('runLibrarySync: continuations', () => {
    it('renews the lease on every continuation', async () => {
        fake = await startFakeKomga({
            state: {
                libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })],
                taskQueueFrames: [{ count: 1, countByType: { ScanLibrary: 1 } }],
            },
        });
        const { db, writes } = makeDb();
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'settle', komgaLibraryIds: [K_L], scanRequestedAt: Date.now(), settleStartedAt: Date.now() },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue: vi.fn() },
        );
        expect(writes.some(w => w.syncLeaseUntil instanceof Date)).toBe(true);
    });

    it('enqueues continuations WITHOUT the flush dedupe id, so a chain cannot swallow itself', async () => {
        fake = await startFakeKomga({
            state: {
                libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })],
                taskQueueFrames: [{ count: 1, countByType: { ScanLibrary: 1 } }],
            },
        });
        const enqueue = vi.fn().mockResolvedValue(undefined);
        const { db } = makeDb();
        await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'settle', komgaLibraryIds: [K_L], scanRequestedAt: Date.now(), settleStartedAt: Date.now() },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue },
        );
        expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ stage: 'settle' }), expect.any(Number));
    });

    it('logs and returns for an unknown stage rather than throwing', async () => {
        fake = await startFakeKomga();
        const { db } = makeDb();
        const result = await runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'reconcile' },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue: vi.fn() },
        );
        expect(result).toEqual({ done: true });
    });

    it('does not hold a Prisma transaction across HTTP', async () => {
        // Node's SQLite runs connection_limit=1 (issue #195). The db fake exposes no $transaction,
        // so any attempt to use one would throw — this is the regression guard for that rule.
        fake = await startFakeKomga({ state: { libraries: [makeKomgaLibrary({ id: K_L, root: '/komga/manga' })] } });
        const { db } = makeDb();
        (db as any).$transaction = () => { throw new Error('$transaction must not be used in a sync step'); };
        await expect(runLibrarySync(
            { omnibusLibraryId: OMNIBUS_LIB, stage: 'scan', komgaLibraryIds: [K_L] },
            { db, client: await clientFor(fake), settings: SETTINGS, enqueue: vi.fn() },
        )).resolves.toBeDefined();
    });
});
