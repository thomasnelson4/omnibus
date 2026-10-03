// GetComics hoster-priority helpers — kept in lock-step with the Rust engine's getcomics.rs.
//
// LEAF MODULE: deliberately imports nothing. It is shared by client components (the settings page),
// server routes, and tests, so it must not drag `undici`/`node:crypto` into the browser bundle.
// The GetComics scraping/resolve helpers that DO need the engine stay in ./getcomics.ts, which
// re-exports everything below for a single stable import site.
//
// NOTE on the old "Kept in lock-step with the Node `getHosterFromUrl`" comment that used to sit in
// the Rust classifier: there is no TypeScript URL→hoster classifier any more. Link classification moved
// wholesale into the engine (`GET /api/getcomics/links`, which classifies and ranks in Rust and returns
// ranked candidates). The mirror that genuinely matters is `DEFAULT_HOSTER_ORDER` below <-> the Rust
// `default_hoster_prefs()`, plus this file's `parseHosterPrefs` <-> the Rust `hoster_prefs()`.

/** Default hoster order. Reliable-by-scraping mirrors are tried BEFORE the one hoster that needs a
 *  browser solver: `getcomics_direct` (comicfiles CDN, never Cloudflare-gated) → `mediafire` / `mega` /
 *  `pixeldrain` (all resolvable by plain scraping) → `getcomics_main` (getcomics.org/dls/ "main server",
 *  the only Cloudflare-gated hoster and the only one that can end in MANUAL_DDL). It used to sit second,
 *  ahead of every working mirror, funnelling the bulk of downloads at the most failure-prone path for no
 *  benefit — a mirror that needs no solver simply succeeds. `getcomics_main` stays ENABLED (many issues
 *  only expose a /dls/ link); it is just tried last. Mirrors the Rust `default_hoster_prefs`. */
// Anna's Archive is its own search source (search_source_priority), not a GetComics mirror, so it's no
// longer part of the hoster-mirror priority list. Its download key still lives in a HosterAccount.
export const DEFAULT_HOSTER_ORDER = ['getcomics_direct', 'mediafire', 'mega', 'pixeldrain', 'getcomics_main', 'rootz', 'vikingfile', 'terabox'];

// Listed but OFF by default — Cloudflare/JS/app-gated, not resolvable by scraping (still toggleable).
export const DEFAULT_DISABLED_HOSTERS = ['rootz', 'vikingfile', 'terabox'];

export type HosterPref = { hoster: string, enabled: boolean };

/** Default hoster prefs: the standard order with the known-unreliable hosters disabled out of the box. */
export function defaultHosterPrefs(): HosterPref[] {
    return DEFAULT_HOSTER_ORDER.map(h => ({ hoster: h, enabled: !DEFAULT_DISABLED_HOSTERS.includes(h) }));
}

/** The order shipped before `getcomics_main` was demoted below the scraping mirrors. Only the
 *  "untouched config" fingerprint for {@link migratePristineHosterOrder}. Mirrors Rust LEGACY_DEFAULT_ORDER. */
export const LEGACY_DEFAULT_ORDER: [string, boolean][] = [
    ['getcomics_direct', true], ['getcomics_main', true], ['mediafire', true], ['mega', true],
    ['pixeldrain', true], ['rootz', false], ['vikingfile', false], ['terabox', false]
];

/** Moves a PRISTINE stored config onto the new default order.
 *
 *  `hoster_priority` is a persisted per-install setting, so changing {@link DEFAULT_HOSTER_ORDER} alone
 *  only helps installs where it is unset — every existing install keeps its stored order, including the
 *  ones drowning in MANUAL_DDL. Reordering stored configs wholesale would be a regression though: it
 *  cannot distinguish "the user never touched this" from "the user deliberately put getcomics_main
 *  first", and silently overwriting deliberate tuning is not acceptable.
 *
 *  So it is deliberately conservative: it fires ONLY when the stored list is exactly the order WE
 *  shipped (same hosters, same order, same enabled flags). Any customisation — a reordered entry, a
 *  toggled hoster, a dropped or added hoster — fails the comparison and is left completely untouched.
 *  Pure and read-path only (no DB write), so it is idempotent by construction: applied to an already-
 *  migrated list it finds no `getcomics_main` in the legacy slot and returns it unchanged. Mirrors the
 *  Rust `migrate_pristine_default_order`. */
export function migratePristineHosterOrder(prefs: HosterPref[]): HosterPref[] {
    const pristine = prefs.length === LEGACY_DEFAULT_ORDER.length
        && LEGACY_DEFAULT_ORDER.every(([h, en], i) => prefs[i].hoster === h && prefs[i].enabled === en);
    return pristine ? defaultHosterPrefs() : prefs;
}

/** Migrate a legacy single `getcomics` entry into `getcomics_direct` (kept in place + enabled flag) +
 *  `getcomics_main` (inserted right after it, same enabled flag, so both stay high-priority — the
 *  legacy `getcomics` was first). Idempotent; mirrors Rust migrate_legacy_getcomics. */
export function migrateHosterPrefs(prefs: HosterPref[]): HosterPref[] {
    const out = prefs.map(p => ({ ...p }));
    const i = out.findIndex(p => p.hoster === 'getcomics');
    if (i !== -1) {
        const enabled = out[i].enabled;
        out[i] = { hoster: 'getcomics_direct', enabled };
        if (!out.some(p => p.hoster === 'getcomics_main')) out.splice(i + 1, 0, { hoster: 'getcomics_main', enabled });
    }
    return out;
}

/** Parse a raw `hoster_priority` setting value into an ordered, migrated pref list. Unset → defaults;
 *  empty array → none; string array → all enabled; object array → each entry's `enabled` (default true). */
export function parseHosterPrefs(value?: string | null): HosterPref[] {
    const defaults = defaultHosterPrefs;
    if (!value) return defaults();
    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed)) return defaults();
        if (parsed.length === 0) return [];
        const prefs: HosterPref[] = typeof parsed[0] === 'string'
            ? parsed.map((h: string) => ({ hoster: h, enabled: true }))
            : parsed.map((p: { hoster: string, enabled?: boolean }) => ({ hoster: p.hoster, enabled: p.enabled !== false }));
        return migratePristineHosterOrder(migrateHosterPrefs(prefs));
    } catch { return defaults(); }
}

/** Enabled hoster names in priority order, migrating the legacy `getcomics` key. Mirrors Rust enabled_hosters. */
export function enabledHostersFromSetting(value?: string | null): string[] {
    return parseHosterPrefs(value).filter(p => p.enabled).map(p => p.hoster);
}

