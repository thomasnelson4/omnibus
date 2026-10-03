# Komga integration — shared module contract (all phases)

Worktree: /Users/thomas/orca/workspaces/omnibus/komga-integration (branch komga-integration).
Plan: docs/komga-integration/PLAN.md (v2). Research notes (read-only hints, never commit):
docs/komga-integration/research/*.md. Komga 1.28.1 source (READ-ONLY):
/Users/thomas/repos/sbx/omnibus-references/komga (OpenAPI: docs/openapi.json).
Where PLAN.md and the code disagree, the code wins — report the deviation in your final answer
(the coordinator writes PLAN.md §15; do not edit PLAN.md yourself).

Toolchain: `export PATH=/opt/homebrew/opt/node@22/bin:$HOME/.cargo/bin:$PATH` before any npm/npx/
vitest/cargo command (Node 26 breaks jsdom). Run single test files with
`npx vitest run --pool=forks <file>`. `curl`/`wget` inside Bash are blocked by a hook — use `node -e`
with fetch, or the ctx_execute tool, for HTTP. Never `git commit`, never `git stash`, never push,
never touch other worktrees or the reference checkout. Never run `prisma format` (it reformats the
whole schema). The Prisma schema (all §7 models) is ALREADY in place and generated — do not edit
prisma/schema.prisma unless your slice says so.

## Conventions (verified in the code)
- DB: `import { prisma } from '@/lib/db'`. systemSetting reads are transparently decrypted for keys in
  `SECRET_SETTING_KEYS` (src/lib/secret-keys.ts) by a Prisma $extends hook.
- Logging: `import { Logger } from '@/lib/logger'`; `Logger.log(message, 'info'|'error'|'success'|'warn'|'debug')`.
  Prefix every Komga message with `[Komga]`. NEVER log the API key, request headers or full URLs with
  query strings carrying secrets.
- Audit: `import { AuditLogger } from '@/lib/audit-logger'` (see its `log(...)` signature).
- Library roots: `getLibraryRoots()` from '@/lib/library-roots'; `isPathWithinRoots` from '@/lib/utils/paths'.
- Routes: inline ADMIN check exactly like src/app/api/admin/prowlarr/indexers/route.ts (setup_complete
  gate + getServerSession(getAuthOptions()) + role === 'ADMIN'). No zod; validate by hand.
- Tests: vitest, `__tests__/**`. Global mocks in `__tests__/helpers/setup-global.ts` (logger, audit,
  auth options, notifications, next/cache). No test uses a real DB: mock `@/lib/db` per file
  (`vi.mock('@/lib/db', () => ({ prisma: {...} }))`). Look at neighbouring tests for the style.
- Module state that must survive across route bundles / the instrumentation bundle lives on
  `globalThis` (pattern: `const g = globalThis as unknown as { __komgaX?: ... }`).
- Style: match neighbouring files (4-space indent in most of src/lib and routes; check the file you
  edit). Comments explain *why*, sparingly.

## File ownership map (one owner per file; read anything, edit only what you own)
src/lib/komga/
- constants.ts            — timing/caps/version constants + setting key names         [P1 client slice]
- types.ts                — hand-written Komga DTOs + KomgaError                      [P1 client slice]
- client.ts               — KomgaClient, buildKomgaUrl, SSE parser                    [P1 client slice]
- path-map.ts             — normalizer, mapping, isKomgaScannable                     [P1 paths slice]
- libraries.ts            — KomgaLibrary cache refresh, Omnibus↔Komga library mapping, library warnings [P1 paths slice]
- settings.ts             — settings read (fresh + hot cached flags), custom headers   [P1 service slice]
- factory.ts              — getKomgaClient(settings?) from saved settings              [P1 service slice]
- connection-test.ts      — testKomgaConnection(...)                                  [P1 service slice]
- settings-hooks.ts       — save-time gate + on-change hooks                           [P1 service slice]
- queue.ts                — omnibus-komga Queue + enqueue helpers (lazy Redis)         [P1 service slice]
- worker.ts               — initKomgaWorker (Worker, flush interval, repeatable)       [P2]
- changes.ts              — recordLibraryChange (HOT PATH: db/logger/settings/library-roots only) [P2]
- flush.ts                — isLibraryDue (pure) + flushDueLibraries                    [P2]
- sync.ts                 — runLibrarySync stage machine                               [P2/P3/P4]
- reconcile.ts, verify.ts, id-map.ts                                                   [P3]
- readlist-resolver.ts, readlist-push.ts, readlist-trigger.ts (HOT PATH, lazy queue import) [P4]
- health.ts                                                                             [P5]

## Exact P1 interfaces

### constants.ts
```ts
export const KOMGA_QUEUE_NAME = 'omnibus-komga';
export const KOMGA_KEYS = {
  enabled: 'komga_enabled', url: 'komga_url', apiKey: 'komga_api_key',
  pathMappings: 'komga_path_mappings', scanOnChange: 'komga_scan_on_change',
  readListsEnabled: 'komga_readlists_enabled', instanceId: 'komga_instance_id',
} as const;
export const KOMGA_SETTING_KEYS: readonly string[] = Object.values(KOMGA_KEYS);
export const KOMGA_MIN_VERSION = '1.20.0';
export const KOMGA_RECOMMENDED_VERSION = '1.23.5';
export const KOMGA_READLIST_MIN_VERSION = '1.23.3';
export const KOMGA_DEBOUNCE_MS = 60_000;
export const KOMGA_MAX_WAIT_MS = 600_000;
export const KOMGA_FLUSH_INTERVAL_MS = 30_000;
export const KOMGA_LEASE_MS = 30 * 60_000;
export const KOMGA_PRE_IDLE_RECHECK_MS = 30_000;
export const KOMGA_PRE_IDLE_CAP_MS = 10 * 60_000;
export const KOMGA_SETTLE_INITIAL_DELAY_MS = 15_000;
export const KOMGA_SETTLE_RECHECK_MS = 20_000;
export const KOMGA_SETTLE_CAP_MS = 15 * 60_000;
export const KOMGA_SETTLE_FIXED_FALLBACK_MS = 90_000;
export const KOMGA_BACKOFF_BASE_MS = 60_000;          // 1, 2, 4 … min
export const KOMGA_BACKOFF_CAP_MS = 30 * 60_000;
export const KOMGA_RECONCILE_INTERVAL_MS = 24 * 3600_000;
export const KOMGA_PENDING_PATH_CAP = 200;
export const KOMGA_HTTP_TIMEOUT_MS = 10_000;
export const KOMGA_BOOKS_PAGE_TIMEOUT_MS = 60_000;
export const KOMGA_BOOKS_PAGE_SIZE = 1000;            // Komga clamps at 2000
export const KOMGA_SSE_TIMEOUT_MS = 25_000;
export const KOMGA_VERIFY_MAX_RETRIES = 2;            // 2nd retry scans deep=true
export const KOMGA_VERIFY_MTIME_SLACK_MS = 2_000;
export const KOMGA_OVERFLOW_STAT_LIMIT = 500;
export const KOMGA_DB_CHUNK = 500;
export const KOMGA_READLIST_DEBOUNCE_MS = 10_000;
export const KOMGA_DELETE_REMOTE_ON_UNSYNC = true;
export const KOMGA_DEEP_SCAN_DEFAULT = false;
export const KOMGA_SETTINGS_CACHE_TTL_MS = 10_000;    // hot-path flag cache
```
(Add more constants if needed; never rename these.)

### types.ts  (hand-written; verify every field name against docs/openapi.json AND the Kotlin DTOs)
```ts
export interface KomgaLibraryDto { id: string; name: string; root: string;
  importComicInfoBook: boolean; importComicInfoSeries: boolean; importComicInfoCollection: boolean;
  importComicInfoReadList: boolean; importComicInfoSeriesAppendVolume?: boolean; importEpubBook: boolean; importEpubSeries: boolean;
  importMylarSeries: boolean; importLocalArtwork: boolean; importBarcodeIsbn: boolean;
  scanForceModifiedTime: boolean; scanInterval?: string; scanOnStartup: boolean; scanCbx: boolean; scanPdf: boolean; scanEpub: boolean;
  scanDirectoryExclusions: string[]; repairExtensions: boolean; convertToCbz: boolean; emptyTrashAfterScan: boolean;
  seriesCover?: string; hashFiles: boolean; hashPages: boolean; hashKoreader?: boolean; analyzeDimensions: boolean;
  oneshotsDirectory: string | null; unavailable: boolean; }        // adjust to the spec; keep these names
export interface KomgaWebLinkDto { label: string; url: string }
export interface KomgaBookMetadataDto { title: string; number: string; numberSort: number; links: KomgaWebLinkDto[]; isbn: string; /* … */ }
export interface KomgaBookDto { id: string; seriesId: string; seriesTitle: string; libraryId: string; name: string;
  url: string; number: number; created: string; lastModified: string; fileLastModified: string; sizeBytes: number;
  size: string; media: { status: string; mediaType: string; pagesCount: number; /* … */ };
  metadata: KomgaBookMetadataDto; deleted: boolean; fileHash: string; oneshot: boolean; }
export interface KomgaReadListDto { id: string; name: string; summary: string; ordered: boolean; bookIds: string[];
  createdDate: string; lastModifiedDate: string; filtered: boolean; }
export interface KomgaReadListCreateDto { name: string; summary: string; ordered: boolean; bookIds: string[] }
export interface KomgaReadListUpdateDto { name?: string; summary?: string; ordered?: boolean; bookIds?: string[] }
export interface KomgaUserDto { id: string; email: string; roles: string[]; sharedAllLibraries: boolean;
  sharedLibrariesIds: string[]; labelsAllow: string[]; labelsExclude: string[];
  ageRestriction: { age: number; restriction: string } | null; }
export interface KomgaPage<T> { content: T[]; totalElements: number; totalPages: number; number: number;
  size: number; numberOfElements: number; first: boolean; last: boolean; empty: boolean; }
export interface KomgaTaskQueueStatus { count: number; countByType: Record<string, number> }
export type KomgaErrorKind = 'unreachable' | 'unauthorized' | 'forbidden' | 'notFound' | 'badRequest' | 'server' | 'timeout';
export class KomgaError extends Error {
  readonly status: number | null; readonly kind: KomgaErrorKind;
  constructor(kind: KomgaErrorKind, status: number | null, message: string);
}
export function isKomgaError(e: unknown): e is KomgaError;
```

### client.ts
```ts
export interface KomgaClientOptions {
  baseUrl: string;                 // may include a sub-path: http://host/komga
  apiKey: string;
  headers?: Record<string, string>;  // global custom headers (CustomHeader rows), applied like Prowlarr
  fetchImpl?: typeof fetch;        // test seam; defaults to global fetch
  timeoutMs?: number;              // default KOMGA_HTTP_TIMEOUT_MS
}
export function buildKomgaUrl(base: string, path: string): string;  // `${base.replace(/\/+$/,'')}${path}`; never new URL(path, base)
export type KomgaTaskQueueRead =
  | { ok: true; status: KomgaTaskQueueStatus }
  | { ok: false; reason: 'timeout' | 'ended' | 'unsupported' };   // "SSE unavailable"
export class KomgaClient {
  constructor(opts: KomgaClientOptions);
  health(): Promise<{ status: string }>;                  // anonymous /actuator/health
  getMe(): Promise<KomgaUserDto>;                         // GET /api/v2/users/me
  getInfo(): Promise<{ version: string | null }>;         // GET /actuator/info → build.version
  listLibraries(): Promise<KomgaLibraryDto[]>;            // GET /api/v1/libraries
  scanLibrary(libraryId: string, deep: boolean): Promise<void>;   // POST /api/v1/libraries/{id}/scan?deep=… expects 202
  listBooks(libraryId: string, opts?: { pageSize?: number }): AsyncGenerator<KomgaBookDto>;
     // POST /api/v1/books/list?page=&size=&sort=url,asc with body
     // {"condition":{"allOf":[{"libraryId":{"operator":"is","value":id}},{"deleted":{"operator":"isFalse"}}]}}
     // paginate with last/totalPages; if totalElements changes between the first and the last page,
     // restart ONCE from page 0 (yield nothing from the aborted pass — buffer per pass), then accept.
     // Per-page timeout KOMGA_BOOKS_PAGE_TIMEOUT_MS.
  getBook(bookId: string): Promise<KomgaBookDto>;         // GET /api/v1/books/{id}
  listReadLists(): Promise<KomgaReadListDto[]>;           // GET /api/v1/readlists?unpaged=true (never ?search=)
  createReadList(body: KomgaReadListCreateDto): Promise<KomgaReadListDto>;
  updateReadList(id: string, body: KomgaReadListUpdateDto): Promise<void>;   // PATCH, 204
  deleteReadList(id: string): Promise<void>;              // DELETE, 204
  readTaskQueue(opts?: { timeoutMs?: number }): Promise<KomgaTaskQueueRead>;
     // GET /sse/v1/events; read until the first TaskQueueStatus frame; ALWAYS abort the connection.
     // Throws KomgaError for unreachable / 401 / 403; returns {ok:false} for 404 ('unsupported'),
     // no frame within timeout ('timeout', default KOMGA_SSE_TIMEOUT_MS), or stream end ('ended').
  scanMetricsCount(): Promise<number | null>;
     // GET /actuator/metrics/komga.tasks.execution?tag=type:ScanLibrary → COUNT measurement;
     // 404 → 0 (no scan has executed yet); any other failure → null (metrics unavailable).
}
export interface SseFrame { event: string | null; data: string }
export function parseSseChunk(buffer: string): { frames: SseFrame[]; rest: string };
   // Accepts `event:X` and `event: X`, `data:{…}` and `data: {…}`, CRLF or LF, multi-line data,
   // ignores `:` comment lines (heartbeats); frames end at a blank line.
```
Error mapping: network failure → 'unreachable' (status null); AbortSignal timeout → 'timeout';
401 → 'unauthorized'; 403 → 'forbidden'; 404 → 'notFound'; 400 → 'badRequest'; 5xx and other
non-2xx → 'server'. Error messages include Komga's JSON `message` when present, never the API key.
Every request sends `X-API-Key` (except health) plus the custom headers, `Accept: application/json`.

### path-map.ts
```ts
export interface KomgaPathMapping { omnibus: string; komga: string }
export function normalizeKomgaPath(p: string | null | undefined): string | null;
   // '\\'→'/', collapse repeated '/', trim trailing '/' (keep '/' itself), Unicode NFC,
   // reject any '..' segment (→ null), reject empty (→ null). Case-sensitive. Accepts and strips a
   // leading 'file://' scheme if Komga returns URLs that way (verify BookDto.url format in source).
export function parsePathMappings(raw: string | null | undefined): KomgaPathMapping[];  // tolerant; drops invalid rows; normalizes both sides
export function serializePathMappings(m: KomgaPathMapping[]): string;
export function isPathUnder(child: string, parent: string): boolean;   // normalized, equal or folder-boundary prefix, case-sensitive
export function toKomgaPath(omnibusPath: string, mappings: KomgaPathMapping[]): string | null;
export function toOmnibusPath(komgaPath: string, mappings: KomgaPathMapping[]): string | null;
   // longest matching prefix first; folder boundary only. Empty mappings = identity (returns the
   // normalized input). Non-empty mappings where no prefix matches → null (path not visible to Komga).
export interface KomgaScanSettings { root: string; scanCbx: boolean; scanPdf: boolean; scanEpub: boolean; scanDirectoryExclusions: string[] }
export function isKomgaScannable(komgaPath: string, lib: KomgaScanSettings): boolean;
   // replicate Komga's FileSystemScanner rules exactly (verify in source): supported extensions
   // (cbz/zip always; cbr/rar iff scanCbx; pdf iff scanPdf; epub iff scanEpub; never cb7/7z),
   // hidden segments (names starting with '.') below the root, and scanDirectoryExclusions semantics.
```

### libraries.ts
```ts
export interface KomgaLibrarySettingsSnapshot { hashFiles: boolean; importComicInfoBook: boolean; importComicInfoReadList: boolean;
  emptyTrashAfterScan: boolean; scanForceModifiedTime: boolean; convertToCbz: boolean; repairExtensions: boolean;
  scanCbx: boolean; scanPdf: boolean; scanEpub: boolean; scanDirectoryExclusions: string[]; oneshotsDirectory: string | null }
export interface ResolvedKomgaLibrary { komgaLibraryId: string; name: string; root: string; translatedRoot: string | null;
  omnibusLibraryId: string | null; settings: KomgaLibrarySettingsSnapshot; unavailable: boolean }
export interface OmnibusLibraryRef { id: string; name: string; path: string }
export function snapshotLibrarySettings(dto: KomgaLibraryDto): KomgaLibrarySettingsSnapshot;
export function resolveKomgaLibraries(dtos: KomgaLibraryDto[], mappings: KomgaPathMapping[], omnibusLibraries: OmnibusLibraryRef[]): ResolvedKomgaLibrary[];
   // translatedRoot = toOmnibusPath(dto.root); omnibusLibraryId = the Omnibus library whose path equals
   // translatedRoot, else the most specific one where one contains the other (pure, unit-tested).
export function komgaLibrariesForOmnibusLibrary(omnibusLibrary: OmnibusLibraryRef, komgaLibs: ResolvedKomgaLibrary[]): ResolvedKomgaLibrary[];
   // ALL Komga libraries whose translatedRoot equals, contains, or is contained in the Omnibus path
   // (a Komga library over a parent folder can serve several Omnibus libraries — runtime containment, not just the stored column).
export function computeLibraryWarnings(lib: ResolvedKomgaLibrary, ctx: { mappedOmnibusPaths: string[] }): string[];
   // hashFiles=false, importComicInfoBook=false, importComicInfoReadList=true, emptyTrashAfterScan=true,
   // STRONG (prefix "Strongly discouraged:") convertToCbz=true / repairExtensions=true, scanCbx=false,
   // unavailable=true, exclusions overlapping mapped paths, unmapped Komga library.
export function computeGlobalWarnings(komgaLibs: ResolvedKomgaLibrary[], omnibusLibraries: OmnibusLibraryRef[], cb7Count: number): string[];
   // Omnibus libraries with no Komga library; `.cb7` files present in mapped libraries.
export async function countCb7InLibraries(paths: string[]): Promise<number>;   // cheap prisma.issue.count on filePath endsWith .cb7 under the paths
export async function persistKomgaLibraries(resolved: ResolvedKomgaLibrary[]): Promise<void>;
   // upsert every KomgaLibrary row (settings JSON string, lastSeenAt=now) and delete rows not in `resolved`; array-form $transaction.
export async function loadCachedKomgaLibraries(): Promise<ResolvedKomgaLibrary[]>;   // from the KomgaLibrary table (parse settings JSON defensively)
export async function refreshKomgaLibraries(client: KomgaClient, mappings: KomgaPathMapping[]): Promise<ResolvedKomgaLibrary[]>;
   // listLibraries → resolve against prisma.library.findMany → persist → return. Never inside a transaction with HTTP.
```

### settings.ts  (MUST stay hot-path safe: imports only '@/lib/db', '@/lib/logger', './constants', './path-map')
```ts
export interface KomgaSettings { enabled: boolean; url: string | null; apiKey: string | null; pathMappings: KomgaPathMapping[];
  pathMappingsRaw: string; scanOnChange: boolean; readListsEnabled: boolean; instanceId: string | null }
export function parseKomgaSettings(rows: { key: string; value: string }[]): KomgaSettings;   // pure; defaults per PLAN §5 (scanOnChange default true)
export async function getKomgaSettings(): Promise<KomgaSettings>;           // fresh read of the 7 keys
export interface KomgaHotFlags { enabled: boolean; scanOnChange: boolean; readListsEnabled: boolean }
export async function getKomgaHotFlags(): Promise<KomgaHotFlags>;          // globalThis cache, TTL KOMGA_SETTINGS_CACHE_TTL_MS; on DB error → all false
export function invalidateKomgaSettingsCache(): void;
export async function getKomgaCustomHeaders(): Promise<Record<string, string>>;   // prisma.customHeader.findMany → {key: value}
```

### factory.ts
```ts
export async function getKomgaClient(settings?: KomgaSettings): Promise<KomgaClient | null>;  // null when disabled or url/key missing
export async function createKomgaClientFor(url: string, apiKey: string): Promise<KomgaClient>; // with saved custom headers
```

### connection-test.ts
```ts
export interface KomgaDetectedLibrary { id: string; name: string; root: string; translatedRoot: string | null;
  omnibusLibrary: { id: string; name: string; path: string } | null; warnings: string[] }
export interface KomgaTestResult { success: boolean; message: string; version: string | null; warnings: string[];
  user?: { email: string; roles: string[]; sharedAllLibraries: boolean }; libraries?: KomgaDetectedLibrary[] }
export async function testKomgaConnection(url: string, apiKey: string, opts?: { pathMappings?: KomgaPathMapping[];
  includeLibraries?: boolean; persist?: boolean; client?: KomgaClient }): Promise<KomgaTestResult>;
   // PLAN §6 P1 steps 1–4 in order; first failing step → success:false with a specific message
   // (401 on getMe → "Invalid API key, or Komga is older than 1.20.0 (no API-key support)").
   // Fails unless roles include ADMIN and the user has no content restrictions (ageRestriction null,
   // labelsAllow/labelsExclude empty). Version < 1.20.0 fails; < 1.23.5 warns. Never throws.
   // persist=true → persistKomgaLibraries(...) after a successful listLibraries.
export function compareKomgaVersions(a: string, b: string): number;   // semver-ish compare, tolerant of "1.28.1-SNAPSHOT"
```

### settings-hooks.ts
```ts
export async function runKomgaEnableGate(incoming: Record<string, any>, prior: Record<string, string | undefined>, warnings: string[]): Promise<void>;
   // Only when incoming.komga_enabled === 'true' (string or boolean true) and prior komga_enabled !== 'true':
   // resolve the key ('********' → stored decrypted value), run testKomgaConnection(url, key, {pathMappings});
   // on failure set incoming.komga_enabled = 'false' and push a warning
   // "Komga was not enabled: <message>". Must run BEFORE the secret-encryption loop in the config route.
export async function applyKomgaSettingsChange(prior: Record<string, string | undefined>, next: Record<string, string | undefined>, actor?: { id?: string; username?: string }): Promise<void>;
   // After save. Never throws (log [Komga] warn). invalidateKomgaSettingsCache(). If komga_url changed:
   // deleteMany KomgaBookLink + KomgaSeriesLink + KomgaLibrary, updateMany KomgaReadListLink {komgaReadListId:null}.
   // Generate komga_instance_id (crypto.randomUUID) if missing and enabled. If enabled went false→true, or
   // url/api key/path mappings changed while enabled → enqueue KOMGA_RECONCILE via `await import('./queue')`.
```

### queue.ts  (lazy: creating the Queue/IORedis happens on first call, never at module load)
```ts
export const KOMGA_JOB = { SYNC: 'KOMGA_SYNC', RECONCILE: 'KOMGA_RECONCILE', READLIST_PUSH: 'KOMGA_READLIST_PUSH', READLIST_DELETE: 'KOMGA_READLIST_DELETE' } as const;
export type KomgaJobName = typeof KOMGA_JOB[keyof typeof KOMGA_JOB];
export interface KomgaSyncJobData { omnibusLibraryId: string; stage?: string; startedAt?: number; stageStartedAt?: number;
  scanRequestedAt?: number; metricsBefore?: number | null; snapshotPaths?: string[]; snapshotOverflow?: boolean;
  deep?: boolean; full?: boolean; reason?: string }
export interface KomgaReconcileJobData { reason: string }
export interface KomgaReadListPushJobData { readingListId: string }
export interface KomgaReadListDeleteJobData { komgaReadListId: string; readingListId: string }
export function getKomgaQueue(): import('bullmq').Queue;   // globalThis singleton, own IORedis(OMNIBUS_REDIS_URL, {maxRetriesPerRequest:null})
export async function enqueueKomgaSync(data: KomgaSyncJobData, opts?: { delayMs?: number; dedupe?: boolean }): Promise<void>;
   // dedupe (default true for flush-originated jobs): deduplication {id: 'komga-sync-'+omnibusLibraryId}; removeOnComplete true, attempts 1
export async function enqueueKomgaReconcile(reason: string): Promise<void>;     // dedup id 'komga-reconcile'
export async function enqueueKomgaReadListPush(readingListId: string): Promise<void>;
   // delay KOMGA_READLIST_DEBOUNCE_MS, deduplication {id:'komga-rl-'+id, ttl:10000, extend:true, replace:true}
export async function enqueueKomgaReadListDelete(data: KomgaReadListDeleteJobData): Promise<void>;
```
All enqueue helpers: `removeOnComplete: true`, `removeOnFail: 100` (or similar), `attempts: 1`.
Check bullmq's installed version (node_modules/bullmq/package.json) for the exact deduplication option shape.

### Routes (P1)
- `POST /api/admin/test` with `{type:'komga', config:{komga_url, komga_api_key, komga_path_mappings}}` (the page's
  handleTest sends the whole config bag): resolve '********' via the stored key, run
  testKomgaConnection(url, key, {pathMappings, includeLibraries:false}); respond `{success, message}` (message
  includes the version and a warnings count / first warnings).
- `POST /api/admin/komga/libraries` body `{url, apiKey, pathMappings}` (pathMappings: JSON string or array):
  returns `{libraries:[{id,name,root,translatedRoot,omnibusLibrary,warnings[]}], warnings[], version}` (200) or
  `{error}` (4xx/5xx with a useful message; 401 when not admin). persist=true only when url and mappings
  equal the saved ones (a preview with unsaved values must not overwrite the cache).
- `/api/admin/config`: add 'komga_api_key' to SENSITIVE_KEYS (and SECRET_SETTING_KEYS in secret-keys.ts);
  call runKomgaEnableGate before the encryption loop; call applyKomgaSettingsChange after the save succeeds
  (outside the transaction, fire-and-forget safe: `void` + catch). Komga settings must never make a save fail.

### UI (P1)
- New settings tab id `media-servers`, label "Media Servers", component
  src/app/admin/settings/tabs/media-servers-tab.tsx with a Komga card: enabled switch, URL, API key (password,
  masked '********' semantics like other secrets), scan-on-change switch, read lists switch, path-mapping
  table editor (rows {omnibus, komga}; stored as JSON string in config.komga_path_mappings), "Test connection"
  (handleTest('komga')), detected-libraries table (POST /api/admin/komga/libraries with the unsaved values).
