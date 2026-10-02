// __tests__/lib/smart-match-providers.test.ts
//
// The provider adapter behind the shared Smart Match pipeline: bounded, budgeted, paced provider
// access with precise cache eviction on a forced refresh. Every HTTP call, database row and usage
// counter is mocked — no live provider quota is ever consumed here.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    get: vi.fn(), countApiUsage: vi.fn(), logApiUsage: vi.fn(), markSystemFlag: vi.fn(),
    getCached: vi.fn(), putCached: vi.fn(), cacheFindMany: vi.fn(), cacheDeleteMany: vi.fn(), settingFindUnique: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: mocks.get } }));
vi.mock('@/lib/utils/system-flags', () => ({ countApiUsage: mocks.countApiUsage, logApiUsage: mocks.logApiUsage, markSystemFlag: mocks.markSystemFlag }));
vi.mock('@/lib/metadata/metadata-cache', async () => ({
    ...(await vi.importActual<typeof import('@/lib/metadata/metadata-cache')>('@/lib/metadata/metadata-cache')),
    getCachedResponse: mocks.getCached, putCachedResponse: mocks.putCached,
}));
vi.mock('@/lib/db', () => ({ prisma: {
    metadataCache: { findMany: mocks.cacheFindMany, deleteMany: mocks.cacheDeleteMany },
    systemSetting: { findUnique: mocks.settingFindUnique },
} }));

import { createGateway } from '@/lib/smart-match/providers';
import { MatchFailure } from '@/lib/smart-match/decision';
import { parseSignals } from '@/lib/smart-match/signals';

const config = { cv_api_key: 'cv-secret', metron_user: 'user', metron_pass: 'pass', filter_foreign_publishers: 'Panini' };
const cvCandidate = { id: '1', name: 'Batman', metadataSource: 'COMICVINE' as const };
const metronCandidate = { id: '7', name: 'Batman', metadataSource: 'METRON' as const };
const cvOk = (results: unknown, total = 0) => ({ data: { status_code: 1, number_of_total_results: total, results } });
const url = (call: number) => String(mocks.get.mock.calls[call][0]);

beforeEach(() => {
    vi.clearAllMocks();
    mocks.countApiUsage.mockResolvedValue(0);
    mocks.getCached.mockResolvedValue(null);
    mocks.cacheFindMany.mockResolvedValue([]);
    mocks.settingFindUnique.mockResolvedValue(null);
});

describe('smart-match provider gateway — bounded search', () => {
    it('searches with one request, keeps the publisher block filter, and never fetches details or covers to rank', async () => {
        mocks.get.mockResolvedValueOnce(cvOk([
            { id: 1, name: 'Batman', start_year: '2016', publisher: { name: 'DC Comics' }, count_of_issues: 100, image: { medium_url: 'cover.jpg' } },
            { id: 2, name: 'Batman', start_year: '2011', publisher: { name: 'Panini Comics' } },
        ], 41));
        const gateway = createGateway(config, false);
        const result = await gateway.search('COMICVINE', 'Batman', 1);
        expect(mocks.get).toHaveBeenCalledTimes(1);
        expect(url(0)).toContain('/search/');
        expect(url(0)).toContain('limit=40');
        expect(url(0)).not.toContain('/volume/');
        expect(result.hasMore).toBe(true);
        expect(result.candidates.map(c => c.id)).toEqual(['1']);
        expect(result.candidates[0]).toMatchObject({ year: 2016, publisher: 'DC Comics', count: 100, image: 'cover.jpg' });
        expect(gateway.requests()).toBe(1);
        expect(mocks.logApiUsage).toHaveBeenCalledWith('comicvine', '/search');
    });

    it('answers identical requests from the shared cache or the in-flight memo without spending budget', async () => {
        mocks.getCached.mockResolvedValueOnce({ results: [], number_of_total_results: 0 });
        const gateway = createGateway(config, false);
        await gateway.search('COMICVINE', 'Batman', 1);
        await gateway.search('COMICVINE', 'Batman', 1);
        expect(mocks.get).not.toHaveBeenCalled();
        expect(mocks.getCached).toHaveBeenCalledTimes(1);
        expect(gateway.requests()).toBe(0);
    });

    it('a zero request budget never reaches the network but may still answer from the shared cache', async () => {
        await expect(createGateway(config, false, 0).search('COMICVINE', 'Batman', 1)).rejects.toMatchObject({ kind: 'deferred' });
        expect(mocks.get).not.toHaveBeenCalled();
        mocks.getCached.mockResolvedValueOnce({ results: [], next: null });
        expect((await createGateway(config, false, 0).search('METRON', 'Batman', 1)).candidates).toEqual([]);
        expect(mocks.get).not.toHaveBeenCalled();
    });

    it('reserves the existing app quota (CV 200-30, Metron 5000-500) instead of raising provider limits', async () => {
        mocks.countApiUsage.mockResolvedValueOnce(170);
        await expect(createGateway(config, false).search('COMICVINE', 'Batman', 1)).rejects.toMatchObject({ kind: 'deferred', message: expect.stringContaining('reserved') });
        mocks.countApiUsage.mockResolvedValueOnce(4500);
        await expect(createGateway(config, false).search('METRON', 'Batman', 1)).rejects.toMatchObject({ kind: 'deferred' });
        expect(mocks.get).not.toHaveBeenCalled();
    });

    it('stops on a provider rate limit, records the flag, and never leaks credentials into failures', async () => {
        mocks.get.mockRejectedValueOnce({ response: { status: 429 }, config: { url: 'https://comicvine.gamespot.com/api/search/?api_key=cv-secret' } });
        const limited = await createGateway(config, false).search('COMICVINE', 'Batman', 1).catch(e => e);
        expect(limited).toBeInstanceOf(MatchFailure);
        expect(limited.kind).toBe('rate_limited');
        expect(mocks.markSystemFlag).toHaveBeenCalledWith('cv_rate_limit_time');

        mocks.get.mockRejectedValueOnce({ response: { status: 500 }, config: { auth: { password: 'pass' } } });
        const failed = await createGateway(config, false).search('METRON', 'Batman', 1).catch(e => e);
        expect(failed.kind).toBe('provider_error');
        expect(failed.message).toContain('HTTP 500');
        expect(JSON.stringify(failed)).not.toMatch(/cv-secret|pass/);
    });

    it('treats missing or masked credentials as a configuration failure rather than not found', async () => {
        const gateway = createGateway({ cv_api_key: '********', metron_user: 'u', metron_pass: 'enc:abc' }, false);
        expect(gateway.configured).toEqual([]);
        await expect(gateway.search('COMICVINE', 'Batman', 1)).rejects.toMatchObject({ kind: 'provider_error' });
        expect(mocks.get).not.toHaveBeenCalled();
    });
});

describe('smart-match provider gateway — forced refresh eviction', () => {
    it('evicts every field_list/paging variant of the refreshed resource and nothing else', async () => {
        mocks.cacheFindMany.mockResolvedValueOnce([
            { key: 'issue100-volume', url: 'https://comicvine.gamespot.com/api/issue/4000-100/?field_list=id%2Cvolume&format=json' },
            { key: 'issue100-dates', url: 'https://comicvine.gamespot.com/api/issue/4000-100/?field_list=id%2Cissue_number%2Ccover_date&format=json' },
            { key: 'issue101', url: 'https://comicvine.gamespot.com/api/issue/4000-101/?field_list=id%2Cvolume&format=json' },
        ]);
        mocks.get.mockResolvedValueOnce(cvOk({ id: 100, volume: { id: 1 } }));
        const gateway = createGateway(config, true);
        expect(await gateway.resolve({ provider: 'COMICVINE', kind: 'issue', id: '100', source: 'test' })).toBe('1');
        expect(mocks.getCached).not.toHaveBeenCalled();
        expect(mocks.cacheFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { url: { startsWith: 'https://comicvine.gamespot.com/api/issue/4000-100/' } } }));
        expect(mocks.cacheDeleteMany).toHaveBeenCalledWith({ where: { key: { in: ['issue100-volume', 'issue100-dates'] } } });
    });

    it('refreshing a search evicts only that query across pages, keeping other titles cached', async () => {
        mocks.cacheFindMany.mockResolvedValueOnce([
            { key: 'batman-p1', url: 'https://comicvine.gamespot.com/api/search/?format=json&limit=40&page=1&query=Batman&resources=volume' },
            { key: 'batman-p2', url: 'https://comicvine.gamespot.com/api/search/?format=json&limit=40&page=2&query=Batman&resources=volume' },
            { key: 'superman-p1', url: 'https://comicvine.gamespot.com/api/search/?format=json&limit=40&page=1&query=Superman&resources=volume' },
        ]);
        mocks.get.mockResolvedValueOnce(cvOk([]));
        await createGateway(config, true).search('COMICVINE', 'Batman', 1);
        expect(mocks.cacheDeleteMany).toHaveBeenCalledWith({ where: { key: { in: ['batman-p1', 'batman-p2'] } } });
    });

    it('does not repopulate the shared cache when Clear Metadata Cache changed the generation mid-request', async () => {
        mocks.settingFindUnique.mockResolvedValueOnce({ key: 'smart_match_cache_epoch', value: 'new-generation' });
        mocks.get.mockResolvedValueOnce(cvOk([]));
        await createGateway({ ...config, smart_match_cache_epoch: 'old-generation' }, false).search('COMICVINE', 'Batman', 1);
        expect(mocks.putCached).not.toHaveBeenCalled();
    });
});

describe('smart-match provider gateway — issue-level details', () => {
    it('ComicVine fetches dates only for the requested strongest numbers (max two) and never infers a maximum from count_of_issues', async () => {
        mocks.get.mockResolvedValueOnce(cvOk({ id: 1, name: 'Batman', start_year: '2016', publisher: { name: 'DC Comics' }, count_of_issues: 3,
            issues: [{ id: 10, issue_number: '1' }, { id: 11, issue_number: '2' }, { id: 12, issue_number: '2400' }] }));
        mocks.get.mockResolvedValueOnce(cvOk({ id: 12, issue_number: '2400', cover_date: '2024-01-01', volume: { id: 1 } }));
        const details = await createGateway(config, false).details(cvCandidate, [parseSignals('Batman 2400 (2024)', 'filename')]);
        expect(mocks.get).toHaveBeenCalledTimes(2);
        expect(url(1)).toContain('/issue/4000-12/');
        expect(details.complete).toBe(true);
        expect(details.issues.find(i => i.id === '12')).toMatchObject({ number: '2400', date: '2024-01-01', domain: 'regular' });
        expect(details.issues.find(i => i.id === '10')?.date).toBeUndefined();
    });

    it('classifies numbering domains from the series type / per-issue format, never from a story title', async () => {
        mocks.get.mockResolvedValueOnce({ data: { id: 7, series: 'Batman', year_began: 2016, publisher: { name: 'DC Comics' }, series_type: { name: 'Single Issue' }, issue_count: 3 } });
        mocks.get.mockResolvedValueOnce({ data: { next: null, results: [
            { id: 70, number: '1', name: ['Annual Report'], cover_date: '2016-08-01' },
            { id: 71, number: '2', name: ['Hardcore'], format: 'Hard Cover', cover_date: '2016-09-01' },
            { id: 72, number: '3', name: ['Omnibus Dreams'], store_date: '2016-10-01' },
        ] } });
        const details = await createGateway(config, false).details(metronCandidate, [parseSignals('Batman 001 (2016)', 'filename')]);
        expect(details.candidate).toMatchObject({ year: 2016, format: 'Single Issue', count: 3 });
        expect(details.issues.map(i => i.domain)).toEqual(['regular', 'collected', 'regular']);
        expect(details.issues[0].date).toBe('2016-08-01');
        expect(details.complete).toBe(true);

        mocks.get.mockResolvedValueOnce({ data: { id: 8, series: 'Batman Annual', year_began: 2016, series_type: { name: 'Annual' } } });
        mocks.get.mockResolvedValueOnce({ data: { next: null, results: [{ id: 80, number: '1' }] } });
        expect((await createGateway(config, false).details({ ...metronCandidate, id: '8' }, [])).issues[0].domain).toBe('annual');
    });

    it('refuses a detail whose publisher is excluded by matching policy', async () => {
        mocks.get.mockResolvedValueOnce(cvOk({ id: 1, name: 'Batman', start_year: '2016', publisher: { name: 'Panini Comics' }, issues: [] }));
        await expect(createGateway(config, false).details(cvCandidate, [])).rejects.toMatchObject({ kind: 'provider_error', message: expect.stringContaining('excluded') });
    });
});
