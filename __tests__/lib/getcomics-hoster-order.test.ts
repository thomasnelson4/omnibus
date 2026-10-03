// The GetComics hoster-priority mirror: DEFAULT_HOSTER_ORDER + the pristine-config reorder in
// parseHosterPrefs. These must stay in lock-step with the Rust engine's `default_hoster_prefs()` /
// `migrate_pristine_default_order` in omnibus-engine/src/getcomics.rs — the Rust test
// `default_order_tries_scraping_mirrors_before_the_gated_main_server` asserts the same order.
import { describe, it, expect } from 'vitest';
import {
    DEFAULT_HOSTER_ORDER,
    DEFAULT_DISABLED_HOSTERS,
    defaultHosterPrefs,
    migrateHosterPrefs,
    migratePristineHosterOrder,
    parseHosterPrefs,
    enabledHostersFromSetting,
    type HosterPref
} from '@/lib/hoster-prefs';
import * as getcomics from '@/lib/getcomics';

// The helpers live in the leaf module (so client components don't pull the engine/undici chain into
// the browser bundle) and are re-exported by '@/lib/getcomics' for a single stable import site. Prove
// the re-export is the SAME binding, so the two import sites can never drift.
describe('hoster-prefs re-export', () => {
    it('is re-exported identically from @/lib/getcomics', () => {
        expect(getcomics.DEFAULT_HOSTER_ORDER).toBe(DEFAULT_HOSTER_ORDER);
        expect(getcomics.defaultHosterPrefs).toBe(defaultHosterPrefs);
        expect(getcomics.migrateHosterPrefs).toBe(migrateHosterPrefs);
        expect(getcomics.migratePristineHosterOrder).toBe(migratePristineHosterOrder);
        expect(getcomics.parseHosterPrefs).toBe(parseHosterPrefs);
        expect(getcomics.enabledHostersFromSetting).toBe(enabledHostersFromSetting);
    });
});

describe('GetComics default hoster order', () => {
    it('tries the scraping mirrors before the Cloudflare-gated main server', () => {
        expect(DEFAULT_HOSTER_ORDER).toEqual([
            'getcomics_direct', 'mediafire', 'mega', 'pixeldrain',
            'getcomics_main', 'rootz', 'vikingfile', 'terabox'
        ]);
        // getcomics_main is the ONLY hoster needing a solver, so it must not outrank a mirror that
        // plain scraping can resolve.
        expect(DEFAULT_HOSTER_ORDER.indexOf('getcomics_main'))
            .toBeGreaterThan(DEFAULT_HOSTER_ORDER.indexOf('pixeldrain'));
    });

    it('keeps getcomics_main enabled (many issues only expose a /dls/ link) but leaves the gated mirrors off', () => {
        const prefs = defaultHosterPrefs();
        expect(prefs.find(p => p.hoster === 'getcomics_main')?.enabled).toBe(true);
        // Enabled order is what actually drives the download ranking.
        expect(enabledHostersFromSetting(undefined)).toEqual(['getcomics_direct', 'mediafire', 'mega', 'pixeldrain', 'getcomics_main']);
        expect(DEFAULT_DISABLED_HOSTERS).toEqual(['rootz', 'vikingfile', 'terabox']);
        for (const off of DEFAULT_DISABLED_HOSTERS) {
            expect(prefs.find(p => p.hoster === off)?.enabled).toBe(false);
        }
    });
});

    const legacy = (): HosterPref[] => [
        { hoster: 'getcomics_direct', enabled: true },
        { hoster: 'getcomics_main', enabled: true },
        { hoster: 'mediafire', enabled: true },
        { hoster: 'mega', enabled: true },
        { hoster: 'pixeldrain', enabled: true },
        { hoster: 'rootz', enabled: false },
        { hoster: 'vikingfile', enabled: false },
        { hoster: 'terabox', enabled: false }
    ];

describe('migratePristineHosterOrder', () => {
    it('reorders a stored config that is still exactly what we shipped', () => {
        expect(migratePristineHosterOrder(legacy()).map(p => p.hoster))
            .toEqual(defaultHosterPrefs().map(p => p.hoster));
    });

    it('is idempotent', () => {
        const once = migratePristineHosterOrder(legacy());
        expect(migratePristineHosterOrder(once)).toEqual(once);
    });

    it('never clobbers a deliberate config', () => {
        // Reordered by the user.
        const reordered = legacy();
        [reordered[1], reordered[3]] = [reordered[3], reordered[1]];
        expect(migratePristineHosterOrder(reordered)).toEqual(reordered);
        // Toggled by the user.
        const toggled = legacy().map(p => p.hoster === 'getcomics_main' ? { ...p, enabled: false } : p);
        expect(migratePristineHosterOrder(toggled)).toEqual(toggled);
        // Trimmed / extended by the user.
        expect(migratePristineHosterOrder(legacy().slice(0, 7))).toEqual(legacy().slice(0, 7));
        const extended = [...legacy(), { hoster: 'custom', enabled: true }];
        expect(migratePristineHosterOrder(extended)).toEqual(extended);
        // "No hosters" must never be reinterpreted as "use the defaults".
        expect(migratePristineHosterOrder([])).toEqual([]);
    });
});

describe('parseHosterPrefs migration chain', () => {
    it('leaves an unset / empty setting alone', () => {
        expect(parseHosterPrefs(undefined).map(p => p.hoster)).toEqual(defaultHosterPrefs().map(p => p.hoster));
        expect(parseHosterPrefs(null).map(p => p.hoster)).toEqual(defaultHosterPrefs().map(p => p.hoster));
        expect(parseHosterPrefs('[]')).toEqual([]);
    });

    it('composes the legacy getcomics split with the pristine reorder', () => {
        // A PRE-SPLIT install sitting on defaults: after migrateHosterPrefs the list is exactly the old
        // shipped default (direct, main, mediafire, mega, pixeldrain, rootz*, vikingfile*, terabox*), so it
        // also matches the pristine fingerprint and gets upgraded to the new order. This is the realistic
        // "existing install benefits" path, and it is stable across repeated reads.
        const legacyKey = JSON.stringify([
            { hoster: 'getcomics', enabled: true }, { hoster: 'mediafire', enabled: true },
            { hoster: 'mega', enabled: true }, { hoster: 'pixeldrain', enabled: true },
            { hoster: 'rootz', enabled: false }, { hoster: 'vikingfile', enabled: false },
            { hoster: 'terabox', enabled: false }
        ]);
        const names = ['getcomics_direct', 'mediafire', 'mega', 'pixeldrain', 'getcomics_main', 'rootz', 'vikingfile', 'terabox'];
        const out = parseHosterPrefs(legacyKey);
        expect(out.map(p => p.hoster)).toEqual(names);
        // ...and it is idempotent (a second read sees the new order, which no longer matches the legacy
        // fingerprint, so it passes straight through).
        expect(parseHosterPrefs(JSON.stringify(out))).toEqual(out);
    });

    it('leaves a DELIBERATELY-ordered pre-split config alone', () => {
        // Same legacy key, but the user had already reordered mediafire above it — after the split the
        // list does not match the shipped default, so neither migration may touch the ordering.
        const legacyKey = JSON.stringify([
            { hoster: 'mediafire', enabled: true }, { hoster: 'getcomics', enabled: true },
            { hoster: 'mega', enabled: true }, { hoster: 'pixeldrain', enabled: true },
            { hoster: 'rootz', enabled: false }, { hoster: 'vikingfile', enabled: false },
            { hoster: 'terabox', enabled: false }
        ]);
        expect(parseHosterPrefs(legacyKey).map(p => p.hoster))
            .toEqual(['mediafire', 'getcomics_direct', 'getcomics_main', 'mega', 'pixeldrain', 'rootz', 'vikingfile', 'terabox']);
    });

    it('never re-orders the legacy string-array form', () => {
        const strings = JSON.stringify(['getcomics_main', 'mediafire']);
        expect(parseHosterPrefs(strings).map(p => p.hoster)).toEqual(['getcomics_main', 'mediafire']);
    });

    it('a pristine stored order is upgraded on read, which is the only way existing installs benefit', () => {
        const stored = JSON.stringify(legacy());
        expect(parseHosterPrefs(stored).map(p => p.hoster))
            .toEqual(['getcomics_direct', 'mediafire', 'mega', 'pixeldrain', 'getcomics_main', 'rootz', 'vikingfile', 'terabox']);
        // migrateHosterPrefs alone is not enough — the two must be composed, as page.tsx does.
        expect(migratePristineHosterOrder(migrateHosterPrefs(legacy())).map(p => p.hoster))
            .toEqual(['getcomics_direct', 'mediafire', 'mega', 'pixeldrain', 'getcomics_main', 'rootz', 'vikingfile', 'terabox']);
    });
});