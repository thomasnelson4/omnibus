// __tests__/lib/metadata/issue-match.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    IssueMatchError, clearIssueMatchMemo, getConfiguredProviders, lookupProviderIssue,
} from '@/lib/metadata/issue-match';

const mocks = vi.hoisted(() => ({
    settingFindUnique: vi.fn(),
    settingFindMany: vi.fn(),
    cachedCvGet: vi.fn(),
    getIssueSummary: vi.fn(),
    markSystemFlag: vi.fn(),
    logApiUsage: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: { systemSetting: { findUnique: mocks.settingFindUnique, findMany: mocks.settingFindMany } },
}));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: mocks.cachedCvGet }));
vi.mock('@/lib/metadata/providers/metron', () => ({ MetronProvider: class { getIssueSummary = mocks.getIssueSummary; } }));
vi.mock('@/lib/utils/system-flags', () => ({ markSystemFlag: mocks.markSystemFlag, logApiUsage: mocks.logApiUsage }));

const CV_URL = 'https://comicvine.gamespot.com/api/issue/4000-20288/';
const cvIssue = {
    id: 20288,
    name: 'Days of Future Past',
    issue_number: '141',
    cover_date: '1981-01-01',
    store_date: '1980-10-07',
    image: { medium_url: 'https://comicvine.gamespot.com/a/uploads/scale_medium/x 141.jpg', small_url: 'https://cv/small.jpg' },
    volume: { id: 2133, name: 'Uncanny X-Men' },
    site_detail_url: 'https://comicvine.gamespot.com/uncanny-x-men-141-days-of-future-past/4000-20288/',
};
const cvOk = (results: any = cvIssue, cached = false) => ({ data: { status_code: 1, error: 'OK', results }, cached });

const expectMatchError = async (p: Promise<unknown>, code: string, status: number, message?: RegExp | string) => {
    const e = await p.then(() => null, (err) => err);
    expect(e).toBeInstanceOf(IssueMatchError);
    expect(e).toMatchObject({ code, status });
    if (message) expect(e.message).toMatch(message);
    return e as IssueMatchError;
};

describe('lookupProviderIssue — ComicVine', () => {
    beforeEach(() => {
        clearIssueMatchMemo();
        vi.stubEnv('CV_API_KEY', '');
        mocks.settingFindUnique.mockResolvedValue({ key: 'cv_api_key', value: 'cv_key' });
        mocks.cachedCvGet.mockResolvedValue(cvOk());
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('maps every field from one issue call and never logs usage itself', async () => {
        const m = await lookupProviderIssue('COMICVINE', 20288);
        expect(m).toEqual({
            provider: 'COMICVINE',
            issueId: 20288,
            seriesId: 2133,
            seriesName: 'Uncanny X-Men',
            seriesStartYear: null,
            publisher: null,
            issueNumber: '141',
            issueTitle: 'Days of Future Past',
            coverDate: '1981-01-01',
            storeDate: '1980-10-07',
            image: `/api/library/cover?path=${encodeURIComponent('https://comicvine.gamespot.com/a/uploads/scale_medium/x 141.jpg')}`,
            siteUrl: 'https://comicvine.gamespot.com/uncanny-x-men-141-days-of-future-past/4000-20288/',
            displayTitle: 'Uncanny X-Men #141',
        });
        expect(m.image).toContain('x%20141.jpg');
        expect(mocks.cachedCvGet).toHaveBeenCalledOnce();
        const [url, opts, bypass] = mocks.cachedCvGet.mock.calls[0];
        expect(url).toBe(CV_URL);
        expect(opts.params).toEqual({ api_key: 'cv_key', format: 'json', field_list: 'id,name,issue_number,cover_date,store_date,image,volume,site_detail_url' });
        expect(opts.timeout).toBe(10000);
        expect(bypass).toBeUndefined();
        expect(mocks.logApiUsage).not.toHaveBeenCalled();
    });

    it('normalizes numbers, drops placeholder titles and untrusted site URLs', async () => {
        mocks.cachedCvGet.mockResolvedValue(cvOk({
            ...cvIssue, issue_number: '013½', name: 'Issue #13', site_detail_url: 'https://evil.example/x', image: { thumb_url: 'https://cv/t.jpg' },
        }));
        const m = await lookupProviderIssue('COMICVINE', 20288);
        expect(m).toMatchObject({
            issueNumber: '13.5', issueTitle: null, displayTitle: 'Uncanny X-Men #13.5',
            siteUrl: 'https://comicvine.gamespot.com/issue/4000-20288/',
            image: `/api/library/cover?path=${encodeURIComponent('https://cv/t.jpg')}`,
        });
    });

    it('drops a title equal to the series name and handles a missing volume', async () => {
        mocks.cachedCvGet.mockResolvedValue(cvOk({ id: 20288, issue_number: '3', name: 'Uncanny X-Men', volume: { id: 2133, name: 'Uncanny X-Men' } }));
        expect(await lookupProviderIssue('COMICVINE', 20288)).toMatchObject({ issueTitle: null, image: null, coverDate: null });
        clearIssueMatchMemo();
        mocks.cachedCvGet.mockResolvedValue(cvOk({ id: 20288, issue_number: '3', name: null, volume: null }));
        expect(await lookupProviderIssue('COMICVINE', 20288)).toMatchObject({ seriesId: null, seriesName: null, displayTitle: 'Issue #3' });
    });

    it.each([
        ['an HTTP 404', () => mocks.cachedCvGet.mockRejectedValue({ response: { status: 404 } })],
        ['status_code 101', () => mocks.cachedCvGet.mockResolvedValue({ data: { status_code: 101, error: 'Object Not Found', results: [] }, cached: false })],
        ['a different issue id', () => mocks.cachedCvGet.mockResolvedValue(cvOk({ id: 999 }))],
        ['empty results', () => mocks.cachedCvGet.mockResolvedValue(cvOk([]))],
    ])('maps %s to ISSUE_NOT_FOUND', async (_label, arrange) => {
        arrange();
        await expectMatchError(lookupProviderIssue('COMICVINE', 20288), 'ISSUE_NOT_FOUND', 404, 'No ComicVine issue has ID 20288. Check the provider and ID.');
    });

    it.each([
        ['HTTP 420', () => mocks.cachedCvGet.mockRejectedValue({ response: { status: 420 } })],
        ['HTTP 429', () => mocks.cachedCvGet.mockRejectedValue({ response: { status: 429 } })],
        ['status_code 107', () => mocks.cachedCvGet.mockResolvedValue({ data: { status_code: 107, results: [] }, cached: false })],
    ])('maps %s to RATE_LIMITED and raises the health flag', async (_label, arrange) => {
        arrange();
        await expectMatchError(lookupProviderIssue('COMICVINE', 20288), 'RATE_LIMITED', 429, /rate-limiting/);
        expect(mocks.markSystemFlag).toHaveBeenCalledWith('cv_rate_limit_time');
    });

    it('maps timeouts / network errors to PROVIDER_ERROR', async () => {
        mocks.cachedCvGet.mockRejectedValue({ code: 'ECONNABORTED', message: 'timeout of 10000ms exceeded' });
        await expectMatchError(lookupProviderIssue('COMICVINE', 20288), 'PROVIDER_ERROR', 502, "Couldn't reach ComicVine — try again.");
        mocks.cachedCvGet.mockRejectedValue({ response: { status: 503 } });
        await expectMatchError(lookupProviderIssue('COMICVINE', 20288), 'PROVIDER_ERROR', 502);
        expect(mocks.markSystemFlag).not.toHaveBeenCalled();
    });

    it('maps a rejected key (401 or status_code 100) to PROVIDER_ERROR with the Settings hint', async () => {
        mocks.cachedCvGet.mockRejectedValue({ response: { status: 401 } });
        await expectMatchError(lookupProviderIssue('COMICVINE', 20288), 'PROVIDER_ERROR', 502, /rejected the API key/);
        mocks.cachedCvGet.mockResolvedValue({ data: { status_code: 100, error: 'Invalid API Key' }, cached: false });
        await expectMatchError(lookupProviderIssue('COMICVINE', 20288), 'PROVIDER_ERROR', 502, /rejected the API key/);
    });

    it('maps other non-success status codes and non-JSON bodies to PROVIDER_ERROR', async () => {
        mocks.cachedCvGet.mockResolvedValue({ data: { status_code: 105, results: [] }, cached: false });
        await expectMatchError(lookupProviderIssue('COMICVINE', 20288), 'PROVIDER_ERROR', 502);
        mocks.cachedCvGet.mockResolvedValue({ data: '<html>busy</html>', cached: false });
        await expectMatchError(lookupProviderIssue('COMICVINE', 20288), 'PROVIDER_ERROR', 502);
    });

    it('re-fetches a CACHED error body once with the cache bypassed', async () => {
        mocks.cachedCvGet
            .mockResolvedValueOnce({ data: { status_code: 100, error: 'Invalid API Key' }, cached: true })
            .mockResolvedValueOnce(cvOk());
        await expect(lookupProviderIssue('COMICVINE', 20288)).resolves.toMatchObject({ issueId: 20288 });
        expect(mocks.cachedCvGet).toHaveBeenCalledTimes(2);
        expect(mocks.cachedCvGet.mock.calls[1][0]).toBe(CV_URL);
        expect(mocks.cachedCvGet.mock.calls[1][2]).toBe(true);
    });

    it('does not retry an UNCACHED error body', async () => {
        mocks.cachedCvGet.mockResolvedValue({ data: { status_code: 100 }, cached: false });
        await expectMatchError(lookupProviderIssue('COMICVINE', 20288), 'PROVIDER_ERROR', 502);
        expect(mocks.cachedCvGet).toHaveBeenCalledOnce();
    });

    it('does not re-fetch a cached success', async () => {
        mocks.cachedCvGet.mockResolvedValue(cvOk(cvIssue, true));
        await expect(lookupProviderIssue('COMICVINE', 20288)).resolves.toMatchObject({ issueId: 20288 });
        expect(mocks.cachedCvGet).toHaveBeenCalledOnce();
    });

    it.each([
        ['missing', null],
        ['masked', { key: 'cv_api_key', value: '********' }],
        ['undecryptable', { key: 'cv_api_key', value: 'enc:v2:abcdef' }],
        ['empty', { key: 'cv_api_key', value: '' }],
    ])('is PROVIDER_NOT_CONFIGURED when the key is %s', async (_label, row) => {
        mocks.settingFindUnique.mockResolvedValue(row);
        await expectMatchError(lookupProviderIssue('COMICVINE', 20288), 'PROVIDER_NOT_CONFIGURED', 503, /an admin can add an API key/);
        expect(mocks.cachedCvGet).not.toHaveBeenCalled();
    });

    it('falls back to process.env.CV_API_KEY', async () => {
        mocks.settingFindUnique.mockResolvedValue(null);
        vi.stubEnv('CV_API_KEY', 'env_key');
        await lookupProviderIssue('COMICVINE', 20288);
        expect(mocks.cachedCvGet.mock.calls[0][1].params.api_key).toBe('env_key');
    });

    it('memoizes successful lookups only, until cleared', async () => {
        await lookupProviderIssue('COMICVINE', 20288);
        await lookupProviderIssue('COMICVINE', 20288);
        expect(mocks.cachedCvGet).toHaveBeenCalledTimes(1);

        clearIssueMatchMemo();
        await lookupProviderIssue('COMICVINE', 20288);
        expect(mocks.cachedCvGet).toHaveBeenCalledTimes(2);

        mocks.cachedCvGet.mockRejectedValueOnce({ response: { status: 404 } });
        await expectMatchError(lookupProviderIssue('COMICVINE', 77), 'ISSUE_NOT_FOUND', 404);
        mocks.cachedCvGet.mockResolvedValueOnce(cvOk({ ...cvIssue, id: 77 }));
        await expect(lookupProviderIssue('COMICVINE', 77)).resolves.toMatchObject({ issueId: 77 });
        expect(mocks.cachedCvGet).toHaveBeenCalledTimes(4);
    });

    it('keys the memo by provider', async () => {
        mocks.getIssueSummary.mockResolvedValue({ id: 20288, number: '1', title: null, seriesId: 1, seriesName: 'Saga', seriesYearBegan: 2012, publisher: 'Image', coverDate: null, storeDate: null, image: null });
        await lookupProviderIssue('COMICVINE', 20288);
        await expect(lookupProviderIssue('METRON', 20288)).resolves.toMatchObject({ provider: 'METRON', seriesName: 'Saga' });
        expect(mocks.getIssueSummary).toHaveBeenCalledOnce();
    });

    it.each([0, -1, 1.5, Number.NaN, 2147483648])('refuses an unvalidated id %s before any I/O', async id => {
        await expectMatchError(lookupProviderIssue('COMICVINE', id), 'INVALID_INPUT', 400);
        expect(mocks.settingFindUnique).not.toHaveBeenCalled();
        expect(mocks.cachedCvGet).not.toHaveBeenCalled();
    });
});

describe('lookupProviderIssue — Metron', () => {
    const summary = {
        id: 4521, number: '141', title: 'Days of Future Past', seriesId: 2133, seriesName: 'Uncanny X-Men',
        seriesYearBegan: 1963, publisher: 'Marvel', coverDate: '1981-01-01', storeDate: '1980-10-07',
        image: 'https://static.metron.cloud/media/issue/x.jpg',
    };

    beforeEach(() => {
        clearIssueMatchMemo();
        mocks.getIssueSummary.mockResolvedValue(summary);
    });

    it('maps the summary', async () => {
        await expect(lookupProviderIssue('METRON', 4521)).resolves.toEqual({
            provider: 'METRON',
            issueId: 4521,
            seriesId: 2133,
            seriesName: 'Uncanny X-Men',
            seriesStartYear: 1963,
            publisher: 'Marvel',
            issueNumber: '141',
            issueTitle: 'Days of Future Past',
            coverDate: '1981-01-01',
            storeDate: '1980-10-07',
            image: `/api/library/cover?path=${encodeURIComponent('https://static.metron.cloud/media/issue/x.jpg')}`,
            siteUrl: 'https://metron.cloud/issue/4521/',
            displayTitle: 'Uncanny X-Men #141',
        });
        expect(mocks.getIssueSummary).toHaveBeenCalledWith('4521');
        expect(mocks.cachedCvGet).not.toHaveBeenCalled();
    });

    it('drops a title equal to the series name', async () => {
        mocks.getIssueSummary.mockResolvedValue({ ...summary, title: 'Uncanny X-Men' });
        await expect(lookupProviderIssue('METRON', 4521)).resolves.toMatchObject({ issueTitle: null });
    });

    it('maps null to ISSUE_NOT_FOUND', async () => {
        mocks.getIssueSummary.mockResolvedValue(null);
        await expectMatchError(lookupProviderIssue('METRON', 4521), 'ISSUE_NOT_FOUND', 404, 'No Metron issue has ID 4521. Check the provider and ID.');
    });

    it('maps METRON_NOT_CONFIGURED to 503', async () => {
        mocks.getIssueSummary.mockRejectedValue(new Error('METRON_NOT_CONFIGURED'));
        await expectMatchError(lookupProviderIssue('METRON', 4521), 'PROVIDER_NOT_CONFIGURED', 503, /a Metron login/);
    });

    it.each(['METRON_RATE_LIMITED', 'FATAL_RATE_LIMIT'])('maps %s to 429 and raises the health flag', async msg => {
        mocks.getIssueSummary.mockRejectedValue(new Error(msg));
        await expectMatchError(lookupProviderIssue('METRON', 4521), 'RATE_LIMITED', 429, 'Metron is rate-limiting requests — try again in a few minutes.');
        expect(mocks.markSystemFlag).toHaveBeenCalledWith('metron_rate_limit_time');
    });

    it.each(['HTTP Error: 401', 'HTTP Error: 403'])('maps %s to a login PROVIDER_ERROR', async msg => {
        mocks.getIssueSummary.mockRejectedValue(new Error(msg));
        await expectMatchError(lookupProviderIssue('METRON', 4521), 'PROVIDER_ERROR', 502, /rejected the login/);
    });

    it('maps anything else to PROVIDER_ERROR', async () => {
        mocks.getIssueSummary.mockRejectedValue(new Error('This operation was aborted'));
        await expectMatchError(lookupProviderIssue('METRON', 4521), 'PROVIDER_ERROR', 502, "Couldn't reach Metron — try again.");
        mocks.getIssueSummary.mockRejectedValue(new Error('HTTP Error: 500'));
        await expectMatchError(lookupProviderIssue('METRON', 4521), 'PROVIDER_ERROR', 502);
        expect(mocks.markSystemFlag).not.toHaveBeenCalled();
    });
});

describe('getConfiguredProviders', () => {
    beforeEach(() => {
        vi.stubEnv('CV_API_KEY', '');
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    const settings = (rows: Record<string, string>) =>
        mocks.settingFindMany.mockResolvedValue(Object.entries(rows).map(([key, value]) => ({ key, value })));

    it('reports both providers and the primary', async () => {
        settings({ cv_api_key: 'k', metron_user: 'u', metron_pass: 'p', primary_metadata_source: 'METRON' });
        await expect(getConfiguredProviders()).resolves.toEqual({ providers: { COMICVINE: true, METRON: true }, primary: 'METRON' });
        expect(mocks.settingFindMany).toHaveBeenCalledWith({
            where: { key: { in: ['cv_api_key', 'metron_user', 'metron_pass', 'primary_metadata_source'] } },
        });
    });

    it('defaults the primary to ComicVine and treats masked / undecryptable secrets as unconfigured', async () => {
        settings({ cv_api_key: 'enc:v2:zz', metron_user: 'u', metron_pass: '********', primary_metadata_source: 'ANILIST' });
        await expect(getConfiguredProviders()).resolves.toEqual({ providers: { COMICVINE: false, METRON: false }, primary: 'COMICVINE' });
        settings({ metron_user: 'u', metron_pass: 'enc:v1:zz' });
        await expect(getConfiguredProviders()).resolves.toEqual({ providers: { COMICVINE: false, METRON: false }, primary: 'COMICVINE' });
    });

    it('needs a Metron username as well as a password', async () => {
        settings({ metron_pass: 'p' });
        expect((await getConfiguredProviders()).providers.METRON).toBe(false);
    });

    it('counts the CV_API_KEY environment fallback', async () => {
        settings({});
        vi.stubEnv('CV_API_KEY', 'env_key');
        expect((await getConfiguredProviders()).providers.COMICVINE).toBe(true);
    });
});
