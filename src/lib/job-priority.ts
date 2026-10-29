// src/lib/job-priority.ts
// The order work is taken in on the one background worker (queue.ts runs at concurrency 1).
//
// BullMQ serves the plain wait list BEFORE the prioritized set — the worker's `moveToActive` pops
// `wait` first and only then the lowest score from `prioritized` — so a job added WITHOUT a priority
// is taken before any prioritized one (#240 finding 3, PR #249). The scheduled jobs (the per-batch
// watched-folder trigger, the 15-minute sweep, the health check) carry no priority, so they never
// wait behind a backlog of searches.
//
// Among prioritized jobs a LOWER number goes first, and equal numbers are first-in-first-out (the
// score is `priority * 2^32 + a counter`). A delayed job keeps its priority when it is promoted.
export const JOB_PRIORITY = {
    /**
     * Work a person is waiting on right now: a search for an issue someone just requested (or an
     * admin just approved), and the chunks of an admin's page sweep. These alternate with each other.
     */
    REQUESTED: 1,
    /**
     * Searches someone asked for in bulk — a whole series, a reading-list import — and the automatic
     * re-search of a request whose download failed. Ahead of the app's own searches, behind a single ask.
     */
    BULK: 5,
    /**
     * The app's own searches: the Series Monitor's new issues, released upgrades and its re-search of
     * parked requests. A monitor run can queue hundreds; nobody is waiting on any one of them.
     */
    BACKGROUND: 10,
} as const;

export type JobPriority = typeof JOB_PRIORITY[keyof typeof JOB_PRIORITY];
