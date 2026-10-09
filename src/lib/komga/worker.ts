// src/lib/komga/worker.ts
//
// The Komga worker: one BullMQ Worker on the `omnibus-komga` queue, plus the 30 s flush timer and
// the daily reconcile schedule. Started from src/instrumentation.ts right after initWorker().
//
// Idempotence is not optional here. instrumentation.ts runs in the Next.js server process, which
// under `next dev` re-evaluates on every hot reload, and in production can be re-entered by the
// instrumentation hook. Without a globalThis guard every reload would add another flush interval
// and another Worker on the same queue, and the flush would multiply.
import { Worker, type Job } from 'bullmq';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { KOMGA_QUEUE_NAME, KOMGA_FLUSH_INTERVAL_MS, KOMGA_RECONCILE_INTERVAL_MS } from './constants';
import { getKomgaQueue, getKomgaRedisConnection, KOMGA_BASE_JOB_OPTIONS, KOMGA_JOB, type KomgaSyncJobData } from './queue';
import { flushDueLibraries } from './flush';
import { getKomgaSettings } from './settings';
import { komgaLibrariesForOmnibusLibrary, komgaLibraryRowToResolved } from './libraries';
import type { PushResult } from './readlist-push';

const REPEATABLE_JOB_ID = 'repeat_komga_reconcile';

// SAFETY: same rationale as queue.ts — this state must be shared across module instances, and
// globalThis has no index signature for these private keys.
const g = globalThis as unknown as {
    __komgaWorker?: Worker;
    __komgaFlushTimer?: ReturnType<typeof setInterval>;
    __komgaFlushing?: boolean;
    __komgaRepeatableScheduled?: boolean;
};

const log = (msg: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info') =>
    Logger.log(`[Komga] ${msg}`, level);

/** One tick of the flush, guarded so a slow flush cannot overlap the next one. */
async function flushTick(): Promise<void> {
    if (g.__komgaFlushing) return;
    g.__komgaFlushing = true;
    try {
        await flushDueLibraries();
    } catch (e) {
        log(`flush tick failed: ${getErrorMessage(e)}`, 'warn');
    } finally {
        g.__komgaFlushing = false;
    }
}

/**
 * The daily (and settings-change, and manual) reconcile: a FULL sync of every Omnibus library that
 * a Komga library serves — pre-idle, scan, settle, reconcile, verify. That makes it a real backstop
 * for lost engine callbacks: anything written to disk outside Omnibus still ends up scanned and
 * mapped. Phase 4 appends the read-list pass and the orphan sweep to the same job.
 *
 * Library selection uses RUNTIME CONTAINMENT (komgaLibrariesForOmnibusLibrary), not the cached
 * `omnibusLibraryId` column. One Komga library over a parent folder serves several Omnibus
 * libraries but is stored against the single best match, so filtering on that column alone would
 * silently skip the others on every nightly pass.
 *
 * The per-library sync is enqueued WITH dedupe (`komga-sync-<id>`): if a flush-originated sync is
 * already waiting for that library it will run the same pipeline — including reconcile and verify —
 * so a second job would only make Komga do the work twice.
 */
async function runKomgaReconcile(data: { reason?: string }): Promise<void> {
    const reason = data?.reason || 'scheduled';
    try {
        const [omnibusLibraries, rows] = await Promise.all([
            prisma.library.findMany({ select: { id: true, name: true, path: true } }),
            prisma.komgaLibrary.findMany({}),
        ]);
        const resolved = rows.map(komgaLibraryRowToResolved).filter(l => !l.unavailable);
        const libraryIds = omnibusLibraries
            .filter(lib => komgaLibrariesForOmnibusLibrary(lib, resolved).length > 0)
            .map(lib => lib.id);

        // The orphan sweep is the one part of the reconcile that belongs to no library pipeline:
        // remote read lists this instance pushed whose Omnibus list is gone. It runs FIRST and
        // unconditionally, because a list can outlive every library it was built from — and the
        // common case (Komga reachable, no library mapped any more) returns early below.
        if ((await getKomgaSettings()).readListsEnabled) {
            const { sweepOrphanedReadLists } = await import('./readlist-push');
            const deleted = await sweepOrphanedReadLists();
            if (deleted > 0) log(`orphan sweep (${reason}): deleted ${deleted} Komga read list(s) with no Omnibus list.`, 'info');
        }

        if (libraryIds.length === 0) {
            log(`daily reconcile (${reason}): no Omnibus library is mapped to a Komga library; nothing to scan`, 'debug');
            return;
        }
        const { enqueueKomgaSync } = await import('./queue');
        for (const id of libraryIds) {
            await enqueueKomgaSync({ omnibusLibraryId: id, full: true, reason: `reconcile:${reason}` });
        }
        log(`daily reconcile (${reason}): queued ${libraryIds.length} librar${libraryIds.length === 1 ? 'y' : 'ies'}.`, 'info');
    } catch (e) {
        // Never throw: attempts is 1, so a throw just becomes a dead job and a lost night.
        log(`reconcile (${reason}) failed: ${getErrorMessage(e)}`, 'warn');
    }
}

/**
 * History for one read-list push. `KOMGA_SCAN` and `KOMGA_RECONCILE` were written by the pipeline
 * itself; the push had no JobLog at all, so a failed push (or a push that quietly skipped half the
 * list) left nothing behind in the Admin → Logs history — the only record was a `[Komga]` line in
 * the rotating log file, which is not what that page reads.
 *
 * `skipped` and `unchanged` are COMPLETED, not errors: a list whose books are not on disk yet is a
 * normal state that resolves itself on the next sync.
 */
async function recordReadListPushJobLog(readingListId: string, result: PushResult): Promise<void> {
    try {
        await prisma.jobLog.create({
            data: {
                jobType: 'KOMGA_READLIST_SYNC',
                status: result.status === 'error' ? 'FAILED' : 'COMPLETED',
                relatedItem: result.name ?? readingListId,
                durationMs: null,
                message: JSON.stringify({
                    readingListId,
                    status: result.status,
                    name: result.name ?? null,
                    komgaReadListId: result.komgaReadListId ?? null,
                    bookCount: result.bookCount ?? null,
                    pushedCount: result.pushedCount ?? null,
                    skipped: result.skipped ?? null,
                    ...(result.reason ? { reason: result.reason } : {}),
                    ...(result.error ? { error: result.error.slice(0, 500) } : {}),
                }).slice(0, 2000),
            },
        });
    } catch (e) {
        log(`could not write the read-list push JobLog for ${readingListId}: ${getErrorMessage(e)}`, 'warn');
    }
}

/** Dispatch one Komga job. Unknown names are logged, never thrown. */
export async function processKomgaJob(job: { name: string; data: unknown }): Promise<void> {
    const data = (job?.data ?? {}) as Record<string, unknown>;
    try {
        // One gate for every handler: a disabled integration must do nothing, including for jobs
        // that were already queued when it was switched off.
        const settings = await getKomgaSettings();
        if (!settings.enabled) {
            log(`ignoring ${job.name}: Komga is disabled`, 'debug');
            return;
        }

        switch (job.name) {
            case KOMGA_JOB.SYNC: {
                const { runLibrarySync } = await import('./sync');
                // SAFETY: the queue name is the contract. KOMGA_SYNC jobs are only ever added by
                // enqueueKomgaSync/flush/reconcile, all of which pass a KomgaSyncJobData; a
                // hand-crafted job would fail on the missing omnibusLibraryId inside runLibrarySync
                // rather than corrupting anything here.
                await runLibrarySync(data as unknown as KomgaSyncJobData);
                return;
            }
            case KOMGA_JOB.RECONCILE:
                await runKomgaReconcile(data ?? {});
                return;
            case KOMGA_JOB.READLIST_PUSH: {
                const { pushReadList } = await import('./readlist-push');
                const readingListId = (data as { readingListId?: string }).readingListId;
                if (!readingListId) {
                    log('KOMGA_READLIST_PUSH without a readingListId; ignoring', 'warn');
                    return;
                }
                const result = await pushReadList(readingListId);
                if (result.status === 'error') log(`push of ${readingListId} ended in an error: ${result.error}`, 'warn');
                else log(`push of ${readingListId}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`, 'debug');
                await recordReadListPushJobLog(readingListId, result);
                return;
            }
            case KOMGA_JOB.READLIST_DELETE: {
                const { deleteKomgaReadList } = await import('./readlist-push');
                const payload = data as { komgaReadListId?: string; readingListId?: string };
                if (!payload.komgaReadListId || !payload.readingListId) {
                    log('KOMGA_READLIST_DELETE without both ids; ignoring', 'warn');
                    return;
                }
                const result = await deleteKomgaReadList({
                    komgaReadListId: payload.komgaReadListId,
                    readingListId: payload.readingListId,
                });
                log(`delete of Komga read list ${payload.komgaReadListId}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`, 'debug');
                return;
            }
            default:
                log(`unknown job type '${job.name}'; ignoring`, 'warn');
        }
    } catch (e) {
        // Attempts is 1 by design (the pipeline owns its retries via KomgaSyncState), so this log is
        // the only record of why a library stopped syncing. Level matters.
        log(`job ${job?.name} failed: ${getErrorMessage(e)}`, 'warn');
    }
}

/**
 * Register the daily reconcile on the Komga queue. Kept separate from initKomgaWorker so a test can
 * call it against a fake queue.
 *
 * bullmq 5.x replaced `repeat` with job schedulers; upsertJobScheduler is used when present and
 * the legacy repeat option otherwise, so this works across the versions this repo might run.
 */
export async function scheduleKomgaReconcile(): Promise<void> {
    if (g.__komgaRepeatableScheduled) return;
    try {
        const queue = getKomgaQueue();
        const opts = {
            ...KOMGA_BASE_JOB_OPTIONS,
            name: KOMGA_JOB.RECONCILE,
            data: { reason: 'daily' },
        };
        // SAFETY: bullmq 5.76 replaced `repeat` with job schedulers. Which of the two APIs this
        // build exposes is a property of the installed bullmq, not something the type system can
        // check here, so probe for the method rather than pinning a version.
        const upsert = (queue as unknown as {
            upsertJobScheduler?: (id: string, repeat: { every: number }, template: unknown) => Promise<unknown>;
        }).upsertJobScheduler;
        if (typeof upsert === 'function') {
            await upsert.call(queue, REPEATABLE_JOB_ID, { every: KOMGA_RECONCILE_INTERVAL_MS }, opts);
        } else {
            await queue.add(KOMGA_JOB.RECONCILE, { reason: 'daily' }, {
                ...KOMGA_BASE_JOB_OPTIONS,
                repeat: { every: KOMGA_RECONCILE_INTERVAL_MS },
                jobId: REPEATABLE_JOB_ID,
            });
        }
        g.__komgaRepeatableScheduled = true;
        log(`daily reconcile scheduled (every ${Math.round(KOMGA_RECONCILE_INTERVAL_MS / 3600_000)}h).`, 'info');
    } catch (e) {
        // No Redis, or the scheduler is unavailable. The interval-based sync still works, and the
        // settings-change hook can enqueue a reconcile too.
        log(`could not schedule the daily reconcile: ${getErrorMessage(e)}`, 'warn');
    }
}

/**
 * Start the Komga worker, the flush timer and the daily reconcile. Safe to call repeatedly: the
 * second call is a no-op.
 */
export function initKomgaWorker(): void {
    if (g.__komgaWorker) return;
    try {
        const worker = new Worker(KOMGA_QUEUE_NAME, processKomgaJob, {
            // BullMQ duplicates the connection for its blocking reads; sharing one ioredis instance
            // between a Queue and a Worker would make the blocking BRPOPLPUSH starve the queue.
            connection: getKomgaRedisConnection(),
            // 1 on purpose: sync stages re-enqueue themselves, and a second concurrent worker could
            // pick up a continuation while its predecessor still holds the library's lease.
            concurrency: 1,
        });
        worker.on('error', (e: Error) => log(`worker error: ${e?.message ?? String(e)}`, 'warn'));
        worker.on('failed', (job: Job | undefined, err: Error) =>
            log(`job ${job?.name ?? '?'} failed: ${err?.message ?? String(err)}`, 'warn'));
        g.__komgaWorker = worker;

        g.__komgaFlushTimer = setInterval(() => { void flushTick(); }, KOMGA_FLUSH_INTERVAL_MS);
        // Node keeps the process alive for a timer; this one must not.
        g.__komgaFlushTimer.unref?.();

        void scheduleKomgaReconcile();
        log(`worker started on '${KOMGA_QUEUE_NAME}' (concurrency 1, flush every ${Math.round(KOMGA_FLUSH_INTERVAL_MS / 1000)}s).`, 'info');
    } catch (e) {
        // Redis down at boot: log and carry on. Settings saves and the next restart will retry.
        log(`could not start the Komga worker: ${getErrorMessage(e)}`, 'warn');
    }
}
