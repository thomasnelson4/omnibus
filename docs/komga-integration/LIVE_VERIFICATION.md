# Komga live verification (PLAN §10)

- Date: 2026-10-02, run against a real Komga 1.28.1 jar.
- Scope: items a–i of PLAN §10. Each section gives the request, what came back (trimmed), and a
  verdict: **confirmed** (PLAN §2 holds) or **corrected** (PLAN §2 is incomplete or wrong).
- No password, API key or session cookie appears in this file or in the fixtures.

## Setup

| Item | Value |
| --- | --- |
| Komga | 1.28.1 (`komga-1.28.1.jar`; `/actuator/info` → `build.version: "1.28.1"`, `git.commit.id: "2ab7a5a"`) |
| JDK | Homebrew OpenJDK 21.0.12.1 (`/usr/libexec/java_home -v 21`), `-Xmx1g` |
| OS | macOS 26.6.2, aarch64 |
| Client | Node v22.23.3, global `fetch` (curl/wget are blocked by a hook) |
| Port | `http://localhost:25601` |
| PID | 55968. An earlier phase started it, and it ran for the whole session. `komga.pid` holds the PID. |
| Scratch root | `$SCRATCH=/private/tmp/claude-502/-Users-thomas-orca-workspaces-omnibus-komga-integration/0dac9aa8-c899-4db0-884e-fbfb7f0c78d3/scratchpad/komga-live` |
| Config dir | `$SCRATCH/config` (`KOMGA_CONFIGDIR`) |
| Log | `$SCRATCH/komga.log` |
| Credentials | `$SCRATCH/creds.json` (mode 600): `{email, password, apiKey}`. The email is `admin@omnibus.local`. |
| Scripts / raw captures | `$SCRATCH/scripts/*.mjs` / `$SCRATCH/captures/` (one `.log` per step) |

Start command (from the earlier phase; to be reused if the process dies):

```sh
cd $SCRATCH && KOMGA_CONFIGDIR=$SCRATCH/config JAVA_HOME=$(/usr/libexec/java_home -v 21) \
  nohup $(/usr/libexec/java_home -v 21)/bin/java -Xmx1g -jar komga-1.28.1.jar --server.port=25601 > komga.log 2>&1 &
```

Bootstrap (script `01-claim.mjs`):

1. `GET /api/v1/claim` (anonymous) → `200 {"isClaimed":false}`.
2. `POST /api/v1/claim` with headers `X-Komga-Email` and `X-Komga-Password` (random 24-char
   password) → `200`, returning a UserDto with roles
   `["ADMIN","FILE_DOWNLOAD","KOBO_SYNC","KOREADER_SYNC","PAGE_STREAMING","USER"]`.
3. `POST /api/v2/users/me/api-keys {"comment":"omnibus"}` with Basic auth → `200`, returning
   `{id, userId, key (32 chars), comment, createdDate, lastModifiedDate}`.
4. Every later call uses only `X-API-Key`.

Libraries were created with `POST /api/v1/libraries {name, root, hashFiles, scanInterval:"DISABLED"}`.
The DTO's other fields have Kotlin defaults, so you can leave them out. The response is `200` with
a full LibraryDto. Creating a library queues a non-deep `ScanLibrary` (priority 4) by itself.

| Library | id | Options | Layout |
| --- | --- | --- | --- |
| Live A | `0RT153YK7XXMX` | hashFiles=true (default) | `library/live-a/{Alpha Squad (2020), Beta Force (2021), Gamma Team (2022)}/<Series> 00N (<Year>).cbz`: 3 series × 3 issues |
| Live NoHash | `0RT15QCCFXVWC` | hashFiles=false | `library/live-nohash/Delta Unit (2023)/…`: 1 series × 3 issues |
| Live Bulk | `0RT16D9ZFXHD0` | hashFiles=true | `library/live-bulk/Bulk Series NNNN (2000)/…` (300 folders × 10) plus, later, `Bulk Two NNNN (2000)/…` (200 × 10): 5000 books |

- `scripts/gen_cbz.py` generated the CBZs: valid 8×12 PNG pages written with zlib/struct, plus a
  `ComicInfo.xml` with `<Title>`, `<Series>`, `<Number>`, `<Year>` and
  `<Web>https://comicvine.gamespot.com/x/4000-<id>/</Web>`.
- Server settings (`GET /api/v1/settings`): `deleteEmptyReadLists: true` and `taskPoolSize: 1`
  (the default).

## a. Scan trigger

Request: `POST /api/v1/libraries/0RT153YK7XXMX/scan?deep=false` with `X-API-Key`.

Observed:
- **`202`** with an empty body (`content-length: 0`, no content-type) in 23 ms.
- The Komga log has `TaskEmitter : Sending task: ScanLibrary(libraryId='0RT153YK7XXMX', scanDeep='false', priority='8')`
  before the response.
- The ScanLibrary metric COUNT went from 1 to 2 after the queue was idle.
- Unknown library: `POST /api/v1/libraries/NOPE0000000000/scan` → `404`
  `{"timestamp":…,"status":404,"error":"Not Found","message":"404 NOT_FOUND","path":"/api/v1/libraries/NOPE0000000000/scan"}`.
- No auth: `401` with the same JSON error shape.

Conclusion: **confirmed.** The task is queued synchronously before the response. The body is empty,
so the client must not parse it as JSON.

## b. SSE `GET /sse/v1/events`

Requests:
- `GET /sse/v1/events` with `X-API-Key` (scripts `03-b-sse-capture.mjs`, `12-i-concurrent.mjs`,
  `15-b-sse-connect.mjs`).
- Anonymous, or with a wrong key → `401` (JSON error body).

Observed framing, byte-exact (fixtures `sse-frames.txt` and `sse-frames-idle.txt`):

```
event:TaskQueueStatus\ndata:{"count":0,"countByType":{}}\n\n
:heartbeat\n\n
event:TaskQueueStatus\ndata:{"count":437,"countByType":{"RefreshBookMetadata":396,"RefreshSeriesMetadata":39,"ScanLibrary":2}}\n\n
event:BookAdded\ndata:{"bookId":"0RT16PY3ZXKCS","seriesId":"0RT16PY3ZXKCH","libraryId":"0RT16D9ZFXHD0"}\n\n
```

Framing:
- Lines are `event:<Name>` and `data:<one-line JSON>` with **no space after the colon**.
- Frames end with `\n\n`. No `\r` appears.
- There are **no `id:` lines** and **no `retry:` lines**, so a reconnect cannot resume.
- The heartbeat is the comment `:heartbeat`, sent every **15 s**.
- `Content-Type: text/event-stream`.
- The response sets a `KOMGA-SESSION` cookie. Requests that use an API key get the cookie too.

Cadence:
- `TaskQueueStatus` comes every **10.0 s** on a global server tick.
  - Idle: 23:36:52.576, 23:37:02.560, 23:37:12.562.
  - During the bulk scans: 23:43:42.562, 23:43:52.553, 23:44:02.588, 23:44:12.554, 23:44:22.558.
  - 23:44:52.557 to 23:45:32.557, gaps of 10.00 s each.
- The cadence is the same with and without a running scan.
- The first frame comes at the next tick after connecting (0–10 s), not when the stream opens.
- **Response headers come only with that first frame.** `fetch()` resolved after 756 ms on one
  attempt and after 6298 ms on another, when the first chunk was a heartbeat.
- One first chunk was a partial frame (`"event:TaskQueueStatus\ndata:"`). The parser must buffer
  across chunk boundaries.

Frames only while connected:
- Source: `SseController.taskCount()`/`heartbeat()` run only `if (emitters.isNotEmpty())`.
- Live: the tick phase does not depend on when a client connects, and nothing is replayed after a
  reconnect.

`countByType` during scans:
- Idle is `{"count":0,"countByType":{}}`. The object is present and empty.
- The count includes the running task: `"ScanLibrary":2` was one running non-deep scan plus one
  queued deep scan.
- Keys seen in frames: `ScanLibrary`, `AnalyzeBook`, `HashBook`, `RefreshBookMetadata`,
  `RefreshSeriesMetadata`, `AggregateSeriesMetadata`, `FindBooksToConvert`,
  `FindBooksWithMissingPageHash` and `FindDuplicatePagesToDelete`.
- Seen only in the log, between frames: `GenerateBookThumbnail`, `EmptyTrash`, `RebuildIndex`.
- Example peak frame:
  `{"count":6373,"countByType":{"AnalyzeBook":2684,"FindBooksToConvert":1,"FindBooksWithMissingPageHash":1,"FindDuplicatePagesToDelete":1,"HashBook":3000,"RefreshBookMetadata":386,"RefreshSeriesMetadata":300}}`.

Volume:
- Scanning 3000 new books produced about 16,000 domain-event frames (1.6 MB) in about 40 s:
  3000 `BookAdded`, 9000 `BookChanged`, 3000 `ThumbnailBookAdded`, 300 `SeriesAdded`,
  600 `SeriesChanged` and 1 `LibraryAdded`.
- Only 5 of those frames were `TaskQueueStatus`.

Short scans:
- A ScanLibrary can finish entirely between two ticks. Live A took 3–92 ms. The first bulk scan
  took 2.8 s and never appeared in `countByType`.
- So "I saw ScanLibrary" is not a usable signal. Use "count reached 0 after my POST" together with
  the metric COUNT delta.

Stream lifetime (source only): `spring.mvc.async.request-timeout: 1h`, so the server closes the
stream after one hour and the client must reconnect.

Conclusion: **corrected (additions).** These parts of PLAN §2 hold:
- the frame format
- the 10 s cadence while a client is connected
- countByType is global
- heartbeat present

Corrections:
- add the `Find*` task keys
- the idle frame is `countByType: {}`
- response headers are delayed until the first frame
- comment heartbeats every 15 s
- no `id:` lines
- a heavy flood of domain events during scans
- short scans can be missed entirely

No false-idle frame (count 0 while work remained) appeared in any capture, which is consistent with
§2's "no false-idle gap" (a source claim).

## c. `POST /api/v1/books/list`

Request: `POST /api/v1/books/list?page=0&size=5&sort=url,asc` with this body:

```json
{"condition":{"allOf":[{"libraryId":{"operator":"is","value":"0RT153YK7XXMX"}},{"deleted":{"operator":"isFalse"}}]}}
```

Observed: `200`. Envelope keys (Spring `PageImpl`):
`content, pageable{pageNumber,pageSize,sort,offset,paged,unpaged}, totalPages, totalElements, last, size, number, sort{empty,unsorted,sorted}, first, numberOfElements, empty`.
Komga logs `Serializing PageImpl instances as-is is not supported`. The envelope is not a stable
contract, so rely only on `content`, `totalElements`, `totalPages`, `number` and `last`.

One book (fixtures `book.json` and `books-page.json`):

```json
{"id":"0RT153YNBXQWF","seriesId":"0RT153YNBXQWD","seriesTitle":"Alpha Squad","libraryId":"0RT153YK7XXMX",
 "name":"Alpha Squad 001 (2020)",
 "url":"/private/tmp/…/komga-live/library/live-a/Alpha Squad (2020)/Alpha Squad 001 (2020).cbz",
 "number":1,"created":"2026-10-02T23:38:03Z","lastModified":"2026-10-02T23:38:04Z",
 "fileLastModified":"2026-10-02T23:37:45Z","sizeBytes":665,"size":"665 B",
 "media":{"status":"READY","mediaType":"application/zip","pagesCount":2,…},
 "metadata":{"title":"Alpha Squad part 1","number":"1","numberSort":1.0,"releaseDate":"2020-01-01",
   "links":[{"label":"comicvine.gamespot.com","url":"https://comicvine.gamespot.com/x/4000-100101/"}],…},
 "readProgress":null,"deleted":false,"fileHash":"676b9032ce902e93b16dde676788e515","oneshot":false}
```

This sample (and the fixtures) was captured before section f. Book `0RT153YNBXQWF` was later renamed
and hard-deleted; its live replacement is `0RT15N2AVXS1K` (`… 001 (2020) renamed.cbz`).

Book fields:
- `url` is a **plain absolute POSIX path**: not a `file://` URL, no percent-encoding, and spaces and
  parentheses as-is. Komga stores `file:/…` internally (see the log), but the API returns the path.
  The independent re-check below found the same for `Ü`, `ï`, `#`, `%`, `[`, `]`, `+`, `;` and `&`.
- Series `url` is the folder path with no trailing slash.
- `fileLastModified` is ISO-8601 UTC with **whole seconds** and a `Z` suffix. It equals the file
  mtime truncated to the second.
- `sizeBytes` is a number, and `size` is a display string.
- `fileHash` is 32 lowercase hex characters (XXH3-128), or the **empty string `""`** (not null) when
  the book is not hashed.
- `metadata.links` is `[{label: <host>, url}]`.

Paging (Live A has 9 books, Live Bulk has 3000):

| Query | Result |
| --- | --- |
| `size=5000` / `size=2001` / `size=2000` | `size: 2000`, silently clamped (Bulk: 2000 rows, `totalPages: 2`) |
| `page=1&size=2000` (Bulk) | 1000 rows, `last: true`, `pageable.offset: 2000` |
| `size=0` | falls back to the default `size: 20` |
| `page=99` | `200`, `content: []`, `last: true`, `empty: true` |
| `unpaged=true` | **all rows in one page**: Bulk 3000 rows in 165 ms, 3.8 MB. The reported `size` is `max(total, 20)`. |
| `sort=url,desc` / no sort | descending order / unsorted (`sort.unsorted: true`), in insertion-like order |
| body `{}` | every book on the server; unknown libraryId → `totalElements: 0` |

Single book:
- `GET /api/v1/books/{id}` → `200` with the same BookDto.
- Unknown id → **`404` with an empty body** and no content-type.

Conclusion: **confirmed.** PLAN §2 holds: offset paging, the 2000 cap with silent clamping, sort by
`url`, the full path for ADMIN, `links`, whole-second UTC `fileLastModified`, `sizeBytes` and
`deleted`. Additions:
- `url` has no `file://` prefix and no encoding.
- `fileHash` is `""` when the book is unhashed.
- `unpaged=true` works.
- The single-book 404 has no body.

## d. Read list with an unknown book ID

Requests and results (all through `06-d-e-readlists.mjs`; bodies are in fixture `errors.json`):

- `POST /api/v1/readlists {"name":"RL Unknown","summary":"","ordered":true,"bookIds":[<valid>,"0ZZZZZZZZZZZZ",<valid>]}`
  - **`500`**:
    `{"timestamp":…,"status":500,"error":"Internal Server Error","message":"SQL [insert into READLIST_BOOK (READLIST_ID, BOOK_ID, NUMBER) values (?, ?, ?)]; [SQLITE_CONSTRAINT_FOREIGNKEY] A foreign key constraint failed (FOREIGN KEY constraint failed)","path":"/api/v1/readlists"}`.
  - Afterwards `GET /api/v1/readlists?unpaged=true` returned `[]`. **Nothing was created**, so the
    request rolled back.
- `PATCH /api/v1/readlists/{id} {"bookIds":[<valid>,"0ZZZZZZZZZZZZ"]}` → **`500`** with the same
  message. Membership, order and `lastModifiedDate` stayed unchanged.
- `PATCH … {"name":"RL Renamed","bookIds":["0ZZZZZZZZZZZZ"]}` → `500`. The **name change rolled
  back too**.
- `PATCH /api/v1/readlists/<unknown list id>` and `GET` on it → `404` with the Spring error JSON
  (`"message":"404 NOT_FOUND"`).
- Soft-deleted book IDs pass the FK check. `POST` returned `200` and `PATCH` returned `204` with a
  soft-deleted ID (`09-f-softdeleted.mjs`).

Conclusion: **confirmed.** The inference in PLAN §2 holds live: the response is 500 and the whole
request is rolled back. The client can detect this case from the message substring
`SQLITE_CONSTRAINT_FOREIGNKEY`.

## e. Read-list validation, replace semantics, DELETE

| Request | Status | Body |
| --- | --- | --- |
| `POST {name:"RL Empty", bookIds:[]}` | 400 | `{"violations":[{"fieldName":"bookIds","message":"must not be empty"}]}` |
| `POST {name:"RL Valid"}` (exists) | 400 | `{"timestamp":…,"status":400,"error":"Bad Request","message":"Read list name already exists","path":"/api/v1/readlists"}` |
| `POST {name:"rl valid"}` (case differs) | 400 | same: `"Read list name already exists"` |
| `POST {name:"RL Valid "}` (trailing space) | **200** | created as a separate list. Komga does **not trim** names. |
| `POST {bookIds:[b1,b2,b1]}` | 400 | `{"violations":[{"fieldName":"bookIds","message":"must only contain unique elements"}]}` |
| `POST {name:""}` | 400 | `{"violations":[{"fieldName":"name","message":"must not be blank"}]}` |
| `POST {name, bookIds}` (no `summary`/`ordered`) | 200 | defaults `summary:""`, `ordered:true` |
| `PATCH other {name:"RL VALID"}` (collides) | 400 | `"Read list name already exists"` |
| `PATCH self {name:"rl valid"}` (case-only rename of own name) | 204 | allowed |
| `PATCH {bookIds:[]}` | 400 | `{"violations":[{"fieldName":"bookIds","message":"must be null"},{"fieldName":"bookIds","message":"must not be empty"}]}` |
| `PATCH {bookIds:[b2,b2]}` | 400 | `"must only contain unique elements"` |
| `PATCH {bookIds:[b5,b4,b1]}` | 204 | empty body. `GET` → `bookIds` = `[b5,b4,b1]`, the same as `/readlists/{id}/books`. The list is fully replaced and order is kept. |
| `PATCH {summary:"…"}` only | 204 | membership unchanged |
| `DELETE /api/v1/readlists/{id}` | 204 | empty |
| `DELETE` again | 404 | Spring error JSON |

- A successful create returns `200` with a ReadListDto (fixture `readlist.json`):
  `{"id","name","summary","ordered","bookIds":[…in request order…],"createdDate","lastModifiedDate","filtered":false}`.
  Its timestamps are whole seconds.
- `GET /api/v1/readlists?unpaged=true` returns the same page envelope as in (c).

Conclusion: **confirmed** (statuses and the duplicate-name message match PLAN §2). Contract notes:
- 400s come in **two body shapes**. Bean validation gives `{"violations":[{fieldName,message}]}`.
  Domain errors give the Spring error JSON with `message`.
- Names are case-insensitively unique but **not trimmed**, so Omnibus must trim and normalise
  names itself.

## f. Book ID after a rename

Script: `07-f-rename.mjs`. It puts the book in a read list, waits for an idle TaskQueueStatus,
renames `X.cbz` → `X renamed.cbz` in the same folder, runs a non-deep scan, waits for idle, then
lists books including deleted ones.

**(i) With the hash present** (Live A, book `0RT153YNBXQWF`, `fileHash 676b90…e515`, in `RL Valid`
at position 0):
- New book `0RT15N2AVXS1K` with the same `fileHash`. Its media was copied (`READY` at once), and its
  title and links were kept.
- `GET /api/v1/books/0RT153YNBXQWF` → **`404`**. The old book was **hard-deleted**, and no
  soft-deleted row is left.
- The read list went from `["0RT153YNBXQWF","0RT153YNBXQWG","0RT153YNBXQWE"]` to
  `["0RT15N2AVXS1K","0RT153YNBXQWG","0RT153YNBXQWE"]`. Membership **moved to the new ID at the same
  position**.
- SSE during the scan: `BookChanged(old)`, `BookAdded(new)`, `BookDeleted(old)`, `BookChanged(new)`,
  `SeriesChanged`×2.

**(ii) Without the hash** (Live NoHash, `hashFiles=false`, `fileHash:""`, book `0RT15QCCVXNPJ` in
`RL NoHash`):
- New book `0RT15V41QXWQY` (`fileHash:""`), analysed from scratch.
- The old book is **soft-deleted**: `GET` → `200` with `deleted:true` and the old `url`. It drops
  out of `books/list` when `deleted isFalse` is in the condition.
- The read list **still holds the old ID** (`/readlists/{id}/books` shows it as deleted). The new
  book is not in the list.
- SSE: **no `BookDeleted`**. The soft delete shows up only as `BookChanged(old)`.
- After `POST /api/v1/libraries/{id}/empty-trash` (`202`), the old book returns `404` and is
  **removed from every read list**. Lists shrink; they are not re-pointed.

Conclusion: **confirmed** (PLAN §2 book-identity bullets hold exactly). Additions:
- Komga hashes the new file inline during the scan, but only when a soft-deleted candidate with a
  non-blank hash and the same size exists.
- The soft-delete path emits only `BookChanged`.

## g. In-place rewrite (temp file + rename)

Script: `10-g-rewrite.mjs temp "Beta Force 002"`, which uses `rewrite_cbz.py`. It writes
`.<name>.omnibus-tmp` in the same folder, then `os.replace()`s it over the original. The folder
mtime changed as a result. Then it runs a non-deep scan.

| | Before | After |
| --- | --- | --- |
| id | `0RT153YN7XPBK` | `0RT153YN7XPBK` (same) |
| fileLastModified | `2026-10-02T23:37:45Z` | `2026-10-02T23:42:20Z` |
| sizeBytes | 661 | 695 |
| fileHash | `32fcef…ed36` | `2e5c86…a2c7` (re-hashed) |
| metadata.title / summary | `Beta Force part 2` / `""` | `Beta Force part 2 (rewritten temp)` / `summary via temp rewrite` |
| media.status | READY | READY (after idle) |

Control test (not in PLAN):
- `rewrite_cbz.py … inplace` truncates and rewrites the file without a rename, so the folder mtime
  does **not** change.
- A **non-deep scan does not see that change**: `fileLastModified`, hash and metadata were all
  unchanged.
- A `deep=true` scan then picked it up, with the same ID and the new metadata.

Conclusion: **confirmed.** Temp+rename keeps the ID and is detected by a non-deep scan. Delta: any
write that does not change the folder mtime needs a deep scan.

## h. Actuator, user, metrics

- `GET /actuator/info` with `X-API-Key` → `200`, `content-type: application/vnd.spring-boot.actuator.v3+json`
  (fixture `actuator-info.json`):

  ```json
  {"git":{"branch":"master","commit":{"id":"2ab7a5a","time":"2026-10-02T05:56:47Z"}},
   "build":{"artifact":"komga","name":"komga","version":"1.28.1","group":"komga"},
   "java":{"version":"21.0.12.1",…},"os":{"name":"Mac OS X","version":"26.6.2","arch":"aarch64"}}
  ```

  Anonymous → `401`.
- `GET /actuator/health` anonymous → `200 {"status":"UP"}` (no details). With the key, it also
  returns `components` (db, diskSpace, ping, ssl).
- `GET /api/v2/users/me` → `200` (fixture `user-me.json`):
  `{"id","email","roles":[…],"sharedAllLibraries":true,"sharedLibrariesIds":[],"labelsAllow":[],"labelsExclude":[]}`.
  - **`ageRestriction` is left out when unset** (`@JsonInclude(NON_NULL)`). When it is set, it looks
    like `"ageRestriction":{"age":10,"restriction":"ALLOW_ONLY"}`.
  - The claimed admin has 6 roles. An ADMIN created through `POST /api/v2/users` has
    `["ADMIN","USER"]`.
  - `/api/v1/users/me` → `404`; it exists only under v2.
  - A wrong key or no auth → `401` JSON.
- Restrictions filter admins (a second ADMIN with `ageRestriction ALLOW_ONLY 10` +
  `labelsExclude ["nsfw"]`, script `14-h-restrictions.mjs`):
  - `books/list` for Live A returned **0** (versus 9 for the unrestricted admin).
  - `GET /api/v1/books/{id}` returned **`403`**.
  - `GET /api/v1/readlists` returned none.
  - With only `labelsAllow:["some-label"]` set, the result was also 0.
  - That user was deleted afterwards, and its key then returned `401`.
- Metrics `GET /actuator/metrics/komga.tasks.execution?tag=type:ScanLibrary`:
  - X-API-Key works. Anonymous → `401`.
  - **Before any ScanLibrary since startup: `404` with an empty body.** The untagged metric already
    existed, with `availableTags:[{"tag":"type","values":["RebuildIndex"]}]`.
  - After the scans, the response is (fixture `metrics-scan.json`):
    `{"name":"komga.tasks.execution","baseUnit":"seconds","measurements":[{"statistic":"COUNT","value":11},{"statistic":"TOTAL_TIME","value":5.89426679},{"statistic":"MAX","value":2.827510541}],"availableTags":[]}`.
    `description` is absent here but present on the untagged metric. `value` is printed as `1.0` or
    `9`, so parse it as a number.
  - The only tag is `type`, so the **COUNT is global across all libraries**.
  - COUNT goes up when a task **finishes**. Polled at 1 s: 8 → 9 at +3.0 s, right after the 2.8 s
    scan ended.
  - The registry is in memory, so COUNT resets to 404/0 on restart (inferred, not observed).

Conclusion: **confirmed.** `build.version`, ADMIN-only info, anonymous health, X-API-Key on the
actuator, 404 meaning 0, and restrictions filtering admins all match PLAN §2. Additions:
- `ageRestriction` is omitted when unset.
- The metric is global across libraries.
- The info endpoint uses the actuator v3 content type.

## i. Scan requested while a scan is running

**Run 1** (`12-i-concurrent.mjs create`): creating "Live Bulk" (3000 books) queued a non-deep scan
on its own. The script waited for the log line
`Executing task: ScanLibrary(libraryId='0RT16D9ZFXHD0', scanDeep='false', priority='4')` and then
posted the same scan.

```
18:43:42.588 Sending   ScanLibrary(0RT16D9ZFXHD0, scanDeep=false, priority=4)   <- library create
18:43:42.590 Executing ScanLibrary(0RT16D9ZFXHD0, scanDeep=false, priority=4)
18:43:42.596 Sending   ScanLibrary(0RT16D9ZFXHD0, scanDeep=false, priority=8)   <- POST ?deep=false -> 202
18:43:45.418 Task ScanLibrary(0RT16D9ZFXHD0, scanDeep=false, priority=4) executed in 2.827510541s
```

- After idle (40 s, about 6400 follow-up tasks), the metric COUNT went **8 → 9 (delta 1)**.
- There was no second `Executing` line. The duplicate was **merged into the running row and
  dropped**.

**Run 2** (`12-i-concurrent.mjs deep`): 2000 new books were added in 200 new folders. The script
posted `deep=false`, and while it ran it posted `deep=false` again and then `deep=true`.

```
18:45:01.361 Sending   ScanLibrary(…, scanDeep=false)            <- POST #1
18:45:01.362 Executing ScanLibrary(…, scanDeep=false)
18:45:01.366 Sending   ScanLibrary(…, scanDeep=false)            <- duplicate, 202
18:45:01.370 Sending   ScanLibrary(…, scanDeep=true)             <- deep, 202
18:45:03.084 Task ScanLibrary(…, scanDeep=false) executed in 1.722226500s
18:45:03.086 Executing ScanLibrary(…, scanDeep=true)
18:45:04.256 Task ScanLibrary(…, scanDeep=true) executed in 1.170446333s
```

- The SSE frame at 18:45:02.555 showed `"ScanLibrary":2`: the running non-deep scan plus the queued
  deep scan.
- COUNT went **9 → 11 (delta 2)**: one non-deep and one deep. The non-deep duplicate was dropped,
  and the deep request ran **right after** the non-deep scan.

**Run 3** (`16-i-queued-dup.mjs`): the script posted a deep scan of Live Bulk, then two non-deep
scans of Live A while the Live A scan was **still queued** behind it.
- Live A ran once, and only after Live B finished (COUNT delta 2).
- Queued duplicates collapse as well.
- With `taskPoolSize: 1`, scans of different libraries run one after another through one global
  queue.

Conclusion: **confirmed.** A request with the same uniqueId as a running scan is merged and dropped.
`deep=true` is not absorbed. Additions:
- Queued duplicates also collapse.
- All tasks share one serial queue (pool size 1), so Omnibus's pre-idle wait is global.

Timing reference:
- ScanLibrary of 3000 new tiny books: 2.8 s.
- ScanLibrary with +2000 new books over 5000: 1.7 s.
- Deep scan of 5000 unchanged books: 1.0–1.2 s.
- Live A: 3–92 ms.

## Deltas for the implementation

1. **SSE parser:**
   - Accept `field:value` with or without a space after the colon.
   - Ignore `:`-comment lines (`:heartbeat`, every 15 s).
   - Do not expect `id:` or `retry:`.
   - Buffer across chunks, since frames split mid-line.
   - `data` is one JSON line.
2. **SSE connect:**
   - `fetch()` resolves only when the first frame arrives (up to about 10 s; heartbeats every 15 s).
   - Use a connect/first-byte timeout of at least 20 s and an idle timeout of at least 30 s.
   - Expect the server to close the stream after 1 h (source) and reconnect with back-off.
   - Nothing is replayed after a reconnect.
3. **Idle detection:**
   - Idle is `TaskQueueStatus.count === 0` (`countByType` is `{}`).
   - `count` includes the running task, and it is global across libraries and task types.
   - Scans shorter than 10 s may never show up as `ScanLibrary` in a frame, so do not wait to "see"
     ScanLibrary.
   - After the POST, wait for a frame with `count === 0` that arrives later than the POST, and/or a
     ScanLibrary COUNT delta.
   - Unknown `countByType` keys must be tolerated. Seen so far: `FindBooksToConvert`,
     `FindBooksWithMissingPageHash`, `FindDuplicatePagesToDelete`, `GenerateBookThumbnail`,
     `EmptyTrash`, `RebuildIndex`.
4. **SSE volume:**
   - A scan of N new books emits about 5×N domain-event frames (3000 books → about 16,000 frames,
     1.6 MB).
   - Parse cheaply and drop everything except `TaskQueueStatus`; for example, check the event name
     before you `JSON.parse`.
5. **Scan POST** returns `202` with an **empty body**: do not parse it. An unknown library returns
   `404` with JSON.
6. **Metric:**
   - `404` with an empty body means 0.
   - The value is a JSON number (`1.0` or `11`).
   - COUNT is **global across libraries** (only the `type` tag exists), goes up when a task
     finishes, and resets on Komga restart, so a drop means a restart.
7. **`BookDto.url`:**
   - It is a plain absolute path, never `file://`, with no percent-encoding.
   - Join it to Omnibus paths with exact string equality after the prefix map.
   - Series `url` is the folder path with no trailing slash.
8. **`fileHash`:** `""` (empty string) when unhashed, otherwise 32 hex characters.
9. **`fileLastModified`:** `YYYY-MM-DDTHH:MM:SSZ`, truncated to whole seconds. Compare it at
   1 s resolution.
10. **Paging:**
    - The page size is silently clamped to 2000 (the `size` field reports 2000). Loop until
      `last === true`; do not loop on "fewer rows than I asked for".
    - `size=0` falls back to 20.
    - `unpaged=true` returns everything in one page (about 1.3 KB per book).
    - The envelope is Spring `PageImpl` and Komga warns that it is unstable. Read only `content`,
      `last`, `number`, `totalElements` and `totalPages`.
11. **`GET /api/v1/books/{id}` unknown** → `404` with an **empty body**. Read-list 404s carry a
    JSON body. Error handling must not require JSON.
12. **Read-list errors:**
    - Unknown book ID → `500` with Spring error JSON whose `message` contains
      `SQLITE_CONSTRAINT_FOREIGNKEY`. The request is **fully rolled back**, including name and
      summary changes in the same PATCH.
    - Validation 400s are `{"violations":[{"fieldName","message"}]}`.
    - A name collision is a 400 with Spring error JSON, `message: "Read list name already exists"`.
      This applies to create, and to a PATCH rename into another list's name in any case.
13. **Read-list names:** case-insensitive unique, **not trimmed**. Trim and collapse whitespace in
    Omnibus before you compare or send them. A case-only rename of a list's own name is allowed.
14. **PATCH `bookIds: []`** → 400 with two violations. An empty list cannot be pushed, as PLAN
    already says.
15. **PATCH semantics:**
    - Returns `204` with an empty body.
    - `bookIds` fully replaces membership and keeps order.
    - Leaving `bookIds` out keeps membership.
    - `summary` and `ordered` are optional on create (defaults `""` and `true`).
16. **DELETE** a read list → `204`. Deleting it again → `404`. Treat 404 as success when un-syncing.
17. **Rename with a hash** gives a new ID, and the old ID becomes `404` (hard-deleted). Komga moves
    read-list membership in place.
18. **Rename without a hash** gives a new ID. The old ID stays as `deleted:true` and stays in read
    lists. Empty-trash then removes it from lists (lists shrink).
19. **Soft delete over SSE** shows up only as `BookChanged`. Only a hard delete emits `BookDeleted`.
20. **File rewrites:** temp+rename keeps the ID and is seen by a non-deep scan. A plain overwrite
    (no folder-mtime change) needs `deep=true`. Every engine write path must use temp+rename.
21. **`/api/v2/users/me`:**
    - `ageRestriction` is **absent** when unset; treat absent and null the same.
    - Check `roles.includes("ADMIN")`.
    - Any `ageRestriction`, `labelsAllow` or `labelsExclude` makes books invisible even to an admin
      (books/list → 0, GET book → 403).
    - `/api/v1/users/me` does not exist.
22. **Version:** read `build.version` from `/actuator/info`. Accept content-type
    `application/vnd.spring-boot.actuator.v3+json` as JSON.
23. **Cookies:** every API-key response sets `KOMGA-SESSION`. Do not keep cookies in the client;
    this avoids the pre-1.23.5 bug where an API key plus a session returned empty content.
24. **Scan dedupe and ordering:**
    - Running and queued duplicates collapse.
    - `deep=true` is separate from `deep=false` and runs after it.
    - All libraries share one serial task queue (`taskPoolSize: 1`).
25. **Creating a library** queues a scan by itself. This matters only for test harnesses.

## Independent re-check

A second agent re-ran the three claims that matter most to the implementer against the same running
instance (scripts `21-audit-live.mjs` and `22-audit-url-encoding.mjs`). No recorded claim was wrong.

- **`BookDto.url` (c):**
  - `books/list` for Live A returned plain absolute paths (no `file:`, no `%XX`, spaces kept).
  - The series `url` had no trailing slash, and the NoHash `fileHash` was `""`.
  - Unknown `GET /api/v1/books/{id}` → `404`, empty body, no content-type.
  - Extra test: a throwaway library had folder and file names with `Ü ï # % [ ] + ; &`. Book and
    series `url` were byte-equal to the filesystem path, with no decoding needed. The library was
    then deleted (`204`); it added one ScanLibrary to the metric COUNT.
- **SSE (b):** a 22 s raw capture returned `200`, `text/event-stream`, and a `set-cookie`.
  - Frames were exactly `event:TaskQueueStatus\ndata:{"count":0,"countByType":{}}\n\n`. Key order
    was `count`, `countByType`.
  - There was no space after the colon, no `\r`, and no `id:` or `retry:` lines. There were two
    `:heartbeat` frames.
  - The first chunk was a heartbeat at 675 ms, and the headers arrived with it.
- **Read lists (d/e):**
  - `POST` with an unknown book ID → `500`, Spring error JSON, `message` containing
    `SQLITE_CONSTRAINT_FOREIGNKEY`. Nothing was created.
  - `PATCH {name, bookIds:[unknown]}` → `500`. Name, `bookIds` and `lastModifiedDate` were all
    unchanged.
  - `POST` with `RL Valid`, `RL VALID` or `rl valid` → `400` Spring error JSON with
    `"message":"Read list name already exists"`.
  - Afterwards the read lists were still exactly `RL Valid` and `RL NoHash`.
- **Secrets:** the API key, the password and the Basic `email:password` base64 were compared
  exactly against every modified or untracked file in the worktree, including this file and the
  fixtures. A generic pattern scan was also run. Nothing was found.

## Omnibus-client end-to-end run

Pending. A later phase drives the real Omnibus Komga client modules against this same Komga
instance (sync, reconcile, then push a list with one missing book) and records the results here.

The state left for that phase:
- Libraries: Live A `0RT153YK7XXMX` (9 books), Live NoHash `0RT15QCCFXVWC` (3) and Live Bulk
  `0RT16D9ZFXHD0` (5000).
- Read lists: `RL Valid` `0RT15EJXKXV79` and `RL NoHash` `0RT15RKP7XQZ9`.
- No soft-deleted books.
- IDs are in `$SCRATCH/ids.json`, and the credentials are in `$SCRATCH/creds.json`.

## Teardown

Not done yet. The Komga process (PID 55968, port 25601, config `$SCRATCH/config`) is **kept
running** on purpose so the end-to-end run can reuse it. The phase that finishes the end-to-end
run kills it (`kill 55968`) and records that here.
