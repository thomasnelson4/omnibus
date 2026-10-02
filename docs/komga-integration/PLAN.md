# Komga integration — implementation plan (v2)

- Status: approved for implementation on 2026-10-02.
- Branch: `komga-integration`. Worktree: `/Users/thomas/orca/workspaces/omnibus/komga-integration`.
- Base: `main@2ce1fb6`.
- Komga reference source (read-only): Komga 1.28.1 at `/Users/thomas/repos/sbx/omnibus-references/komga`.
  Its OpenAPI spec is `docs/openapi.json`.
- Research notes: `docs/komga-integration/research/*.md`. These notes are excluded from git, so do
  not commit them. Their line numbers are from `2ce1fb6` and are hints only. Verify everything in
  the current code.
- An adversarial review of v1 (three critics against the source) produced this v2. Where this plan
  and the code disagree, the code wins. Record each deviation in §15.

## 1. Goal

1. **Scan trigger (required, ships first).** When Omnibus finishes an operation that changes comic
   files on disk, it asks Komga to scan the affected library.
   - Requests are debounced.
   - The scan never collides with a scan that is already running.
   - Omnibus then verifies that Komga saw the change, retries when it did not, and keeps the request
     pending while Komga is down.
2. **Reading-list push (required).** Omnibus pushes the reading lists an admin opts in to Komga.
   - Each pushed list contains only issues that exist as books in Komga, in Omnibus order.
   - Omnibus re-pushes a list when more of its issues reach Komga.
   - Omnibus corrects drift that Komga introduces on its side.
3. **Identity map (enabler).** Omnibus keeps a reconciled ledger of Omnibus Issue/Series ↔ Komga
   Book/Series IDs. Later work can build on it: read-progress sync and "Open in Komga" links.

## 2. Facts that shape the design (verified in source)

**What Komga reads from disk**
- Komga reads only these files:
  - the `ComicInfo.xml` inside each archive:
    - `<Web>` is split on single spaces and becomes `metadata.links` (label = host)
    - `<GTIN>` becomes isbn, and `<Tags>` and `<Number>` are also read
    - `<StoryArc>` and `<AlternateSeries>` create **add-only, find-by-name** read lists
      (`importComicInfoReadList`, default **true**)
  - Mylar `series.json` (Komga parses `comicid` and then discards it)
  - local artwork
- Komga ignores unknown tags, so Omnibus's `ComicVineIssueId`/`MetronId` tags have no effect in Komga.
- Komga indexes only these file types:
  - `cbz` and `zip`
  - `cbr` and `rar`, when `scanCbx` is on
  - `pdf` (`scanPdf`) and `epub` (`scanEpub`)
- **It never indexes `.cb7`.** It skips names that start with `.` and folders listed in
  `scanDirectoryExclusions`.

**Book identity**
- **A book's identity is its file URL.** An in-place rewrite at the same path keeps the ID.
  - Omnibus writes every file as temp + rename in the same folder: the ComicInfo embed, page edits,
    and conversions. That changes the folder mtime, so a **non-deep** scan re-examines the folder.
    The book is matched by URL (the ID is kept) and marked OUTDATED when `fileLastModified` differs.
  - A rename, a move, or CBR→CBZ conversion produces a **new book ID**.
    - The old book is soft-deleted, and soft-deleted books stay in read lists until a hard delete.
    - If an already-hashed, soft-deleted book of the same size has the same XXH3-128 hash,
      `tryRestoreBooks` keeps the **new** ID. It moves read-list membership, progress and metadata to
      that ID and **hard-deletes the old book**. A cached old ID then becomes unknown.

**Scans**
- Scans are library-wide: `POST /api/v1/libraries/{id}/scan?deep=false` returns `202` and is queued
  synchronously before the response.
- The task uniqueId is `SCAN_LIBRARY_{id}_DEEP_{deep}`. A request with the same uniqueId as a
  **running** scan is merged into it and **dropped** after the run. A `deep=true` request is not
  absorbed by a running non-deep scan.
- Komga sends no "scan finished" event. The admin-only SSE stream `GET /sse/v1/events` emits
  `TaskQueueStatus {count, countByType}` **every 10 s while a client is connected**.
  - `countByType` is **global across libraries**. Its keys are Task simple names: `ScanLibrary`,
    `AnalyzeBook`, `RefreshBookMetadata`, `RefreshSeriesMetadata`, `AggregateSeriesMetadata`,
    `HashBook` (lowest priority), `HashBookPages`, `GenerateBookThumbnail`, `EmptyTrash`,
    `ConvertBook`, `RepairExtension`.
  - Spring writes frames as `event:Name` / `data:{json}` with no space after the colon. A
    heartbeat comment exists only from Komga 1.24.0.
  - Follow-up tasks are queued **before** the ScanLibrary row is deleted, so there is no false-idle
    gap.
  - Fallback signal: `GET /actuator/metrics/komga.tasks.execution?tag=type:ScanLibrary`, a
    cumulative COUNT (404 means 0).

**Listing books**
- Komga has no lookup by path. Page `POST /api/v1/books/list` with this body:
  `{"condition":{"allOf":[{"libraryId":{"operator":"is","value":"<id>"}},{"deleted":{"operator":"isFalse"}}]}}`
  - Paging is by offset. The page-size cap is 2000 and is silently clamped. Sort by `url`.
  - `BookDto` exposes `url` (a full path **only for ADMIN**, otherwise the filename),
    `metadata.links[{label,url}]`, `fileLastModified` (UTC, whole seconds), `sizeBytes` and `deleted`.

**Read lists**
- Read lists are global. They have no owner, and their names are unique case-insensitively.
- `POST /api/v1/readlists {name, summary, ordered, bookIds}` returns 200 with a `ReadListDto`.
- `PATCH /api/v1/readlists/{id}` (204) with `bookIds` **fully replaces** membership.
- These requests fail:
  - `bookIds` empty or with duplicates → 400
  - a duplicate name → 400 with the message `Read list name already exists`
  - an unknown book ID → FK violation, which should return **500 and roll back** (inferred, so
    confirm it live)
- Soft-deleted books pass the FK check.
- `GET /api/v1/readlists?search=` is a **Lucene** query that breaks on `:` `-` `()`. Never use it.
  Use `?unpaged=true` and filter on the client.
- Komga deletes empty read lists through the server setting `delete-empty-read-lists` (default true),
  only at the end of a scan or an empty-trash.

**Authentication**
- `X-API-Key` (Komga ≥ 1.20.0) works on `/api/**`, `/sse/**` and actuator. `/actuator/health` is
  anonymous. `/actuator/info` (which has `build.version`) requires ADMIN.
- Every endpoint we need requires **ADMIN**. Content restrictions (`ageRestriction`, `labelsAllow`,
  `labelsExclude`) **also filter admins**. `sharedAllLibraries` is irrelevant for admins.
- Known Komga bugs:
  - 1.23.2 broke read-list creation; it is fixed in 1.23.3.
  - An API key sent together with a session returned empty content until 1.23.5.
- Komga library options that rewrite Omnibus files: `convertToCbz` and `repairExtensions`. These
  break path identity.

**Omnibus side**
- Omnibus has no "library changed" hook. Node file operations finish inline.
- Detached engine jobs report completion only through `JobLog`. Those jobs are watched-folder sync
  (where batch downloads land), ComicInfo embed, CBR sweep, repack and metadata sync.
- `SystemNotifier`/`comic_available` is a user-notification channel that is held back and filtered,
  so it is not a usable trigger.
- Reading lists contain placeholders: `issueId = null` with `cvIssueId` + `metadataSource`.
  - Placeholders are linked **only lazily** in `GET /api/reading-lists`.
  - Linked issues can be `WANTED` skeletons with `filePath = NULL`.
- `Issue.id` is stable across every path change. The engine rewrites `Issue.filePath` with raw SQL
  that does **not** bump `updatedAt`.

## 3. The "shared ID file" question

The idea was a file that both systems read so that series and issue IDs stay in sync. **Komga cannot
consume such a file** without a fork: it reads no custom sidecar and never writes IDs back to disk.
The idea still holds if the comic files themselves are the shared medium:

- **Primary shared key: the file path.** Both systems index the same files. Omnibus maps its container
  path to Komga's with a prefix map and joins `Issue.filePath` ↔ `BookDto.url`. Omnibus is the only
  party that changes these paths, so it knows when Komga IDs will churn and can re-link right away.
- **Secondary shared key: the provider URL Omnibus already embeds.** The ComicVine `4000-{id}` or
  Metron `metron.cloud/issue/{id}` issue URL goes in `<Web>` and comes back from Komga as
  `metadata.links`. Use issue-level URLs only.
- **The ledger lives in Omnibus's DB** (`KomgaBookLink`, `KomgaSeriesLink`) and is rebuilt from
  Komga's API. An admin endpoint exports it as JSON, which is the "ID map file" for inspection. Only
  Omnibus writes it, and nothing depends on reading it back.
- **Rejected: embedding Omnibus IDs in `<Web>`.** There are three reasons:
  - Engine IDs are UUIDv4. They collide with `watched_sync`'s host-agnostic `/issue/(\d+)` and
    `/series/(\d+)` regexes, and they do not survive a DB rebuild.
  - It forces a full-library re-embed plus a full Komga re-analysis.
  - The path already gives the same join for free.

## 4. Architecture

```
Node file ops ──┐                                    (DB-only hot path: no HTTP, no Redis import)
Engine detached ─┴─▶ recordLibraryChange({paths?, seriesIds?, reason, source})
  writers via POST /api/internal/library-changed      → KomgaSyncState per *Omnibus* Library.id
                                                         (dirtySince, lastChangeAt, pendingPaths≤200)
Komga flush interval (30 s, initKomgaWorker) ── due? (quiet 60 s | max-wait 600 s, backoff, no lease)
        ▼ enqueue KOMGA_SYNC(omnibusLibraryId) on queue "omnibus-komga" (dedup per library)
runLibrarySync(omnibusLibraryId) = ordered steps, each short (≤ ~30 s), re-enqueueing itself to wait:
  P2 a. resolve the mapped Komga libraries (KomgaLibrary cache table; refresh from the API when possible)
  P2 b. pre-idle: no ScanLibrary in TaskQueueStatus (re-enqueue +30 s while busy; cap 10 min)
  P2 c. POST /scan for each mapped Komga library; on 202 commit lastScanRequestedAt and snapshot+clear pendingPaths
  P2 d. settle: wait until ScanLibrary is gone (re-enqueue +20 s; cap 15 min; metrics/fixed-delay fallback)
  P3 e. reconcile the identity map for those Komga libraries (safety valve)
  P3 f. verify the snapshot paths against Komga; on a miss → re-dirty (retry ≤2, 2nd retry deep=true)
  P4 g. read lists: drift check (one GET ?unpaged=true) + re-push lists whose resolution changed
Read-list mutations ─▶ KOMGA_READLIST_PUSH(listId)   (BullMQ dedup debounce 10 s)
Settings change / first enable / daily repeatable ─▶ KOMGA_RECONCILE = full sync of every mapped library + orphan sweep
```

- **Node owns** the Komga client, settings, queue, reconcile and push. **The engine** only emits
  coalesced "files changed" events. Rust gets no Komga client.
- Phase 2 ships steps a–d, which are requirement 1 and are independently testable. Phase 3 adds e–f.
  Phase 4 adds g and the push. Implement `runLibrarySync` as an ordered list of step functions so
  that each phase appends to it.

## 5. Configuration

Use `SystemSetting` string keys for a single Komga server. Only these are visible in the UI:

| Key | Default | Notes |
| --- | --- | --- |
| `komga_enabled` | `false` | Master switch. When it is off, every hook is a cheap no-op, including the engine's HTTP emits. |
| `komga_url` | — | Base URL, which may include a sub-path (`http://host/komga`). Build URLs as `${base.replace(/\/+$/,'')}${path}`, never with `new URL(path, base)`. Do **not** apply `assertSafeFetchUrl`, because Komga is on the LAN. Apply the global custom headers the same way Prowlarr does. |
| `komga_api_key` | — | **Secret.** Add it to `SECRET_SETTING_KEYS` (`src/lib/secret-keys.ts`) **and** `SENSITIVE_KEYS` (`src/app/api/admin/config/route.ts`). |
| `komga_path_mappings` | `[]` | A JSON string `[{"omnibus":"/data/comics","komga":"/comics"}]`. Empty means identity. Use a dedicated key, because the global `remote_path_mapping(s)` keys are broken today (§13). |
| `komga_scan_on_change` | `true` | Requirement 1. |
| `komga_readlists_enabled` | `false` | Requirement 2. Refuse to enable it when the Komga version is < 1.23.3. |
| `komga_instance_id` | auto UUID | Generated on first enable. Used in the read-list ownership marker. Not shown in the UI. |

Constants in `src/lib/komga/constants.ts`, not settings:
- debounce 60 s, max-wait 600 s
- flush interval 30 s
- pre-idle cap 10 min, settle cap 15 min
- deep scan off (on only for the second retry)
- delete remote lists on delete or un-sync: on
- reconcile every 24 h
- path cap 200 per library
- HTTP timeouts: 10 s for small calls, 60 s per books page

## 6. Phases

Each phase ends green on all gates in §11. Commit locally at the end of each phase, with commit
messages that end in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **Never push.
Never touch `main`** or any other worktree.

### Phase 0 — Workspace setup and baselines
- `export PATH=/opt/homebrew/opt/node@22/bin:$HOME/.cargo/bin:$PATH`. Node 26 breaks jsdom
  localStorage.
- `npm ci`. Add `--legacy-peer-deps` only if a plain `npm ci` fails. Then `npx prisma generate`.
- If `next build` needs env vars, copy `/Users/thomas/repos/sbx/omnibus/.env` into the worktree.
  It is gitignored by `.env*`, so never commit it and never print its values.
- Record these baselines before any change:
  - `npx vitest run --pool=forks`. Main had 1085 tests at `2ce1fb6`; re-measure.
  - In `omnibus-engine/`: `cargo test` (main had 292) and
    `cargo clippy --all-targets -- -D warnings`.
  - `npx tsc --noEmit` and `npm run lint`. Note any failures that already exist at baseline.
- Run `npx prisma generate` again after **every** `schema.prisma` edit.

### Phase 1 — Komga client, settings, connection test, library discovery
- `src/lib/komga/client.ts`: a typed, minimal client.
  - Write the types by hand and check them against `docs/openapi.json`. Add no codegen dependency.
  - It uses `fetch` with `AbortSignal.timeout` and `X-API-Key`.
  - Errors are a `KomgaError {status, kind: unreachable|unauthorized|forbidden|notFound|badRequest|server|timeout, message}`.
  - Methods:
    - `health()` (anonymous)
    - `getMe()`: roles, `ageRestriction`, `labelsAllow`, `labelsExclude`, `sharedAllLibraries`
    - `getInfo()`: `build.version`
    - `listLibraries()`, including:
      - `root`, `hashFiles`, `importComicInfoBook`, `importComicInfoReadList`
      - `emptyTrashAfterScan`, `scanForceModifiedTime`
      - `convertToCbz`, `repairExtensions`
      - `scanCbx`, `scanPdf`, `scanEpub`, `scanDirectoryExclusions`
      - `oneshotsDirectory`, `unavailable`
    - `scanLibrary(id, deep)`
    - `listBooks(libraryId)`: an async iterator. Paginate with the `last`/`totalPages` fields. If
      `totalElements` changes between the first and the last page, restart once, then accept the
      result.
    - `getBook(id)`
    - `listReadLists()` (`?unpaged=true`), `createReadList`, `updateReadList`, `deleteReadList`
    - `readTaskQueue({timeoutMs})`: a short-lived SSE read that returns the first `TaskQueueStatus`.
      It parses both `data:` and `data: `. It reports "SSE unavailable" if no frame arrives within
      25 s, and it always aborts the connection.
    - `scanMetricsCount()`: the fallback signal
- `src/lib/komga/path-map.ts`: bidirectional prefix mapping.
  - Try the longest prefix first and match only at folder boundaries.
  - Normalize: `\`→`/`, trim trailing slashes, Unicode NFC, reject `..`.
  - Comparisons are case-sensitive.
  - Reference: Shelfmark `path_mappings.py`.
  - Also provide `isKomgaScannable(path, komgaLibrary)`, which checks the extension against
    `scanCbx`/`scanPdf`/`scanEpub`, hidden path segments, and `scanDirectoryExclusions`.
- Prisma `KomgaLibrary` cache table (§7). It is refreshed whenever `listLibraries` succeeds (test,
  sync, reconcile). For each Komga library it stores the translated root and the resolved
  `omnibusLibraryId`. A Komga library maps to an Omnibus `Library` when their roots, after
  translation, are equal or one contains the other. Any in-memory cache must live on `globalThis`
  (repo convention: route bundles and the instrumentation bundle do not share module state), or be
  read from the DB.
- **Connection test** (`testKomgaConnection(url, key)`, reusable, modelled on `annas-test.ts`):
  1. `health()` → is Komga reachable?
  2. `getMe()` → a 401 means "invalid key or Komga < 1.20.0". **Fail** unless the roles include
     ADMIN and the user has no content restrictions. Show `sharedAllLibraries` for information only.
  3. `getInfo()` → the version. **Fail** below 1.20.0. Warn below 1.23.5.
  4. `listLibraries()` → for each library, the mapping status and these warnings:
     - `hashFiles=false`
     - `importComicInfoBook=false`
     - `importComicInfoReadList=true` (StoryArc lists may collide with or drift pushed lists)
     - `emptyTrashAfterScan=true`
     - **strong** warnings for `convertToCbz=true` and `repairExtensions=true`
     - `scanCbx=false`
     - `unavailable=true`
     - exclusions that overlap mapped paths
     - Komga libraries with no Omnibus mapping, and Omnibus libraries with no Komga library
     - `.cb7` files present in mapped Omnibus libraries (a cheap DB query on `filePath`)
  5. Omnibus **never** changes Komga library settings.
- Routes:
  - `/api/admin/test` gets a `komga` branch that returns `{success, message}`.
  - New `POST /api/admin/komga/libraries`, modelled on the prowlarr/indexers route.
    - It accepts **unsaved** `url`/`key`, and resolves `'********'` through the stored, decrypted
      key.
    - It returns `{libraries:[{id,name,root,translatedRoot,omnibusLibrary,warnings[]}], warnings[], version}`
      for the detected-libraries table.
  - Both routes do the inline ADMIN session check.
- **Save-time gate:** applies only on the `komga_enabled` false→true transition. Mirror the Anna's
  Archive gate in `config/route.ts` and run it before the secret-encryption loop. On failure, refuse
  the transition and add a warning.
- **On settings change** (config POST, after save):
  - If `komga_enabled` went false→true, or `komga_url`, `komga_api_key` or `komga_path_mappings`
    changed while enabled, enqueue `KOMGA_RECONCILE`.
  - If `komga_url` changed, first delete every `KomgaBookLink` and `KomgaSeriesLink` row and the
    `KomgaLibrary` cache, and set `KomgaReadListLink.komgaReadListId = null`. Adoption by marker
    recovers the lists.
  - Generate `komga_instance_id` if it is missing.
- **Settings UI:** add a new **"Media Servers"** tab with a Komga card.
  - The card contains the §5 fields, a path-mapping table editor, a "Test connection" button
    (unsaved values), and a detected-libraries table backed by the libraries route.
  - Update `tabs/dirty.ts` (`SETTINGS_TABS`, `TAB_CONFIG_KEYS`), `page.tsx` (`TabsContent`, defaults,
    `testResults`), and the settings tests. `settings-tabs-list.test.tsx` checks labels by role, so
    only its "8 tabs" wording, the test title and the `tabs-list.tsx` comments need updating. The
    `mkBag` in `settings-tabs.test.tsx` must include the new keys.

### Phase 2 — Change tracking and the debounced, collision-free scan trigger (requirement 1)
- `src/lib/komga/changes.ts`: `recordLibraryChange({paths?, seriesIds?, issueIds?, reason, source})`.
  - **Hot path rules:**
    - It may import only `db`, `logger` and settings or library-root helpers. It must **never**
      import a queue module and **never** make an HTTP call.
    - Callers use `void recordLibraryChange(…)`. The function catches everything, logs `[Komga]` at
      debug level, and returns immediately when `komga_enabled` or `komga_scan_on_change` is off.
      Read those settings through a cheap cached lookup on `globalThis` with a short TTL.
  - **Resolution:** it resolves each path, or the series `folderPath` / `libraryId` when only IDs
    are given, to an **Omnibus** `Library.id` with `getLibraryRoots()` and `isPathWithinRoots`.
    Paths outside every library root are skipped (`/unmatched`, staging, downloads). If nothing
    resolves but `paths`/`seriesIds` were given, it marks every Omnibus library dirty without paths.
  - **The write:** one upsert of `KomgaSyncState` per affected Omnibus library per call:
    - `dirtySince = coalesce(dirtySince, now)`
    - `lastChangeAt = now`
    - merge the normalized paths into `pendingPaths`, a JSON string array that is de-duplicated and
      capped at 200; past the cap, set `pendingOverflow = true`
    - Read-modify-write races may lose a path. That is acceptable, because verification is
      defense in depth.
- **Flush:**
  - `initKomgaWorker()` is started from `src/instrumentation.ts` after `initWorker()`. It runs a
    30 s `setInterval` with a `globalThis` guard and an in-process "running" flag. The flush is
    independent of the download-checker cron, which can stay busy during imports.
  - A library is due when all of these hold:
    - `(lastChangeAt > lastScanRequestedAt OR (dirtySince != null AND consecutiveFailures > 0))`
    - `now >= nextEligibleAt`
    - no live lease (`syncLeaseUntil > now`)
    - `(now − lastChangeAt ≥ 60 s OR now − dirtySince ≥ 600 s)`
  - The flush enqueues `KOMGA_SYNC {omnibusLibraryId}` with `deduplication: {id: 'komga-sync-'+id}`.
  - Write the due test as a **pure function** and unit-test it.
- **Queue:** a new `omnibus-komga` queue with its own Worker, concurrency 1 and `attempts: 1`. The
  pipeline has its own retry semantics.
  - Job types: `KOMGA_SYNC`, `KOMGA_RECONCILE`, `KOMGA_READLIST_PUSH`, `KOMGA_READLIST_DELETE`.
  - Register the daily `KOMGA_RECONCILE` as a repeatable job on this queue
    (`jobId: 'repeat_komga_reconcile'`) inside `initKomgaWorker`. Do **not** register it in
    `syncSchedules`, which manages only `omnibusQueue`.
  - Use `removeOnComplete: true` for these job types, so that a fixed `jobId` never silently
    deduplicates later jobs.
- **`runLibrarySync(omnibusLibraryId, state)`.** Each step is short. A step that must wait
  re-enqueues the job with `delay` and a `stage` field instead of blocking the worker.
  - **a.** Take a lease (`syncLeaseUntil = now + 30 min`). Load the mapped Komga libraries from
    `KomgaLibrary`, refreshing from the API when reachable. If none are mapped, clear the dirty state
    and write `lastError = 'no Komga library mapped'`.
  - **b. Pre-idle.** Call `readTaskQueue`. If `countByType.ScanLibrary > 0`, re-enqueue with a
    +30 s delay. After the 10-minute cap, proceed anyway. This avoids Komga's merge-and-drop.
  - **c. Scan.** Record `requestTime` in memory and POST a scan for each mapped Komga library. Use
    `deep=true` only when `retryCount ≥ 2`.
    - When every scan returns 202: set `lastScanRequestedAt = requestTime`, move `pendingPaths` into
      the job data as the verification snapshot, clear `pendingPaths`/`pendingOverflow`, set
      `consecutiveFailures = 0`, and clear `dirtySince` if `lastChangeAt ≤ requestTime`.
    - On failure: **do not** advance `lastScanRequestedAt`. Increment `consecutiveFailures`, set
      `nextEligibleAt` with exponential back-off (1, 2, 4 … capped at 30 min), set `lastError`,
      release the lease, and stop.
  - **d. Settle.**
    - Re-enqueue with a +15 s delay, then `readTaskQueue` until `ScanLibrary` is absent. Each
      re-enqueue adds +20 s. Cap the wait at 15 minutes.
    - If SSE is unavailable, use `scanMetricsCount()`: wait until the count exceeds the value taken
      before the scan. If metrics are unavailable too, wait a fixed 90 s.
    - Do **not** wait for `AnalyzeBook`/`RefreshBookMetadata`/`HashBook`, because those backlogs can
      run for hours.
    - If the settle step times out, do not count it as a verification miss.
    - Write a `JobLog` row `KOMGA_SCAN` with the library, duration, how the settle was detected, and
      the outcome. Release the lease.
- **Node call sites.** Verify each one in the current code. The line numbers are hints.
  - importer single-file success (~`importer.ts:1094`; the batch-to-watched return is the engine's
    job)
  - **importer series-folder standardization**, which moves an existing folder and can move it to
    another library (~`importer.ts:676-682`). Record both the old and the new folder.
  - `/api/library/rename` (engine and local-fallback paths)
  - issue move, issue link, issue delete
  - both series-delete routes, when files are deleted
  - `match-series` single and bulk (relocate and renames)
  - series metadata update (`safeRelocateFolder`)
  - `match-collision.ts` `attachAsCollected` (also reached from series attachments)
  - series cover upload **and its DELETE handler**
  - the cores of page removal and insert-cover (`remove-pages-core.ts`, `insert-cover-core.ts`).
    These emit once per file. The page sweep reaches them per file, and the debounce absorbs that.
    There is no "once at finalize" rule.
  - diagnostics delete-duplicates and delete-orphans
  - Also: Node emits after **awaited synchronous engine calls** (rename, convert-file, remove-pages,
    insert-cover).
  - Then grep `src/` for `fs.rename|fs.move|fs.unlink|fs.rm|writeFile|copyFile|engineFetch` and the
    engine endpoints that mutate files. List every site, wired or deliberately skipped (with the
    reason), in the report.
- **Engine emitter** (`omnibus-engine/src/library_events.rs`), modelled on `log_forward.rs`
  (`OnceLock` mpsc sender plus a drain task):
  - `emit(reason, paths, series_ids)` never blocks. The drain task coalesces events for about 3 s or
    up to 500 paths and POSTs `{events:[…]}` to `${OMNIBUS_NODE_URL}/api/internal/library-changed`
    with `X-Internal-Secret` (= `NEXTAUTH_SECRET`), a 10 s timeout and 2 retries. It logs on
    failure.
  - It skips the HTTP call when `komga_enabled` is not `'true'`: a small TTL cache (~60 s) over
    `SELECT value FROM "SystemSetting"`, using the `Db` handle passed into the drain task (available
    in `run()` after `connect_with_retry`).
  - **Emit only from code that detached jobs reach:**
    - `watched_sync::process_watched_folder`: destination paths, only when imported > 0
    - `metadata_writer::process_embed_job`: only for files that actually changed. Make
      `inject_xml_into_zip` return `enum {Written, Unchanged}` (or `Result<…>`). `success_count`
      still counts both, and its callers and tests are updated.
    - `converter::process_cbr_sweep` / `process_archive`
    - the `handle_repack` loop
    - the scanner cover backfill: `ensure_folder_cover`, **only in the `fs::write` Ok branch**
    - `metadata.rs` `resolve_cover`: add a byte-compare skip (identical bytes → no write, no emit)
      and emit only on a real write
    - The deferred 30-minute `sync_metadata` retries and the sync spawned by watched-sync reach these
      leaves, so they are covered.
  - Do not emit from `run_bulk_rename`; Node already emits after its awaited call.
  - Do not emit from `write_series_json`. It rewrites in place without changing the folder mtime, it
    is always called next to an embed, and it is out of scope.
- **Node route** `src/app/api/internal/library-changed/route.ts`:
  - Check `secretsMatch` on `x-internal-secret`. The middleware already allows `/api/internal`.
  - Validate the body by hand; the repo has no zod.
  - Call `recordLibraryChange` for each event and return 202.

### Phase 3 — Identity map and post-scan verification
- **Reconcile** for one Komga library (step e, and `KOMGA_RECONCILE`):
  1. Page **all** non-deleted books into memory with no DB transaction open. Build a map from
     normalized `url` to the book.
  2. Select the Omnibus issues whose `filePath` lies under the Omnibus prefix that maps to this
     library.
  3. **PATH match:** `normalize(mapToKomga(issue.filePath))` must equal `book.url`.
  4. **LINK match** among the issues and books that are still unmatched (a book that is already
     PATH-matched is never a candidate):
     - Parse issue-level `4000-(\d+)` / `metron.cloud/issue/(\d+)` from `metadata.links`.
     - Compare against `Issue.metadataSource`/`metadataId`.
     - The match must be unique on both sides.
     - Never use `unmatched_*` or `LOCAL` IDs.
  5. **Safety valve.** Abort link deletions for this library, keep the existing links, set
     `lastError`, and raise a health warning when any of these holds:
     - the listing has 0 books while links exist
     - more than `max(20, 25 %)` of the library's links would be removed in one pass
     - any `url` is not absolute or is not under `LibraryDto.root`
     - `unavailable=true`
  6. **Stale links.** Remove a link only after it misses in **two consecutive** reconciles
     (`missCount` column), or after `getBook` returns 404 or `deleted=true`. Remove links whose
     issue no longer has a `filePath` immediately.
  7. **Writes.** Compute the diff in memory. Write only the changed rows, as array-form
     `$transaction` chunks of about 500. **Never await HTTP inside a transaction**: Node's SQLite runs
     with `connection_limit=1`, and issue #195 is the precedent.
  8. `KomgaSeriesLink` = the majority `komgaSeriesId` among a series' linked books.
  9. Write a `JobLog` row `KOMGA_RECONCILE` with these counts: path, link, unmatched Omnibus
     issues, Komga books not in Omnibus, removed links, and valve trips.
- **Link validity** (no timestamps needed): a link is valid when
  `link.omnibusPath === issue.filePath` (normalized). Otherwise the issue is "awaiting Komga scan".
- **Verification** (step f), against the snapshot taken in step c. For each path:
  - If the file exists and `isKomgaScannable`: Komga must have a non-deleted book at the mapped path
    with `fileLastModified ≥ floor(mtime) − 2 s`. That also covers in-place rewrites.
  - If the file no longer exists: no non-deleted Komga book may exist at that path.
  - If the snapshot overflowed: instead stat up to 500 Omnibus issues under the library that have no
    Komga book and a scannable extension. Any with `mtime ≥ lastScanRequestedAt − 120 s` is a miss.
  - **On a miss:** set `lastChangeAt = now`, put the missed paths back into `pendingPaths`, and
    increment `retryCount`. The second retry scans with `deep=true`.
  - After 2 retries: write a `JobLog` warning listing up to 20 missed paths, set `retryCount = 0`,
    and drop the paths.
  - **On success:** set `retryCount = 0` and `lastSyncCompletedAt = now`.
- **`KOMGA_RECONCILE`:**
  - Runs on the daily repeatable job, after a settings change, from the manual trigger, and when
    `komgaSync` is turned on while `lastReconciledAt` is null.
  - It runs the **full** sync for every mapped Omnibus library (pre-idle → scan → settle → reconcile
    → verify → read lists), so it is a real backstop for lost engine callbacks, and then the orphan
    sweep (Phase 4).
- **`GET /api/admin/komga/id-map`** (ADMIN): downloads
  `{generatedAt, komga:{url,version}, libraries, series:[{seriesId,komgaSeriesId}], books:[{issueId,komgaBookId,omnibusPath,komgaPath,matchedBy,verifiedAt}]}`.
  It never contains the API key.
- Deferred, not in this branch: the ComicRack CBL fallback matcher and "Open in Komga" links.

### Phase 4 — Reading-list push (requirement 2)
- **Eligibility:** `komga_readlists_enabled`, Komga ≥ 1.23.3, and `ReadingList.komgaSync = true`.
  Only admins can toggle it, because Komga lists are visible to every Komga user with library
  access.
- **Toggle and status API** (`src/app/api/reading-lists/komga/route.ts`):
  - `PATCH {listId, komgaSync}`: inline ADMIN check, `AuditLogger` entry. It enqueues a push, or a
    remote delete when sync is turned off. If `lastReconciledAt` is null, it enqueues
    `KOMGA_RECONCILE` first.
  - `GET ?listId=`: returns the link status, with `skippedSummary` parsed.
- **Resolver**, pure and unit-tested:
  1. Order the items by (`order`, `id`).
  2. Resolve each item to an issue:
     - with `issueId`: use that issue
     - with `issueId` null and `cvIssueId` set: look the issue up by
       `{metadataId: String(cvIssueId), metadataSource}`, preferring one with a non-null `filePath`.
       Extract this rule from the `GET /api/reading-lists` auto-link into a shared lib helper that
       both use. The resolver does not write the link back.
     - title-only placeholders are skipped as `placeholder`.
  3. Classify the item:
     - `filePath` null → `notDownloaded`
     - not `isKomgaScannable` → `unsupportedFormat`
     - library not mapped → `libraryUnmapped`
     - link missing or not valid → `awaitingScan`
     - otherwise it resolves to `komgaBookId`
  4. Dedupe by book, keeping the first occurrence (dropped entries count as `duplicate`).
  5. `skippedSummary` is a JSON string
     `{placeholder, notDownloaded, unsupportedFormat, libraryUnmapped, awaitingScan, duplicate}`.
- **Naming:**
  - `{name}` for global or legacy-global lists
  - `{name} ({ownerUsername})` for user-owned lists
  - a ` (Omnibus)` suffix when the name collides with a list Omnibus does not own
- **Ownership marker.** The Komga `summary` ends with:
  `Managed by Omnibus · instance <komga_instance_id> · list <readingListId> · edits in Komga are overwritten`
- **`KomgaReadListLink`** (§7) stores `lastPushedBookIds` (a JSON string) and `lastPushedName`, so
  that drift can be detected.
- **Push algorithm** (`pushReadList`, idempotent):
  1. Resolve the list.
  2. **No link row, or `komgaReadListId` null:** fetch `listReadLists()` once.
     - Adopt any list whose marker has this instance and this `readingListId`, whatever its name.
     - Otherwise create it with `POST`.
  3. **Name collides:**
     - If the colliding list's marker is this instance with a list ID that no longer exists in
       Omnibus, take it over with `PATCH`.
     - Otherwise retry with the ` (Omnibus)` suffix.
     - If that also collides, set `lastError` and never touch a list Omnibus does not own.
  4. **Zero resolvable books:**
     - Never create a list.
     - If a remote list exists, **keep it unchanged** and mark the link `waiting`. Delete a remote
       list only on Omnibus delete or un-sync.
  5. **Existing list:** `PATCH {name, summary, ordered:true, bookIds}` when the intended payload
     differs from the last pushed payload, or when the drift check shows a remote difference.
  6. Error handling:
     - `404` → recreate.
     - `400`/`5xx` from bad IDs → re-verify each ID with `getBook` (404 or `deleted` → drop and
       re-classify as `awaitingScan`), retry once, and enqueue a sync for the affected library.
- **Drift check** (step g, and every reconcile):
  - Make one `GET /api/v1/readlists?unpaged=true`.
  - For each link, compare the remote `{name, summary, bookIds in order}` with the last pushed
    payload.
  - A missing list is recreated. A different one is PATCHed back. This undoes Komga's StoryArc
    appends, `tryRestoreBooks` ID swaps (re-resolved from the fresh links), and manual edits.
  - Then re-resolve every synced list and push the ones whose intended payload changed.
- **Delete paths.** These read the `KomgaReadListLink` **before** they delete, and enqueue
  `KOMGA_READLIST_DELETE {komgaReadListId, readingListId}`. The job checks the marker before it
  deletes.
  - `DELETE /api/reading-lists`
  - user deletion, if it cascades to lists
  - turning sync off
  - the MAL/AniList re-import `deleteMany` (`import-mal`, `import-anilist`). These routes also
    **copy `komgaSync`** to the recreated list, and the new list adopts the old remote list through
    the "marker list no longer exists" rule.
- **Orphan sweep** (in `KOMGA_RECONCILE`): delete remote lists whose marker has this instance but a
  `readingListId` that no longer exists.
- **Push triggers** (debounced `KOMGA_READLIST_PUSH`, using BullMQ
  `delay: 10000, deduplication: {id: 'komga-rl-'+listId, ttl: 10000, extend: true, replace: true}`):
  - `reading-lists` POST
  - `items` POST (add/remove) and PUT (reorder)
  - `import-cbl`, `import-csv`, `import-mal`, `import-anilist`
  - `auto-build`
  - library POST `bulk-remove-list`
  - the `GET /api/reading-lists` auto-link, when it linked at least one item
  - Only lists with `komgaSync` are enqueued. Do the lookup in a tiny
    `src/lib/komga/readlist-trigger.ts` that imports the queue **lazily** (`await import`).
- **Reading-list page** (admins only): a "Sync to Komga" switch and a status line, for example
  "38 of 52 issues in Komga · pushed 5 m ago · 14 skipped (9 not downloaded, 5 awaiting scan)",
  plus `lastError`. Sync is one-way: say "Edits made in Komga are overwritten".

### Phase 5 — Admin jobs, health, docs, polish
- **Admin jobs.** The trigger route keeps a separate `komgaJobMap` that enqueues onto the
  `omnibus-komga` queue through a lazy import. **Never** send these to `omnibusQueue`: its worker
  throws `Unknown job type`.
  - Triggers: "Komga: sync mapped libraries", "Komga: rebuild ID map" (`KOMGA_RECONCILE`) and
    "Komga: push reading lists".
  - Extend the `handleRunJob` union and the buttons on `src/app/admin/jobs/page.tsx`.
  - Add a routing test.
- **Health check** (`health-checker.ts`). DB-only, with no live HTTP call:
  - `consecutiveFailures`, `lastError`, unmapped libraries, safety-valve trips
  - `lastReconciledAt` older than 48 h
  - verification give-ups in the last 24 h
  - `actionLink: '/admin/settings'`
- **Logging.** `Logger` prefix `[Komga]`; never log the API key.
  - `JobLog` types: `KOMGA_SCAN`, `KOMGA_RECONCILE`, `KOMGA_READLIST_SYNC`.
  - `AuditLogger` entries for settings changes, toggles and manual triggers.
- **Backups.** No backup code changes. All three backup lists are allowlists that copy columns
  dynamically, so the new tables are already excluded and `ReadingList.komgaSync` round-trips.
  - Add a one-line comment next to the existing `JobLog` exclusion note in `backup.rs`, the Node
    backup route and the restore route: "Komga* tables are rebuildable caches".
  - Do **not** touch the `backup_table_set_matches_restore` test.
- **`docs/KOMGA.md`**, the user guide. It covers:
  - creating a Komga admin user with **no content restrictions**, and its API key
  - the minimum version (1.20; 1.23.5+ recommended)
  - path mapping examples: Docker, with Omnibus `/data/comics` ↔ Komga `/comics`
  - recommended Komga library settings:
    - `hashFiles` on
    - `importComicInfoBook` on
    - `importComicInfoReadList` off when Omnibus owns reading lists
    - `convertToCbz` and `repairExtensions` **off**
    - `emptyTrashAfterScan` trade-offs
  - `.cb7` is not indexed by Komga
  - what is pushed, the naming rules, the marker, the one-way semantics, troubleshooting, and the
    ID-map export

## 7. Data model

All changes are additive, compatible with SQLite and Postgres, and use no `Json` or enum types.

```prisma
model KomgaLibrary {            // cache of Komga's libraries; refreshed whenever listLibraries succeeds
  komgaLibraryId   String   @id
  name             String
  root             String   // Komga-side path
  translatedRoot   String?  // root mapped to Omnibus paths
  omnibusLibraryId String?  // resolved Omnibus Library.id (null = unmapped)
  settings         String   // JSON string of the LibraryDto flags used for warnings and scannability
  unavailable      Boolean  @default(false)
  lastSeenAt       DateTime
}
model KomgaSyncState {          // dirty/lease state per *Omnibus* library
  omnibusLibraryId    String    @id   // relation to Library with onDelete: Cascade, if Library rows can be deleted
  dirtySince          DateTime?
  lastChangeAt        DateTime?
  pendingPaths        String?   // JSON string array, de-duplicated, ≤ 200
  pendingOverflow     Boolean   @default(false)
  lastScanRequestedAt DateTime?
  lastSyncCompletedAt DateTime?
  lastReconciledAt    DateTime?
  syncLeaseUntil      DateTime?
  nextEligibleAt      DateTime?
  retryCount          Int       @default(0)
  consecutiveFailures Int       @default(0)
  lastError           String?
  updatedAt           DateTime  @updatedAt
}
model KomgaBookLink {
  id             String   @id @default(cuid())
  issueId        String   @unique
  issue          Issue    @relation(fields: [issueId], references: [id], onDelete: Cascade)
  komgaBookId    String   @unique
  komgaSeriesId  String
  komgaLibraryId String
  omnibusPath    String   // Issue.filePath when matched (validity check)
  komgaPath      String
  matchedBy      String   // PATH | LINK
  missCount      Int      @default(0)
  verifiedAt     DateTime
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@index([komgaLibraryId])
}
model KomgaSeriesLink {
  id String @id @default(cuid())
  seriesId String @unique
  series Series @relation(fields: [seriesId], references: [id], onDelete: Cascade)
  komgaSeriesId String
  komgaLibraryId String
  verifiedAt DateTime
}
model KomgaReadListLink {
  id String @id @default(cuid())
  readingListId String @unique
  readingList ReadingList @relation(fields: [readingListId], references: [id], onDelete: Cascade)
  komgaReadListId String?
  lastPushedName String?
  lastPushedBookIds String?   // JSON string array
  lastPushedAt DateTime?
  status String @default("pending")  // pending | synced | waiting | error
  pushedCount Int @default(0)
  skippedCount Int @default(0)
  skippedSummary String?      // JSON string
  lastError String?
  updatedAt DateTime @updatedAt
}
// back-relations (virtual, no column): Issue.komgaBookLink KomgaBookLink?, Series.komgaSeriesLink KomgaSeriesLink?,
// ReadingList.komgaReadListLink KomgaReadListLink?; ReadingList gets komgaSync Boolean @default(false)
```
- The schema is applied with `prisma db push --accept-data-loss` at startup, so every change must be
  **purely additive**.
- The engine's sqlx SQLite connection enforces foreign keys, which is the sqlx default, so engine
  `Issue` deletes cascade to `KomgaBookLink`.
- The engine never writes these tables.

## 8. Invariants and safety
- A Komga failure must never fail or slow an Omnibus operation. Hooks are fire-and-forget,
  DB-only, and do one upsert per library.
- Omnibus's only Komga writes are:
  - library scans
  - create, update and delete of read lists that carry **this instance's** marker
- Omnibus never modifies Komga books, series or settings.
- The API key is a full Komga admin credential. It is never logged, never returned to the browser
  (masking test), and never exported.
- Everything is a no-op when `komga_enabled=false`.
- All path comparisons go through the shared normalizer.

## 9. Testing
- **Global mocks.** Add `vi.mock('@/lib/komga/changes', …)` and
  `vi.mock('@/lib/komga/readlist-trigger', …)` to `__tests__/helpers/setup-global.ts` with exported
  spies. Komga tests `vi.unmock` them. This prevents the about 35 existing route tests (narrow
  `@/lib/db` mocks, `toHaveBeenCalledTimes` assertions) from regressing. Redis is never imported at
  module load.
- **Unit tests:**
  - **Paths and libraries:** path-map (both directions, longest prefix, folder boundary, NFC,
    backslashes, `..`, sub-path URL base), `isKomgaScannable`, Omnibus↔Komga library resolution.
  - **Change tracking:** `recordLibraryChange` (disabled no-op, outside-roots skip, unresolved
    fallback, cap and overflow, merge), and the flush due-predicate (debounce, max-wait, back-off,
    lease, failure retry).
  - **Komga I/O:** client error mapping, URL building with a sub-path, the SSE frame parser
    (`data:` with and without a space, timeout), pagination restart.
  - **Sync and identity:** sync stage transitions (pre-idle busy → re-enqueue, scan failure keeps
    dirty, settle fallback chain), reconcile (PATH, LINK, uniqueness, safety valve, two-miss
    removal), verification (present, modified, absent, overflow stat, retry → deep).
  - **Read lists:** resolver (all skip reasons, placeholder lookup, dedupe, order), push state
    machine (create, adopt-by-marker, collision suffix, orphan takeover, zero books → keep, drift
    PATCH, 404 recreate, bad-ID re-verify), delete-before-cascade.
  - **Settings and routes:** `SECRET_SETTING_KEYS.has('komga_api_key')`. Masking: GET
    `/api/admin/config` with a mocked `findMany` returns `'********'`. Settings tab tests. Job
    routing.
- **Integration test.** Use a node `http` fake Komga with these endpoints: health, users/me,
  actuator/info, libraries, scan 202, an SSE endpoint that emits `TaskQueueStatus` frames, paged
  `books/list`, and read-list CRUD with FK→500 and duplicate→400 behaviour.
  - Drive `runLibrarySync` and `pushReadList` directly.
  - Use injected repositories or in-memory fakes for the Prisma delegates they touch, because no
    Node test uses a real DB.
  - Test the BullMQ wiring with a mocked queue.
- **Rust:** inline `#[cfg(test)]` tests for event coalescing, the `inject_xml_into_zip` result enum,
  the `resolve_cover` byte-compare skip, and the emitter's komga-enabled gate. HTTP-callback tests
  use a `tokio::net::TcpListener` stub.

## 10. Live verification against a real Komga (required; record results)
- **Setup:**
  - Docker is absent, and JDK 21 is installed. Use
    `JAVA_HOME=$(/usr/libexec/java_home -v 21)`.
  - Download the Komga 1.28.1 release jar from GitHub releases; the URL resolves. Run it on port
    25601 with `KOMGA_CONFIGDIR` pointing to a scratch directory outside the repo.
  - Claim the admin with `POST /api/v1/claim` (headers `X-Komga-Email`, `X-Komga-Password`), then
    create an API key with `POST /api/v2/users/me/api-keys {"comment":"omnibus"}` (Basic auth).
  - Create a library over a scratch folder of generated CBZs that contain `ComicInfo.xml` with a
    ComicVine issue URL in `<Web>`.
- **Confirm or correct:**
  - a. scan → 202
  - b. `TaskQueueStatus` cadence, frame format, type names
  - c. `books/list` body and payload (`url`, `metadata.links`, `fileLastModified`)
  - d. the response for an **unknown book ID** in read-list create and patch
  - e. the responses for an empty list and a duplicate name (status and body)
  - f. book-ID behaviour after a rename, with and without the hash present. Wait until no `HashBook`
    remains before renaming.
  - g. an in-place temp+rename ComicInfo rewrite is picked up by a non-deep scan
    (`fileLastModified` changes, same ID)
  - h. `/actuator/info` version shape
  - i. a scan request made while a scan is running is dropped
- **Also:** drive the real Omnibus client modules, through a small script or test harness, against
  this Komga for one end-to-end run: sync, reconcile, then push a list containing one missing book.
  Fold the observed shapes back into the fake-Komga fixtures.
- **Record** the results, commands, PID and teardown in `docs/komga-integration/LIVE_VERIFICATION.md`.
  Kill the process when you are done. If something blocks this, record exactly what, and keep the
  code tolerant (any non-2xx on a read-list write → re-verify and retry once).

## 11. Gates (required before every phase commit and at the end)
- `PATH=/opt/homebrew/opt/node@22/bin:$HOME/.cargo/bin:$PATH`.
- **Node:**
  - `npx prisma validate`
  - `npx prisma generate`
  - `npx vitest run --pool=forks`
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npx next build` (at least at the end of Phases 1, 4 and 5)
  - CI does not enforce tsc or eslint, but this branch must pass both.
- **Rust**, from `omnibus-engine/`:
  - `cargo clippy --all-targets -- -D warnings`
  - `cargo test`
  - Format only the files you touch: `cargo fmt --check` is not clean at baseline for the whole
    crate.
- There may be no regressions against the Phase 0 baselines. Every new module has tests.

## 12. Risks and mitigations
| Risk | Mitigation |
| --- | --- |
| Komga merges and drops a scan request made during a running scan | Pre-idle wait before every scan, path verification after it, and a deep-scan second retry |
| Komga is down while Omnibus changes files | The dirty state is durable in the DB, the POST failure keeps it dirty with back-off, and the daily full sync is the backstop |
| Lost engine callback | The daily `KOMGA_RECONCILE` runs a full sync, and Komga's own periodic scan also helps |
| Bursts (bulk match, rename, CBR sweep, embed) hammer Komga | Per-library debounce with max-wait, one sync per library through dedup and lease, no-op embeds and covers stay silent |
| A Komga backlog blocks the worker | Steps never block; waits are delayed re-enqueues, and only `ScanLibrary` is awaited |
| Book IDs churn on rename or convert | Re-link by path after every scan, link validity by `omnibusPath`, re-push on resolution change, re-verify on push errors |
| Unmounted share, lost ADMIN, bad mapping → mass link loss | Safety valve, two-miss removal, remote lists never deleted on zero resolution |
| Komga-side drift (StoryArc appends, restores, manual edits) | A drift check on every sync and reconcile, plus a recommendation to turn off `importComicInfoReadList` |
| Read-list name collisions | Owner suffix, ` (Omnibus)` suffix, adoption by instance marker, orphan takeover and sweep |
| SQLite contention | One upsert per hook call; reconcile diffs are written in chunks of about 500; no HTTP inside a transaction |
| Secret leak | Both key lists are updated, with a masking test |

## 13. Out of scope (list as follow-ups in the report)
- Read-progress sync. Two-way read-list sync. Collections. More than one Komga server.
- The ComicRack CBL fallback matcher. "Open in Komga" links.
- Multiple URLs in `<Web>` (this forces a full re-embed). `series.json` nullability for Komga's
  Mylar import.
- Pre-existing bugs to report, not fix:
  - the global path-mapping UI saves `remote_path_mapping`/`local_path_mapping`, but the resolver
    reads `remote_path_mappings`
  - the reading-list UI treats `WANTED` linked issues as readable (`/reader?path=null`)
  - CBL and CSV imports drop provider IDs
  - Omnibus's `.cb7` files are invisible to Komga
- Substituting a collected edition for covered issues.

## 14. Defaults chosen for the user (the coordinator may override them)
1. Read lists are pushed only when an admin opts a list in. There is no "push all".
2. Naming: `{name}` for global lists and `{name} ({owner})` for user-owned lists, plus a
   ` (Omnibus)` suffix on collision.
3. Sync is one-way, Omnibus → Komga. Komga-side edits are reverted.
4. Debounce 60 s, max-wait 600 s, non-deep scans (deep only on the second retry).
5. The Komga tables are rebuildable caches and are not in backups.
6. A zero-resolution list keeps its remote copy. A remote list is deleted only on Omnibus delete or
   un-sync.

## 15. Deviations (filled in by the implementer)
<!-- Record every place where the implementation differs from this plan, and why. -->
