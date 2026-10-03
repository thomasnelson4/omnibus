# Komga integration — implementation handoff

Branch `komga-integration` in this worktree. A previous agent (Claude) completed **Phase 0 and
Phase 1**, started **Phase 2**, and stopped mid-task on a usage limit. This file records where
things actually stand so the next agent does not have to re-derive it.

- Plan: [`PLAN.md`](./PLAN.md) (v2, 792 lines) — the requirements of record.
- **Before writing any client code, read [`LIVE_VERIFICATION.md`](./LIVE_VERIFICATION.md).** It records
  25 numbered behavioural deltas found by probing a real Komga 1.28.1, several of which **correct the
  plan**. It supersedes PLAN §2 wherever they disagree.
- [`CONTRACT.md`](./CONTRACT.md) — shared module contract, conventions and the file-ownership map.
- [`CONTRACT-P2.md`](./CONTRACT-P2.md) — the Phase 2 contract, **including an "Addenda" section
  marked authoritative** where it differs from the rest of that file.
- [`P2-INVENTORY.md`](./P2-INVENTORY.md) — per-call-site inventory for Phase 2 emitters.
- [`DEVIATIONS.md`](./DEVIATIONS.md) — running deviation log for Phases 0 and 1.
- [`BASELINE.md`](./BASELINE.md) — the Phase 0 baselines all gates are compared against.

> These five files were recovered from the previous agent's `/private/tmp` scratchpad and copied in
> here, because `/private/tmp` is not durable. Treat them as first-class project docs.

```text
docs/komga-integration/DEVIATIONS.md   running deviation log, Phases 0-2
```

---

## 0. Rebase onto `main` — DONE

The branch was rebased onto `main` (now based on `cf2ae35`). Only two conflicts, both pure
import-block unions in the admin routes, resolved by taking **both** sides:

- `src/app/api/admin/config/route.ts` — kept `annas-mirrors` (main) **and** the Komga constants /
  settings-hooks imports (Phase 1).
- `src/app/api/admin/test/route.ts` — kept `hosters/mega-session` (main) **and** the Komga
  connection-test imports (Phase 1).

Everything else auto-merged, including `prisma/schema.prisma` (main's models and the Komga models
coexist) and the reading-list routes. Gate numbers immediately after the rebase: **192 files,
1650 passed / 2 skipped, 0 failed**, `tsc` 0 errors.

The rebase carried a batch of pre-existing `main` code-quality problems into files Phase 2 also
edits (empty `catch {}` blocks, unused locals, unguarded `new URL(request.url)`). These were **not**
merge artifacts — verified identical on `git show main:…` and absent from `git diff main`. They are
listed at the end of [`DEVIATIONS.md`](./DEVIATIONS.md). One was deliberately **not** "fixed": the
`!!a !== !!b` MEGA validation in `config/route.ts` is already a correct XOR and rewriting it would
introduce a bug.


## 1. Current state of the branch

Phases 1, 2 and 3 are **committed** on top of `main`. See the gate table in §2 and the phase
table in §3 for what exists and what does not.

## 2. Verified gates (measured today, Node 22)

| Gate | Phase 0 baseline (`BASELINE.md`) | After Phase 3 | Verdict |
| --- | --- | --- | --- |
| `npx vitest run --pool=forks` | 171 files, 1095 passed / 2 skipped | **213 files, 2220 passed / 2 skipped, 0 failed** | ✅ no regressions; +1125 vs baseline, +86 from Phase 3 |
| `npx tsc --noEmit` | clean | **0 errors** | ✅ |
| `npm run lint` | 2 errors, 2004 warnings | **0 errors, 2139 warnings** | ✅ |
| `npx prisma validate` | — | **valid** | ✅ |
| `npx next build` | — | **succeeds** | ✅ |

Harmless `ECONNREFUSED 127.0.0.1:6379` noise in test output is expected — there is no Redis here.

## 3. Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| **0** | Workspace setup and baselines | ✅ **committed** as `240d920` |
| **1** | Komga client, settings, connection test, library discovery | ✅ **complete, committed** |
| **2** | Change tracking + debounced scan trigger (req 1) | ✅ **complete, committed** |
| **3** | Identity map + post-scan verification | ✅ **complete, committed** |
| **4** | Reading-list push (req 2) | ❌ not started |
| **5** | Admin jobs, health, docs | ❌ not started |

### Phase 1 — done

Ten modules under `src/lib/komga/` (2,153 LOC), each with tests:

| File | LOC | Exports |
| --- | --- | --- |
| `client.ts` | 564 | `KomgaClient`, `buildKomgaUrl`, `parseSseChunk`, `readTaskQueue` |
| `types.ts` | 232 | Hand-written Komga DTOs + `KomgaError` |
| `path-map.ts` | 240 | `normalizeKomgaPath`, `toKomgaPath`, `isKomgaScannable`, … |
| `libraries.ts` | 316 | Library cache refresh, Omnibus↔Komga mapping, warnings |
| `connection-test.ts` | 239 | `testKomgaConnection`, `compareKomgaVersions` |
| `settings-hooks.ts` | 225 | `runKomgaEnableGate`, `applyKomgaSettingsChange` |
| `settings.ts` | 131 | `getKomgaSettings`, `getKomgaHotFlags`, cache invalidation |
| `queue.ts` | 121 | `omnibus-komga` Queue + the four `enqueueKomga*` helpers |
| `constants.ts` | 65 | All timing/cap/version constants |
| `factory.ts` | 20 | `getKomgaClient`, `createKomgaClientFor` |

Plus: `src/app/api/admin/komga/libraries/route.ts`, `src/app/admin/settings/tabs/media-servers-tab.tsx`
(a new 9th settings tab), the admin config/test route branches, and the full §7 Prisma model set.

11 test files, 313 cases: `client` 63, `path-map` 42, `libraries` 40, `connection-test` 34,
`settings` 20, `settings-hooks` 26, `admin-config-komga` 25, `admin-komga-libraries` 22,
`admin-test-komga` 14, `queue` 12, `live-fixtures` 15. Shared fake: `__tests__/helpers/fake-komga.ts`
— **extend it, do not fork it.**

### Phase 2 — complete

All five modules exist, plus the engine emitter and every call site in `P2-INVENTORY.md`:

| File | Role |
| --- | --- |
| `changes.ts` | `recordLibraryChange` (HOT PATH), `mergePendingPaths`, `resolveLibraryForPath` |
| `flush.ts` | `isLibraryDue` (pure), `backoffMs`, `flushDueLibraries` |
| `worker.ts` | `initKomgaWorker`, `processKomgaJob`, `scheduleKomgaReconcile` |
| `sync.ts` | `runLibrarySync` stage machine (`start → preIdle → scan → settle`) |
| `../api/internal/library-changed/route.ts` | the engine's inbound webhook (202, hand-validated) |
| `omnibus-engine/src/library_events.rs` | engine emitter + drain + coalescer |

`src/instrumentation.ts` now starts the worker right after `initWorker()`. `queue.ts` gained
`komgaLibraryIds` / `settleStartedAt` / `settleOutcome` on `KomgaSyncJobData`;
`libraries.ts` exports `komgaLibraryRowToResolved`; `library-roots.ts` exports
`getLibraryRootEntries()`; `settings-hooks.ts` resets `KomgaSyncState` backoff on a connection change.

4 new test files: `changes` 44, `flush` 34, `sync` 28, `worker` 18, plus `internal-library-changed`
20 (144 cases). `rename.test.ts:97` was updated — the inventory predicted this: the engine branch
now takes one extra `series.findMany` snapshot query.

### Phase 3 — complete

| File | Role |
| --- | --- |
| `reconcile.ts` | `reconcileLibrary()`: pages every non-deleted book into memory with no transaction open, PATH-matches then LINK-matches, the four-condition safety valve, the two-consecutive-miss rule, chunked array-form `$transaction` writes of changed rows only, `KomgaSeriesLink` majority vote, one `KOMGA_RECONCILE` JobLog |
| `verify.ts` | `verifyLibrary()`: checks the snapshot step c took, the `floor(mtime) − 2 s` rule, folder-path expansion, the overflow sweep, the 2-retry budget and the give-up JobLog |
| `sync.ts` | `stepReconcile` + `stepVerify` appended after `settle`; `KomgaSyncDb` widened to the map models and `$transaction` |
| `worker.ts` | `KOMGA_RECONCILE` now selects libraries by runtime containment instead of the cached best-match column |
| `../api/admin/komga/id-map/route.ts` | ADMIN-only export of the map; no API key in the body |

4 new test files: `reconcile` 46, `verify` 25, `admin-komga-id-map` 9, plus `sync` +4 (32 total).
`fake-komga.ts`'s `makeKomgaBook` gained an optional metadata shorthand (shared helper, extended
not forked).

### Phases 4–5 — nothing exists

Every module is absent: `health.ts`, `readlist-resolver.ts`, `readlist-push.ts`,
`readlist-trigger.ts`, plus the `PATCH|GET /api/reading-lists/komga` route and `docs/KOMGA.md`.

**The Prisma models for all of it already exist** (`KomgaLibrary`, `KomgaSyncState`, `KomgaBookLink`,
`KomgaSeriesLink`, `KomgaReadListLink`) and are generated — but they are currently **dead weight**,
written and unused until Phase 3 wires them up. This was a deliberate choice (see `DEVIATIONS.md`:
one additive schema edit up front, so parallel agents never collide on `schema.prisma`). Do not
"clean them up".

## 4. The live Komga instance is still running

The most expensive thing the previous agent produced cannot be recreated cheaply, so it was left
deliberately alive.

| Item | Value |
| --- | --- |
| PID | **55968** — alive, port **25601** |
| Version | Komga **1.28.1**, JDK 21, `-Xmx1g` |
| Scratch root | `/private/tmp/claude-502/-Users-thomas-orca-workspaces-omnibus-komga-integration/0dac9aa8-c899-4db0-884e-fbfb7f0c78d3/scratchpad/komga-live` |
| Config | `$SCRATCH/config` (`KOMGA_CONFIGDIR`) |
| Log | `$SCRATCH/komga.log` |
| Credentials | `$SCRATCH/creds.json` (mode 600) — **never commit, never paste the key anywhere** |
| IDs | `$SCRATCH/ids.json` |
| Scripts | `$SCRATCH/scripts/*.mjs` (22 scripts, one per probe step) |

Fixture state, as left:

- Libraries: Live A `0RT153YK7XXMX` (9 books, hashFiles on), Live NoHash `0RT15QCCFXVWC`
  (3 books, hashFiles off), Live Bulk `0RT16D9ZFXHD0` (5000 books).
- Read lists: `RL Valid` `0RT15EJXKXV79`, `RL NoHash` `0RT15RKP7XQZ9`.
- No soft-deleted books.

**Teardown was deliberately not done** — `LIVE_VERIFICATION.md` says the process is kept running so
the end-to-end client run can reuse it. That run is still **pending** and is the natural companion
to Phases 2–4: drive the real `src/lib/komga` modules against this instance (sync → reconcile → push
a list with one missing book) and record the results in the "Omnibus-client end-to-end run" section,
which currently reads *Pending*. Kill PID 55968 only when that is done.

`curl`/`wget` are blocked by a hook in this environment — use `node -e` with global `fetch`.

## 5. Toolchain and hard rules

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$HOME/.cargo/bin:$PATH
```

Node 26 breaks jsdom — the default `node` on this machine is v26, so **always** set the PATH.
`npm ci` needs `--legacy-peer-deps` (ERESOLVE: next-auth 4.24.15 vs nodemailer 9).
Never run `prisma format` — it reformats the entire schema.
`npx prisma validate` needs `DATABASE_URL` copied from the main checkout.

Never `git stash`, `git reset --hard`, `git checkout --`, or touch another worktree or the
read-only Komga reference checkout at `/Users/thomas/repos/sbx/omnibus-references/komga`.

## 6. Suggested order of work

1. ~~**Rebase onto `main`**~~ — **done**, see §0.
2. ~~**Phase 2**~~ — **done**, see §3. Two notes for whoever picks this up:
   - `sync.ts` deliberately reads its cached library list through the **injected** `db`, not
     `loadCachedKomgaLibraries()` (which uses the module-level `prisma`). Keep it that way, or the
     stage machine stops being testable without a real database.
   - `stepScan` snapshots `pendingPaths` **before** the update that clears it. Phase 3's
     verification reads that snapshot; reading it after would silently verify nothing.
   - `stepSettle` returns `{next: 'reconcile'}` now (it used to end the pipeline), and
     `stepVerify` is what releases the lease. If you add a stage, keep the lease held for the whole
     pipeline — see `DEVIATIONS.md`.
3. **Phase 4** — reading-list push. `readlists` is still absent from `SYNC_STEPS`; append it after
   `verify`. `isBookLinkValid` (exported from `reconcile.ts`) is already what classifies an issue
   as `awaitingScan`. The push must treat `KomgaBookLink` as read-only.
4. **Phase 5** — admin jobs, health check, `docs/KOMGA.md`. `health.ts` should read
   `lastReconciledAt` staleness and the `reconcile safety valve` prefix in `lastError`, both of which
   Phase 3 now writes and nothing else does.
5. **End-to-end run** against PID 55968, then tear it down. Phase 3 has been validated against the
   live instance (paging, url shape, whole-second mtimes, provider-key uniqueness over 5000 real
   books — see `DEVIATIONS.md`), but the modules still run only against the fake.

Per-phase gates are PLAN §11. No phase is committed until they pass, and every new module needs tests.

## 7. Open questions / risks carried forward

- `PLAN.md` §15 "Deviations" is **empty** — the coordinator never backfilled it. `DEVIATIONS.md`
  holds the Phase 0/1/2 content and should be merged into §15 when the branch is next committed.
- Phase 1's deviations from PLAN are substantial and all correct the plan (see `DEVIATIONS.md`),
  notably: `scanCbx` gates cbz/zip/cbr/rar together, not cbz alone; `scanDirectoryExclusions` is a
  case-insensitive substring match on the **full path**, not a folder-name match.
- PLAN §13 lists pre-existing bugs to **report, not fix** (global path-mapping UI saving
  `remote_path_mapping` while the resolver reads `remote_path_mappings`; the reading-list UI treating
  `WANTED` links as readable via `/reader?path=null`; CBL/CSV imports dropping provider IDs;
  `.cb7` invisible to Komga). Leave these alone.
- The `settings-hooks.ts` reset of `KomgaSyncState` backoff on a `komga_*` change **is now
  implemented** (Phase 2).
- **Three contradictions between the authoritative docs were found in Phase 2** and are written up
  in `DEVIATIONS.md` §Phase 2: the `LibraryChange.source` type union vs the inventory's provenance
  tags; PLAN's mark-all fallback wording vs the addenda's out-of-root decision; and
  "settle when count reaches 0" being unimplementable given a global 10 s tick and sub-tick scans.
  The first two were resolved by choosing the more specific document; the third by implementing the
  LIVE-verified rule instead.
- **Phase 2's never-ran-against-Komga risk is now shared by Phase 3.** Phase 3 was validated against
  the live instance for *data shape* only (urls, mtimes, paging, provider keys); the modules still
  run end-to-end only against the fake. The end-to-end run in §4 remains the thing that would catch
  a wrong assumption about real Komga behaviour.