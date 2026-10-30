// src/lib/automation.ts
// The live search path is the Rust engine: searchAndDownload() enqueues a BullMQ
// SEARCH_AND_DOWNLOAD job, and queue.ts forwards it to the engine's /api/automation/search.
// The legacy full-Node search (executeSearchAndDownload) was removed as dead code.
import { JOB_PRIORITY, type JobPriority } from '@/lib/job-priority';

// Searches START at least this far apart, so the providers (GetComics, the indexers) never see a
// burst. The gap is kept by the worker as each search starts (waitForSearchSlot), not handed out as
// a delay when the search is queued: a delay is fixed at `add` time and no priority can overtake it,
// so a request made just after a 300-search monitor run used to sit out 300 x 5 s = 25 minutes of
// slots whatever its priority. Queued at once, the searches are ordered by priority alone.
export const SEARCH_SPACING_MS = 5000;

// Only the queue's single worker calls waitForSearchSlot, so this lives in the worker's process.
let lastSearchStartedAt = 0;

/** Waits until SEARCH_SPACING_MS has passed since the previous search started, then claims the slot. */
export async function waitForSearchSlot(): Promise<void> {
  const wait = lastSearchStartedAt + SEARCH_SPACING_MS - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastSearchStartedAt = Date.now();
}

// Every search carries a priority (see job-priority.ts): the scheduled jobs carry none, so BullMQ
// serves them ahead of any search backlog (#240 finding 3), and among searches the one a person is
// waiting on goes first. A caller that names no tier is one of the app's own searches.
//
// Consequence to keep in mind: a queued search sits in the `prioritized` state, so anything that
// looks it up by state has to ask for it — the cancel and retry routes do (see `getJobs` there).
export async function searchAndDownload(requestId: string, name: string, year: string, publisher?: string, isManga: boolean = false, skipIndexers: boolean = false, priority: JobPriority = JOB_PRIORITY.BACKGROUND) {
  const { omnibusQueue } = await import('@/lib/queue');
  const jobId = `SEARCH_${requestId}`;
  // #240: BullMQ ignores an add whose job id still exists - including a FINISHED job it keeps
  // (removeOnComplete: 100) - so a re-search after a failed or refused download (cron re-queue,
  // importer refusal, the retry route) was silently dropped. Clear a finished one first; a search
  // that is still pending keeps the id, so the same request is never searched twice at once.
  try {
    const previous = await omnibusQueue.getJob(jobId);
    if (previous) {
      const state = await previous.getState();
      if (state === 'completed' || state === 'failed') await previous.remove();
    }
  } catch { /* can't inspect the queue: add anyway */ }
  await omnibusQueue.add('SEARCH_AND_DOWNLOAD', {
    type: 'SEARCH_AND_DOWNLOAD',
    requestId, name, year, publisher, isManga, skipIndexers
  }, {
    jobId,
    priority
  });
}

/** Queues the searches of one bulk ask (a whole series, a reading-list import) at one tier. */
export async function processAutomationQueue(items: any[], priority: JobPriority = JOB_PRIORITY.BULK) {
  for (const item of items) {
    await searchAndDownload(item.id, item.name, item.year, item.publisher, item.isManga, item.skipIndexers, priority);
  }
}
