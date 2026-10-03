// src/lib/komga/constants.ts
//
// Komga integration tunables and setting key names. Pure (no imports) so the hot-path modules
// (settings, changes, readlist-trigger) can depend on it freely. These are deliberately constants,
// not settings (PLAN §5); never rename the exported names, other modules and tests key off them.

export const KOMGA_QUEUE_NAME = 'omnibus-komga';

export const KOMGA_KEYS = {
    enabled: 'komga_enabled',
    url: 'komga_url',
    apiKey: 'komga_api_key',
    pathMappings: 'komga_path_mappings',
    scanOnChange: 'komga_scan_on_change',
    readListsEnabled: 'komga_readlists_enabled',
    instanceId: 'komga_instance_id',
} as const;

export const KOMGA_SETTING_KEYS: readonly string[] = Object.values(KOMGA_KEYS);

// X-API-Key on the REST API arrived in 1.20.0; 1.23.5 fixed API key + session returning empty
// content; 1.23.2 broke read-list creation and 1.23.3 fixed it.
export const KOMGA_MIN_VERSION = '1.20.0';
export const KOMGA_RECOMMENDED_VERSION = '1.23.5';
export const KOMGA_READLIST_MIN_VERSION = '1.23.3';

// --- Change tracking / flush (Phase 2) ---
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

// --- HTTP (client.ts) ---
export const KOMGA_HTTP_TIMEOUT_MS = 10_000;
export const KOMGA_BOOKS_PAGE_TIMEOUT_MS = 60_000;
export const KOMGA_BOOKS_PAGE_SIZE = 1000;            // Komga clamps at 2000
export const KOMGA_BOOKS_MAX_PAGE_SIZE = 2000;        // Spring Data's default max-page-size (Komga doesn't override it)
export const KOMGA_SSE_TIMEOUT_MS = 25_000;           // TaskQueueStatus is emitted every 10 s while connected
export const KOMGA_SSE_MAX_BUFFER_BYTES = 1_000_000;  // a stream that never yields a frame boundary is not Komga
export const KOMGA_SSE_TASK_QUEUE_EVENT = 'TaskQueueStatus';
export const KOMGA_USER_AGENT = 'Omnibus/1.0';

// --- Verification (Phase 3) ---
export const KOMGA_VERIFY_MAX_RETRIES = 2;            // 2nd retry scans deep=true
export const KOMGA_VERIFY_MTIME_SLACK_MS = 2_000;
export const KOMGA_OVERFLOW_STAT_LIMIT = 500;
export const KOMGA_DB_CHUNK = 500;

/**
 * The first words of the JobLog message verify.ts writes when it stops retrying. The Phase 5 health
 * check counts these rows to spot files Komga never picked up, so the literal lives here instead of
 * being copied into the query (one place to change, and no silent drift into a query that matches
 * nothing).
 */
export const KOMGA_VERIFY_GIVEUP_PREFIX = 'Komga did not pick up';

/**
 * The prefix of `KomgaSyncState.lastError` when a reconcile aborted on its safety valve. Same
 * reason: the health check finds tripped valves with `startsWith`, so the valve's own write and the
 * query share one constant.
 */
export const KOMGA_VALVE_ERROR_PREFIX = 'reconcile safety valve';

// --- Read lists (Phase 4) ---
export const KOMGA_READLIST_DEBOUNCE_MS = 10_000;
export const KOMGA_DELETE_REMOTE_ON_UNSYNC = true;

export const KOMGA_DEEP_SCAN_DEFAULT = false;
export const KOMGA_SETTINGS_CACHE_TTL_MS = 10_000;    // hot-path flag cache
