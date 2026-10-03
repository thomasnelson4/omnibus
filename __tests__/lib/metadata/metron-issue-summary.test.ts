// __tests__/lib/metadata/metron-issue-summary.test.ts
//
// MetronProvider.getIssueSummary — the fail-fast single-issue lookup behind reading-list Fix match.
// The existing fetchWithBackoff behavior (sleeps, retries) is pinned by metron.test.ts; these tests
// pin that failFast never sleeps or retries, and that usage/caching accounting stays honest.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetronProvider } from '@/lib/metadata/providers/metron';

const mocks = vi.hoisted(() => ({
    findManySettings: vi.fn(),
    logApiUsage: vi.fn(),
    getCachedResponse: vi.fn(),
    putCachedResponse: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { systemSetting: { findMany: mocks.findManySettings } } }));
vi.mock('@/lib/utils/system-flags', () => ({ logApiUsage: mocks.logApiUsage }));
vi.mock('@/lib/metadata/metadata-cache', () => ({
    getCachedResponse: mocks.getCachedResponse,
    putCachedResponse: mocks.putCachedResponse,
}));

const creds = [
    { key: 'metron_user', value: 'test_user' },
    { key: 'metron_pass', value: 'test_pass' },
];

const issuePayload = {
    id: 4521,
    number: '141',
    title: '',
    name: ['Days of Future Past'],
    series: { id: 2133, name: 'Uncanny X-Men', year_began: 1963 },
    publisher: { id: 1, name: 'Marvel' },
    cover_date: '1981-01-01',
    store_date: '1980-10-07',
    image: 'https://static.metron.cloud/media/issue/x.jpg',
};

const response = (status: number, body: any, headers: Record<string, string> = {}) => ({
    status,
    headers: new Headers(headers),
    json: async () => body,
});

describe('MetronProvider.getIssueSummary', () => {
    let provider: MetronProvider;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mocks.findManySettings.mockResolvedValue(creds);
        mocks.getCachedResponse.mockResolvedValue(null);
        mocks.putCachedResponse.mockResolvedValue(undefined);
        mocks.logApiUsage.mockResolvedValue(undefined);
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        provider = new MetronProvider();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('maps the issue and logs one coarse /issue call', async () => {
        fetchMock.mockResolvedValueOnce(response(200, issuePayload));
        const summary = await provider.getIssueSummary('4521');
        expect(summary).toEqual({
            id: 4521, number: '141', title: 'Days of Future Past',
            seriesId: 2133, seriesName: 'Uncanny X-Men', seriesYearBegan: 1963, publisher: 'Marvel',
            coverDate: '1981-01-01', storeDate: '1980-10-07', image: 'https://static.metron.cloud/media/issue/x.jpg',
        });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0][0]).toBe('https://metron.cloud/api/issue/4521/');
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toMatch(/^Basic /);
        expect(mocks.logApiUsage).toHaveBeenCalledOnce();
        expect(mocks.logApiUsage).toHaveBeenCalledWith('metron', '/issue');
    });

    it('prefers title over name, drops placeholders, and tolerates sparse payloads', async () => {
        fetchMock.mockResolvedValueOnce(response(200, { ...issuePayload, title: 'Mind Out of Time' }));
        expect((await provider.getIssueSummary('4521'))?.title).toBe('Mind Out of Time');

        fetchMock.mockResolvedValueOnce(response(200, { id: 4521, number: 3, title: 'Issue #3', series: 'Saga', series_id: 77 }));
        expect(await provider.getIssueSummary('4521')).toEqual({
            id: 4521, number: '3', title: null, seriesId: 77, seriesName: 'Saga', seriesYearBegan: null,
            publisher: null, coverDate: null, storeDate: null, image: null,
        });
    });

    it.each([
        ['no credentials', []],
        ['a masked password', [{ key: 'metron_user', value: 'u' }, { key: 'metron_pass', value: '********' }]],
        ['an undecryptable password', [{ key: 'metron_user', value: 'u' }, { key: 'metron_pass', value: 'enc:v2:abc' }]],
        ['no username', [{ key: 'metron_pass', value: 'p' }]],
    ])('throws METRON_NOT_CONFIGURED with %s, before any fetch', async (_label, settings) => {
        mocks.findManySettings.mockResolvedValue(settings);
        await expect(provider.getIssueSummary('4521')).rejects.toThrow('METRON_NOT_CONFIGURED');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(mocks.logApiUsage).not.toHaveBeenCalled();
    });

    it('resolves null on a 404 and still counts the call', async () => {
        fetchMock.mockResolvedValueOnce(response(404, { detail: 'Not found.' }));
        await expect(provider.getIssueSummary('999999')).resolves.toBeNull();
        expect(mocks.logApiUsage).toHaveBeenCalledWith('metron', '/issue');
        expect(mocks.putCachedResponse).not.toHaveBeenCalled();
    });

    it('resolves null when the payload names a different issue', async () => {
        fetchMock.mockResolvedValueOnce(response(200, { ...issuePayload, id: 1 }));
        await expect(provider.getIssueSummary('4521')).resolves.toBeNull();
    });

    it('fails fast on a short 429: one fetch, no retry sleep', async () => {
        const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
        fetchMock.mockResolvedValue(response(429, {}, { 'retry-after': '1' }));
        await expect(provider.getIssueSummary('4521')).rejects.toThrow('METRON_RATE_LIMITED');
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 2000);
        // Only the (always-armed) request abort timer.
        expect(setTimeoutSpy.mock.calls.map(c => c[1])).toEqual([10000]);
    });

    it('surfaces a long ban as FATAL_RATE_LIMIT', async () => {
        fetchMock.mockResolvedValue(response(429, {}, { 'retry-after': '120' }));
        await expect(provider.getIssueSummary('4521')).rejects.toThrow('FATAL_RATE_LIMIT');
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('does not burst-sleep when the burst budget is nearly spent', async () => {
        const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
        const reset = String(Math.floor(Date.now() / 1000) + 30);
        fetchMock.mockResolvedValueOnce(response(200, issuePayload, { 'x-ratelimit-burst-remaining': '1', 'x-ratelimit-burst-reset': reset }));
        await expect(provider.getIssueSummary('4521')).resolves.toMatchObject({ id: 4521 });
        expect(setTimeoutSpy.mock.calls.map(c => c[1])).toEqual([10000]);
    });

    it('lets other HTTP errors through without retrying', async () => {
        fetchMock.mockResolvedValue(response(401, {}));
        await expect(provider.getIssueSummary('4521')).rejects.toThrow('HTTP Error: 401');
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('serves a cache hit without fetching or logging usage', async () => {
        mocks.getCachedResponse.mockResolvedValueOnce(issuePayload);
        await expect(provider.getIssueSummary('4521')).resolves.toMatchObject({ id: 4521, seriesName: 'Uncanny X-Men' });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(mocks.logApiUsage).not.toHaveBeenCalled();
    });

    it.each(['abc', '12/../3', '', '-1', '1.5'])('rejects id %j before any I/O', async id => {
        await expect(provider.getIssueSummary(id)).rejects.toThrow('METRON_INVALID_ID');
        expect(mocks.findManySettings).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
