// src/lib/komga/flush.ts
//
// The debounce. change tracking (changes.ts) only marks a library dirty; nothing talks to Komga
// until this runs, on a 30 s timer inside worker.ts. That is the whole point: 400 books dropped
// into a library by one import produce ONE scan request 60 s after the last write, not 400.
//
// isLibraryDue is PURE and is where the real logic lives, so it can be unit-tested against a
// table of edge cases with no DB, no clock injection and no mocks. flushDueLibraries is the thin
// I/O shell around it.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getKomgaHotFlags } from './settings';
import { enqueueKomgaSync, type KomgaSyncJobData } from './queue';
import {
    KOMGA_DEBOUNCE_MS,
    KOMGA_MAX_WAIT_MS,
    KOMGA_BACKOFF_BASE_MS,
    KOMGA_BACKOFF_CAP_MS,
} from './constants';

/** The subset of KomgaSyncState the due rule reads. Lets tests pass plain objects. */
export interface KomgaSyncStateLike {
    omnibusLibraryId: string;
    dirtySince: Date | null;
    lastChangeAt: Date | null;
    lastScanRequestedAt: Date | null;
    syncLeaseUntil: Date | null;
    nextEligibleAt: Date | null;
    consecutiveFailures: number;
}

/**
 * Is this library's debounce satisfied?
 *
 *   ELIGIBLE   =  a change arrived after the last scan was requested, or the library is still
 *                 dirty from failures (so a scan that errored keeps being retried), AND
 *                 backoff has expired, AND
 *                 no live lease, AND
 *   QUIET      =  the last change is at least KOMGA_DEBOUNCE_MS old (quiet period), or the library
 *                 has been dirty for at least KOMGA_MAX_WAIT_MS (the ceiling — a steady trickle of
 *                 writes can never postpone a scan forever).
 *
 * Both halves are needed. QUIET alone would starve a library that is written to continuously.
 * ELIGIBLE alone would fire on the first change and defeat the debounce entirely.
 *
 * PURE — no clock, no I/O.
 */
export function isLibraryDue(s: KomgaSyncStateLike, now: Date): boolean {
    // null lastScanRequestedAt means "never scanned", i.e. -infinity: any change beats it.
    const lastScan = s.lastScanRequestedAt ? s.lastScanRequestedAt.getTime() : Number.NEGATIVE_INFINITY;
    const lastChange = s.lastChangeAt ? s.lastChangeAt.getTime() : Number.NEGATIVE_INFINITY;

    const changedSinceScan = lastChange > lastScan;
    const dirtyFromFailure = s.dirtySince != null && s.consecutiveFailures > 0;
    if (!(changedSinceScan || dirtyFromFailure)) return false;

    // Backoff: a failing library waits. nextEligibleAt == null means "no backoff".
    if (s.nextEligibleAt && now.getTime() < s.nextEligibleAt.getTime()) return false;

    // A live lease means a sync job already owns this library. Enqueuing again would either be
    // swallowed by dedup or, worse, race a running job's own continuation.
    if (s.syncLeaseUntil && s.syncLeaseUntil.getTime() > now.getTime()) return false;

    const sinceChange = s.lastChangeAt ? now.getTime() - lastChange : Infinity;
    const sinceDirty = s.dirtySince ? now.getTime() - s.dirtySince.getTime() : Infinity;
    return sinceChange >= KOMGA_DEBOUNCE_MS || sinceDirty >= KOMGA_MAX_WAIT_MS;
}

/** 1, 2, 4 … minutes, capped at 30. failures < 1 → 0 (no backoff). */
export function backoffMs(consecutiveFailures: number): number {
    if (!Number.isFinite(consecutiveFailures) || consecutiveFailures < 1) return 0;
    // Cap the exponent before shifting: 2**n overflows to Infinity past n=53, and Infinity would
    // park the library forever instead of at the 30-minute ceiling.
    const exp = Math.min(consecutiveFailures - 1, 30);
    return Math.min(KOMGA_BACKOFF_BASE_MS * Math.pow(2, exp), KOMGA_BACKOFF_CAP_MS);
}

/**
 * Enqueue a sync for every library whose debounce has expired. Returns how many were enqueued.
 *
 * No-op unless Komga is enabled. `deps.enqueue` is the test seam; the real one dedupes by library
 * id, so two ticks inside one debounce window cannot produce two jobs.
 */
export async function flushDueLibraries(
    now: Date = new Date(),
    deps?: { enqueue?: (data: KomgaSyncJobData) => Promise<void> }
): Promise<number> {
    const enqueue = deps?.enqueue ?? ((data: KomgaSyncJobData) => enqueueKomgaSync(data, { dedupe: true }));
    try {
        const flags = await getKomgaHotFlags();
        if (!flags.enabled) return 0;

        const states = await prisma.komgaSyncState.findMany({
            where: { OR: [{ dirtySince: { not: null } }, { lastChangeAt: { not: null } }] },
        });

        let enqueued = 0;
        for (const state of states) {
            if (!isLibraryDue(state, now)) continue;
            try {
                await enqueue({ omnibusLibraryId: state.omnibusLibraryId, reason: 'flush' });
                enqueued++;
            } catch (e) {
                // One Redis hiccup must not abort the rest of the tick.
                Logger.log(`[Komga] flush could not enqueue ${state.omnibusLibraryId}: ${getErrorMessage(e)}`, 'warn');
            }
        }
        if (enqueued > 0) Logger.log(`[Komga] flush enqueued ${enqueued} librar${enqueued === 1 ? 'y' : 'ies'} for sync.`, 'debug');
        return enqueued;
    } catch (e) {
        Logger.log(`[Komga] flushDueLibraries failed: ${getErrorMessage(e)}`, 'warn');
        return 0;
    }
}
