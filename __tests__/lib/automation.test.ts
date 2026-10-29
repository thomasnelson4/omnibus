// __tests__/lib/automation.test.ts
// automation.ts is now a thin layer: searchAndDownload() enqueues a BullMQ
// SEARCH_AND_DOWNLOAD job (the Rust engine performs the actual search via
// queue.ts -> /api/automation/search). The legacy full-Node search
// (executeSearchAndDownload) was deleted as dead code.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { searchAndDownload, processAutomationQueue, waitForSearchSlot, SEARCH_SPACING_MS } from '@/lib/automation';
import { JOB_PRIORITY } from '@/lib/job-priority';

const mocks = vi.hoisted(() => ({
    queueAdd: vi.fn().mockResolvedValue({}),
    queueGetJob: vi.fn().mockResolvedValue(undefined),
}));

// searchAndDownload pulls the queue in via a dynamic import; vi.mock covers that too.
vi.mock('@/lib/queue', () => ({
    omnibusQueue: { add: mocks.queueAdd, getJob: mocks.queueGetJob }
}));

describe('Core Logic: Automation (engine handoff)', () => {

    // #240: BullMQ ignores an add whose job id still exists - and it keeps finished jobs
    // (removeOnComplete: 100). Every search for a request uses the id SEARCH_<requestId>, so a
    // re-search after a failed or refused download was silently dropped while the old one was kept.
    describe('re-searching a request', () => {
        const previousJob = (state: string) => ({ getState: vi.fn().mockResolvedValue(state), remove: vi.fn().mockResolvedValue(undefined) });

        it('clears the request\'s finished search job first, so the new search is actually queued', async () => {
            for (const state of ['completed', 'failed']) {
                const old = previousJob(state);
                mocks.queueGetJob.mockResolvedValueOnce(old);
                await searchAndDownload('req_9', 'Batman', '2024');
                expect(mocks.queueGetJob).toHaveBeenLastCalledWith('SEARCH_req_9');
                expect(old.remove).toHaveBeenCalled();
                expect(old.remove.mock.invocationCallOrder[0]).toBeLessThan(mocks.queueAdd.mock.invocationCallOrder.at(-1)!);
            }
        });

        it('leaves a search that is still pending alone, so a request is never searched twice at once', async () => {
            for (const state of ['waiting', 'delayed', 'active', 'prioritized']) {
                const pending = previousJob(state);
                mocks.queueGetJob.mockResolvedValueOnce(pending);
                await searchAndDownload('req_9', 'Batman', '2024');
                expect(pending.remove).not.toHaveBeenCalled();
            }
        });

        it('still queues the search when the queue cannot be inspected', async () => {
            mocks.queueGetJob.mockRejectedValueOnce(new Error('redis down'));
            await searchAndDownload('req_10', 'Batman', '2024');
            expect(mocks.queueAdd).toHaveBeenLastCalledWith('SEARCH_AND_DOWNLOAD', expect.objectContaining({ requestId: 'req_10' }), expect.objectContaining({ jobId: 'SEARCH_req_10' }));
        });
    });

    describe('searchAndDownload()', () => {
        it('should enqueue a SEARCH_AND_DOWNLOAD job with the full request payload', async () => {
            await searchAndDownload('req_1', 'Batman', '2024', 'DC', false, true);

            expect(mocks.queueAdd).toHaveBeenCalledWith(
                'SEARCH_AND_DOWNLOAD',
                {
                    type: 'SEARCH_AND_DOWNLOAD',
                    requestId: 'req_1',
                    name: 'Batman',
                    year: '2024',
                    publisher: 'DC',
                    isManga: false,
                    skipIndexers: true
                },
                expect.objectContaining({ jobId: 'SEARCH_req_1' })
            );
        });

        // The 5-second gap between searches used to be handed out as a delay when a search was QUEUED.
        // A delay is fixed at `add` time and no priority can overtake it, so one request made after
        // a 300-search monitor run sat out 300 x 5 s = 25 minutes of slots whatever its priority.
        // The gap now lives in the worker (waitForSearchSlot), and the queue decides the order.
        it('queues every search at once and leaves the spacing to the worker', async () => {
            await searchAndDownload('req_a', 'Batman', '2024');
            await searchAndDownload('req_b', 'Superman', '2024');
            await searchAndDownload('req_c', 'Flash', '2024');

            expect(mocks.queueAdd).toHaveBeenCalledTimes(3);
            for (const call of mocks.queueAdd.mock.calls) {
                expect(call[2].delay ?? 0).toBe(0);
            }
        });

        // #240 finding 3 + its follow-up: every search carries a priority, because BullMQ serves the
        // plain wait list before the prioritized set — so the scheduled jobs (no priority) always jump
        // the search backlog. Among searches, the one a person is waiting on goes first.
        it('queues each search with the priority its caller asks for, and the app\'s own searches last', async () => {
            await searchAndDownload('req_one', 'Batman #1', '2024', 'DC', false, false, JOB_PRIORITY.REQUESTED);
            await searchAndDownload('req_run', 'Batman #2', '2024', 'DC', false, false, JOB_PRIORITY.BULK);
            await searchAndDownload('req_mon', 'Batman #3', '2024'); // no tier given: one of the app's own

            const priorityOf = (id: string) => mocks.queueAdd.mock.calls.find(c => c[1].requestId === id)![2].priority;
            expect(priorityOf('req_one')).toBe(JOB_PRIORITY.REQUESTED);
            expect(priorityOf('req_run')).toBe(JOB_PRIORITY.BULK);
            expect(priorityOf('req_mon')).toBe(JOB_PRIORITY.BACKGROUND);

            // A lower number is served first, and any priority at all keeps the scheduled jobs ahead.
            expect(JOB_PRIORITY.REQUESTED).toBeGreaterThan(0);
            expect(JOB_PRIORITY.REQUESTED).toBeLessThan(JOB_PRIORITY.BULK);
            expect(JOB_PRIORITY.BULK).toBeLessThan(JOB_PRIORITY.BACKGROUND);
        });
    });

    describe('waitForSearchSlot()', () => {
        afterEach(() => { vi.useRealTimers(); });

        it('starts searches at least 5 seconds apart, waiting out only what is left of the gap', async () => {
            vi.useFakeTimers();
            vi.advanceTimersByTime(60_000); // any earlier search is long past

            await waitForSearchSlot(); // the first search starts at once

            // That search took 2 s, so the next one waits the remaining 3 s — and not a moment less.
            vi.advanceTimersByTime(2_000);
            let started = false;
            const next = waitForSearchSlot().then(() => { started = true; });
            await vi.advanceTimersByTimeAsync(SEARCH_SPACING_MS - 2_000 - 1);
            expect(started).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await next;
            expect(started).toBe(true);

            // A search that ran longer than the gap lets the next one start straight away.
            vi.advanceTimersByTime(SEARCH_SPACING_MS + 3_000);
            let immediate = false;
            await waitForSearchSlot().then(() => { immediate = true; });
            expect(immediate).toBe(true);
        });
    });

    describe('processAutomationQueue()', () => {
        it('queues a bulk ask at the tier it is given', async () => {
            await processAutomationQueue([
                { id: 'req_1', name: 'Batman #1', year: '2024', publisher: 'DC', isManga: false, skipIndexers: false },
                { id: 'req_2', name: 'Batman #2', year: '2024', publisher: 'DC', isManga: false, skipIndexers: false }
            ], JOB_PRIORITY.BULK);

            expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
            for (const call of mocks.queueAdd.mock.calls) {
                expect(call[2]).toEqual(expect.objectContaining({ priority: JOB_PRIORITY.BULK }));
            }
        });

        it('should enqueue one job per queued automation item', async () => {
            await processAutomationQueue([
                { id: 'req_1', name: 'Batman', year: '2024', publisher: 'DC', isManga: false, skipIndexers: false },
                { id: 'req_2', name: 'Akira', year: '1988', publisher: 'Kodansha', isManga: true, skipIndexers: false }
            ]);

            expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
            expect(mocks.queueAdd).toHaveBeenCalledWith(
                'SEARCH_AND_DOWNLOAD',
                expect.objectContaining({ requestId: 'req_2', name: 'Akira', isManga: true }),
                expect.objectContaining({ jobId: 'SEARCH_req_2' })
            );
        });
    });
});
