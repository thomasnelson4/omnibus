# Komga integration — Phase 2 contract (requirement 1: change tracking + debounced, collision-free scan)

Read together with CONTRACT.md (P1 interfaces, conventions, toolchain rules) — everything there still holds.
Phase 1 is committed; its modules (constants, types, client, path-map, libraries, settings, factory,
connection-test, settings-hooks, queue) are real now — read them, reuse them, do not re-implement.
Inventory of call sites: P2-INVENTORY.md (same scratchpad folder).

## changes.ts — HOT PATH
Imports allowed: '@/lib/db', '@/lib/logger', './settings' (getKomgaHotFlags), './path-map'
(normalizeKomgaPath), './constants', '@/lib/library-roots', '@/lib/utils/paths'. NEVER a queue,
bullmq, ioredis, './client', './factory', or anything doing HTTP. Verify with a test that imports the
module graph (e.g. vi.mock('bullmq'/'ioredis', () => { throw }) or inspect imports).
```ts
export interface LibraryChange {
  paths?: (string | null | undefined)[];      // absolute container paths of changed files/folders (old AND new for moves)
  seriesIds?: (string | null | undefined)[];
  issueIds?: (string | null | undefined)[];
  reason: string;                              // short slug, e.g. 'import', 'rename', 'issue-move', 'cbr-sweep'
  source?: 'node' | 'engine';                  // default 'node'
}
export async function recordLibraryChange(change: LibraryChange): Promise<void>;   // never throws, never awaits HTTP
export function mergePendingPaths(existingJson: string | null, add: string[], cap?: number): { json: string | null; overflow: boolean };  // pure; dedupe, cap KOMGA_PENDING_PATH_CAP
export function resolveLibraryForPath(p: string, libraries: { id: string; path: string }[]): string | null;  // pure; longest root that contains p (isPathWithinRoots semantics)
```
Behaviour:
1. `const flags = await getKomgaHotFlags(); if (!flags.enabled || !flags.scanOnChange) return;`
2. Libraries `{id, path}` come from a small cached lookup (add `getLibraryRootEntries()` to
   src/lib/library-roots.ts beside getLibraryRoots, same 30 s TTL + reset hook; extend
   resetLibraryRootsCache to clear it).
3. Each path → `resolveLibraryForPath`. Paths outside every root are dropped (unmatched, staging,
   downloads) — dropping them never triggers the fallback.
   seriesIds → prisma.series.findMany({where:{id:{in}}, select:{id, libraryId, folderPath}}): use libraryId,
   else resolve folderPath. issueIds → prisma.issue.findMany({select:{filePath, series:{select:{libraryId, folderPath}}}}):
   the issue's filePath is added to that library's pending paths.
4. Fallback (PLAN "unresolved"): when seriesIds/issueIds were given and NONE of them resolved to a
   library (rows missing, no libraryId and folderPath outside roots), and no path resolved either,
   mark EVERY Omnibus library dirty without paths. (Record in deviations: PLAN's wording also lists
   `paths`, but out-of-root paths are an explicit skip, so only unresolved IDs trigger the fallback.)
5. Per affected library, one read + one upsert of KomgaSyncState:
   dirtySince = existing.dirtySince ?? now; lastChangeAt = now; pendingPaths/pendingOverflow via
   mergePendingPaths with normalizeKomgaPath'd paths (skip nulls); overflow is sticky until a scan clears it.
6. catch everything → Logger.log(`[Komga] recordLibraryChange failed: …`, 'debug').

## flush.ts
```ts
export interface KomgaSyncStateLike { omnibusLibraryId: string; dirtySince: Date | null; lastChangeAt: Date | null;
  lastScanRequestedAt: Date | null; syncLeaseUntil: Date | null; nextEligibleAt: Date | null; consecutiveFailures: number }
export function isLibraryDue(s: KomgaSyncStateLike, now: Date): boolean;   // PURE — PLAN §6 P2 "Flush" four conditions
export function backoffMs(consecutiveFailures: number): number;            // 1,2,4… min capped at 30 min (failures ≥ 1)
export async function flushDueLibraries(now?: Date, deps?: { enqueue?: (d: KomgaSyncJobData) => Promise<void> }): Promise<number>;
   // no-op unless getKomgaHotFlags().enabled; findMany states with dirtySince != null OR lastChangeAt != null;
   // for each due → enqueueKomgaSync({omnibusLibraryId, reason:'flush'}, {dedupe:true}). Returns count enqueued.
```
Due rule (exact): `(lastChangeAt > lastScanRequestedAt (null ⇒ -∞)  OR  (dirtySince != null AND consecutiveFailures > 0))
AND (nextEligibleAt == null OR now ≥ nextEligibleAt) AND NOT (syncLeaseUntil > now)
AND ((lastChangeAt != null AND now − lastChangeAt ≥ KOMGA_DEBOUNCE_MS) OR (dirtySince != null AND now − dirtySince ≥ KOMGA_MAX_WAIT_MS))`.

## worker.ts
```ts
export function initKomgaWorker(): void;   // idempotent via globalThis guard; called from src/instrumentation.ts right after initWorker()
export async function processKomgaJob(job: { name: string; data: any; id?: string }): Promise<void>;
```
- Worker(KOMGA_QUEUE_NAME, processKomgaJob, {connection (same lazy IORedis as queue.ts — export a getter), concurrency: 1}).
  The worker's own retries are off (jobs are added with attempts 1). Worker errors are logged, never thrown into Next.
- Flush: setInterval(KOMGA_FLUSH_INTERVAL_MS) with an in-process `running` flag (skip a tick while the previous
  flush is still running); guard on globalThis so HMR / double register never creates two intervals.
- Daily KOMGA_RECONCILE as a repeatable job ON THIS QUEUE with job id 'repeat_komga_reconcile' (bullmq 5.76:
  use `queue.upsertJobScheduler('repeat_komga_reconcile', { every: KOMGA_RECONCILE_INTERVAL_MS }, { name: KOMGA_JOB.RECONCILE, data: { reason: 'daily' }, opts: { removeOnComplete: true, removeOnFail: 100 } })`
  if available, else `add(..., { repeat: { every }, jobId })`). Never touch syncSchedules / omnibusQueue.
- Switch: KOMGA_SYNC → runLibrarySync(job.data); KOMGA_RECONCILE → runKomgaReconcile(job.data) (P2 version:
  for every Omnibus library that has ≥1 mapped Komga library, enqueue KOMGA_SYNC {omnibusLibraryId, full:true,
  reason:'reconcile:'+reason} WITHOUT dedupe-skipping a pending flush job (use dedupe id 'komga-sync-'+id as well —
  a waiting sync for that library already covers it); P3 extends it); READLIST_PUSH / READLIST_DELETE → log
  "not implemented until Phase 4" at debug and return (P4 replaces). Unknown names → log + return (never throw
  'Unknown job type' — attempts are 1 anyway).
- Every handler: early return when getKomgaSettings().enabled is false.

## sync.ts — runLibrarySync as an ordered list of step functions
```ts
export type SyncStage = 'start' | 'preIdle' | 'scan' | 'settle' | 'reconcile' | 'verify' | 'readlists' | 'done';
export interface SyncContext { data: KomgaSyncJobData; now: () => Date; db: KomgaSyncDb; client: KomgaClient;
  enqueue: (data: KomgaSyncJobData, delayMs: number) => Promise<void>; settings: KomgaSettings;
  state: KomgaSyncState /* prisma row */; komgaLibs: ResolvedKomgaLibrary[] }
export type StepResult = { next: SyncStage } | { wait: number; stage: SyncStage; patch?: Partial<KomgaSyncJobData> } | { done: true };
export const SYNC_STEPS: { stage: SyncStage; run: (ctx: SyncContext) => Promise<StepResult> }[];  // P3/P4 append/insert
export async function runLibrarySync(data: KomgaSyncJobData, deps?: Partial<Pick<SyncContext, 'now' | 'db' | 'client' | 'enqueue'>>): Promise<StepResult>;
export type KomgaSyncDb = Pick<typeof prisma, 'komgaSyncState' | 'komgaLibrary' | 'library' | 'jobLog'>;  // P3 widens (issue, komgaBookLink, komgaSeriesLink)
```
- Injected deps make it testable with in-memory fakes (no real DB in tests) and the fake Komga.
- A step that must wait returns {wait, stage}; runLibrarySync then calls enqueue({...data, ...patch, stage}, wait)
  — continuation jobs are added WITHOUT the flush dedup id (the active job still holds it) and with a unique jobId.
  Every continuation renews the lease (syncLeaseUntil = now + KOMGA_LEASE_MS).
- Stage 'start' (a): fresh job (data.stage undefined/'start'): if a live lease exists → return done (another
  sync owns the library). Take the lease. Load Komga libs: try refreshKomgaLibraries(client, settings.pathMappings),
  on error fall back to loadCachedKomgaLibraries(); select with komgaLibrariesForOmnibusLibrary. None mapped →
  clear dirty state (dirtySince, pendingPaths, pendingOverflow, retryCount=0), lastError='no Komga library mapped',
  release the lease, done. Komga libs are re-derived from the KomgaLibrary cache in later stages (job data carries
  their ids: add `komgaLibraryIds?: string[]` to KomgaSyncJobData).
- 'preIdle' (b): readTaskQueue(). ok && (countByType.ScanLibrary ?? 0) > 0 && elapsed(preIdleStartedAt) < KOMGA_PRE_IDLE_CAP_MS
  → wait KOMGA_PRE_IDLE_RECHECK_MS. Busy past the cap, or SSE unavailable → proceed to 'scan'. KomgaError
  (unreachable/unauthorized/forbidden/timeout) → the scan-failure path below.
- 'scan' (c): requestTime = now(); metricsBefore = scanMetricsCount() (null ok); deep = data.deep || state.retryCount ≥ 2;
  POST scanLibrary for every mapped Komga library. All 202 → ONE update: lastScanRequestedAt=requestTime,
  pendingPaths=null, pendingOverflow=false, consecutiveFailures=0, nextEligibleAt=null, lastError=null,
  dirtySince = (lastChangeAt ≤ requestTime ? null : dirtySince); snapshot = previous pendingPaths/overflow into job data
  (snapshotPaths, snapshotOverflow, scanRequestedAt, metricsBefore, settleStartedAt) → wait KOMGA_SETTLE_INITIAL_DELAY_MS, stage 'settle'.
  Failure (any library) → do NOT advance lastScanRequestedAt; consecutiveFailures+1; nextEligibleAt=now+backoffMs(n);
  lastError (no secrets); dirtySince = dirtySince ?? now (so the failure clause of the due rule keeps it eligible);
  release lease; JobLog KOMGA_SCAN status FAILED; done.
- 'settle' (d): readTaskQueue(): ok & ScanLibrary absent/0 → settled('sse'); ok & present → elapsed(settleStartedAt) <
  KOMGA_SETTLE_CAP_MS ? wait KOMGA_SETTLE_RECHECK_MS : timeout. SSE unavailable → scanMetricsCount(): both counts known →
  settled('metrics') when count ≥ metricsBefore + number of scanned libraries, else recheck/timeout as above; metrics
  unknown → settled('fixed') once now − scanRequestedAt ≥ KOMGA_SETTLE_FIXED_FALLBACK_MS (else wait the remainder).
  Never wait for AnalyzeBook/RefreshBookMetadata/HashBook. Unreachable during settle → treat as timeout (the scan was
  accepted; do not count a failure). On settle: JobLog KOMGA_SCAN (status COMPLETED, or COMPLETED_WITH_ERRORS on timeout;
  relatedItem = Omnibus library name; durationMs = now − scanRequestedAt; message = JSON-ish summary: komga libraries,
  detection 'sse'|'metrics'|'fixed'|'timeout', deep, snapshot size). Phase 2 then finishes: lastSyncCompletedAt = now
  (P3 moves this into verify), release lease (syncLeaseUntil=null), done. P3 inserts 'reconcile' and 'verify' after
  'settle' (store `settleOutcome` in job data so verify can skip miss-counting on timeout).
- KOMGA_SYNC with data.full=true (reconcile/manual) runs even when not dirty.
- Every step: never hold a Prisma transaction across HTTP. All Logger messages prefixed [Komga]; never log the key.

## Internal route  src/app/api/internal/library-changed/route.ts
POST, `x-internal-secret` checked with secretsMatch(provided, process.env.NEXTAUTH_SECRET) (src/lib/api-auth.ts),
exactly like src/app/api/internal/notify/route.ts. Body `{events:[{reason: string, paths?: string[], seriesIds?: string[], issueIds?: string[]}]}`
validated by hand (array, ≤ 1000 events, strings only, ≤ 5000 paths total; drop invalid entries); for each event
`await recordLibraryChange({...event, source:'engine'})`; respond 202 `{accepted: n}`. 401 bad secret, 400 bad JSON/shape.
Confirm src/middleware.ts lets /api/internal through without a session.

## Global test mocks (PLAN §9)
__tests__/helpers/setup-global.ts: add `recordLibraryChange: vi.fn(async () => {})` to the hoisted spies,
`vi.mock('@/lib/komga/changes', () => ({ recordLibraryChange: spies.recordLibraryChange }))`, export
`recordLibraryChangeMock`. Komga's own tests `vi.unmock('@/lib/komga/changes')`. (P4 adds readlist-trigger the same way.)

## Node call sites
Use P2-INVENTORY.md. Insert `void recordLibraryChange({...})` AFTER the operation succeeded (after the awaited
engine call / fs op / DB update), never inside a Prisma transaction callback, never awaited, import from
'@/lib/komga/changes'. Old AND new paths for moves/renames. Every site gets a short reason slug.

## Engine (omnibus-engine)
- New src/library_events.rs modelled on log_forward.rs: `pub fn init(db: Db)` (spawns the drain task; called in
  run() after connect_with_retry), `pub fn emit(reason: &str, paths: Vec<String>, series_ids: Vec<String>)` (never
  blocks: try_send on a bounded channel or unbounded sender; no-op before init). Drain: wait for the first event, then
  coalesce for ~3 s or until 500 paths; skip HTTP unless komga_enabled == "true" (TTL cache ~60 s over
  `SELECT value FROM "SystemSetting" WHERE key = 'komga_enabled'` using the engine's existing settings-read helper/quoting);
  POST {events:[{reason, paths, seriesIds}]} to ${OMNIBUS_NODE_URL}/api/internal/library-changed with X-Internal-Secret
  (= NEXTAUTH_SECRET, same as notify_node/log_forward), 10 s timeout, 2 retries with short backoff; log on failure (never panic).
  Pure, unit-tested coalescing function; gate tested with an injected value source; HTTP tested with a tokio TcpListener stub.
- Emit leaves exactly per PLAN §6 P2 "Engine emitter" + P2-INVENTORY.md; inject_xml_into_zip → enum {Written, Unchanged}
  (success_count counts both; update callers + tests); resolve_cover identical-bytes skip; ensure_folder_cover only in the
  fs::write Ok branch. Do not emit from run_bulk_rename or write_series_json.
- `cargo clippy --all-targets -- -D warnings` clean, `cargo test` green. Formatting: `rustfmt --edition 2021
  src/library_events.rs` (the new file) is fine; NEVER run `cargo fmt` or rustfmt on main.rs or other existing files
  (rustfmt on main.rs recurses into every module, and the crate is not fmt-clean at baseline) — hand-format your
  edits there in rustfmt style so the diff stays minimal.

## Addenda after Phase 1 + discovery (authoritative where they differ from the sections above)
- Phase 1 helpers to REUSE (src/lib/komga/queue.ts): `getKomgaRedisConnection()`, `KOMGA_BASE_JOB_OPTIONS`,
  `komgaSyncDedupId(id)`, `KOMGA_RECONCILE_DEDUP_ID`, `komgaReadListDedupId(id)`; `enqueueKomgaSync(data, {dedupe:false, delayMs})`
  for continuations. The repeatable reconcile spreads KOMGA_BASE_JOB_OPTIONS.
- `getKomgaHotFlags()` already returns EFFECTIVE flags (scanOnChange=false whenever enabled=false).
- KomgaError has `.detail` (Komga's message / joined violations). `readTaskQueue` → `{ok:false,'timeout'}` also for a
  non-admin key (Komga sends TaskQueueStatus to admins only). `scanMetricsCount()` 0 on 404 is ambiguous (no scan since
  Komga start, or metrics not exposed) — settle must not treat metrics as definitive when the before-count was 0 and
  the after-count stays 0; keep the fixed-delay fallback in that case.
- LIVE (docs/komga-integration/LIVE_VERIFICATION.md, scratchpad LIVE-DELTAS.md): TaskQueueStatus ticks every 10 s
  globally, idle = {count:0,countByType:{}}; fetch resolves only when the first frame/heartbeat is flushed; scans shorter
  than 10 s can finish between ticks, so settle = "a TaskQueueStatus frame received after the scan POST shows no
  ScanLibrary" (never require having seen ScanLibrary). Metric COUNT is global and increments when a task FINISHES.
  Duplicate scan requests (same library+deep) are merged whether the original is running or queued; one serial task
  queue for all libraries.
- Fake Komga extension points (from P1): state.failures[] {method, path|regex, status, body, headers, delayMs, destroy,
  times}, state.onBooksListPage, state.sse {frameStyle, lineEnding, intervalMs, heartbeat, extraEvents, endAfterFrames},
  state.sseConnections, state.scans, requests log; builders makeKomgaLibrary/makeKomgaBook/makeKomgaReadList/makeKomgaUser,
  waitUntil. Extend it (don't fork it) when P2 needs more.
- Out-of-root decision (confirmed): drop paths positively outside every root; the mark-all fallback applies only to
  IDs that cannot be classified (missing series/issue row, or null libraryId with an empty/out-of-root folderPath AND
  no other input resolved). Record as a deviation.
- Folder paths are legitimate in pendingPaths (series delete/relocate, rename engine, match relocate). Phase 3
  verification will treat a path that is (or was) a directory as a prefix — Phase 2 just stores them.
- Partial failures at call sites: when a route moves/deletes several files in a loop and a later step can throw,
  accumulate the changed paths in a variable declared before the try and emit in a `finally` (or in both the success
  path and the catch) so already-changed files are still recorded. Keep it simple; do not restructure handlers.
- `__tests__/api/rename.test.ts:97` asserts seriesFindMany is never called — prefer collecting old paths without a new
  query; if a query is unavoidable, update that assertion with a comment explaining why.
- settings-hooks.ts (P2 pipeline slice may edit it): on a komga_url / komga_api_key / komga_path_mappings change, also
  reset KomgaSyncState backoff (consecutiveFailures=0, nextEligibleAt=null, lastError=null) so a fixed connection syncs
  promptly.
