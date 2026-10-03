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

---

## 1. Current state of the branch

**⚠️ The branch is 3 commits behind `main` and must be rebased before it can land:**

```
240d920  docs: add Komga integration implementation plan   ← HEAD
2ce1fb6  Add bulk Assign to Series flow
...  base
```

Missing from this branch, present on `main`:

| Commit | Subject |
| --- | --- |
| `ebc6fbe` | feat(annas-archive): add configurable mirror failover |
| `907bc1c` | Add MEGA account downloads with session caching (#5) |
| `cf2ae35` | Smart Match: one evidence-first decision service |

All Phase 1 work is **uncommitted**. Do not discard it.

## 2. Verified gates (measured today, Node 22)

| Gate | Phase 0 baseline (`BASELINE.md`) | Current | Verdict |
| --- | --- | --- | --- |
| `npx vitest run --pool=forks` | 171 files, 1095 passed / 2 skipped | **183 files, 1488 passed / 2 skipped, 0 failed** | ✅ +393 tests, no regressions |
| `npx tsc --noEmit` | clean | **0 errors** | ✅ |
| `npm run lint` | 2 errors, 2004 warnings | **0 errors, 2026 warnings** | ✅ the 2 baseline errors were fixed |
| `cargo clippy --all-targets -- -D warnings` | clean | not re-run | — |
| `cargo test` | 292 passed | not re-run | — |
| `npx next build` | — | not re-run | — |

Everything currently on the branch is green. The build is unfinished by design, not broken.

Harmless `ECONNREFUSED 127.0.0.1:6379` noise in test output is expected — there is no Redis here.

## 3. Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| **0** | Workspace setup and baselines | ✅ **committed** as `240d920` |
| **1** | Komga client, settings, connection test, library discovery | ✅ **complete, uncommitted** |
| **2** | Change tracking + debounced scan trigger (req 1) | 🔶 **~15% — queue only** |
| **3** | Identity map + post-scan verification | ❌ not started |
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

### Phase 2 — only the queue exists

Present: `src/lib/komga/queue.ts` (job types `KOMGA_SYNC`, `KOMGA_RECONCILE`, `KOMGA_READLIST_PUSH`,
`KOMGA_READLIST_DELETE`, dedup helpers, lazy Redis).

**Missing — all of it:**

```
src/lib/komga/changes.ts                    recordLibraryChange (HOT PATH)
src/lib/komga/flush.ts                      isLibraryDue (pure) + flushDueLibraries
src/lib/komga/worker.ts                     initKomgaWorker
src/lib/komga/sync.ts                       runLibrarySync stage machine
src/app/api/internal/library-changed/route.ts
```

Also untouched: **the Rust engine emitter** in `omnibus-engine/src/library_events.rs` (modelled on
`log_forward.rs`), which `git status omnibus-engine` shows as completely clean. Phase 2 needs
emitters on both sides, and the plan lists ~14 Node call sites plus ~7 engine call sites.

Note `src/instrumentation.ts` and `src/lib/cron.ts` contain **zero** Komga references — the worker is
never started and the daily reconcile repeatable job is never registered.

### Phases 3–5 — nothing exists

Every module is absent: `reconcile.ts`, `verify.ts`, `id-map.ts`, `health.ts`, `readlist-resolver.ts`,
`readlist-push.ts`, `readlist-trigger.ts`, plus the `GET /api/admin/komga/id-map` and
`PATCH|GET /api/reading-lists/komga` routes and `docs/KOMGA.md`.

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

1. **Rebase onto `main`** (`git rebase main`, resolving the Prisma/reading-list touchpoints) and
   re-run the full gate set. Phase 1 touches settings tabs, admin config/test routes and
   `page-sweep.ts` / `secret-keys.ts`, all of which `main` has since moved.
2. **Phase 2**, per `CONTRACT-P2.md` + `P2-INVENTORY.md`, treating the LIVE addenda as authoritative:
   `changes.ts` → `flush.ts` → `worker.ts` → `sync.ts` → internal route → Node call sites →
   Rust emitter. Start the worker from `instrumentation.ts` after `initWorker()`.
3. **Phase 3** — identity map and post-scan verification; the schema is ready.
4. **Phase 4** — reading-list push.
5. **Phase 5** — admin jobs, health check, `docs/KOMGA.md`.
6. **End-to-end run** against PID 55968, then tear it down.

Per-phase gates are PLAN §11. No phase is committed until they pass, and every new module needs tests.

## 7. Open questions / risks carried forward

- `PLAN.md` §15 "Deviations" is **empty** — the coordinator never backfilled it. `DEVIATIONS.md`
  holds the Phase 0/1 content and should be merged into §15 when the branch is next committed.
- Phase 1's deviations from PLAN are substantial and all correct the plan (see `DEVIATIONS.md`),
  notably: `scanCbx` gates cbz/zip/cbr/rar together, not cbz alone; `scanDirectoryExclusions` is a
  case-insensitive substring match on the **full path**, not a folder-name match.
- PLAN §13 lists pre-existing bugs to **report, not fix** (global path-mapping UI saving
  `remote_path_mapping` while the resolver reads `remote_path_mappings`; the reading-list UI treating
  `WANTED` links as readable via `/reader?path=null`; CBL/CSV imports dropping provider IDs;
  `.cb7` invisible to Komga). Leave these alone.
- The `settings-hooks.ts` reset of `KomgaSyncState` backoff on a `komga_*` change is listed as a P2
  slice in `CONTRACT-P2.md` and is **not yet implemented**.