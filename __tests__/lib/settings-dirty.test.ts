// __tests__/lib/settings-dirty.test.ts
//
// Settings reorganization Phase 2: per-tab dirty tracking. computeDirtyTabs compares the current
// and initial state snapshots (the same object shape the page's unsaved-changes hash uses) and
// returns which of the 9 tabs own the changed keys/collections — driving the amber dot on each
// tab trigger. Keys the settings page doesn't own (e.g. the Jobs page's *_schedule keys, which
// ride along in the config bag) must never light a dot.
import { describe, it, expect } from 'vitest';
import { computeDirtyTabs } from '@/app/admin/settings/tabs/dirty';

const emptySnapshot = () => ({
    config: {} as Record<string, any>,
    configuredLibraries: [] as any[],
    configuredIndexers: [] as any[],
    configuredClients: [] as any[],
    configuredHosters: [] as any[],
    configuredWebhooks: [] as any[],
    customHeaders: [] as any[],
    customAcronyms: [] as any[],
    hosterPriority: [] as any[],
    searchSourcePriority: [] as any[],
    scoringRules: [] as any[],
});

const withConfig = (kv: Record<string, any>) => ({ ...emptySnapshot(), config: { ...kv } });

describe('lib: settings per-tab dirty tracking', () => {
    it('returns nothing when the snapshots match', () => {
        expect(computeDirtyTabs(emptySnapshot(), emptySnapshot())).toEqual([]);
        const same = withConfig({ cv_api_key: 'k' });
        expect(computeDirtyTabs(same, withConfig({ cv_api_key: 'k' }))).toEqual([]);
    });

    it('maps config keys to their owning tab', () => {
        expect(computeDirtyTabs(withConfig({ cv_api_key: 'new' }), withConfig({ cv_api_key: 'old' }))).toEqual(['metadata']);
        expect(computeDirtyTabs(withConfig({ manga_publishers: 'viz' }), withConfig({}))).toEqual(['discovery']);
        expect(computeDirtyTabs(withConfig({ engine_cpu_cap: '4' }), withConfig({}))).toEqual(['system']);
        expect(computeDirtyTabs(withConfig({ flaresolverr_url: 'http://x' }), withConfig({}))).toEqual(['downloads']);
        expect(computeDirtyTabs(withConfig({ annas_archive_mirrors: 'https://mirror.example' }), withConfig({}))).toEqual(['downloads']);
        expect(computeDirtyTabs(withConfig({ oidc_enabled: 'true' }), withConfig({}))).toEqual(['access']);
        expect(computeDirtyTabs(withConfig({ smtp_host: 'smtp.x' }), withConfig({}))).toEqual(['notifications']);
        expect(computeDirtyTabs(withConfig({ folder_naming_pattern: '{Series}' }), withConfig({}))).toEqual(['library']);
        expect(computeDirtyTabs(withConfig({ prowlarr_url: 'http://p' }), withConfig({}))).toEqual(['search']);
    });

    it('maps every editable Komga key to the Media Servers tab', () => {
        const before = {
            komga_enabled: 'false', komga_url: '', komga_api_key: '', komga_path_mappings: '[]',
            komga_scan_on_change: 'true', komga_readlists_enabled: 'false',
        };
        const after: Record<string, string> = {
            komga_enabled: 'true', komga_url: 'http://komga:25600', komga_api_key: 'k',
            komga_path_mappings: '[{"omnibus":"/data/comics","komga":"/comics"}]',
            komga_scan_on_change: 'false', komga_readlists_enabled: 'true',
        };
        for (const [key, value] of Object.entries(after)) {
            expect(computeDirtyTabs(withConfig({ ...before, [key]: value }), withConfig(before))).toEqual(['media-servers']);
        }
    });

    it('never lights a dot for the server-generated komga_instance_id', () => {
        expect(computeDirtyTabs(withConfig({ komga_instance_id: 'b' }), withConfig({ komga_instance_id: 'a' }))).toEqual([]);
    });

    it('treats an edited-then-reverted path-mapping list as clean', () => {
        expect(computeDirtyTabs(withConfig({ komga_path_mappings: '[]' }), withConfig({ komga_path_mappings: '[]' }))).toEqual([]);
    });

    it('maps collection changes to their owning tab', () => {
        const cur = emptySnapshot(); const init = emptySnapshot();
        cur.configuredLibraries = [{ id: '1' }];
        expect(computeDirtyTabs(cur, init)).toEqual(['library']);

        const cur2 = emptySnapshot();
        cur2.scoringRules = [{ id: 's1', term: 'empire', score: 100 }];
        expect(computeDirtyTabs(cur2, init)).toEqual(['search']);

        const cur3 = emptySnapshot();
        cur3.hosterPriority = [{ hoster: 'mega', enabled: true }];
        expect(computeDirtyTabs(cur3, init)).toEqual(['downloads']);

        const cur4 = emptySnapshot();
        cur4.customHeaders = [{ key: 'Authorization', value: 'x' }];
        expect(computeDirtyTabs(cur4, init)).toEqual(['access']);

        const cur5 = emptySnapshot();
        cur5.configuredWebhooks = [{ id: 'w1' }];
        expect(computeDirtyTabs(cur5, init)).toEqual(['notifications']);
    });

    it('ignores config keys the settings page does not own (Jobs page schedules etc.)', () => {
        expect(computeDirtyTabs(withConfig({ metadata_sync_schedule: '6' }), withConfig({ metadata_sync_schedule: '12' }))).toEqual([]);
        expect(computeDirtyTabs(withConfig({ some_future_key: 'x' }), withConfig({}))).toEqual([]);
    });

    it('reports multiple dirty tabs in stable tab order', () => {
        const cur = withConfig({ engine_cpu_cap: '4', cv_api_key: 'new', komga_url: 'http://k', oidc_enabled: 'true' });
        cur.configuredWebhooks = [{ id: 'w1' }];
        const init = withConfig({ cv_api_key: 'old' });
        expect(computeDirtyTabs(cur, init)).toEqual(['metadata', 'notifications', 'media-servers', 'access', 'system']);
    });
});
