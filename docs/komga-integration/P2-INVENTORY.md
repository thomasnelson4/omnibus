# Phase 2 change-tracking inventory (Node call sites + engine emitter)

Verified against the working tree at HEAD `240d920` (branch `komga-integration`) on 2026-10-02. None of
the call-site files have uncommitted edits; the other team's edits are confined to settings/config/test/
komga/secret-keys/schema files. Line numbers below are exact for this tree.

## Conventions used in every "call to insert"

- Import (all Node sites): `import { recordLibraryChange } from '@/lib/komga/changes';`
  (none of these files gains a queue import; the hot-path rule holds).
- Always `void recordLibraryChange({...})`; never `await`.
- **Placement rule applied below:** emit immediately after the disk mutation succeeds, *before* any DB
  write / audit log that can throw into a catch that would skip the emit. Never emit inside the generic
  helpers (`safe-fs.ts`, `process_archive`), only at callers that know the reason.
- Delete sites pass **paths only**: the Series/Issue rows are deleted before (or concurrently with) the
  async resolution inside `recordLibraryChange`, so IDs would not resolve.
- `reason` vocabulary (kebab-case, both sides): `import`, `folder-standardize`, `convert`, `rename`,
  `issue-move`, `issue-link`, `issue-delete`, `series-delete`, `match`, `series-relocate`,
  `attach-collected`, `series-cover`, `series-cover-revert`, `remove-pages`, `insert-cover`,
  `delete-duplicates`, `delete-orphans`; engine: `watched-import`, `metadata-embed`, `cbr-convert`,
  `repack`, `cover-extract`, `cover-download`.

---

## Table 1 — Node: wire (23 rows)

| # | file:line | symbol | change on disk | exact call to insert |
|---|---|---|---|---|
| N1 | `src/lib/importer.ts:678` | `Importer.importRequest` series-folder standardization | `fs.move(series.folderPath → idealDestFolder)`; can cross libraries (`Series.libraryId := targetLibrary.id` at 682). DB repoint 680-694 is inside a try whose catch (696) swallows errors. | Insert **after line 678** (inside the try, before the `prisma.series.update`): `void recordLibraryChange({ paths: [series.folderPath, idealDestFolder], seriesIds: [series.id], reason: 'folder-standardize', source: 'importer:standardize' });` (`series.folderPath` is still the OLD folder; the object is never re-read.) |
| N2 | `src/lib/importer.ts:1094` | `Importer.importRequest` single-file success | copy/move into `destFolder` (791/794), magic-number rename (821), CBR→CBZ (829), `cover.<ext>` sidecar (968). | Insert **before line 1094** (`Logger.log(... Successfully imported ...)`, `return true` is 1095): `void recordLibraryChange({ paths: [finalPath], seriesIds: series?.id ? [series.id] : undefined, reason: 'import', source: 'importer' });` |
| N3 | `src/lib/importer.ts:774/809/1097` | `Importer.importRequest` partial-failure path (recommended addition) | A throw after the file landed (Prisma, notifier, usenet cleanup) reaches the catch at 1097 with the file left in the library and no emit. `finalPath` (769) and `series` (502) are function-scoped, so no hoisting of `finalPath` is needed. | Before `try {` at **774**: `let landedInLibrary = false;`. After **809** (`if (!moveSuccess) throw ...`): `landedInLibrary = true;`. First statement inside `} catch (e: any) {` at **1097**: `if (landedInLibrary) void recordLibraryChange({ paths: [finalPath], seriesIds: series?.id ? [series.id] : undefined, reason: 'import', source: 'importer:partial' });` |
| N4 | `src/lib/converter.ts:52` | `convertCbrToCbz` engine branch (`POST /api/converter/convert-file`, awaited) | Engine writes `.cbz`, deletes `.cbr/.rar/.cb7`, repoints `Issue.filePath`. | Insert **after line 52**, before `return data.path;` (53): `void recordLibraryChange({ paths: [cbrPath, data.path], reason: 'convert', source: 'converter:engine' });` |
| N5 | `src/lib/converter.ts:201` | `convertCbrToCbz` local fallback | `zip.writeZip(cbzPath)` (197), `fs.remove(cbrPath)` (200), then Issue repoint 203-209 (a throw there returns `null` from the catch at 214 although the file already changed). | Insert **after line 201** (closing `}` of the `fs.remove` block), before the `prisma.issue.findFirst`: `void recordLibraryChange({ paths: [cbrPath, cbzPath], reason: 'convert', source: 'converter:local' });` (Deviation from both sweeps, which put it at the `return` on 213: this placement survives a DB throw.) |
| N6 | `src/app/api/library/rename/route.ts:40-47` | POST engine branch (`POST /api/library/rename` via `engineFetchLong`, awaited) | Engine `run_bulk_rename` moves every file, updates `Issue.filePath`/`Series.folderPath`, removes empty dirs. Response has only counts + `newPath` (last folder). Can cross libraries when `Series.libraryId` is null. | Insert **before line 40** (the engine `try {`): `const preRenameFolders = (await prisma.series.findMany({ where: { id: { in: seriesIds } }, select: { folderPath: true } }).catch(() => [])).map(s => s.folderPath).filter(Boolean);` Then **after line 47** (`const data = await engineRes.json();`), before the AuditLogger at 48: `if ((data.filesRenamed || 0) + (data.foldersRenamed || 0) > 0) void recordLibraryChange({ paths: [...preRenameFolders, ...(data.newPath ? [data.newPath] : [])], seriesIds, reason: 'rename', source: 'api/library/rename:engine' });` Use a separate snapshot query (B), not hoisting `seriesList` (A): hoisting would hand the fallback loop pre-engine folderPaths if the engine fails part-way. **Test impact:** `__tests__/api/rename.test.ts:97` asserts `seriesFindMany` is not called on the engine path; change it to assert one call with `select: { folderPath: true }`. |
| N7 | `src/app/api/library/rename/route.ts:257` | POST local fallback loop | `fs.move(sourcePath, newFilePath)` per issue (257), `ensureDir(targetFolder)` (152), `cleanupEmptyDirs` (281). | After **line 89** (`let lastProcessedPath = "";`): `const changedPaths: string[] = [];`. After **line 257** (the `fs.move`, before `sourceDirs.add` and the Issue update, so a DB throw caught at 264 cannot drop it): `changedPaths.push(sourcePath, newFilePath);`. Before the AuditLogger at **288**: `if (changedPaths.length) void recordLibraryChange({ paths: changedPaths, seriesIds, reason: 'rename', source: 'api/library/rename:local' });` |
| N8 | `src/app/api/library/issue/move/route.ts:91` | POST move issues to another series | `moveFileNoClobber` → `fs.move` (29) into `target.folderPath` (may be a new folder in another library). DB update at 98. | After **line 84**: `const changedPaths: string[] = [];`. After **line 91** (inside the try, after `newFilePath = await moveFileNoClobber(...)`): `if (issue.filePath && newFilePath && newFilePath !== issue.filePath) changedPaths.push(issue.filePath, newFilePath);`. Before the AuditLogger at **102**: `if (changedPaths.length) void recordLibraryChange({ paths: changedPaths, seriesIds: [...new Set([target.id, ...issues.map(i => i.seriesId)])], issueIds, reason: 'issue-move', source: 'api/library/issue/move' });` |
| N9 | `src/app/api/library/issue/link/route.ts:131` | POST link unmatched file to official issue | `moveFileSafe(oldFilePath, finalFilePath)` (124): rename **in the same folder** (`activeFolderPath = dirname(oldFilePath)`, line 50). On OS failure `finalFilePath = oldFilePath` (130). | Insert **after line 131** (end of the rename try/catch), before the `$transaction` at 134: `if (finalFilePath !== oldFilePath) void recordLibraryChange({ paths: [oldFilePath, finalFilePath], seriesIds: [series.id], issueIds: [targetId], reason: 'issue-link', source: 'api/library/issue/link' });` (B's "moves into the official series folder" is wrong; A is right.) |
| N10 | `src/app/api/library/issue/route.ts:496` | DELETE issue (`deleteFile`) | Row deleted at 490, then `fs.promises.unlink(fullPath)` (496). | Insert **after line 496**, inside `if (fs.existsSync(fullPath)) {`: `void recordLibraryChange({ paths: [fullPath], reason: 'issue-delete', source: 'api/library/issue:DELETE' });` |
| N11 | `src/app/api/library/route.ts:484` | DELETE bulk series | `fs.remove(series.folderPath)` per series (480) into `deletedPaths` (481); rows deleted 486-487. | Insert **after line 484** (end of `if (deleteFiles) {…}`), before `prisma.issue.deleteMany` at 486: `if (deletedPaths.length) void recordLibraryChange({ paths: deletedPaths, reason: 'series-delete', source: 'api/library:DELETE' });` |
| N12 | `src/app/api/library/series/route.ts:533` | DELETE series | Rows deleted first (522-523), then `fs.remove(series.folderPath)` (529) into `deletedPaths` (530). | Insert **after line 533** (end of `if (deleteFiles) {…}`), before the AuditLogger at 535: `if (deletedPaths.length) void recordLibraryChange({ paths: deletedPaths, reason: 'series-delete', source: 'api/library/series:DELETE' });` |
| N13 | `src/app/api/library/match-series/route.ts:383-683` | POST Smart Matcher single match (also reached per item by `match-series/bulk/route.ts:52`) | Loose file `moveFileSafe` (398) or folder `safeRelocateFolder` (407) — both **outside** the swallowing try (439-683), so a throw in the repoint at 413-435 skips any end-of-handler emit. Then per-file rename `moveFileSafe` (538; conflict restore to /unmatched at 534) and `cover.jpg` writes (675, 680) inside the swallowing try. For a folder source the rename loop renames nothing (it only acts on `basename(file) === basename(oldFolderPath)`). | After **line 383** (`let activeFolderPath = oldFolderPath;`): `const changedPaths: string[] = []; const flushChanges = () => { if (!changedPaths.length) return; void recordLibraryChange({ paths: changedPaths.splice(0), seriesIds: existingRecord?.id ? [existingRecord.id] : undefined, reason: 'match', source: 'api/library/match-series' }); };` After **398**: `changedPaths.push(oldFolderPath, targetFilePath); flushChanges();` After **407**: `changedPaths.push(oldFolderPath, newFolderPath); flushChanges();` After **538**: `changedPaths.push(oldFilePath, newFilePath);` After **675** and after **680**: `changedPaths.push(path.join(activeFolderPath, 'cover.jpg'));` After **683** (`} catch (err) {}`): `flushChanges();` At most two DB upserts per match; the debounce absorbs them. (Settles A vs B: B's single `[oldFolderPath, activeFolderPath]` emit at 756 is not reached when the repoint throws, and is folder-granular.) |
| N14 | `src/app/api/library/update/route.ts:102-106` | POST series metadata update | `safeRelocateFolder(activePath, newPath, libraryRoot)` (102). `targetLib` is always the default library for the manga flag (53-57), so a series in a non-default library moves across libraries. `existingRecord` is loaded later (116). | Insert **between line 105 and line 106** (`activePath = newPath;`), inside `if (fs.existsSync(activePath))`: `void recordLibraryChange({ paths: [activePath, newPath], reason: 'series-relocate', source: 'api/library/update' });` (The `else` at 107-108 is DB-only. EMBED_METADATA at 221 emits from the engine.) |
| N15 | `src/lib/match-collision.ts:211` | `attachAsCollected` (shared core for `match-series/route.ts:240` attach mode and `series/attachments/route.ts:70`) | `moveFileSafe(item.filePath, target)` per file into the owner folder (211), `ensureLibraryDir` (210), `cleanupEmptyDirs` (264). Early returns at 137/142 happen before any move. | After **line 180** (`let ensured = false;`): `const changedPaths: string[] = [];`. After **line 212** (`result.moved++;`): `changedPaths.push(item.filePath, target);`. Before `return result;` at **267**: `if (changedPaths.length) void recordLibraryChange({ paths: changedPaths, seriesIds: [owner.id], reason: 'attach-collected', source: 'match-collision:attachAsCollected' });` Recommended hardening: wrap the loop (182-252) in `try { … } finally { <same emit> }` and drop the one at 267, so a DB throw mid-loop does not lose already-moved files. |
| N16 | `src/app/api/library/cover-upload/route.ts:61` | POST series cover upload | Removes `cover.*`/`folder.*` variants (57-60), writes `<folder>/cover.jpg` (61). | Insert **after line 61**: `void recordLibraryChange({ paths: [coverPath], seriesIds: [series.id], reason: 'series-cover', source: 'api/library/cover-upload:POST' });` |
| N17 | `src/app/api/library/cover-upload/route.ts:86` | DELETE revert series cover | `fs.remove(<folder>/cover.jpg)` (86). | Replace **line 86** with `const hadCover = await fs.pathExists(coverPath); if (hadCover) { try { await fs.remove(coverPath); } catch { /* best effort */ } }` and insert after it: `if (hadCover) void recordLibraryChange({ paths: [coverPath], seriesIds: [series.id], reason: 'series-cover-revert', source: 'api/library/cover-upload:DELETE' });` |
| N18 | `src/lib/pages/remove-pages-core.ts:92` | `removePagesFromIssue` (`POST /api/archive/remove-pages`, awaited). Callers: `issue/pages/route.ts:20`, `page-sweep.ts:93/138` per file | Engine rewrites CBZ in place or repacks RAR/7z to a sibling `.cbz` (`newFilePath`, 87-89). DB fixups follow. | Insert **after line 92** (end of the engine try/catch), before the index fixups: `void recordLibraryChange({ paths: newFilePath ? [issue.filePath, newFilePath] : [issue.filePath], seriesIds: [issue.seriesId], issueIds: [issueId], reason: 'remove-pages', source: \`remove-pages-core:${context}\` });` (`issue.filePath` is narrowed to `string` by the guard at 38; `Issue.seriesId` is non-null in Prisma.) Once per file; no finalize rule. |
| N19 | `src/lib/pages/insert-cover-core.ts:80` | `embedUploadedCoverIntoArchive` (`POST /api/archive/insert-cover`, awaited). Callers: `issue/cover-upload/route.ts:73`, `match-series/route.ts:653` | Engine inserts page 0 in place, or repacks RAR/7z to `.cbz` (75-77). | Insert **after line 80**: `void recordLibraryChange({ paths: newFilePath ? [issue.filePath, newFilePath] : [issue.filePath], seriesIds: [issue.seriesId], issueIds: [issueId], reason: 'insert-cover', source: \`insert-cover-core:${context}\` });` |
| N20 | `src/app/api/admin/diagnostics/route.ts:152` | POST `action=delete-duplicates` | `fs.remove(issue.filePath)` for authorized library children (152), then row delete (158). | After **line 146** (`let filesDeleted = 0;`): `const deletedFiles: string[] = [];`. After **line 153** (`filesDeleted++;`): `deletedFiles.push(issue.filePath);`. Before the AuditLogger at **161**: `if (deletedFiles.length) void recordLibraryChange({ paths: deletedFiles, reason: 'delete-duplicates', source: 'api/admin/diagnostics:delete-duplicates' });` |
| N21 | `src/app/api/admin/diagnostics/route.ts:200` | POST `action=delete-orphans` | `fs.remove(p)` for children of library roots **or** `UNMATCHED_DIR` (200) into `deletedPaths` (201). | Before the AuditLogger at **208**: `if (deletedPaths.length) void recordLibraryChange({ paths: deletedPaths, reason: 'delete-orphans', source: 'api/admin/diagnostics:delete-orphans' });` |
| N22 | `src/lib/metadata-fetcher.ts:89` | `syncSeriesMetadata` Metron cover write (not in the plan list; Node twin of engine `resolve_cover`). Only caller `request/route.ts:301` (fire-and-forget) | `fs.writeFile(<folderPath>/cover.<ext>)`. | Insert **after line 89**: `void recordLibraryChange({ paths: [path.join(folderPath, coverFileName)], seriesIds: [series.id], reason: 'series-cover', source: 'metadata-fetcher:metron' });` Low priority. |
| N23 | `src/lib/metadata-fetcher.ts:384` | `syncSeriesMetadata` ComicVine cover write | Same as N22. | Insert **after line 384**: `void recordLibraryChange({ paths: [path.join(folderPath, coverFileName)], seriesIds: [series.id], reason: 'series-cover', source: 'metadata-fetcher:comicvine' });` |

Awaited synchronous engine calls from Node, fully inventoried: mutating + wired = `/api/library/rename`
(N6), `/api/converter/convert-file` (N4), `/api/archive/remove-pages` (N18), `/api/archive/insert-cover`
(N19). Every `ENGINE_URL` call in `src/` was classified (42 call sites; see S20-S23).

---

## Table 2 — Node: skip (with reason) (28 rows)

| # | file:line | symbol | change | reason |
|---|---|---|---|---|
| S1 | `src/lib/importer.ts:369-498` (+ `:25`/`:398` `engineNestedArchives`) | batch → WATCHED routing | copy/move/AdmZip-extract/magic-fix into `WATCHED_DIR`; remove download source; sync `/api/importer/nested` with `dest_dir=WATCHED_DIR` | Staging only. The library write happens in engine `watched_sync::process_watched_folder` (E1). Plan says skip the batch return. |
| S2 | `src/lib/importer.ts:775/821/968` | `ensureDir(destFolder)`, `fixMagicNumberSync`, `ensureLocalCover` | mkdir, in-library extension rename, `cover.<ext>` sidecar | Part of the single-file import; covered by N2/N3 (`finalPath` is post-rename; cover is in the same folder). |
| S3 | `src/lib/converter.ts:64-219` | local temp work | `ensureDir`/extract/unrar/unar/sharp/`fs.remove(tempDir)` in `CACHE_DIR` | Outside library roots; library-visible result is N5. |
| S4 | `src/app/api/library/match-series/bulk/route.ts:52` | bulk Accept All / Assign to Series | calls the single POST (`applySingleMatch`) per item | Covered by N13 per item; debounce collapses. The new "Assign to Series" UI flow (commit `2ce1fb6`) is UI-only and posts to this route. |
| S5 | `src/app/api/library/match-series/route.ts:295/386/534/641` | `ensureLibraryDir`, conflict restore, per-issue sidecar | empty-folder mkdir; restore loose file to /unmatched; `CONFIG_DIR/uploads/issue-covers/<id>.jpg` | Empty dirs are not books; the restore's library-side path is already flushed at 398 (N13); sidecar is not in a library. |
| S6 | `src/app/api/library/series/attachments/route.ts:70` (POST local) | `attachLocal` | calls `attachAsCollected` | Covered by N15. |
| S7 | `src/app/api/library/series/attachments/route.ts:101/218`, `src/lib/match-collision.ts:129` | `POST /api/metadata/attach-sync` (awaited) | engine `attached_volumes` claims/creates rows | DB-only: `attached_volumes.rs` has no production fs writes. PUT absorb (289-353) and DELETE detach (360+) are DB-only; `queueSeriesJsonExport` = series.json (out of scope). |
| S8 | `src/lib/pages/page-sweep.ts:93/138`, `src/app/api/library/issue/pages/route.ts:20`, `src/lib/queue.ts:708` PAGE_SWEEP | page sweep / editor | `removePagesFromIssue` per file | Covered by N18 per file; plan has no finalize rule. Tests inject a mock `removeFn`. |
| S9 | `src/app/api/library/issue/cover-upload/route.ts:56-57/99` | POST/DELETE issue cover sidecar | write/unlink `CONFIG_DIR/uploads/issue-covers/<id>.jpg` | Not in a library root. `embedInArchive` (73) is covered by N19. |
| S10 | `src/app/api/admin/diagnostics/route.ts:166-177` | `action=delete-ghosts` | Series/Issue row deletes | DB-only (ghosts have no file). |
| S11 | `src/app/api/admin/cleanup-duplicates/route.ts:38` | GET cleanup duplicate LOCAL series | `prisma.series.deleteMany` | DB-only. |
| S12 | `src/app/api/admin/restore/route.ts:11`, `src/app/api/admin/backup/route.ts`, `queue.ts:588` DATABASE_BACKUP | restore / backup | row upserts; engine writes backups dir | DB-only / outside library roots. (A restore can change Library rows; that is a Komga mapping/reconcile concern, not Phase 2.) |
| S13 | `src/lib/utils/safe-fs.ts` | `moveFileSafe`, `safeRelocateFolder`, `cleanupEmptyDirs`, `ensureLibraryDir` | generic move/merge/cleanup | Callers emit (N7, N9, N13, N14, N15); emitting here would double-count and lose `reason`. Full caller list verified: match-series 295/386/398/407/534/538, update 102, issue/link 124, rename 281, match-collision 210/211/264. |
| S14 | `src/app/api/admin/upload/route.ts:110-300` | chunked manual upload | `.part` streams, stale sweeps, final move into WATCHED/UNMATCHED (290), park in `download_path` (261) then `Importer.importRequest` (266) | All staging; the direct-to-request library write is N2/N3; watched drops are E1. |
| S15 | `admin/manual-import/route.ts:37`, `admin/download/auto-import/route.ts:37`, `request/manual/route.ts:248/292`, `request/retry/route.ts:92/123/144/222`, `cron.ts:139/384`, `queue.ts:393` SEARCH_AND_DOWNLOAD | import entry points | call `Importer.importRequest` / `DownloadService` | No fs ops of their own (grep-verified); covered by N2/N3. |
| S16 | `src/lib/download-clients.ts:333-508` (+ engine `/api/download/stream` at 397) | `downloadDirectFile` | `.part` writes/renames in `<download_path>/GetComics` | Download staging, outside roots. |
| S17 | `src/lib/utils/usenet-cleanup.ts:78` | `deleteUsenetSource` | `fs.remove` of client download folder | Explicitly refuses any path overlapping a library root or WATCHED_DIR (66-73). |
| S18 | `reader/image/route.ts:21-103`, `library/cover/route.ts:44/82-86`, `logger.ts`, `user/profile/route.ts:133-159`, `trophies/route.ts:40-44` | cache / log / uploads housekeeping | CACHE_DIR, LOGS_DIR, CONFIG uploads | Never inside a library root. |
| S19 | `src/lib/metadata-fetcher.ts:61/356` | `mkdirSync(folderPath)` | creates an empty series folder | Empty dir is not a book; cover writes are N22/N23. |
| S20 | `src/lib/queue.ts:623` CBR_CONVERSION, `:649` WATCHED_FOLDER_SYNC, `:661` LIBRARY_SCAN (+ `library-scanner.ts:41/63`), `:733` METADATA_SYNC, `:770` EMBED_METADATA, `:476` UNMATCHED_SWEEP; `src/app/api/library/repack/route.ts:25` | detached engine jobs (202 handoff) | engine-side conversions/moves/embeds/cover writes | Engine leaves emit (E1, E3-E7). Node enqueue sites need nothing: `issue/route.ts:460`, `issue/bulk:50`, `update:221`, `refresh-metadata:31`, `match-series:606/717/726`, `importer:455/991`, `metadata-fetcher:300/590`. UNMATCHED_SWEEP/matcher is DB-only (no fs writes in `matcher.rs`). |
| S21 | `src/lib/queue.ts:821` EXPORT_SERIES_JSON | `/api/metadata/export-series-json` (awaited) | writes `series.json` | Out of scope per plan (sidecar rewritten in place). |
| S22 | `src/lib/queue.ts:860` SERIES_MONITOR | `/api/monitor/sync` (awaited) | DB skeletons + download queueing | No fs writes in `monitor.rs`; files land via importer. |
| S23 | other engine calls | `/api/reader/*`, `/api/archive/find-page`, `/api/converter/extract-cover`, `/api/search/*`, `/api/automation/search`, `/api/getcomics/scrape`, `/api/diagnostics/*`, `/api/discover/*`, `/api/health/auth` | — | Read-only, DB-only, network-only, or report-only (orphans returns a list). |
| S24 | `library/issue/route.ts` PATCH, `issue/bulk/route.ts`, `library/refresh-metadata`, `library/refresh-series`, `library/route.ts` PATCH (monitor/manga/status) | metadata edits | DB writes + EMBED/METADATA enqueue | No direct fs; engine leaf emits for the embed. |
| S25 | `src/app/api/library/series/route.ts:137/191/310` (GET) | twin/dedupe cleanup | `prisma.issue.deleteMany` | DB-only (readdir/access only at 208/333). |
| S26 | read-only fs hits (grouped) | health-checker, admin/requests:110, admin/unmatched:37-40, notifications:113, match-prefill, archive-pages, chunk-session `open 'r'`, mailer:209, opds, download, uploads, archive-preview/cover, library-scanner, duplicate-detector, manga-detector, metadata-extractor (AdmZip reads) | stat/readdir/read | Read-only. |
| S27 | false positives | `layout.tsx:116` classList.remove; BullMQ `job.remove()` in request/route:714, request/retry:43; comment-only hits | — | Not filesystem mutations. |
| S28 | `src/app/api/library/match-series/route.ts:240` attach mode | collision `attach` branch | delegates to `attachAsCollected` then returns | Covered by N15. |

---

## Table 3 — Engine: emit leaves (8 rows)

| # | file:line | symbol | change | exact edit |
|---|---|---|---|---|
| E0 | `omnibus-engine/src/main.rs:1-27, 452-454` | `run()` infra | start drain with a `Db` clone | Add `mod library_events;` to the module list (e.g. after `mod log_forward;` at 25). After line **454** (`log::info!("✅ Connected to the database ...")`): `library_events::spawn_drain(db.clone());` (`db` is moved into `AppState` at 486, so clone before that.) |
| E1 | `omnibus-engine/src/watched_sync.rs:176/365/375/522` | `process_watched_folder` | `robust_move(path → final_dest)` into `<library>/<pattern>`; sibling images to `dest_folder` (375, result discarded today); Series/Issue upserts; spawns `sync_metadata` at 525. Old paths are under WATCHED (outside roots). | After **176**: `let mut imported_paths: Vec<String> = Vec::new();`. First line inside `if robust_move(&path, &final_dest).is_ok() {` (**365**): `imported_paths.push(final_dest.to_string_lossy().into_owned());`. Replace **375** `let _ = robust_move(&sib_path, &sib_dest);` with `if robust_move(&sib_path, &sib_dest).is_ok() { imported_paths.push(sib_dest.to_string_lossy().into_owned()); }`. Before **522** (`if !synced_series_ids.is_empty() {`, which consumes the set at 523): `if success_count > 0 { crate::library_events::emit("watched-import", imported_paths, synced_series_ids.iter().cloned().collect()); }` (Paths are pushed even when the Issue upsert at ~500 fails: the file is already in the library.) |
| E2 | `omnibus-engine/src/metadata_writer.rs:894` | `inject_xml_into_zip` (enabling change; never emits itself) | ComicInfo rewrite via tmp+rename; byte-identical skip returns `true` today (924) | Add `#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub(crate) enum EmbedOutcome { Written, Unchanged }`; signature `fn inject_xml_into_zip(file_path: &str, generated_xml: &str) -> Option<EmbedOutcome>` (`None` = failed, logging unchanged). Returns: 905 `return false` → `return None`; 924 `return true` → `return Some(EmbedOutcome::Unchanged)`; 961 `Ok(_) => true` → `Ok(_) => Some(EmbedOutcome::Written)`; 965 `false` → `None`; 972 `false` → `None`. Callers/tests: see last section. |
| E3 | `omnibus-engine/src/metadata_writer.rs:175-201` | `process_embed_job` (reached by `handle_metadata_embed` main.rs:1300, every `sync_metadata_attempt` metadata.rs:490 incl. 30-min retries at 540, and the watched-spawned sync) | Writes ComicInfo per archive; `write_series_json` once per series | 175-180: `tokio::task::spawn_blocking(move \|\| { let outcome = inject_xml_into_zip(&task.file_path, &task.xml_content); (outcome, task.series_id, task.file_path) }).await.unwrap_or((None, String::new(), String::new()))`. After 187: `let mut changed_paths: Vec<String> = Vec::new(); let mut changed_series: HashSet<String> = HashSet::new();`. 190-191: `if let Ok((outcome, series_id, file_path)) = res { match outcome { Some(EmbedOutcome::Written) => { success_count += 1; changed_series.insert(series_id.clone()); changed_paths.push(file_path); } Some(EmbedOutcome::Unchanged) => success_count += 1, None => fail_count += 1 }` (series.json block 193-197 unchanged). Before **201** `Ok((success_count, …))`: `if !changed_paths.is_empty() { crate::library_events::emit("metadata-embed", changed_paths, changed_series.into_iter().collect()); }` Return tuple and both production callers unchanged. |
| E4 | `omnibus-engine/src/converter.rs:297-384` | `process_cbr_sweep` (detached `handle_cbr_sweep` main.rs:633) | `process_archive` writes `.cbz`, deletes `.cbr/.rar/.cb7`; then `UPDATE Issue` | 297 and 303: `SELECT id, "seriesId", "filePath" FROM "Issue" …`. After 327: `let series_id: String = row.get("seriesId");`. 336: `Ok(Ok(new_path)) => Ok((issue_id, series_id, file_path, new_path.to_string_lossy().to_string())),`. After 345: `let mut changed_paths: Vec<String> = Vec::new(); let mut changed_series: std::collections::HashSet<String> = Default::default();`. 350: `Ok(Ok((issue_id, series_id, old_path, new_path))) => { if old_path != new_path { changed_paths.push(old_path); } changed_paths.push(new_path.clone()); changed_series.insert(series_id);` then the existing pages/UPDATE body. Before **384**: `if !changed_paths.is_empty() { crate::library_events::emit("cbr-convert", changed_paths, changed_series.into_iter().collect()); }` (Recorded even if the DB UPDATE fails; the file changed.) |
| E5 | `omnibus-engine/src/main.rs:1146-1210` | `handle_repack` spawned loop (detached) | `process_archive` per issue (in-place WebP/flatten or CBR→CBZ), then `UPDATE Issue` | Before 1146: `let mut changed_paths: Vec<String> = Vec::new(); let mut changed_series: std::collections::HashSet<String> = Default::default();`. 1146: `let mut targets: Vec<(String, String, String)> = Vec::new();`. 1154: `targets.push((series_id.clone(), issue.get("id"), issue.get("filePath")));`. 1162: `for (series_id, issue_id, file_path) in targets {`. 1168: `(series_id, issue_id, file_path, result)`. 1173: `let (series_id, issue_id, file_path, result) = match res {`. After **1179** (`let new_path_str = …`): `if file_path != new_path_str { changed_paths.push(file_path.clone()); } changed_paths.push(new_path_str.clone()); changed_series.insert(series_id.clone());`. Before **1210** (`let duration_ms`): `if !changed_paths.is_empty() { crate::library_events::emit("repack", changed_paths, changed_series.into_iter().collect()); }` |
| E6 | `omnibus-engine/src/converter.rs:1620-1624` | `ensure_folder_cover` (only caller: scanner cover backfill scanner.rs:2504 in `spawn_blocking`, from detached `handle_scan`) | writes `<folder>/cover.{jpg,png,webp}`; early return at 1596-1599 when a cover already exists | In `Ok(_) => {` at **1621**, after the `log::info!` (1622) and before `Some(dest)` (1623): `crate::library_events::emit("cover-extract", vec![dest.to_string_lossy().into_owned()], Vec::new());` (`emit` is a sync unbounded send; safe on a blocking thread. Optional: add `series_id: Option<&str>` param, pass `Some(&id)` from scanner.rs:2504 and `None` in the test at converter.rs:2607.) |
| E7 | `omnibus-engine/src/metadata.rs:1763-1812` | `resolve_cover` (callers `fetch_comicvine` :626, `fetch_metron` :1297; both have `series_id: &str`) | `std::fs::write(<folder>/cover<ext>)` unconditionally on every sync (1800) | Signature: add `series_id: &str` after `client` (7 params, under clippy's `too_many_arguments` threshold); update 626 → `resolve_cover(client, series_id, image_url.as_deref(), …)` and 1297 → `resolve_cover(client, series_id, cover_remote.as_deref(), …)`. Replace 1799-1802 with: `let cover_path = Path::new(folder_path).join(format!("cover{}", ext)); let cover_url = format!("/api/library/cover?path={}", urlencoding::encode(&cover_path.to_string_lossy())); let unchanged = std::fs::metadata(&cover_path).map(\|m\| m.len() == bytes.len() as u64).unwrap_or(false) && std::fs::read(&cover_path).map(\|old\| old[..] == bytes[..]).unwrap_or(false); if unchanged { log::debug!("[Metadata] Cover unchanged at {:?}; skipping write.", cover_path); return Some(cover_url); } if std::fs::write(&cover_path, &bytes).is_ok() { crate::library_events::emit("cover-download", vec![cover_path.to_string_lossy().into_owned()], vec![series_id.to_string()]); return Some(cover_url); }` |

### Engine — do not emit (9 rows)

| # | file:line | symbol | reason |
|---|---|---|---|
| D1 | `converter.rs:388` | `process_archive` | Shared helper. Callers emit (E4, E5). Its third caller `handle_convert_file` (main.rs:1069) is awaited by Node (N4); emitting here would double-emit. Edge: rename (492) OK but `remove_file` (494) fails → `Err` with a new `.cbz` on disk and no emit; rare, Komga periodic scan is the backstop. |
| D2 | `renamer.rs:260` | `run_bulk_rename` | Only production caller is the synchronous `handle_bulk_rename` (main.rs:1040); Node owns the event (N6). |
| D3 | `metadata_writer.rs:714/763` | `write_series_json` / `run_series_json_export` | Out of scope per plan; rewrites on every embed with no byte compare (would emit on every sync). Known gap: a series.json-only change waits for another change or Komga's periodic scan. |
| D4 | `main.rs:778/827/1069/1327` | `handle_insert_cover`, `handle_remove_pages`, `handle_convert_file`, `handle_export_series_json` | Synchronous endpoints Node awaits; Node emits (N19, N18, N4) or out of scope (series.json). `insert_cover_into_archive`/`remove_pages_from_archive` do not go through `process_archive`. |
| D5 | `main.rs:991`, `converter.rs:1713/1736/1772`, `main.rs:1777` + `download.rs`, `converter.rs:216` via `watched_sync.rs:124`, `watched_sync.rs:89-90/331/572` | nested-archive extraction, magic-ext fix, download stream, watched phase-1 CBR conversion, `move_to_unmatched`, dir creation | Write only to WATCHED, UNMATCHED, staging, or create empty dirs. |
| D6 | `metadata.rs:528-548`, `watched_sync.rs:525` | 30-min rate-limit retry; watched-spawned `sync_metadata` | Reach E3/E7 leaves, which emit. |
| D7 | `metadata.rs:1768` | `create_dir_all(folder_path)` in `resolve_cover` | Empty dir. |
| D8 | `backup.rs:192-212` | backup write/rotation | Backups dir. |
| D9 | `scanner.rs` (except E6), `matcher.rs`, `attached_volumes.rs`, `monitor.rs`, `diagnostics.rs`, `discover.rs` | scans, sweeps, syncs | No production fs writes (verified across every non-test region, including scanner.rs's mid-file `#[cfg(test)]` items at 484/1167 and main.rs's at 195/232/325/1108; main.rs and scanner.rs contain no direct fs writes at all). |

Engine mutation coverage check: every non-test `fs::write/rename/remove*/copy/create_dir*`,
`File::create`, `robust_move`, `move_file` in `omnibus-engine/src` maps to E1-E7 or D1-D9.

---

## Engine plumbing facts

- **log_forward pattern** (`log_forward.rs`): `static SENDER: OnceLock<UnboundedSender<LogLine>>` +
  `static RECEIVER: OnceLock<Mutex<Option<UnboundedReceiver<LogLine>>>>` (21-22). `init()` (79) runs
  synchronously in `main()` (main.rs:353) before the runtime exists; `spawn_forwarder()` (94) is the first
  line of `run()` (main.rs:450), takes the receiver out of the mutex (second call no-op), reads
  `OMNIBUS_NODE_URL` (default `http://localhost:3000`, trailing `/` trimmed) and `NEXTAUTH_SECRET`
  (`.ok().filter(|s| !s.is_empty())`), then `tokio::spawn`s a loop with its own
  `reqwest::Client::builder().timeout(5s)`, blocks on `rx.recv()`, `try_recv`-drains up to 100 lines,
  POSTs `{"lines":[…]}` to `/api/internal/log` with `X-Internal-Secret` (omitted when unset), ignores
  errors. `SKIP_TARGETS` (27) includes `omnibus_engine::log_forward`; `library_events`' own log lines
  will be forwarded, which is fine.
- **library_events shape** (recommended): no pre-runtime `init()` needed (emits originate only from
  HTTP-triggered jobs after `axum::serve`). `pub fn emit(reason: &'static str, paths: Vec<String>,
  series_ids: Vec<String>)` → no-op on empty input or when `SENDER` is unset (so all existing engine
  tests need no change); `pub fn spawn_drain(db: crate::db::Db)` creates the channel, sets `SENDER`
  (return if already set), spawns: block on first event, then `tokio::time::timeout_at(first+3s, rx.recv())`
  until 3 s or 500 paths; drop the batch when `komga_enabled != 'true'` (TTL ~60 s cache local to the
  task); POST `{"events":[{reason, paths, seriesIds}]}` (chunk ≤500 paths per body) via
  `crate::shared_http_client()` with `.header("X-Internal-Secret", …).timeout(10s)`; 2 retries
  (e.g. 2 s, 5 s) on error/non-2xx; `log::warn!` on final failure. Keep pure cores
  (`komga_enabled_value(Option<&str>) -> bool`, the coalesce/chunk fn) unit-tested; CI runs
  `clippy -D warnings`, so every item must be used.
- **Db handle**: `let db = connect_with_retry(&db_url, db_connections).await?;` (main.rs:452) →
  `db::Db` is `#[derive(Clone)]` with `pub pool: AnyPool`, `pub dialect: Dialect` (db.rs:26-29). Moved
  into `AppState` at 486 → clone before.
- **Settings read**: no crate-wide helper. The closest is the **private**
  `metadata_cache::setting(db: &Db, key: &str) -> Option<String>` (metadata_cache.rs:93-100):
  `sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = $1"#).bind(key).fetch_optional(&db.pool).await.ok().flatten()`.
  Inline literal form used elsewhere (metadata_writer.rs:492, metadata.rs:337, scanner.rs:2477).
  Recommended in the drain: `… WHERE key = 'komga_enabled' …`, `.as_deref() == Some("true")`. Optional:
  read both keys with `SELECT key, value FROM "SystemSetting" WHERE key IN ('komga_enabled','komga_scan_on_change')`
  (Node keys confirmed in `src/lib/komga/constants.ts:10/14`); Node's `recordLibraryChange` re-checks
  both anyway. Quoting is identical on Postgres and SQLite under AnyPool; placeholders `$1..$N`.
- **Node URL + secret**: `OMNIBUS_NODE_URL` (default `http://localhost:3000`, trim trailing `/`) and
  `NEXTAUTH_SECRET`. `notify_node` uses the raw untrimmed value (`unwrap_or_default()`, skip when empty);
  `AppState.internal_secret` (main.rs:465-469) is the trimmed, placeholder-filtered value used for
  *inbound* auth. Use the `notify_node` semantics for outbound.
- **notify_node shape** (main.rs:608-631): skip with `log::debug!` if secret empty; POST
  `{node}/api/internal/notify` via `shared_http_client()` (main.rs:39, `pub(crate)`, process-wide
  `OnceLock<reqwest::Client>`), `.header("X-Internal-Secret", &secret).json(&{"event", "payload":{"description"}}).timeout(10s)`;
  warn on non-2xx and send errors; never fatal. Node side: `src/app/api/internal/notify/route.ts`
  checks `secretsMatch(request.headers.get('x-internal-secret'), process.env.NEXTAUTH_SECRET)` from
  `@/lib/api-auth`; `src/middleware.ts:37` exempts the whole `/api/internal` prefix, so the new
  `/api/internal/library-changed` route needs only the same guard + hand validation + 202.

## inject_xml_into_zip callers/tests to update

Only `metadata_writer.rs` references it.

- Production: `metadata_writer.rs:176` (inside the `spawn_blocking` closure, 175-180) and the
  `unwrap_or((false, String::new()))` at 180 plus the join loop 189-199 (see E3).
- Tests:
  - `:998` (4 concurrent threads, each different XML) → keep the closure; change the assertion at
    **`:1002`** `assert!(thread.join().unwrap())` → `assert!(thread.join().unwrap().is_some())`.
  - **`:1037`** same XML → `assert_eq!(inject_xml_into_zip(path.to_str().unwrap(), "<ComicInfo>OLD</ComicInfo>"), Some(EmbedOutcome::Unchanged));`
  - **`:1041`** new XML → `assert_eq!(inject_xml_into_zip(path.to_str().unwrap(), "<ComicInfo>NEW</ComicInfo>"), Some(EmbedOutcome::Written));`
  - **`:1195`** → `assert!(inject_xml_into_zip(cbz.to_str().unwrap(), &with_extras).is_some());`
- `process_embed_job` tests need no edits (`metadata_writer.rs:1126/1169/1183/1202/1288/1315`,
  `scanner.rs:4144/4270`); `:1315-1319` asserts `ok_c == 2` on an unchanged re-embed, which is why
  `Unchanged` must still count toward `success_count`.

---

## Disagreements between sweeps A and B, settled from the code

| site | A | B | settled |
|---|---|---|---|
| importer standardize | emit after 678 | after 694 | **A** — the catch at 696 swallows DB errors; the disk move is done at 678. |
| converter local | before `return` 212 | before `return` 213 | **neither** — after 201 (post-`fs.remove`, pre-DB repoint), so a repoint throw cannot skip it. |
| rename engine old paths | hoist `seriesList` | separate snapshot | **B** (+ A's `data.newPath`), with `.catch(() => [])`; breaks `rename.test.ts:97` either way. |
| rename local | push after 263, emit after audit | push after 263, emit before audit | push right after the `fs.move` at **257**; emit **before** audit (288). |
| issue link | same-folder rename | "into the official series folder" | **A** (`activeFolderPath = dirname(oldFilePath)`, line 50). |
| library/route DELETE | after audit 493 | after deleteMany 487 | **after 484**, before the row deletes. |
| match-series | per-mutation paths, one emit at 753 | one folder-level emit at 756; claims end is always reached | B's claim is **wrong**: the relocate (407) and repoint (413-435) are outside the swallowing try (439-683). Use the N13 `flushChanges` scheme. |
| cover-upload DELETE | emit only if a cover existed | unconditional | **A**. |
| cores seriesId | `issue.seriesId` | guarded | `Issue.seriesId` is non-null → unguarded is fine. |

## Open decisions / uncertain items

1. **Mark-all fallback vs `/unmatched`-only calls (needs a decision in `changes.ts`, owned by the team
   editing `src/lib/komga/*`).** PLAN says "if nothing resolves but paths/seriesIds were given, mark every
   Omnibus library dirty". Several wired sites can legitimately pass only out-of-root paths: N16/N17 on a
   series folder inside `/unmatched`, N21 orphans under `UNMATCHED_DIR`, N9 inside an unmatched series,
   N10 with a client-supplied path. Recommendation: apply mark-all only to inputs that cannot be
   classified (missing series row, empty `folderPath` with null `libraryId`); silently drop paths that are
   positively outside every root. Otherwise unmatched-only operations trigger all-library Komga scans.
2. `recordLibraryChange` must wrap its entire body (including the settings-cache read) in try/catch:
   every caller uses `void`, so a rejection becomes an unhandled rejection that fails vitest. Tests that
   execute the new calls (add `vi.mock('@/lib/komga/changes', () => ({ recordLibraryChange: vi.fn() }))`
   to keep them deterministic and to avoid the async resolution consuming `mockResolvedValueOnce` chains
   on partial `@/lib/db` mocks): `__tests__/api/{rename,issue-move,library-route,match-series,
   match-series-bulk,match-series-collision,series-update-lock,series-attachments,cover-upload,
   diagnostics,issue-pages-removal,issue-cover-upload-embed,page-sweep-routes,admin-upload,
   request-retry}.test.ts`, `__tests__/lib/{importer,converter-engine,insert-cover-core,match-collision,
   metadata-fetcher,page-sweep,cron}.test.ts`. The only assertion known to break is
   `rename.test.ts:97` (N6 adds a `series.findMany`).
3. Remaining partial-failure gaps (flagged, not fixed above): rename local — a `prisma.series.update`
   throw at 271 exits to the outer catch with moved files unrecorded (fix: declare `changedPaths` before
   the outer try and also emit in the catch); library/route DELETE — an `fs.remove` throw mid-loop loses
   earlier deletes (try/finally); attachAsCollected — see N15 hardening.
4. Folder paths in `pendingPaths` (series deletes N11/N12, relocates N1/N14, rename engine N6, match
   relocate N13) must be treated as prefixes by Phase 3 verification, not as book URLs.
5. N4/N5 duplicate N2 for the importer's conversion (only caller `importer.ts:829`); intentional, the
   debounce absorbs it, and it keeps the plan's "emit after awaited convert-file" rule.
6. Engine granularity: one emit per job/series after the join loops (E3-E5), so Komga never scans a
   half-rewritten library mid-job; a crash mid-job emits nothing (Komga's periodic scan is the backstop).
   Flush every 500 paths inside the loops if incremental progress is wanted.
7. Unrelated latent bug (not part of this task): `watched_sync.rs:268`
   `target_lib_id = series_row.get("libraryId")` decodes into `String`, but `Series.libraryId` is
   `String?`; a NULL panics the watched-sync task. Fix with `try_get::<Option<String>, _>`.
8. Pre-existing, out of scope: DELETE `/api/library/issue` unlinks a client-supplied `fullPath` with no
   `isPathWithinRoots` check (the diagnostics deletes do check).
9. `resolve_cover` can leave both `cover.jpg` and `cover.png` when the provider's content type changes;
   pre-existing, out of scope.
