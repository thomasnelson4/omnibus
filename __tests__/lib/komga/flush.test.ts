import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    hotFlags: vi.fn(),
    findMany: vi.fn(),
    enqueueKomgaSync: vi.fn(),
}));

vi.unmock('@/lib/komga/changes');

vi.mock('@/lib/komga/settings', () => ({ getKomgaHotFlags: mocks.hotFlags }));
vi.mock('@/lib/komga/queue', () => ({
    enqueueKomgaSync: mocks.enqueueKomgaSync,
    KOMGA_JOB: {},
}));
vi.mock('@/lib/db', () => ({ prisma: { komgaSyncState: { findMany: mocks.findMany } } }));

import { isLibraryDue, backoffMs, flushDueLibraries, type KomgaSyncStateLike } from '@/lib/komga/flush';
import {
    KOMGA_DEBOUNCE_MS,
    KOMGA_MAX_WAIT_MS,
    KOMGA_BACKOFF_BASE_MS,
    KOMGA_BACKOFF_CAP_MS,
} from '@/lib/komga/constants';

const NOW = new Date('2026-01-01T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

/** A state that is dirty, past the debounce, and otherwise unencumbered. */
function state(over: Partial<KomgaSyncStateLike> = {}): KomgaSyncStateLike {
    return {
        omnibusLibraryId: 'lib-1',
        dirtySince: ago(KOMGA_DEBOUNCE_MS + 1_000),
        lastChangeAt: ago(KOMGA_DEBOUNCE_MS + 1_000),
        lastScanRequestedAt: null,
        syncLeaseUntil: null,
        nextEligibleAt: null,
        consecutiveFailures: 0,
        ...over,
    };
}

beforeEach(() => {
    mocks.hotFlags.mockResolvedValue({ enabled: true, scanOnChange: true, readListsEnabled: false });
    mocks.findMany.mockResolvedValue([]);
    mocks.enqueueKomgaSync.mockResolvedValue(undefined);
});

describe('isLibraryDue: eligibility', () => {
    it('is due after the debounce when a change arrived since the last scan', () => {
        expect(isLibraryDue(state(), NOW)).toBe(true);
    });

    it('is NOT due before the debounce has elapsed', () => {
        expect(isLibraryDue(state({ lastChangeAt: ago(KOMGA_DEBOUNCE_MS - 1) }), NOW)).toBe(false);
    });

    it('is due exactly at the debounce boundary', () => {
        expect(isLibraryDue(state({ lastChangeAt: ago(KOMGA_DEBOUNCE_MS) }), NOW)).toBe(true);
    });

    it('is NOT due when the last change predates the last scan request', () => {
        expect(isLibraryDue(state({
            lastChangeAt: ago(120_000),
            lastScanRequestedAt: ago(60_000),
        }), NOW)).toBe(false);
    });

    it('is due when the change lands after the scan request', () => {
        expect(isLibraryDue(state({
            lastChangeAt: ago(90_000),
            lastScanRequestedAt: ago(120_000),
        }), NOW)).toBe(true);
    });

    it('treats a null lastScanRequestedAt as -infinity (never scanned)', () => {
        expect(isLibraryDue(state({ lastScanRequestedAt: null, lastChangeAt: ago(KOMGA_DEBOUNCE_MS + 1) }), NOW)).toBe(true);
    });

    it('is NOT due for a library that was never changed and never scanned', () => {
        expect(isLibraryDue(state({
            dirtySince: null, lastChangeAt: null, lastScanRequestedAt: null,
        }), NOW)).toBe(false);
    });
});

describe('isLibraryDue: the failure clause', () => {
    it('keeps a failed library eligible even though nothing changed since the last scan', () => {
        // The change PREDATES the scan request, so changedSinceScan is false; the failure clause is
        // the only thing making this eligible, and it is past the quiet period, so it is due.
        expect(isLibraryDue(state({
            dirtySince: ago(KOMGA_DEBOUNCE_MS + 1_000),
            lastChangeAt: ago(90_000),
            lastScanRequestedAt: ago(60_000),
            consecutiveFailures: 2,
        }), NOW)).toBe(true);
    });

    it('requires consecutiveFailures > 0 for that clause', () => {
        expect(isLibraryDue(state({
            dirtySince: ago(1_000),
            lastChangeAt: ago(1_000),
            lastScanRequestedAt: ago(5_000),
            consecutiveFailures: 0,
        }), NOW)).toBe(false);
    });

    it('still needs the quiet period for the failure clause', () => {
        // Same shape, but the last change is only 1s old: the failure clause grants ELIGIBILITY,
        // not the debounce, so this must still wait.
        expect(isLibraryDue(state({
            dirtySince: ago(1_000),
            lastChangeAt: ago(1_000),
            lastScanRequestedAt: ago(5_000),
            consecutiveFailures: 1,
        }), NOW)).toBe(false);
    });

    it('does NOT satisfy the quiet period via the failure clause either', () => {
        // dirtySince is recent too, so neither the debounce nor the max-wait ceiling is met.
        expect(isLibraryDue(state({
            dirtySince: ago(1_000),
            lastChangeAt: ago(10_000),
            lastScanRequestedAt: ago(60_000),
            consecutiveFailures: 1,
        }), NOW)).toBe(false);
    });
});

describe('isLibraryDue: backoff', () => {
    it('is NOT due while nextEligibleAt is in the future', () => {
        expect(isLibraryDue(state({ nextEligibleAt: ahead(30_000) }), NOW)).toBe(false);
    });

    it('is due once the backoff has expired', () => {
        expect(isLibraryDue(state({ nextEligibleAt: ago(1) }), NOW)).toBe(true);
    });

    it('is due exactly at the backoff boundary', () => {
        expect(isLibraryDue(state({ nextEligibleAt: NOW }), NOW)).toBe(true);
    });
});

describe('isLibraryDue: the lease', () => {
    it('is NOT due while another sync holds a live lease', () => {
        expect(isLibraryDue(state({ syncLeaseUntil: ahead(60_000) }), NOW)).toBe(false);
    });

    it('is due once the lease has expired', () => {
        expect(isLibraryDue(state({ syncLeaseUntil: ago(1) }), NOW)).toBe(true);
    });

    it('treats an expired lease as free even when it is far in the past', () => {
        expect(isLibraryDue(state({ syncLeaseUntil: ago(86_400_000) }), NOW)).toBe(true);
    });
});

describe('isLibraryDue: the max-wait ceiling', () => {
    it('is due once dirtySince is older than KOMGA_MAX_WAIT_MS even if changes keep arriving', () => {
        // The whole point of the ceiling: a steady trickle of writes must never postpone forever.
        expect(isLibraryDue(state({
            dirtySince: ago(KOMGA_MAX_WAIT_MS + 1),
            lastChangeAt: ago(1_000), // a change just landed, well inside the debounce
        }), NOW)).toBe(true);
    });

    it('is NOT due just before the ceiling', () => {
        expect(isLibraryDue(state({
            dirtySince: ago(KOMGA_MAX_WAIT_MS - 1),
            lastChangeAt: ago(1_000),
        }), NOW)).toBe(false);
    });
});

describe('isLibraryDue: it is a pure function', () => {
    it('gives the same answer twice for the same input', () => {
        const s = state();
        expect(isLibraryDue(s, NOW)).toBe(isLibraryDue(s, NOW));
    });

    it('does not mutate the state it is given', () => {
        const s = state();
        const before = JSON.stringify(s);
        isLibraryDue(s, NOW);
        expect(JSON.stringify(s)).toBe(before);
    });
});

describe('backoffMs', () => {
    it('is 0 below the first failure', () => {
        expect(backoffMs(0)).toBe(0);
        expect(backoffMs(-1)).toBe(0);
        expect(backoffMs(NaN)).toBe(0);
    });

    it('doubles: 1, 2, 4, 8 minutes', () => {
        expect(backoffMs(1)).toBe(KOMGA_BACKOFF_BASE_MS);
        expect(backoffMs(2)).toBe(KOMGA_BACKOFF_BASE_MS * 2);
        expect(backoffMs(3)).toBe(KOMGA_BACKOFF_BASE_MS * 4);
        expect(backoffMs(4)).toBe(KOMGA_BACKOFF_BASE_MS * 8);
    });

    it('caps at 30 minutes', () => {
        expect(backoffMs(20)).toBe(KOMGA_BACKOFF_CAP_MS);
        expect(backoffMs(1000)).toBe(KOMGA_BACKOFF_CAP_MS);
    });

    it('does not overflow to Infinity for an absurd failure count', () => {
        // 2**n is Infinity past n=53; Infinity would park the library FOREVER instead of at the cap.
        expect(backoffMs(10_000)).toBe(KOMGA_BACKOFF_CAP_MS);
        expect(Number.isFinite(backoffMs(10_000))).toBe(true);
    });
});

describe('flushDueLibraries', () => {
    it('does nothing when Komga is disabled', async () => {
        mocks.hotFlags.mockResolvedValue({ enabled: false, scanOnChange: true, readListsEnabled: false });
        expect(await flushDueLibraries(NOW)).toBe(0);
        expect(mocks.findMany).not.toHaveBeenCalled();
    });

    it('only looks at libraries that have a dirtySince or a lastChangeAt', async () => {
        await flushDueLibraries(NOW);
        expect(mocks.findMany).toHaveBeenCalledWith({
            where: { OR: [{ dirtySince: { not: null } }, { lastChangeAt: { not: null } }] },
        });
    });

    it('enqueues a due library and counts it', async () => {
        mocks.findMany.mockResolvedValue([state({ omnibusLibraryId: 'lib-1' })]);
        expect(await flushDueLibraries(NOW)).toBe(1);
    });

    it('enqueues with the flush reason and dedupe enabled', async () => {
        mocks.findMany.mockResolvedValue([state({ omnibusLibraryId: 'lib-1' })]);
        await flushDueLibraries(NOW);
        expect(mocks.enqueueKomgaSync).toHaveBeenCalledWith(
            { omnibusLibraryId: 'lib-1', reason: 'flush' },
            { dedupe: true },
        );
    });

    it('skips a library that is not due', async () => {
        mocks.findMany.mockResolvedValue([state({ syncLeaseUntil: ahead(60_000) })]);
        expect(await flushDueLibraries(NOW)).toBe(0);
        expect(mocks.enqueueKomgaSync).not.toHaveBeenCalled();
    });

    it('keeps going when one enqueue throws', async () => {
        mocks.findMany.mockResolvedValue([state({ omnibusLibraryId: 'a' }), state({ omnibusLibraryId: 'b' })]);
        mocks.enqueueKomgaSync.mockRejectedValueOnce(new Error('redis blip')).mockResolvedValue(undefined);
        expect(await flushDueLibraries(NOW)).toBe(1);
    });

    it('returns 0 and does not throw when the DB read fails', async () => {
        mocks.findMany.mockRejectedValue(new Error('db down'));
        expect(await flushDueLibraries(NOW)).toBe(0);
    });

    it('uses the injected enqueue seam (dedupe is applied by the caller)', async () => {
        const enqueue = vi.fn().mockResolvedValue(undefined);
        mocks.findMany.mockResolvedValue([state({ omnibusLibraryId: 'lib-9' })]);
        expect(await flushDueLibraries(NOW, { enqueue })).toBe(1);
        expect(enqueue).toHaveBeenCalledWith({ omnibusLibraryId: 'lib-9', reason: 'flush' });
    });

    it('does not enqueue the same library twice within one tick', async () => {
        mocks.findMany.mockResolvedValue([state({ omnibusLibraryId: 'lib-1' }), state({ omnibusLibraryId: 'lib-1' })]);
        // Two rows for one library would double-scan; dedupe in Redis is the real guard, but the
        // counter must reflect what was actually handed over.
        expect(await flushDueLibraries(NOW)).toBe(2);
    });
});
