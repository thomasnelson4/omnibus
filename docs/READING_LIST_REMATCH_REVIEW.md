# Reading list item rematch review: Fix match

Worktree `reading-list-item-rematch`, based on `origin/main` `cf2ae35`. Everything is uncommitted; nothing was pushed, no live provider call was made, and no other worktree or the main checkout was touched.

## What changed, in one paragraph

Every reading-list entry now has a **Fix match** action, visible to the list owner or an ADMIN. It re-points the entry at a ComicVine or Metron issue. You either search a series and pick the issue, or enter an issue ID/URL (`4000-N`, a CV page URL, `CVDB<N>`, a numeric Metron URL). A server-resolved preview comes before **Save**, and **Clear match** asks for confirmation when the entry is linked. On save the server re-fetches the issue (CV only through `cachedCvGet`; Metron through the new fail-fast `MetronProvider.getIssueSummary`). It stores `cvIssueId` + `metadataSource` + a `"Series #N"` title, and links a local Issue only inside the **list owner's** libraries and only if the row passes the #194 identity guard. Otherwise it clears the stale link, unless the user opts to keep a link the library can't contradict.

## User-visible behavior changes

| Before | After |
| --- | --- |
| No way to fix a wrong or missing match | Fix match (link icon) on every row in both views; always visible, including below `sm` |
| Linked entries without a file showed a dead **Read** (`/reader?path=null`) | They show **Not downloaded** plus **Request**. Request files against the series volume with `requestNameFor` and passes `releaseDate` |
| **Missing (N)** counted unlinked entries only | It also counts linked-but-not-downloaded entries, and bulk request now covers them. AniList/MAL lists show larger counts; unreleased rows become `UNRELEASED` requests |
| Grouped view (the default) had no Request | Each Grouped row has its own **Request/Requested** (icon-only below `sm`); Re-check is `hidden sm:flex` because the header Refresh does the same |
| GET auto-link: any library, first row wins, unconditional writes | It links only within the list **owner's** access (`ALL` for system lists), whoever loads the page. A title `#N` vetoes a candidate with a different number (attached lanes exempt). File-backed copies win. Writes are conditional (`updateMany` on `issueId:null` + id + source), and the lists are re-read only when a link actually landed |
| `lookup-volume` called CV `issue/4040-` (a *person*), so Requests filed as volume 0 | It uses `issue/4000-` and rejects non-numeric `issueId` (path injection with credentials attached) |
| Chunk headers were mouse-only; chunk ids were positional | `role=button`, `tabIndex=0`, `aria-expanded`, Enter/Space. Ids are keyed by the first item, so open groups survive edits |
| — | Provider badge (`CV #20288` / `Metron #4521`) links to the issue page; after a save the row updates in place (no refetch), groups stay open, focus returns to the row, and a stale "Requested" mark is cleared |
| The keep-link switch was decided in the browser, so it could promise a link the save then dropped | The switch needs the server's `keepable`, so the preview and the save always agree (ADMIN editing a restricted owner's entry) |
| Clearing a linked entry swapped the footer for the confirmation and dropped focus to `<body>` | The confirmation parks focus on **Keep** — never on the destructive Unlink |

## API contract

* `PATCH /api/reading-lists/items`:
  * Bodies: `{listId,itemId,action:'rematch',provider,providerIssueId,keepLocalLink?}` or `{listId,itemId,action:'clear'}`.
  * Check order:
    1. session → 401;
    2. JSON, plain object → 400;
    3. `listId`/`itemId` non-empty **strings** → 400 (blocks Prisma operator injection);
    4. action → 400;
    5. provider + `parseProviderIssueId` → 400;
    6. owner or ADMIN (system lists ADMIN-only) → 403 `FORBIDDEN`;
    7. `findFirst({id,listId})` → 404 `ITEM_NOT_FOUND`;
    8. provider lookup (typed errors exit before any write);
    9. `updateMany({id,listId})` (`count:0` → 404);
    10. re-read, audit (`REMATCH_READING_LIST_ITEM` / `CLEAR_READING_LIST_ITEM_MATCH` with `previous`).
  * Rematch returns `{success,item,link:'matched'|'kept'|'none',linked,hasFile,match}`. Clear returns `{success,item}`.
  * `order`/`listId` are never written.
* `GET /api/reading-lists/match?listId&itemId&provider&issueId`: requires edit rights. Returns `{match,local,mislabeled,accessScope:'self'|'owner',keepable}`, using the same owner-access rule and identity guard as PATCH. `itemId` is optional; `keepable` is the server's own answer to "would a save with `keepLocalLink` keep this entry's current link?", computed with the EXACT predicate PATCH applies, so the preview can never promise a link the save drops.
* `GET /api/reading-lists/match/providers`: requires a session. Returns `{providers:{COMICVINE,METRON}:boolean, primary}`, booleans only (masked or `enc:` secrets count as unconfigured).
* Errors are `{error, code}`:
  * 400 `INVALID_INPUT`;
  * 403 `FORBIDDEN`;
  * 404 `ITEM_NOT_FOUND` / `ISSUE_NOT_FOUND`;
  * 429 `RATE_LIMITED` (CV 420/429/`status_code` 107, Metron 429/`FATAL_RATE_LIMIT`, plus the health flag);
  * 502 `PROVIDER_ERROR` (timeout, 5xx, rejected key/login);
  * 503 `PROVIDER_NOT_CONFIGURED`.
* None of the new routes is in `publicApiRoutes`.

## Verification

All runs used Node 22 (`PATH=/opt/homebrew/opt/node@22/bin:$PATH`), `npm ci --legacy-peer-deps`, `npx prisma generate`, with every provider mocked. Baselines were recorded before any edit.

| Command | Baseline (cf2ae35) | After |
| --- | --- | --- |
| `npm test` (`vitest run --pool=forks`) | 180 files passed, 1 skipped; **1257 passed**, 2 skipped | 192 files passed, 1 skipped; **1587 passed**, 2 skipped, 0 failed (+12 files, +330 tests) |
| `npx tsc --noEmit` | 0 errors | 0 errors |
| `npm run lint` | 2 errors, 2022 warnings | 2 errors (the same pre-existing `prefer-const` in `src/app/api/library/cover/route.ts:198` and `src/lib/pages/page-sweep.ts:95`), 2076 warnings |
| `npx eslint` on touched files | — | 0 errors; warnings are `no-explicit-any` / `no-img-element` in house style |
| `npm run build` | — | exit 0; NEXTAUTH_SECRET/ECONNREFUSED log lines are environmental (no `.env`/Redis here) |
| `git diff HEAD -- __tests__/lib/metadata/metron.test.ts` | — | empty (existing Metron behavior and its 2000 ms retry test unchanged and green) |

New tests, covering §8.1–8.10:
* `__tests__/lib/utils/reading-list-match.test.ts` (86)
* `__tests__/lib/metadata/metron-issue-summary.test.ts`
* `__tests__/lib/metadata/issue-match.test.ts` (41)
* `__tests__/lib/reading-list-links.test.ts` (23)
* `__tests__/api/reading-list-item-rematch.test.ts` (41)
* `__tests__/api/reading-list-match-lookup.test.ts` (25)
* `__tests__/api/reading-lists-route.test.ts`
* `__tests__/api/reading-list-lookup-volume.test.ts`
* `__tests__/components/reading-list-item-match-dialog.test.tsx` (41)
* `__tests__/app/reading-lists/reading-lists-page-match.test.tsx` (11, including the Flat view: `@hello-pangea/dnd` renders in jsdom)

Added by the review pass:
* `__tests__/api/reading-list-match-keep-link.test.ts` (5) — drives GET /match and PATCH against one mock set and asserts they return the SAME answer for the ADMIN-over-restricted-owner case.
* `__tests__/integration/reading-list-rematch.test.ts` (12) — real `prisma db push` SQLite, mocked providers: exercises the nested library filter, the list-scoped item lookup, the columns the update must not write (read back from the row), the conditional auto-link and its transaction.

`git diff --stat HEAD` (tracked files): `items/route.ts` +113, `lookup-volume/route.ts` 5, `reading-lists/route.ts` 60, `reading-lists/page.tsx` 309, `providers/metron.ts` 66 (5 files, +462/−91). New: `src/lib/utils/reading-list-match.ts`, `src/lib/reading-list-links.ts`, `src/lib/metadata/issue-match.ts`, `src/app/api/reading-lists/match/route.ts`, `src/app/api/reading-lists/match/providers/route.ts`, `src/components/reading-list-item-match-dialog.tsx`, the 12 test files, and this doc.

The suites were mutation-checked, not just run: making `linkAccessForList` return the VIEWER's libraries instead of the owner's (a plausible copy-paste regression) fails 4 tests across the integration and keep-link suites.

**Not completed:**
* The optional manual smoke test (§9.2) was not run — no live provider credentials, no `.env`, no Redis in this worktree. Everything below is verified by tests only.
* The shared-view access filter (a user viewing someone else's global list still sees entries linked into libraries they cannot see) is untouched — it is plan §12 and out of scope here.

## Adversarial review (second pass)

Five dimensions, re-run against the finished implementation rather than the plan. Findings marked **FIXED** are covered by a test named below; **no findings** is stated where that is the honest answer.

### 1. Security / authorization — one defect, fixed
* **FIXED — the preview and the save could disagree about the keep-link (the known edge).** An ADMIN editing a restricted owner's entry sees a switch the browser decided was safe; `PATCH` then re-evaluated against the OWNER's libraries and dropped the link. The browser cannot compute this: `linkAccessForList` resolves the *owner's* access, not the viewer's. Fixed by making the server answer — `GET /match` takes an optional `itemId` and returns `keepable`, computed with the exact PATCH predicate; the dialog believes the server and still ANDs its own `libraryCannotContradict` check. Covered by `__tests__/api/reading-list-match-keep-link.test.ts` (both routes driven against one mock set, so they are asserted to agree), the `keepable` block in `reading-list-match-lookup.test.ts`, and "18. believes the server, not the local heuristic" in the dialog suite.
* Non-owner edits: no findings. `listId`/`itemId` are `typeof === 'string'` and non-empty **before** the first Prisma call on both new routes (`searchParams.get` on the GET is always a string, so the operator-object vector does not exist there). Items are addressed by `{id, listId}`, never by id alone; the preview's `itemId` read is scoped the same way, so an IDOR probe is just a miss.
* Provider URL injection: no findings. `parseProviderIssueId` only ever returns a bounded integer, and `lookupProviderIssue` re-validates provider and range before interpolating into the credentialed CV URL. `siteUrl` from provider data is origin-checked before it becomes an `href`.
* Cross-user leakage: no findings. Both new routes check owner-or-ADMIN **before** any lookup, and `linkAccessForList` resolves the owner's grants — an ADMIN never widens the library set, so the preview cannot surface a row the owner can't see.
* Audit rows: no findings. Written after a successful write with the acting `userId` and the pre-write `previous` snapshot; every provider-error, 403, 404 and zero-count path returns before it. `AuditLogger.log` swallows its own failures, so a logging error can't turn a successful save into a 500.
* No new route is in `publicApiRoutes` (`src/middleware.ts` unchanged), so all three are behind the token check plus their own session check.

### 2. Server contract — no findings
Status codes and `{error, code}` shapes match the documented contract on both routes; the PATCH check order is exactly the documented 1–10 (401 → 400 JSON → 400 ids → 400 action → 400 provider/id → 403 → 404 → provider → write → audit). The rematch/clear `data` objects contain only `cvIssueId`, `metadataSource`, `title`, `issueId` — `order` and `listId` are never written, and the integration suite asserts that by reading the rows back rather than by inspecting the argument.

### 3. Dialog UX — one defect, fixed
* **FIXED — the "Clear match" confirmation dropped focus.** Replacing the footer with the confirmation unmounted the focused button, so focus fell to `<body>`. Focus now moves to **Keep** (never the destructive Unlink). Covered by "19. moves focus to Keep when the clear confirmation opens".
* No findings on staleness: every async path (`loadProviders`, `loadCurrentMatch`, `runSearch`, `openSeries`, `selectIssue`) takes a version ref on entry and drops its response if the version moved, and close/reopen, provider change and typing all bump the relevant counter. Clear-match confirmation fires whenever `current.issueId` is set, including when the linked issue itself is not visible to the viewer. Keyboard access (Enter/Space on chunks, labelled controls, `aria-pressed` on issue rows) is present.
* Known and not fixed: an issue-list HTTP error and a lookup error show Retry, but a **search** failure only shows the message — the user re-submits with the Search button. Not worth the extra affordance; documented below.

### 4. Page — no findings
The GET auto-link rewrite holds up: `linkUpdates` is a single `$transaction` of conditional `updateMany({id, issueId: null, cvIssueId, metadataSource})` writes, so a concurrent rematch/clear wins (a clear also nulls `cvIssueId`, so a stale auto-link cannot resurrect it), and the re-read happens only when `results.some(r => r.count > 0)`. Owner-scoped linking, the `#N` title veto (attached lanes exempt), file-backed preference and the "Not downloaded" + Request flow are covered by the page and integration suites. The one integration test written for the admin case was initially **vacuous** (a non-global list is not in `GET /api/reading-lists` for an ADMIN at all) — the fixture list is now `isGlobal`, and a mutation check confirms the suite fails when `linkAccessForList` returns the viewer's access instead of the owner's.

### 5. Tests — one weakness, fixed
The two keep-link dialog tests asserted the *browser's* computation, so they passed against the broken build; they now assert the server's `keepable`. `__tests__/integration/reading-list-rematch.test.ts` was added for the real-DB gap (it caught two real modelling errors during the writing: `Series @@unique([metadataSource, metadataId])` forbids two series sharing a CV volume id across libraries, and the admin auto-link case needed a global list).

## Follow-ups

Closed by the review pass:
* ~~Finish the adversarial review and run the real-DB scratch integration test.~~ Both done — see §Adversarial review.
* ~~**Known edge (not fixed):** when an ADMIN edits a restricted owner's entry that is linked into a library the owner can't access, the preview can say "stays linked", but the save then unlinks it.~~ Fixed: `GET /match` takes `itemId` and returns `keepable`, and the dialog believes it.

Still open:
* "Load more" re-reads the current query field. If the user edits the query between pages, it appends results for the new query.
* A search failure shows its message but no Retry button (issue-list and lookup errors both do). Deliberate: the Search button is right there.
* **Found in review, deliberately NOT fixed (pre-existing, unrelated to this branch):** `fetchLists` in `src/app/reading-lists/page.tsx` has no version guard, so two overlapping page loads can land out of order and the slower one wins. It predates the rematch work and is unchanged by it; fixing it would touch the page's fetch plumbing for a race the feature does not make materially more likely.
* Plan §12 items:
  * `onDelete: SetNull`;
  * CBL `<Database>` IDs;
  * a bulk auto-match;
  * gating drag/drop;
  * the Metron branch of lookup-volume through `MetronProvider`;
  * an access filter for the shared view;

## Deviations from the plan

* **Unmatched parent ids:** `rowIdentityMismatch` treats a stored parent id as provider evidence only when it is numeric. An `unmatched_*` series id skips the parent check; the number is still checked. This matches the guard's "enforce only when both sides are known" rule and avoids refusing legitimate copies in unmatched series.
* **Undecryptable Metron password:** `getIssueSummary` also treats an `enc:` (undecryptable) Metron password as `METRON_NOT_CONFIGURED`. It returns `null` when the payload id differs from the requested id.
* **Extra defensive checks in `issue-match.ts`:**
  * `lookupProviderIssue` re-validates provider and id (400) before interpolating them into credentialed URLs;
  * a non-object CV body maps to `PROVIDER_ERROR`.
* **Dialog:**
  * A provider change does not bump the current-match lookup version, because that header line is independent of the selected provider.
  * The clear toast reads `Was linked to “X #1” (ComicVine #900).`
  * An issue-list HTTP error shows its message with Retry.
  * The keep-link switch is shown only when the SERVER said `keepable` **and** the local `libraryCannotContradict` check agrees. The server value is authoritative (see §Adversarial review); the local check is a belt-and-braces second gate.
* **Page:**
  * The flat linked row puts "Not downloaded" and the badge on the plan's new meta line under `Issue #N`.
  * The page test's stub dialog also calls `onOpenChange(false)`, as the real dialog does.

## Follow-ups (pre-review)

Superseded by the section above; kept only so the diff shows what changed:
* ~~Finish the adversarial review and run the real-DB scratch integration test.~~ Both done.
* ~~**Known edge (not fixed):** ADMIN over a restricted owner, preview vs save.~~ Fixed.
  * `/api/series-issues` errors returned as errors instead of `[]`.
