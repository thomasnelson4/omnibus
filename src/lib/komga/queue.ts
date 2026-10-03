// src/lib/komga/queue.ts
//
// The `omnibus-komga` BullMQ queue and its enqueue helpers. Kept apart from omnibusQueue on purpose:
// that queue's worker throws `Unknown job type` for anything it does not know, and its defaults
// (attempts: 3, keep 100 completed) are wrong here — the Komga pipeline has its own retry/backoff
// state in KomgaSyncState, and a kept completed job would make a fixed jobId swallow later adds.
//
// LAZY: importing this module never opens a Redis connection. Hot paths and settings saves reach it
// through `await import('./queue')`, and the connection is only created by the first getKomgaQueue().
import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { Logger } from '@/lib/logger';
import { KOMGA_QUEUE_NAME, KOMGA_READLIST_DEBOUNCE_MS } from './constants';

export const KOMGA_JOB = {
    SYNC: 'KOMGA_SYNC',
    RECONCILE: 'KOMGA_RECONCILE',
    READLIST_PUSH: 'KOMGA_READLIST_PUSH',
    READLIST_DELETE: 'KOMGA_READLIST_DELETE',
} as const;
export type KomgaJobName = typeof KOMGA_JOB[keyof typeof KOMGA_JOB];

export interface KomgaSyncJobData {
    omnibusLibraryId: string;
    stage?: string;
    startedAt?: number;
    stageStartedAt?: number;
    scanRequestedAt?: number;
    metricsBefore?: number | null;
    snapshotPaths?: string[];
    snapshotOverflow?: boolean;
    deep?: boolean;
    full?: boolean;
    reason?: string;
}
export interface KomgaReconcileJobData { reason: string }
export interface KomgaReadListPushJobData { readingListId: string }
export interface KomgaReadListDeleteJobData { komgaReadListId: string; readingListId: string }

/** Options every Komga job gets: one attempt (the pipeline retries itself) and no kept completions. */
export const KOMGA_BASE_JOB_OPTIONS = { removeOnComplete: true, removeOnFail: 100, attempts: 1 } as const satisfies JobsOptions;

export const komgaSyncDedupId = (omnibusLibraryId: string) => `komga-sync-${omnibusLibraryId}`;
export const KOMGA_RECONCILE_DEDUP_ID = 'komga-reconcile';
export const komgaReadListDedupId = (readingListId: string) => `komga-rl-${readingListId}`;

// Route bundles and the instrumentation bundle each load their own copy of this module; one queue
// (and one Redis connection) per process.
const g = globalThis as unknown as { __komgaQueue?: Queue; __komgaRedis?: IORedis; __komgaQueueErrorAt?: number };

/** The shared Redis connection for the Komga queue (the P2 worker may reuse it; BullMQ duplicates it for blocking reads). */
export function getKomgaRedisConnection(): IORedis {
    if (!g.__komgaRedis) {
        // maxRetriesPerRequest: null is what BullMQ requires for a connection a Worker may share.
        g.__komgaRedis = new IORedis(process.env.OMNIBUS_REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
    }
    return g.__komgaRedis;
}

export function getKomgaQueue(): Queue {
    if (!g.__komgaQueue) {
        const queue = new Queue(KOMGA_QUEUE_NAME, { connection: getKomgaRedisConnection(), defaultJobOptions: { ...KOMGA_BASE_JOB_OPTIONS } });
        // Without a listener BullMQ re-emits connection errors into the void; log them, but at most
        // once a minute so a Redis outage does not flood the log.
        queue.on('error', (err: Error) => {
            const now = Date.now();
            if (!g.__komgaQueueErrorAt || now - g.__komgaQueueErrorAt > 60_000) {
                g.__komgaQueueErrorAt = now;
                Logger.log(`[Komga] Queue connection error: ${err?.message ?? String(err)}`, 'warn');
            }
        });
        g.__komgaQueue = queue;
    }
    return g.__komgaQueue;
}

/**
 * One sync for an Omnibus library. With dedupe (the default, for flush/reconcile-originated jobs)
 * an add while another sync for that library is waiting, delayed or active is dropped: the dedup
 * key lives until that job completes or fails. A running sync that re-enqueues ITSELF to wait for
 * the next stage must pass dedupe: false, or its own continuation would be swallowed.
 */
export async function enqueueKomgaSync(data: KomgaSyncJobData, opts: { delayMs?: number; dedupe?: boolean } = {}): Promise<void> {
    if (!data?.omnibusLibraryId) throw new Error('enqueueKomgaSync: omnibusLibraryId is required');
    const jobOpts: JobsOptions = { ...KOMGA_BASE_JOB_OPTIONS };
    if (opts.delayMs && opts.delayMs > 0) jobOpts.delay = Math.round(opts.delayMs);
    if (opts.dedupe !== false) jobOpts.deduplication = { id: komgaSyncDedupId(data.omnibusLibraryId) };
    await getKomgaQueue().add(KOMGA_JOB.SYNC, data, jobOpts);
}

/**
 * Full reconcile. Deduplicated while one is waiting; keepLastIfActive makes a request that arrives
 * while a reconcile is RUNNING (e.g. path mappings saved mid-run) start one more afterwards instead
 * of being dropped, so the newest settings always get a pass.
 */
export async function enqueueKomgaReconcile(reason: string): Promise<void> {
    const data: KomgaReconcileJobData = { reason: reason || 'unspecified' };
    await getKomgaQueue().add(KOMGA_JOB.RECONCILE, data, {
        ...KOMGA_BASE_JOB_OPTIONS,
        deduplication: { id: KOMGA_RECONCILE_DEDUP_ID, keepLastIfActive: true },
    });
}

/** Debounced push: every mutation within 10 s replaces the delayed job and restarts the timer. */
export async function enqueueKomgaReadListPush(readingListId: string): Promise<void> {
    if (!readingListId) throw new Error('enqueueKomgaReadListPush: readingListId is required');
    const data: KomgaReadListPushJobData = { readingListId };
    await getKomgaQueue().add(KOMGA_JOB.READLIST_PUSH, data, {
        ...KOMGA_BASE_JOB_OPTIONS,
        delay: KOMGA_READLIST_DEBOUNCE_MS,
        deduplication: { id: komgaReadListDedupId(readingListId), ttl: KOMGA_READLIST_DEBOUNCE_MS, extend: true, replace: true },
    });
}

/** Remote delete. Not deduplicated: each one carries its own Komga id, and the job checks the marker first. */
export async function enqueueKomgaReadListDelete(data: KomgaReadListDeleteJobData): Promise<void> {
    if (!data?.komgaReadListId || !data?.readingListId) throw new Error('enqueueKomgaReadListDelete: komgaReadListId and readingListId are required');
    const payload: KomgaReadListDeleteJobData = { komgaReadListId: data.komgaReadListId, readingListId: data.readingListId };
    await getKomgaQueue().add(KOMGA_JOB.READLIST_DELETE, payload, { ...KOMGA_BASE_JOB_OPTIONS });
}
