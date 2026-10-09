// src/lib/komga/sync.ts
//
// runLibrarySync: an ORDERED LIST OF SHORT STEP FUNCTIONS, not one long function.
//
// Why the shape: Node's SQLite runs with connection_limit=1, and the engine hammers that same file
// during a scan. Holding a Prisma transaction open across an HTTP call to Komga therefore blocks
// every other writer in the process — that is issue #195, and it is why no step here is allowed to
// `await` HTTP inside a transaction. Splitting into stages that each finish their DB work before
// returning also means a 15-minute settle never holds anything, and a crash mid-settle resumes from
// a job that carries its own context.
//
// The stages:
//
//   start    → take the lease, work out which Komga libraries serve this Omnibus library
//   preIdle  → wait for Komga's task queue to drain (it is one global serial queue, so our own
//              previous scan may still be running)
//   scan     → POST the scan for every mapped Komga library, record when, clear pendingPaths
//   settle   → wait for that scan to finish
//   reconcile → Phase 3: rebuild the identity map for the library
//   verify    → Phase 3: check the snapshot against what Komga indexed, then release the lease
//   readlists → Phase 4: push the reading lists that cover this library
//
// A step that must wait returns {wait, stage}; runLibrarySync re-enqueues a continuation WITHOUT
// the flush dedup id (the active job still owns it) and with a unique jobId, so the chain cannot
// swallow itself.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { isKomgaError } from './types';
import type { KomgaClient } from './client';
import type { KomgaSettings } from './settings';
import { getKomgaSettings } from './settings';
import {
    komgaLibrariesForOmnibusLibrary,
    komgaLibraryRowToResolved,
    refreshKomgaLibraries,
    type ResolvedKomgaLibrary,
    type OmnibusLibraryRef,
} from './libraries';
import { getKomgaClient } from './factory';
import { enqueueKomgaSync, type KomgaSyncJobData } from './queue';
import { backoffMs } from './flush';
import { reconcileLibrary } from './reconcile';
import { verifyLibrary } from './verify';
import { pushReadList } from './readlist-push';
import {
    KOMGA_LEASE_MS,
    KOMGA_PRE_IDLE_RECHECK_MS,
    KOMGA_PRE_IDLE_CAP_MS,
    KOMGA_SETTLE_INITIAL_DELAY_MS,
    KOMGA_SETTLE_RECHECK_MS,
    KOMGA_SETTLE_CAP_MS,
    KOMGA_SETTLE_FIXED_FALLBACK_MS,
} from './constants';

export type SyncStage = 'start' | 'preIdle' | 'scan' | 'settle' | 'reconcile' | 'verify' | 'readlists' | 'done';

export type StepResult =
    | { next: SyncStage }
    | { wait: number; stage: SyncStage; patch?: Partial<KomgaSyncJobData> }
    | { done: true };

/**
 * The models the stage machine touches. Phase 3 widened this (issue, komgaBookLink,
 * komgaSeriesLink, $transaction) for the reconcile and verify stages; $transaction is here so a
 * missing batch writer is a type error rather than a runtime one.
 */
export type KomgaSyncDb = Pick<typeof prisma,
    'komgaSyncState' | 'komgaLibrary' | 'library' | 'jobLog' | 'issue' | 'komgaBookLink' | 'komgaSeriesLink' | '$transaction'>;

type SyncStateRow = {
    omnibusLibraryId: string;
    dirtySince: Date | null;
    lastChangeAt: Date | null;
    pendingPaths: string | null;
    pendingOverflow: boolean;
    lastScanRequestedAt: Date | null;
    lastSyncCompletedAt: Date | null;
    syncLeaseUntil: Date | null;
    nextEligibleAt: Date | null;
    retryCount: number;
    consecutiveFailures: number;
    lastError: string | null;
};

export interface SyncContext {
    data: KomgaSyncJobData;
    now: () => Date;
    db: KomgaSyncDb;
    client: KomgaClient;
    enqueue: (data: KomgaSyncJobData, delayMs: number) => Promise<void>;
    settings: KomgaSettings;
    state: SyncStateRow;
    komgaLibs: ResolvedKomgaLibrary[];
}

const log = (msg: string, level: 'info' | 'warn' | 'debug' | 'error' | 'success' = 'debug') =>
    Logger.log(`[Komga] ${msg}`, level);

// --- helpers shared by the steps -------------------------------------------------------

async function ensureStateRow(db: KomgaSyncDb, libraryId: string): Promise<SyncStateRow> {
    const existing = await db.komgaSyncState.findUnique({ where: { omnibusLibraryId: libraryId } });
    if (existing) return existing as SyncStateRow;
    return (await db.komgaSyncState.create({ data: { omnibusLibraryId: libraryId } })) as SyncStateRow;
}

/**
 * The cached Komga libraries, read through the INJECTED db.
 *
 * Not loadCachedKomgaLibraries() from libraries.ts: that reads the module-level prisma, which
 * bypasses deps.db and would make every stage untestable without a real database.
 */
async function cachedKomgaLibraries(db: KomgaSyncDb): Promise<ResolvedKomgaLibrary[]> {
    try {
        const rows = await db.komgaLibrary.findMany({});
        return rows.map(komgaLibraryRowToResolved);
    } catch (e) {
        log(`could not read the cached Komga library list: ${getErrorMessage(e)}`, 'warn');
        return [];
    }
}

async function releaseLease(db: KomgaSyncDb, libraryId: string): Promise<void> {
    try {
        await db.komgaSyncState.updateMany({ where: { omnibusLibraryId: libraryId }, data: { syncLeaseUntil: null } });
    } catch (e) {
        // The lease expires on its own (KOMGA_LEASE_MS), so a failed release is not fatal — but it
        // does delay the library, so say so.
        log(`could not release the sync lease for ${libraryId}: ${getErrorMessage(e)}`, 'warn');
    }
}

/**
 * A scan POST failed. Parks the library behind an exponential backoff and records why.
 * Deliberately does NOT advance lastScanRequestedAt: the change is still unhandled, and the due
 * rule's failure clause (dirtySince != null AND consecutiveFailures > 0) is what keeps retrying it.
 */
async function recordScanFailure(ctx: SyncContext, error: unknown): Promise<void> {
    const { db, state, data } = ctx;
    const now = ctx.now();
    const failures = state.consecutiveFailures + 1;
    // Komga's own message, never the URL with a query string and never the key.
    const message = isKomgaError(error) ? (error.detail || error.message) : getErrorMessage(error);
    await db.komgaSyncState.update({
        where: { omnibusLibraryId: data.omnibusLibraryId },
        data: {
            consecutiveFailures: failures,
            nextEligibleAt: new Date(now.getTime() + backoffMs(failures)),
            lastError: `scan failed: ${message}`.slice(0, 500),
            dirtySince: state.dirtySince ?? now,
        },
    });
    await db.jobLog.create({
        data: {
            jobType: 'KOMGA_SCAN',
            status: 'FAILED',
            relatedItem: data.omnibusLibraryId,
            durationMs: null,
            message: `Scan request failed (${failures}): ${message}`.slice(0, 1000),
        },
    }).catch(() => { /* the JobLog write must never mask the real failure */ });
    await releaseLease(db, data.omnibusLibraryId);
    log(`scan request failed for ${data.omnibusLibraryId}: ${message}`, 'warn');
}

// --- the steps -------------------------------------------------------------------------

/** Take the lease and resolve the mapped Komga libraries. */
async function stepStart(ctx: SyncContext): Promise<StepResult> {
    const { db, data, now, settings } = ctx;
    const at = now();

    if (ctx.state.syncLeaseUntil && ctx.state.syncLeaseUntil.getTime() > at.getTime()) {
        // Another sync owns this library. Its own scan covers our change (same library, same
        // pendingPaths), so exiting is correct — not a failure.
        log(`another sync holds the lease for ${data.omnibusLibraryId}; skipping this job`, 'debug');
        return { done: true };
    }

    const state = await db.komgaSyncState.update({
        where: { omnibusLibraryId: data.omnibusLibraryId },
        data: { syncLeaseUntil: new Date(at.getTime() + KOMGA_LEASE_MS) },
    });
    ctx.state = state as SyncStateRow;

    // Refresh the cache, but a Komga outage here must not stop the scan: fall back to the last
    // known library list, which is exactly what the cached copy is for.
    let all: ResolvedKomgaLibrary[] = [];
    try {
        all = await refreshKomgaLibraries(ctx.client, settings.pathMappings);
    } catch (e) {
        log(`could not refresh the Komga library list for ${data.omnibusLibraryId}: ${getErrorMessage(e)}`, 'warn');
        all = await cachedKomgaLibraries(db);
    }

    const omnibusLib = await db.library.findUnique({ where: { id: data.omnibusLibraryId }, select: { id: true, name: true, path: true } });
    const ref: OmnibusLibraryRef = omnibusLib ?? { id: data.omnibusLibraryId, name: data.omnibusLibraryId, path: '' };
    const komgaLibs = komgaLibrariesForOmnibusLibrary(ref, all);

    if (komgaLibs.length === 0) {
        // Nothing to scan. Clear the dirty state so the flush stops re-enqueueing it forever.
        await db.komgaSyncState.update({
            where: { omnibusLibraryId: data.omnibusLibraryId },
            data: {
                dirtySince: null, lastChangeAt: null, pendingPaths: null, pendingOverflow: false,
                retryCount: 0, lastError: 'no Komga library mapped', syncLeaseUntil: null,
            },
        });
        log(`no Komga library maps to ${ref.name}; cleared its dirty state`, 'info');
        return { done: true };
    }

    log(`sync starting for ${ref.name} → ${komgaLibs.map(l => l.name).join(', ')}`, 'info');
    return {
        wait: 0,
        stage: 'preIdle',
        // Carry the ids: later stages must not depend on a Komga call to know what to scan.
        patch: { komgaLibraryIds: komgaLibs.map(l => l.komgaLibraryId) },
    };
}

/**
 * Komga runs ONE serial task queue for every library (taskPoolSize 1). Scanning while a previous
 * scan is still running is safe — Komga collapses the duplicate — but it wastes a scan slot and
 * makes the settle stage below ambiguous, so wait a bounded amount of time first.
 */
async function stepPreIdle(ctx: SyncContext): Promise<StepResult> {
    const startedAt = ctx.data.stageStartedAt ?? ctx.now().getTime();
    const elapsed = ctx.now().getTime() - startedAt;

    try {
        const read = await ctx.client.readTaskQueue();
        const scanning = read.ok ? (read.status.countByType?.ScanLibrary ?? 0) : 0;
        if (read.ok && scanning > 0 && elapsed < KOMGA_PRE_IDLE_CAP_MS) {
            return { wait: KOMGA_PRE_IDLE_RECHECK_MS, stage: 'preIdle' };
        }
        if (!read.ok) log(`task queue unavailable (${read.reason}); scanning anyway`, 'debug');
        return { next: 'scan' };
    } catch (e) {
        if (isKomgaError(e) && (e.kind === 'unreachable' || e.kind === 'unauthorized' || e.kind === 'forbidden' || e.kind === 'timeout')) {
            await recordScanFailure(ctx, e);
            return { done: true };
        }
        // Not a connection problem — proceed rather than stall the library.
        log(`pre-idle check failed (${getErrorMessage(e)}); scanning anyway`, 'warn');
        return { next: 'scan' };
    }
}

/** POST the scan for every mapped Komga library, then advance to settle. */
async function stepScan(ctx: SyncContext): Promise<StepResult> {
    const { db, data, now, state } = ctx;
    const requestTime = now();

    const metricsBefore = await ctx.client.scanMetricsCount().catch(() => null);
    const deep = data.deep === true || state.retryCount >= 2;

    try {
        for (const lib of ctx.komgaLibs) {
            // 202 with an EMPTY body — scanLibrary does not parse it (LIVE delta 5).
            await ctx.client.scanLibrary(lib.komgaLibraryId, deep);
        }
    } catch (e) {
        await recordScanFailure(ctx, e);
        return { done: true };
    }

    // Every library was accepted: one write for the whole batch.
    //
    // The pendingPaths snapshot is read HERE, before the update below — the update clears that
    // column, and reading it afterwards depends on the db layer not handing back the same object
    // reference it was given. Phase 3 verifies against this snapshot, so losing it would silently
    // turn every verification into "verify nothing".
    const snapshotPaths = parseStored(state.pendingPaths);
    const snapshotOverflow = state.pendingOverflow;

    //
    // dirtySince is cleared only when the last change is already covered by this scan. A change
    // that landed between measuring and POSTing stays dirty, so the next flush picks it up.
    const coveredByScan = !state.lastChangeAt || state.lastChangeAt.getTime() <= requestTime.getTime();
    await db.komgaSyncState.update({
        where: { omnibusLibraryId: data.omnibusLibraryId },
        data: {
            lastScanRequestedAt: requestTime,
            pendingPaths: null,
            pendingOverflow: false,
            consecutiveFailures: 0,
            nextEligibleAt: null,
            lastError: null,
            ...(coveredByScan ? { dirtySince: null, lastChangeAt: null } : {}),
        },
    });
    ctx.state = { ...state, lastScanRequestedAt: requestTime, consecutiveFailures: 0, nextEligibleAt: null };

    log(`scan requested (deep=${deep}) for ${ctx.komgaLibs.length} Komga librar${ctx.komgaLibs.length === 1 ? 'y' : 'ies'}; settling`, 'debug');

    return {
        wait: KOMGA_SETTLE_INITIAL_DELAY_MS,
        stage: 'settle',
        patch: {
            snapshotPaths,
            snapshotOverflow,
            scanRequestedAt: requestTime.getTime(),
            metricsBefore: metricsBefore ?? null,
            settleStartedAt: requestTime.getTime(),
            stageStartedAt: requestTime.getTime(),
        },
    };
}

function parseStored(json: string | null): string[] | undefined {
    if (!json) return undefined;
    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Wait for the scan to finish.
 *
 * The subtle part (LIVE deltas 3 + 6): TaskQueueStatus ticks every 10 s GLOBALLY, and a small
 * library scans in 3–92 ms — so a scan can be created AND finished between two ticks and never
 * appear in a frame at all. "I saw ScanLibrary" is therefore not a usable signal, and neither is
 * "the count is still > 0", which may be some other library's work. What IS sound is: read a
 * frame that ARRIVED AFTER our POST and in it no ScanLibrary is queued or running.
 *
 * The metric COUNT is global and increments when a task FINISHES, so it is a fallback, not a
 * primary: 0 → 0 is ambiguous (no scan since Komga started, or metrics not exposed), which is why
 * the fixed-delay fallback still exists.
 */
async function stepSettle(ctx: SyncContext): Promise<StepResult> {
    const { db, data, now } = ctx;
    const scanRequestedAt = data.scanRequestedAt ?? ctx.state.lastScanRequestedAt?.getTime() ?? now().getTime();
    const settleStartedAt = data.settleStartedAt ?? scanRequestedAt;
    const elapsed = now().getTime() - settleStartedAt;

    let detection: 'sse' | 'metrics' | 'fixed' | 'timeout' = 'timeout';

    try {
        const read = await ctx.client.readTaskQueue();
        if (read.ok) {
            const scanning = read.status.countByType?.ScanLibrary ?? 0;
            if (scanning === 0) {
                detection = 'sse';
            } else if (elapsed < KOMGA_SETTLE_CAP_MS) {
                // Still running — but only wait while what we see is plausibly OUR scan.
                return { wait: KOMGA_SETTLE_RECHECK_MS, stage: 'settle', patch: { stageStartedAt: now().getTime() } };
            }
        } else {
            // SSE unavailable (no admin key, or Komga has no SSE). Fall back to the metric.
            const before = data.metricsBefore ?? null;
            const after = await ctx.client.scanMetricsCount().catch(() => null);
            if (before != null && after != null) {
                const expected = before + ctx.komgaLibs.length;
                if (before > 0 && after >= expected) {
                    // before > 0 is required: 0 → 0 cannot distinguish "our scan finished" from
                    // "no scan has ever run / metrics not exposed" (LIVE delta 6).
                    detection = 'metrics';
                } else if (before === 0 && after > 0 && elapsed < KOMGA_SETTLE_CAP_MS) {
                    // We started from an unproven zero and the counter has since moved. Not proof
                    // that OUR scan finished (it is global), so keep waiting rather than settle.
                    return { wait: KOMGA_SETTLE_RECHECK_MS, stage: 'settle', patch: { stageStartedAt: now().getTime() } };
                } else {
                    // Counts unproven or unmoved: hold to the fixed fallback instead of guessing.
                    if (now().getTime() - scanRequestedAt >= KOMGA_SETTLE_FIXED_FALLBACK_MS) {
                        detection = 'fixed';
                    } else {
                        const remain = KOMGA_SETTLE_FIXED_FALLBACK_MS - (now().getTime() - scanRequestedAt);
                        return { wait: Math.max(remain, 1), stage: 'settle', patch: { stageStartedAt: now().getTime() } };
                    }
                }
            } else if (now().getTime() - scanRequestedAt >= KOMGA_SETTLE_FIXED_FALLBACK_MS) {
                detection = 'fixed';
            } else {
                const remain = KOMGA_SETTLE_FIXED_FALLBACK_MS - (now().getTime() - scanRequestedAt);
                return { wait: Math.max(remain, 1), stage: 'settle', patch: { stageStartedAt: now().getTime() } };
            }
        }
    } catch (e) {
        if (isKomgaError(e) && (e.kind === 'unreachable' || e.kind === 'timeout')) {
            // The scan WAS accepted (202). Losing the connection now is not a scan failure — do not
            // count it as one; treat it as an unknown settle.
            log(`lost the connection while settling (${getErrorMessage(e)}); treating as timeout`, 'warn');
        }
        if (elapsed < KOMGA_SETTLE_CAP_MS) {
            return { wait: KOMGA_SETTLE_RECHECK_MS, stage: 'settle', patch: { stageStartedAt: now().getTime() } };
        }
    }

    if (detection === 'timeout' && elapsed < KOMGA_SETTLE_CAP_MS) {
        return { wait: KOMGA_SETTLE_RECHECK_MS, stage: 'settle', patch: { stageStartedAt: now().getTime() } };
    }

    const timedOut = detection === 'timeout';
    const durationMs = now().getTime() - scanRequestedAt;
    const lib = await db.library.findUnique({ where: { id: data.omnibusLibraryId }, select: { name: true } }).catch(() => null);

    await db.komgaSyncState.update({
        where: { omnibusLibraryId: data.omnibusLibraryId },
        data: { lastSyncCompletedAt: now(), syncLeaseUntil: null },
    });
    await db.jobLog.create({
        data: {
            jobType: 'KOMGA_SCAN',
            status: timedOut ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
            relatedItem: lib?.name ?? data.omnibusLibraryId,
            durationMs,
            message: JSON.stringify({
                komgaLibraries: ctx.komgaLibs.map(l => l.name),
                detection,
                deep: data.deep === true || ctx.state.retryCount >= 2,
                snapshotPaths: data.snapshotPaths?.length ?? 0,
                snapshotOverflow: Boolean(data.snapshotOverflow),
                timedOut,
            }),
        },
    }).catch(() => { /* never let the audit write change the outcome */ });

    log(`settled (${detection}) after ${durationMs}ms for ${data.omnibusLibraryId}`, timedOut ? 'warn' : 'info');
    return { next: 'reconcile' };
}

/**
 * Stage e: rewrite the identity map for the Komga libraries this sync just scanned.
 *
 * The lease is taken back here because settle released it (that is where lastSyncCompletedAt is
 * stamped). Letting it go in the middle of the pipeline would let the flush start a second sync for
 * the same library, and two verifies would double-count a miss.
 */
async function stepReconcile(ctx: SyncContext): Promise<StepResult> {
    const { db, data, now } = ctx;
    await db.komgaSyncState.updateMany({
        where: { omnibusLibraryId: data.omnibusLibraryId },
        data: { syncLeaseUntil: new Date(now().getTime() + KOMGA_LEASE_MS) },
    }).catch(() => { /* the original lease expires on its own */ });

    try {
        await reconcileLibrary(data.omnibusLibraryId, {
            db,
            client: ctx.client,
            settings: ctx.settings,
            komgaLibs: ctx.komgaLibs,
            now,
        });
    } catch (e) {
        // reconcileLibrary folds its own failures into its result, so this is a last resort. Verify
        // must still run: it is the stage that re-dirties the library, and skipping it would turn a
        // reconcile bug into a silent "Komga has everything".
        log(`reconcile threw for ${data.omnibusLibraryId}: ${getErrorMessage(e)}`, 'warn');
    }
    return { next: 'verify' };
}

/**
 * Stage f: check the scan against the snapshot step c took, and re-dirty the library on a miss.
 *
 * This stage hands the lease back (see the updateMany below): Phase 4's 'readlists' runs AFTER it,
 * and leaving the library locked for 30 minutes would stop the flush from acting on the retry this
 * stage may have just scheduled.
 */
async function stepVerify(ctx: SyncContext): Promise<StepResult> {
    const { db, data, now } = ctx;
    try {
        const result = await verifyLibrary(data.omnibusLibraryId, {
            db,
            client: ctx.client,
            settings: ctx.settings,
            komgaLibs: ctx.komgaLibs,
            snapshotPaths: data.snapshotPaths,
            snapshotOverflow: data.snapshotOverflow,
            now,
        });
        if (result.unverifiable) {
            // The lease still has to go, or the library stalls for 30 minutes.
            log(`verification could not run for ${data.omnibusLibraryId}; the retry state is unchanged`, 'warn');
        }
    } catch (e) {
        log(`verify threw for ${data.omnibusLibraryId}: ${getErrorMessage(e)}`, 'warn');
    }
    await db.komgaSyncState.updateMany({
        where: { omnibusLibraryId: data.omnibusLibraryId },
        data: { syncLeaseUntil: null },
    }).catch((e: unknown) => log(`could not release the sync lease: ${getErrorMessage(e)}`, 'warn'));
    return { next: 'readlists' };
}

/**
 * Stage g: push the reading lists whose entries live in this library.
 *
 * Runs after 'verify' on purpose — the map is fresh, so a list can pick up the books this very sync
 * produced instead of waiting for the next debounce. It never holds the lease and never fails the
 * pipeline: a list that cannot be pushed is recorded on its own link row.
 */
async function stepReadlists(ctx: SyncContext): Promise<StepResult> {
    const { db, data, now } = ctx;
    try {
        const pushed = await pushReadListsForLibrary(data.omnibusLibraryId, { db, client: ctx.client, settings: ctx.settings, now });
        if (pushed > 0) log(`pushed ${pushed} reading list(s) after syncing ${data.omnibusLibraryId}`, 'debug');
    } catch (e) {
        log(`read-list pass threw for ${data.omnibusLibraryId}: ${getErrorMessage(e)}`, 'warn');
    }
    return { done: true };
}

/**
 * Every synced list with at least one entry under `omnibusLibraryId`. pushReadList itself checks the
 * flags and the version, so an ineligible list costs a couple of cached reads and nothing else.
 */
async function pushReadListsForLibrary(
    omnibusLibraryId: string,
    deps: { db: KomgaSyncDb; client: KomgaClient; settings: KomgaSettings; now: () => Date },
): Promise<number> {
    const lists = await (deps.db as any).readingList.findMany({
        where: {
            komgaSync: true,
            items: { some: { issue: { series: { libraryId: omnibusLibraryId } } } },
        },
        select: { id: true },
    }) as { id: string }[];
    let pushed = 0;
    for (const list of lists) {
        const result = await pushReadList(list.id, { ...deps, db: deps.db as any });
        if (result.status === 'pushed' || result.status === 'waiting') pushed += 1;
    }
    return pushed;
}

/**
 * The stage list. Phase 3 inserts 'reconcile' and 'verify' AFTER 'settle'; Phase 4 appends
 * 'readlists'. Keeping them as data (rather than a switch) is what makes that insertion safe.
 */
export const SYNC_STEPS: { stage: SyncStage; run: (ctx: SyncContext) => Promise<StepResult> }[] = [
    { stage: 'start', run: stepStart },
    { stage: 'preIdle', run: stepPreIdle },
    { stage: 'scan', run: stepScan },
    { stage: 'settle', run: stepSettle },
    { stage: 'reconcile', run: stepReconcile },
    { stage: 'verify', run: stepVerify },
    { stage: 'readlists', run: stepReadlists },
];

const STEP_BY_STAGE = new Map(SYNC_STEPS.map(s => [s.stage, s]));

/** Run the stage machine until it finishes or asks to be re-enqueued. */
export async function runLibrarySync(
    data: KomgaSyncJobData,
    deps?: Partial<Pick<SyncContext, 'now' | 'db' | 'client' | 'enqueue'> & { settings?: KomgaSettings }>,
): Promise<StepResult> {
    const nowFn = deps?.now ?? (() => new Date());
    const db = (deps?.db ?? prisma) as KomgaSyncDb;
    const settings = deps?.settings ?? await getKomgaSettings();
    const enqueue = deps?.enqueue ?? ((d: KomgaSyncJobData, delayMs: number) => enqueueKomgaSync(d, { dedupe: false, delayMs }));

    if (!settings.enabled) return { done: true };

    const state = await ensureStateRow(db, data.omnibusLibraryId);

    // Komga libraries: from the job data when a previous stage already resolved them, else a
    // cached read. Never a blocking HTTP call just to work out what to scan.
    let komgaLibs: ResolvedKomgaLibrary[] = [];
    const ids = data.komgaLibraryIds;
    if (ids?.length) {
        const rows = await db.komgaLibrary.findMany({ where: { komgaLibraryId: { in: ids } } }).catch(() => []);
        komgaLibs = rows.map(komgaLibraryRowToResolved);
    }
    if (komgaLibs.length === 0 && data.stage && data.stage !== 'start') {
        komgaLibs = await cachedKomgaLibraries(db);
    }

    const client = deps?.client ?? (await getKomgaClient(settings));
    if (!client) return { done: true };

    const ctx: SyncContext = { data, now: nowFn, db, client, enqueue, settings, state, komgaLibs };

    let stage: SyncStage = (data.stage as SyncStage) || 'start';
    let working = data;
    // Bounded so a mis-wired stage cycle cannot spin forever inside one job.
    for (let hops = 0; hops < 16; hops++) {
        const step = STEP_BY_STAGE.get(stage);
        if (!step) {
            log(`unknown stage '${stage}'; ending the sync for ${data.omnibusLibraryId}`, 'warn');
            return { done: true };
        }
        if (!working.stageStartedAt && stage !== 'start') {
            working = { ...working, stageStartedAt: nowFn().getTime() };
        }

        const result = await step.run(ctx);

        if ('done' in result) return result;
        if ('wait' in result) {
            const nextData: KomgaSyncJobData = {
                ...working,
                ...(result.patch ?? {}),
                stage: result.stage,
            };
            ctx.data = nextData;
            working = nextData;
            try {
                await db.komgaSyncState.updateMany({
                    where: { omnibusLibraryId: data.omnibusLibraryId },
                    data: { syncLeaseUntil: new Date(nowFn().getTime() + KOMGA_LEASE_MS) },
                });
            } catch { /* the original lease still expires on its own */ }
            // dedupe: false — the active job holds 'komga-sync-<id>'; reusing it would drop the
            // continuation and strand the library until the lease expired.
            await enqueue(nextData, result.wait);
            return result;
        }
        stage = result.next;
        working = { ...working, stage };
    }

    log(`sync for ${data.omnibusLibraryId} exceeded the step budget; ending here`, 'warn');
    await releaseLease(db, data.omnibusLibraryId);
    return { done: true };
}
