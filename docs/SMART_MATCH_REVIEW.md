# Smart Match review: evidence-first matching

Branch `smart-match-improvements`, based on `2ce1fb6` (contains `5cf9743`). Nothing here touches
`main`; no branch was pushed, no image published, no real import or deletion was run.

## What changed, in one paragraph

Automatic matching (the Smart Matcher's Auto-Scan and the engine's background unmatched sweep)
used to be two different algorithms: a browser loop that stripped every `19xx/20xx` from the
name, took one `/api/search` page, scored names with an unbounded token Dice, and cached whatever it
got in `sessionStorage` for 12 hours; and a Rust loop that read only the first archive's ComicInfo,
then did a ComicVine-only name search with a similar but separately maintained scorer. Both are
replaced by one server-side decision service in `src/lib/smart-match/` that reads local evidence
first (embedded provider IDs, `series.json`, ComicInfo, filenames), searches only when needed with a
fixed request budget, validates the strongest few candidates at the issue level, and returns an
explainable decision with an explicit confidence state. The UI shows the decision; the engine
calls the same service over an authenticated internal route. Nothing moves a file on the strength
of a browser flag: an automatic accept carries a server fingerprint that is re-verified at route
entry and again immediately before each write.

## Architecture

```
                 ┌────────────────────────── src/lib/smart-match ───────────────────────────┐
                 │ signals.ts    pure parser + canonical numbers + bounded set-Dice similarity│
                 │ sources.ts    read-only local evidence (DB row, series.json, ComicInfo, files)│
                 │ providers.ts  bounded/budgeted/paced CV + Metron gateway, cache-aware      │
                 │ decision.ts   evidence-first evaluation, issue validation, confidence      │
                 │ service.ts    fingerprinted decision cache, scoped refresh, accept guards  │
                 └──────────────┬──────────────────────────────┬──────────────────────────────┘
   Smart Matcher page ──POST──► /api/admin/smart-match   /api/internal/smart-match ◄──POST── omnibus-engine
   (admin session)             { itemId, provider, refresh }   { itemId, maxRequests,          matcher.rs sweep
                                                                 expectedFingerprint }           (X-Internal-Secret)
   accept → /api/library/match-series { automaticMatch: { itemId, fingerprint, provider } }
            assertAutomaticMatch at entry; revalidateAutomaticMatch before attach / before Series write
```

* **`signals.ts`** — `parseSignals(name, kind, knownSeries?)` returns title, alternate titles, issue
  (with source and confidence), numbering domain (`regular | annual | collected`), publication year
  vs series-start year (bracketed year in a filename is publication evidence; in a series label or a
  year range it is run evidence), run ordinal, publisher, format, release tags and warnings. Bare
  `19xx/20xx` tokens are title text (`Spider-Man 2099`, `2000 AD`); a numberless file has no issue
  (never a confident `#1`); `Vol. N` on a filename with nothing after it is a collected/manga volume
  number with an alternate run interpretation and a warning. `titleSimilarity` is a set Dice
  (bounded, symmetric, `Batman Batman Batman` vs `Batman` = 1). One shared collected/annual
  vocabulary (`isCollectedFormat`, `isAnnualFormat`, word-bounded, includes GN / Graphic Novel /
  Hard Cover) is used by the parser, ComicInfo/series.json readers, provider adapter and scorer.
* **`sources.ts`** — resolves server-owned paths from IDs only (`raw_<base64 filename>` or a
  Series id), realpath-contains them in a library/unmatched root, and reads up to 64 archives with
  an 8 s overall evidence deadline and a per-file 5 s read timeout, streaming only `ComicInfo.xml`
  through `unzip -p` / `unrar p` (never extracting). Results are cached per file by
  `mtime:ctime:size`. Embedded issue IDs carry the originating file's number and domain. Placeholder
  publishers (`Unknown`/`Other`) are ignored; a scanned `Series.year` is a low-confidence hint, never
  a hard contradiction. Mixed folder titles and over-limit folders mark the evidence `incomplete`.
* **`providers.ts`** — one gateway per evaluation: configured providers only (masked/encrypted
  settings count as unconfigured), publisher block filter preserved, `MAX_PROVIDER_REQUESTS = 16`
  live HTTP calls per item (cache hits are free), 45 s per-item deadline, serialized across
  concurrent requests with 1.0 s (CV) / 1.1 s (Metron) pacing, existing quota reservation reused
  (CV stops at 170/200 per hour, Metron at 4500/5000 per day), 420/429 → `rate_limited` and the
  existing system flag, other HTTP errors → `provider_error` with no credentials in the message.
  Search fetches one page of 40 (CV) / one Metron page and no covers or details; details fetch CV
  dates only for the requested strongest numbers (max two issue calls) and up to two Metron
  issue-list pages. Forced refresh evicts only the refreshed resource/query across `field_list`
  and paging variants in `MetadataCache`, and does not repopulate the cache if the cache generation
  changed mid-request.
* **`decision.ts`** — `evaluateMatch` resolves embedded IDs first (conflicting series IDs or
  contradictory cross-provider runs → `conflict`), validates those with details, and only then
  searches: cleaned title, then up to two alternate titles, up to two pages, at most four searches,
  at most four detail validations, second configured provider on a miss. It builds a bounded
  candidate pool before spending the detail budget when page 1 has tied reboots. `validateCandidate`
  checks the exact issue number in the right numbering domain, compares the issue's publication
  date to the file's publication year (never to series start), treats missing dates and incomplete
  pages as unknown, and checks each embedded issue ID against its own file's number/domain. `decide`
  requires a contradiction-free lead with a ≥ 0.08 score gap over the runner-up and positive
  identity evidence for `high`; otherwise `medium | low | ambiguous | conflict | not_found`, plus
  `provider_error | rate_limited | deferred | ignored`. `selected` is the lead, never raw
  `candidates[0]`.
* **`service.ts`** — fingerprints each decision by algorithm version, evidence (names, IDs, stat
  stamps, parsed signals), relevant settings only (provider keys/users as opaque digest, matcher
  mode/threshold, publisher filter, cache toggles, `smart_match_cache_epoch`), provider and purpose.
  Decisions are stored in `SystemSetting` under `smart_match_v1_<fingerprint>` with a TTL of
  15 min (1 min for `not_found`), capped by the live cache TTL settings. Same-fingerprint requests
  coalesce; a settings change during evaluation yields `deferred`. `refresh` bypasses the decision
  cache and provider response cache and deletes the relevant `search_v3_*` (title + year
  variants + pages) and `meta_details_v13_*` (series and issue) keys. `assertAutomaticMatch` /
  `revalidateAutomaticMatch` are the server-side guards for automatic accepts.
* **Routes** — `/api/admin/smart-match` (admin session) and `/api/internal/smart-match`
  (`X-Internal-Secret` = `NEXTAUTH_SECRET`, `purpose: 'sweep'`, `maxRequests`,
  `expectedFingerprint`). `/api/library/match-series` and `/bulk` require either
  `automaticMatch` (verified) or `manualReview: true` (explicit reviewed manual/bulk assignment,
  untouched by the new guards). `/api/admin/metadata-cache` DELETE now also clears `search_v3_*`,
  `meta_details_*`, `cv_details_cache_*`, `smart_match_v1_*` and bumps `smart_match_cache_epoch`
  so open pages' tokens become stale. `CACHE_CLEANUP` expires `search_v3_*` (12 h) and
  `smart_match_v1_*` (`expiresAt`). `/api/search` only treats a bracketed year as a year and keys its
  cache on the publisher filter.
* **Engine (`matcher.rs`)** — the sweep no longer parses, scores or searches. For each candidate row
  it POSTs to the internal route with the remaining budget (≤ 16 per item, 30 per run), accepts only
  `status high / confidence high / safeToAccept / autoAccept / algorithmVersion evidence-1` with a
  numeric provider id, re-requests with `maxRequests: 0` and `expectedFingerprint` immediately
  before applying, and `apply_match` is a guarded `UPDATE … WHERE updatedAt unchanged AND NOT
  hasCustomMetadata AND matchState ≠ IGNORED AND still unmatched` that reports zero rows as "not
  applied". `rate_limited`/`deferred`/transport errors stop the run; the cursor never advances past
  an unexamined row. The old `folder_match_evidence`, `cv_search_best`, `name_similarity`,
  `year_term`, `pick_best`, `auto_accept` and `cv_calls_last_hour` are removed (no silently
  diverging TS/Rust algorithm remains). The engine needs `OMNIBUS_NODE_URL` (already set in both
  compose files) or `NEXTAUTH_URL`, plus the shared `NEXTAUTH_SECRET`; without them the sweep logs
  "Shared matching URL/secret is not configured" and defers everything.
* **UI (`admin/smart-match/page.tsx`)** — Auto-Scan calls the decision service per visible item,
  stores the decision, and renders status · confidence, parsed signals, reasons and every candidate
  with score and evidence. `Accept` / Accept Selected / Accept All go through `acceptableForBulk`,
  which accepts only `manualReviewed` suggestions or unexpired server decisions with
  `safeToAccept`. A per-row **Retry / Refresh** posts `refresh: true`. Legacy `sessionStorage`
  suggestion caches are deleted on load; the browser keeps no authoritative state.

## Behaviour changes to be aware of

| Before | After |
| --- | --- |
| Any `19xx/20xx` in a name was stripped as "the year" | Only bracketed years are years; `2099`/`2000 AD` stay in the title |
| Similarity could exceed 1 with repeated words | Set Dice, bounded [0,1], symmetric |
| Best candidate ⇒ accepted (Accept All took any suggestion) | Only `high` + clear lead + positive evidence is acceptable; ambiguous/weak/stale/expired never |
| Browser cached suggestions 12 h, including NOT_FOUND | Server decisions: 15 min (1 min for not found), invalidated by evidence, settings, algorithm, Clear Cache, Retry |
| Sweep: first archive + CV-only search, `auto ≥ 0.97`, `trust ≥ threshold` ignoring the year | Sweep uses the shared decision; `confirm` mode allows embedded-ID matches only (no name search), `auto`/`trust` allow search with the same confidence contract |
| Issue publication year compared with series start | Issue date compared with the file's publication year; long-running old volumes identify correctly |
| Metron search fetched covers per candidate for ranking | No covers/details during ranking |

Operator-visible consequences: fewer automatic matches in borderline cases (they now show as
`ambiguous`/`medium` with candidates, instead of a wrong folder move); the first scan after upgrade
re-evaluates everything (old browser caches are discarded); Metron and ComicVine budgets are shared
with the rest of the app and matching backs off first.

## Bounded call budgets

| Scope | Limit |
| --- | --- |
| Live provider HTTP calls per item | 16 (cache hits free); sweep passes its remaining run budget |
| Searches per item | 4 (≤ 3 titles × ≤ 2 pages, both configured providers) |
| Detail validations per item | 4 series details; CV adds ≤ 2 issue detail calls, Metron ≤ 2 issue-list pages |
| Sweep per run | 30 live calls across all rows, then defer |
| Wall clock | 8 s local evidence (then `incomplete`), 45 s provider phase per item, 60 s engine → web timeout |
| Quota reservation | CV: stop at 170 calls/hour; Metron: stop at 4500 calls/day (existing policy) |
| Pacing | 1.0 s between CV calls, 1.1 s between Metron calls, serialized across concurrent requests |

## Regression corpus (`__tests__/fixtures/smart-match-parser.json`)

| Input | Old result | New result |
| --- | --- | --- |
| `Batman 001 (2016) (Digital) (Zone-Empire)` | query `Batman 001 (Digital) (Zone-Empire)`, sim 0.33 | title `Batman`, #1, published 2016, tags Digital/Zone-Empire |
| `Batman (2016) #001 (DC Comics)` | `Batman #001 (DC Comics)` | `Batman`, #1, 2016, publisher DC Comics |
| `Batman_001_(2016)` / `Batman.001.(2016)` | `Batman_001_` | `Batman`, #1, 2016 |
| `Kaiju No. 8` (series) / `Kaiju No. 8 003` (known series) | `Kaiju No.` | `Kaiju No. 8`, no issue / `Kaiju No. 8`, #3 |
| `Spider-Man 2099 001 (2015)` | `Spider-Man 001 (2015)`, year 2099 | `Spider-Man 2099`, #1, 2015 |
| `2000 AD 2400 (2024)` | `AD 2400 (2024)`, year 2000 | `2000 AD`, #2400, 2024 |
| `Batman (2016-2020)` | `Batman -2020)` | `Batman`, series year 2016 |
| `Bone #13½ (1991)` | fraction kept in query | `Bone`, #13.5, 1991 |
| `Saga Compendium One TPB` | `Saga One` | `Saga Compendium One` (collected) + alternate `Saga` |
| `Batman Vol. 3 001 (2020)` | run lost | `Batman`, #1, 2020, run 3 |
| `Batman #-001`, `#000`, `#012AU`, `Issue -1`, `Chapter 013.5`, `#001 - I Am Gotham` | — | canonical `-1`, `0`, `12AU`, `-1`, `13.5`, `1` |
| Equal `Batman` 2011 vs 2016 candidates, issue dated 2020 fits both | provider order picked one | `ambiguous`, both candidates visible, nothing acceptable |
| `Batman` vs `Batman Annual` without annual evidence | annual could win on year | `Unexpected annual edition` contradiction; not acceptable |
| Scanned `Series.year = 2020` from publication, ComicInfo 2020, #100 in a 2016 run | reboot mismatch | `high`; low-provenance year is informational only |
| Three plausible wrong page-1 reboots, correct series on page 2 | never validated | page-2 candidate validated and selected (`high`) |
| Mis-tagged `ComicVineIssueId` in a later archive | first archive trusted | `conflict`: "Embedded issue ID contradicts the local issue number or domain" |
| Issue ID absent from the bounded issue list | — | unknown (reason), not a confident success |
| 420/429, timeout, unconfigured Metron, zero budget | all "NOT_FOUND" | `rate_limited` / `provider_error` / `deferred`, distinct from `not_found` |

## Commands and results

Node 22 (`PATH=/opt/homebrew/opt/node@22/bin:…`), Rust 1.96 (`PATH=~/.cargo/bin:…`), run inside this
worktree with its own `node_modules`, a temporary SQLite database for the integration suite and
mocked providers everywhere (no live provider calls, no real imports/deletions, no `.env` read).

| Command | Result |
| --- | --- |
| `npx vitest run --pool=forks` | 174 files passed, 1 skipped; **1187 tests passed, 2 skipped, 0 failed** (baseline main: 1085 passed, 2 skipped; +102 tests on this branch) |
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `npm run build` (production Next build) | success (exit 0) |
| `npx eslint .` | 0 new problems in touched files; 2 pre-existing `prefer-const` errors remain in untouched `src/app/api/library/cover/route.ts:198` and `src/lib/pages/page-sweep.ts:95` (plus the repo's existing `no-explicit-any` warnings); CI does not gate on lint |
| `cargo clippy --all-targets -- -D warnings` | clean |
| `cargo test` | 290 passed, 0 failed (baseline 292: the four removed scorer tests `year_term_*`, `pick_best_*`, `name_similarity_*`, `auto_accept_*` are replaced by `shared_contract_refuses_unsafe_old_and_over_budget_decisions` and `applying_shared_decision_guards_changed_ignored_locked_and_colliding_rows`) |
| `cargo fmt --check` | not clean, pre-existing: the crate was never rustfmt-formatted (every module reports drift at the base commit; `matcher.rs` 36 → 34 hunks, `scanner.rs` 227 → 226, `api_usage.rs` 14 → 13). CI does not run fmt; no whole-crate reformat was done on this branch |
| `git diff --check` (tracked and new files) | clean |
| `/Users/thomas/repos/sbx/omnibus` HEAD | `2ce1fb6`, unchanged (only the user's untracked `AGENTS.md`) |

New/changed test files: `__tests__/lib/smart-match-decision.test.ts` (parser corpus, scorer,
issue validation, confidence, evidence-first order, bounded fallbacks, failure kinds),
`__tests__/lib/smart-match-providers.test.ts` (budget, quota reservation, rate limit, credential
hygiene, targeted eviction, domain classification, bounded details),
`__tests__/integration/smart-match-service.test.ts` (real SQLite + real archives: shared UI/engine
decision, auth before evidence, coalescing, fingerprint hygiene and invalidation, TTLs,
`maxRequests: 0` freshness, scoped refresh, Clear Cache, accept-token guards, later-archive IDs),
`__tests__/api/match-series.test.ts` (manual path never consults the guard; stale token 409 before
any fetch/write; evidence change during the metadata fetch → 409 with no Series write and no move),
`__tests__/app/admin/smart-match-page-search.test.tsx` (Auto-Scan uses the decision service,
explains results, ambiguous stays unacceptable, Retry/Refresh bypasses caches), plus updated
expectations in `smart-match-prefill-helpers.test.ts` and `match-series-bulk.test.ts`, and the
engine tests above.

## Limitations

* Decisions live in `SystemSetting` rows (like the existing route caches); the Redis migration was
  evaluated only and deliberately not done. `CACHE_CLEANUP` expires them.
* Issue-level validation is bounded: CV fetches dates for at most two requested numbers, Metron
  reads at most two issue-list pages. Beyond that, unverified numbers are reasons (manual review),
  not contradictions.
* Local evidence stops after 64 archives or 8 s and marks the folder `incomplete`, which blocks
  `high` until an admin reviews it. Very large folders therefore will not auto-match.
* `readComicSignals` shells out to `unzip`/`unrar`; the runtime image now installs `unzip`
  (Dockerfile). Native dev machines need both on `PATH`.
* The engine depends on the web app being reachable (`OMNIBUS_NODE_URL`); the sweep degrades to
  "defer everything" rather than falling back to its own matching.
* Server decisions are per provider and per purpose (`ui` vs `sweep`), so the UI and sweep can
  each spend budget on the same item once per TTL window.
* `cargo fmt --check` is not clean at the base commit and remains so; formatting the crate is a
  separate change.

## Rollout concerns

* Set `OMNIBUS_NODE_URL` (compose already does) and share `NEXTAUTH_SECRET` between web and engine,
  or the background sweep stops matching (it logs why and defers).
* Rebuild the web image: the Dockerfile adds `unzip`.
* Expect a one-time wave of re-evaluation after upgrade (browser caches are discarded, old
  `search_v3_*` entries age out) and a lower automatic-match rate on ambiguous libraries, with the
  reasons visible in the Smart Matcher.
* Admins who relied on Accept All over weak suggestions must now use Search Match / Assign to
  Series (explicit reviewed path, unchanged) for those rows.
* No database migration is required.
