# Running deviation log (→ PLAN.md §15)

## Phase 0
- `npm ci` fails with ERESOLVE (next-auth@4.24.15 has an optional peer nodemailer@^7; the root
  uses ^9.1.1). Used `npm ci --legacy-peer-deps`, which §6 P0 allows. No package changes.
- `npm run lint` has 2 pre-existing `prefer-const` errors at baseline:
  - `src/app/api/library/cover/route.ts:198`
  - `src/lib/pages/page-sweep.ts:95`
  Both are fixed minimally so that the branch lint gate is green.

## Phase 1
- **Schema:** the full §7 data model goes in with Phase 1 (one additive edit) instead of per
  phase, so that later phases never touch `schema.prisma` while other agents edit in parallel.
  - `KomgaReadListLink` gets one extra column, `lastPushedSummary`, so the drift check can compare
    the remote summary with the last pushed one.
  - `KomgaSeriesLink` gets `@@index([komgaLibraryId])`.
- **§2 / CONTRACT correction — `scanCbx`:** it gates cbz, zip, cbr and rar together
  (`FileSystemScanner.kt:59`, `if (scanCbx) addAll(listOf("cbz","zip","cbr","rar"))`). cbz/zip are
  not "always" indexed. The `scanCbx=false` warning says the library indexes no comic archives at
  all.
- **§2 correction — `scanDirectoryExclusions`:** each entry is a case-insensitive substring match
  on the full folder path string, root included (`dir.pathString.contains(exclude, true)`). It is
  not a folder-name match. The hidden-name rule (`.` prefix) also applies to the library root
  itself.
- **`BookDto.url` / `LibraryDto.root`:** confirmed as plain decoded absolute paths (not `file:`
  URLs) in source and live. The normalizer still accepts `file:` URLs defensively.
- **Library mapping:** a Komga library over a parent folder can serve several Omnibus libraries.
  - `KomgaLibrary.omnibusLibraryId` stores the best (most specific) match for display.
  - Sync uses runtime containment in both directions (`komgaLibrariesForOmnibusLibrary`), not
    only the stored column.
- **Routes and security:**
  - The `komga` branch of `/api/admin/test` and `/api/admin/komga/libraries` always require an
    ADMIN session, even before setup completes. This is stricter than the Prowlarr pattern,
    because `/api/admin/test` is public during setup and `'********'` resolves to the stored Komga
    admin key.
  - `/api/admin/komga/libraries` returns 502 when the Komga connection test fails, so the page
    does not mistake it for its own session expiring.
  - It persists the `KomgaLibrary` cache only when `url` and the mappings equal the saved values,
    so a preview with unsaved values never overwrites the cache.
  - Both the test branch and the libraries route use the saved global custom headers, not the
    page's unsaved headers.
- **Config route:**
  - Komga work runs only when the incoming bag carries a `komga_*` key.
  - `komga_instance_id` is stripped from incoming saves, so the UI can never set it.
  - Path mappings that are not a JSON list are not saved: the stored value is kept and the save
    returns a warning.
  - Booleans are normalised to `'true'`/`'false'`.
  - The gate also enforces §5's rule that read lists cannot be enabled below Komga 1.23.3.
- **`getKomgaHotFlags()`** returns *effective* flags: `scanOnChange` and `readListsEnabled` are
  false whenever `komga_enabled` is not `'true'`.
- **Queue deduplication:**
  - `enqueueKomgaReconcile` uses `deduplication {id:'komga-reconcile', keepLastIfActive:true}`, so
    a reconcile requested while one is running is not dropped.
  - Continuation jobs never carry the flush dedup id, because the active job still holds it.
- **URL change:**
  - The wipe also sets `KomgaReadListLink.status = 'pending'`.
  - "Changed" is judged on the normalised scheme, host, port and path, so a trailing slash or a
    host-case change does not wipe the map.
- **Audit:** `AuditLogger` writes `KOMGA_SETTINGS_CHANGED`, with field names only and never
  values.
- **Client hardening:**
  - Redirects are not followed, because fetch would forward `X-API-Key` to the redirect target.
  - Custom headers cannot override `X-API-Key`.
  - Every error message is scrubbed of the key and of custom-header values.
  - `KomgaError` carries an extra `detail` field (Komga's message or the joined violations).
  - `health()` throws when Komga reports DOWN.
  - `listBooks` restarts as soon as `totalElements` changes on any page.
- **Settings UI:** with 9 tabs the desktop tab row overflowed (about 1126px of content in a
  975px container), so `tabs-list.tsx` now wraps at `lg`. That goes beyond PLAN's "comments
  only".

## Phase 2

### Contradictions found in the authoritative docs (resolved, flagged)

- **`LibraryChange.source` — CONTRACT-P2 vs P2-INVENTORY.** CONTRACT-P2 types it
  `'node' | 'engine'`, but every call site in P2-INVENTORY passes a finer provenance tag
  (`'converter:engine'`, `'api/library/rename:local'`, `'match-collision:attachAsCollected'`,
  `'metadata-fetcher:metron'`), none of which fit that union. Widened to `string`. `source` is
  log-only, and the inventory's granularity is strictly more useful; the alternative was editing
  ~23 call sites to throw information away.
- **Mark-all fallback scope — PLAN vs LIVE/P2-INVENTORY open decision #1.** PLAN says "if nothing
  resolves but paths/seriesIds were given, mark every Omnibus library dirty". Taken literally,
  every `/unmatched`-only operation (N16/N17 on an unmatched series folder, N21 orphans under
  `UNMATCHED_DIR`, N9 inside an unmatched series, N10 with a client-supplied path) would scan
  every library on the server. Resolved as: **out-of-root paths are silently dropped and never
  trigger the fallback**; the fallback fires only for IDs that cannot be classified at all (no
  series/issue row, or `libraryId` null with an out-of-root/empty `folderPath`) *and* no path
  resolved. This is the addenda's "confirmed" decision.
- **`settle` "count reached 0" is not implementable as written.** LIVE delta 3 establishes that
  `count` is global across libraries and task types and that scans shorter than the 10 s tick can
  start and finish between two frames. So "wait for count === 0" would fire while an unrelated
  library is mid-scan, and "wait until I see ScanLibrary" can never fire for a fast scan.
  Implemented instead as: *a `TaskQueueStatus` frame received after the POST in which no
  `ScanLibrary` is present*. Never requires having seen one.
- **Metric-based settle cannot be the primary.** LIVE delta 6: `COUNT` is global and increments
  when a task **finishes**, and `404` (→ 0) is ambiguous. A 0 → 0 transition is therefore not
  evidence, so `metrics` detection additionally requires a **proven non-zero** `metricsBefore`,
  and the fixed-delay fallback is kept for every other case.

### Design decisions

- **Out-of-root paths dropped, mark-all for unclassifiable IDs only** (above).
- **`pendingPaths` is a read-modify-write and can lose a path under concurrent callers.** This is
  accepted on purpose: Phase 3 verification re-lists the library and rescans on a miss, so a lost
  path costs a missed optimisation, never a missed book.
- **`KomgaSyncJobData` gained three fields** (as the contract instructs): `komgaLibraryIds`,
  `settleStartedAt`, `settleOutcome`. Later stages must not need a Komga call just to know what to
  scan.
- **Folder paths are stored in `pendingPaths`** (series deletes, relocates, renames). Phase 2 does
  not interpret them; Phase 3 verification must treat a path that is or was a directory as a
  prefix.
- **`inject_xml_into_zip` now returns `Option<EmbedOutcome>`** (`Written`/`Unchanged`) instead of
  `bool`. `Unchanged` still counts toward `success_count` (three existing tests depend on that)
  but is **not** reported as a changed file — otherwise every re-embed of identical ComicInfo.xml
  would look like a library change and defeat the debounce.
- **`resolve_cover` skips identical-bytes writes.** It rewrote `cover.*` on every provider sync;
  unchanged bytes are now detected and neither written nor emitted.
- **`ensure_folder_cover` emits only in the `Ok` branch** — the `Err` branch wrote nothing.
- **Engine granularity: one emit per job/series, after the join loops**, so Komga never scans a
  half-rewritten library. A crash mid-job emits nothing; Komga's periodic scan is the backstop.
- **`settings-hooks.ts` (CONTRACT-P2 addenda slice)** now resets `KomgaSyncState` backoff
  (`consecutiveFailures=0`, `nextEligibleAt=null`, `lastError=null`) when a `komga_url` /
  `komga_api_key` / `komga_path_mappings` change while enabled. The `where` clause is narrow
  (only rows that actually have backoff or an error), so the common save writes nothing.
- **`isLibraryDue` is pure** and is the unit-tested core; `flushDueLibraries` is a thin I/O shell.
- **`backoffMs` caps the exponent before shifting.** `2 ** n` overflows to `Infinity` past n=53,
  which would park a library *forever* rather than at the 30-minute cap.
- **Unknown stages and unknown job names log and return; they never throw.** `attempts` is 1, so a
  throw is just a dead job with no retry.
- **The reconcile enqueues per-library syncs *with* dedupe** (`komga-sync-<id>`): a flush job
  already waiting for that library covers the reconcile, so a second job would make Komga do the
  work twice.
- **Worker `concurrency: 1`.** A second worker could pick up a continuation while its predecessor
  still holds the library's lease.

### Bugs found in my own Phase 2 code while testing (fixed, with regression tests)

- **`stepStart`'s cached-library fallback bypassed the injected `db`.** It called
  `loadCachedKomgaLibraries()`, which reads the module-level `prisma`, contradicting CONTRACT-P2's
  "injected deps make it testable with in-memory fakes (no real DB in tests)". Replaced with a
  `cachedKomgaLibraries(ctx.db)` helper.
- **`stepScan` read `pendingPaths` after the update that clears it.** The code comment claimed the
  snapshot was taken before the clear; it was not. With Prisma this happens to work (update
  returns a new object), but it depends on the db layer not returning the same reference — and it
  silently destroyed the Phase 3 verification snapshot. Now captured before the write.
- **Off-by-one in the route's `stringList` cap.** The cap was checked *after* pushing, so a cap of
  0 (exhausted path budget) still admitted one path. Found by the 5000-path budget test.

### Pre-existing `main` code touched during the rebase (reported, minimally fixed)

The rebase carried `main` code into files Phase 2 also edits. These were **not** introduced by the
merge (verified: identical on `git show main:…`, absent from `git diff main`), but they were fixed
because the surrounding handler was already being modified and a silent `catch {}` next to a new
side effect is a bad thing to leave. All fixes are log-only or defensive-guard only; no behaviour
changed, and no test was updated to accommodate them:

- `src/app/api/admin/test/route.ts` — empty `catch (e) { }` around custom-header parsing.
- `src/app/api/library/issue/route.ts` — empty catch on the EMBED_METADATA enqueue; `new
  URL(request.url)` now guarded (400 instead of a 500 on a malformed URL).
- `src/app/api/library/route.ts`, `library/series/route.ts`, `library/update/route.ts`,
  `library/match-series/route.ts`, `admin/diagnostics/route.ts`, `lib/importer.ts`,
  `lib/metadata-fetcher.ts` — empty catches given debug/warn logs; dead
  `issuesCallsMade`/`writeToFile`/`oldName` locals removed; unused `axios` /
  `syncSeriesMetadata` imports removed from `importer.ts`.
- **`src/app/api/admin/config/route.ts:214` (`!!a !== !!b`) was deliberately NOT "fixed".** Unary
  `!` binds tighter than `!==`, so this is already a correct XOR ("exactly one of
  username/password supplied → error"). Rewriting it as the linter suggests would introduce a real
  bug. Left as-is and reported.

---

## Phase 3 — identity map and post-scan verification

No schema change was needed: `KomgaBookLink` (`omnibusPath`, `komgaPath`, `matchedBy`, `missCount`,
`verifiedAt`) and `KomgaSeriesLink` (`komgaSeriesId`, `komgaLibraryId`, `verifiedAt`) already carried
everything the plan needs. `prisma/schema.prisma` was not touched.

### Behaviour added on top of PLAN §Phase 3 (all deliberate)

- **A valve trip aborts EVERY map write, not only deletions** — no deletes, no upserts and, most
  importantly, **no `missCount` bump**. PLAN says "abort link deletions, keep existing links". Taken
  literally, a valve trip would still bump `missCount`; two consecutive 0-book listings would then
  delete the whole map on the second pass, which is the exact catastrophe the valve exists to
  prevent. The abort is therefore the default-safe path: `reconcileKomgaLibrary` computes the diff,
  checks the valve, and returns without writing anything if it tripped.
- **`lastReconciledAt` does not move when the valve trips** (nor when the listing failed). It is the
  Phase 5 health check's "the map is out of date" signal, so a nightly valve trip must be visible.
- **The valve is evaluated on the computed diff**, after matching, not on a special error path. There
  is one place where a new reason to distrust the listing can be added, and it cannot forget to trip.
- **Provider keys are host-scoped and boundary-terminated.** PLAN says "parse issue-level
  `4000-(\d+)` / `metron.cloud/issue/(\d+)`". A bare `metron.cloud/issue/(\d+)` against
  `https://metron.cloud/issue/4000-123/` yields `METRON:4000`, silently claiming Metron issue 4000.
  Both patterns now require their host and a `(?=[/?#]|$)` terminator. Verified against 5000 real
  books: all 5000 still parse, and all 5000 keys are distinct.
- **The issue side rejects `'0'`** as well as `unmatched_*` / `LOCAL` and non-numeric ids. The
  importer already treats `volumeId === "0"` as "no provider id" (`lib/importer.ts:511`), so a `0`
  row is a placeholder that several issues share.
- **Duplicate book urls are excluded from PATH matching** rather than resolved arbitrarily. Komga
  never produced one in 5000 live books, but "pick the first" is a silent corruption if it ever does.
- **The `getBook` probe for stale links is capped at 200 per Komga library.** An uncapped loop turns
  one badly out-of-sync library into thousands of sequential requests. Unprobed links fall back to
  the two-miss rule, which is the safe direction. The cap is not a PLAN item; it bounds a case the
  plan does not discuss.
- **Verification treats an unreachable Komga as "cannot verify", not as a miss.** PLAN is silent; the
  settle rule ("a settle timeout is not a verification miss") is the closest precedent. Counting an
  outage as a miss would burn the 2-retry budget and end in a false "gave up" JobLog.
- **A folder path in `pendingPaths` is expanded from the DB** (issues under that prefix, capped at
  2000, ordered by path) rather than being stat'ed once. Phase 2 emits series folders, so this is
  the common case, not an edge case.
- **The overflow sweep fetches up to 4 × `KOMGA_OVERFLOW_STAT_LIMIT` rows and stats at most 500**,
  because the "scannable and unbooked" filter runs client-side (it needs the Komga library's
  `scanCbx`/`scanPdf`/`scanEpub` and exclusions). Fetching exactly 500 and filtering after would
  under-cover a library whose first 500 paths are all `.cb7`.
- **The verification give-up is logged as `jobType: 'KOMGA_SCAN'`**, `status:
  'COMPLETED_WITH_ERRORS'`, so the `JobLog.jobType` set stays the three PLAN §Phase 5 declares
  (`KOMGA_SCAN`, `KOMGA_RECONCILE`, `KOMGA_READLIST_SYNC`). The message begins "Komga did not pick
  up …", which is what a reader greps for.
- **`KOMGA_RECONCILE` selects libraries by runtime containment**, not by the cached
  `KomgaLibrary.omnibusLibraryId` column. One Komga library over a parent folder is stored against a
  single best match, so the old filter would skip the other Omnibus libraries it serves on every
  nightly pass — while `stepStart` (which uses `komgaLibrariesForOmnibusLibrary`) would have scanned
  them. That inconsistency is now gone.
- **The lease is re-taken by `stepReconcile` and released by `stepVerify`.** `stepSettle` releases
  it (that is where `lastSyncCompletedAt` is stamped), so without this the library would be unlocked
  for the rest of the pipeline: the flush could start a second sync and two verifications would
  double-count a miss.
- **`GET /api/admin/komga/id-map` reads the Komga version best-effort.** The map itself is a pure DB
  read, so the export still works when Komga is down; a failed `getInfo` degrades
  `komga.version` to `null` instead of failing the request. The API key is never read.

### Live validation against PID 55968 (Komga 1.28.1)

A throwaway vitest suite drove the real `KomgaClient`, `extractProviderKeys`, `issueProviderKey`,
`isBookCurrent` and `isPathUnder` against the running instance, then was deleted. Results:

| Check | Result |
| --- | --- |
| `listBooks` over Live Bulk (5000 books) | 5000 books, all pages, no throw |
| urls absolute | 5000/5000 (LIVE delta 7 **confirmed**) |
| urls under `LibraryDto.root` | 5000/5000 (the valve's 3rd condition never false-positives) |
| duplicate urls | 0 |
| `fileLastModified` whole-second | 5000/5000 (LIVE delta 9 **confirmed**) |
| provider keys parsed | 5000/5000, all distinct (no false negatives from host-scoping) |
| `isBookCurrent(book, real fs mtime)` over Live A | 9/9 current; worst delta **843 ms** |

The 843 ms worst delta confirms Komga truncates the file mtime **down** to the second, so
`floor(mtime)` (not the raw mtime) is the right basis for the −2 s slack. The slack is generous for
this filesystem and necessary for coarse-grained ones (SMB shares, FAT volumes mounted into a
container).

`size=5000` was re-confirmed to be silently clamped to 2000 (`totalPages: 3` for 5000 books), which
is why `listBooks` loops on `last` rather than on the row count.

### Bugs found in the Phase 1 fake while testing Phase 3 (fixed, shared helper)

`makeKomgaBook`'s metadata argument was ignored: the returned DTO spread the *original*
`partial.metadata` rather than the merged value, so `makeKomgaBook({...}, { links })` produced a
book with no links. The helper now accepts the shorthand second argument and merges it. This is an
extension to `__tests__/helpers/fake-komga.ts`, not a fork.

### Carried into Phase 4 / Phase 5

- The identity map is only as good as its safety valve, so **Phase 4's reading-list push must treat
  `komgaBookLink` as read-only** and must not delete remote lists on the strength of a link that
  reconcile has not re-verified. `lastVerifiedAt` (not `updatedAt`) is the column to reason about.
- `health.ts` (Phase 5) should count `KomgaSyncState.lastError LIKE 'reconcile safety valve%'` for
  the valve-trip signal and `lastReconciledAt` older than 48 h for a stale map; both are now written
  by Phase 3 and nothing else writes them.
- The give-up JobLog uses `jobType: 'KOMGA_SCAN'`, so a Phase 5 health check that counts "verification
  give-ups in the last 24 h" must filter on that type plus the `Komga did not pick up` message.

---

## Phase 4 — reading-list push (requirement 2)

Phase 4's LIVE-verified deltas (#10–#19, #23) were **re-probed independently** against the running
instance (PID 55968, Komga 1.28.1) before and during implementation. All of them held. Two probes
are worth recording because they shaped the code:

- **#12 (FK rollback)** re-confirmed twice, including the part that matters: after
  `PATCH {name, bookIds:[…, unknown]}` returned 500 with
  `SQLITE_CONSTRAINT_FOREIGNKEY`, `GET` showed the **original** name — the rename rolled back with
  the membership. This is why the retry path re-sends the name with the surviving ids rather than
  assuming a partial success, and why a stale id is detected *before* the retry rather than after.
- **#13 (names)** re-confirmed: case-only rename of a list's own name is 204; a PATCH into another
  list's name is 400 `"Read list name already exists"`. `normalizeKomgaReadListName` (collapse all
  whitespace incl. NBSP, trim) runs before **every** comparison and before every name sent, because
  Komga compares untrimmed but case-insensitively.

### D4.1 — the shared `cvIssueId` lookup rule lives in `reading-list-links.ts`, not in the resolver

PLAN says to "extract the rule out of the `GET /api/reading-lists` auto-link into a shared lib
helper that both use". It is implemented as `pickIssueForProviderId` (pure) +
`findIssueForProviderId` (db) in `src/lib/reading-list-links.ts` — the module that already exists
for "which local Issue may an entry link to". Putting it in `readlist-resolver.ts` would have meant
the hottest reading-list route importing a Komga module for one function.

The auto-link keeps everything that was tightened in 4a2fdd2 and is **not** moved: owner-scoped
`linkAccessForList`, the `#194` title-number veto (applied via the helper's `expectedNumber`
argument), and the conditional `updateMany` on `issueId: null`. The resolver calls the same helper
with **no** `expectedNumber` (PLAN specifies no title veto for the push path) and never writes the
link back. Both properties are asserted in `readlist-resolver.test.ts` and
`reading-lists-route.test.ts`.

### D4.2 — a route must never `await` the queue (bug found by the import-anilist test)

The first cut of the cascade delete paths did `await enqueueKomgaReadListDelete(...)`. With Redis
unreachable that blocks on the BullMQ connection, stalling a user-facing response — and it hung
`__tests__/api/import-anilist.test.ts` outright. Fixed by splitting the helper in two:

- `triggerReadListRemoteDelete(readingListId)` — reads the link, then fires and forgets;
- `enqueueKomgaReadListDeleteNow(komgaReadListId, readingListId)` — takes an id the caller already
  holds, returns immediately.

The cascade paths (`import-mal`, `import-anilist`, admin user delete) use the second: they read
`komgaReadListId` **before** the `deleteMany`/`user.delete` that cascades it away, then call the
non-blocking version with the captured ids. The `reading-lists` DELETE calls the first, awaited,
because it has no other way to learn the id.

### D4.3 — `bookIds: []` is never sent, and a dead book id costs the whole request

`PATCH {bookIds: []}` is a 400 (two violations), so the zero-book branch never creates and never
empties: it marks the link `waiting` and leaves any remote list untouched. A remote list is deleted
**only** on Omnibus delete, un-sync, or the orphan sweep.

### D4.4 — the "enqueue a sync for the affected library" step needed the local link

PLAN step 6 says a stale id should "enqueue a sync for the affected library". `getBook` cannot
supply that: a **hard-deleted** book answers 404 with an *empty* body (delta #11), so there is no
`libraryId` to read. Only soft-deleted books (which do return a DTO) contribute one. `pushReadList`
therefore also looks the dropped ids up in `KomgaBookLink` (`komgaLibrariesForDroppedBooks`), which
is where the id's library is still recorded. Without this the enqueue step would only ever fire for
soft deletes.

### D4.5 — `readlists` runs after `verify`, and `verify` keeps releasing the lease

`SYNC_STEPS` gained `{ stage: 'readlists' }` after `verify` (the array stays data, not a switch).
`stepVerify` now returns `{ next: 'readlists' }` instead of `{ done: true }`; the lease release stays
inside `stepVerify`, so `stepReadlists` runs **without** holding it and the whole pipeline still ends
unlocked. The stage also selects lists by `items.some.issue.series.libraryId`, so a list that only
touches other libraries is not re-pushed on every sync.

### D4.6 — the orphan sweep moved ahead of the "nothing mapped" early return

Wiring the sweep into `runKomgaReconcile` first put it *after* the `libraryIds.length === 0` early
return, which meant it never ran in exactly the case it exists for (a remote list outliving the
library it was built from). It now runs first, and is skipped only when read lists are disabled.
Caught by `worker.test.ts`.

### D4.7 — the delete job stands down when the list was taken over

PLAN has the re-import enqueue a remote delete *and* copy `komgaSync` onto the replacement "so the
new list adopts the old remote through the marker rule". Those two race: if the push adopts the
orphan first, the marker is rewritten to the **new** list id, and a delete job that only checks the
*instance* would delete a list the new list now legitimately owns. `deleteKomgaReadList` therefore
additionally requires `marker.readingListId === data.readingListId` and returns `refused` otherwise.
This is strictly safer than PLAN and is covered by its own test.

### D4.8 — a name-collision 400 the listing cannot see must not recurse

If Komga answers the create with 400 `"Read list name already exists"` but the re-listing shows
nothing under that name (lost race, or a normalisation we do not model), retrying the same name
recurses forever. `createRetried` permits exactly one name change, and a same-name resolution with
no takeover records the error instead of retrying.

### D4.9 — out-of-scope lint tidies in files this phase already edits

Reported, not fixed, per HANDOFF §0 — except where the fix is behaviour-free and the phase already
touched the line:

- `src/app/api/reading-lists/route.ts` — removed a dead `isAdmin` local (POST already computed
  `canMakeGlobal`); renamed the unused `GET(request)` to `GET(_request)`, **keeping the arity**
  (an earlier attempt to drop the parameter broke 22 existing test call sites).
- `src/app/reading-lists/page.tsx` — three empty `catch` blocks (lines 131/152/247 on `main`) given
  a `Logger.log(…, 'debug')` so the no-empty-catch lint stops flagging them. Behaviour unchanged.
- `pushReadList` keeps a high branch count: it is PLAN's six numbered steps plus the retry path, and
  splitting it would scatter the ordering guarantees that are the point of the function.

### Test-count note

The task brief stated a `main` baseline of "≥ 2384". Measured, this branch's pre-existing baseline is
**2222** (`2358 + 2 skipped` measured now, minus the **138** cases this phase adds), which matches
`HANDOFF.md`'s recorded post-Phase-3 figure exactly. The 2384 figure could not be reproduced from the
tree and is treated as a miscount; `HANDOFF.md` is believed over it.
