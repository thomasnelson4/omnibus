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
