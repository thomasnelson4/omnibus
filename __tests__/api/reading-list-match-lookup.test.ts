// __tests__/api/reading-list-match-lookup.test.ts
//
// GET /api/reading-lists/match (Fix match preview) and GET /api/reading-lists/match/providers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET as getMatch } from '@/app/api/reading-lists/match/route';
import { GET as getProviders } from '@/app/api/reading-lists/match/providers/route';
import { clearIssueMatchMemo } from '@/lib/metadata/issue-match';
import { adminSession, userSession } from '../helpers/session';
import { getReq } from '../helpers/request';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    listFindUnique: vi.fn(),
    itemFindFirst: vi.fn(),
    issueFindMany: vi.fn(),
    userFindUnique: vi.fn(),
    settingFindUnique: vi.fn(),
    settingFindMany: vi.fn(),
    access: vi.fn(),
    cachedCvGet: vi.fn(),
    getIssueSummary: vi.fn(),
    markSystemFlag: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: {
        readingList: { findUnique: mocks.listFindUnique },
        readingListItem: { findFirst: mocks.itemFindFirst },
        issue: { findMany: mocks.issueFindMany },
        user: { findUnique: mocks.userFindUnique },
        systemSetting: { findUnique: mocks.settingFindUnique, findMany: mocks.settingFindMany },
    },
}));
vi.mock('@/lib/library-access', async (orig) => ({
    ...(await orig<typeof import('@/lib/library-access')>()),
    getAccessibleLibraryIds: mocks.access,
}));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: mocks.cachedCvGet }));
vi.mock('@/lib/metadata/providers/metron', () => ({ MetronProvider: class { getIssueSummary = mocks.getIssueSummary; } }));
vi.mock('@/lib/utils/system-flags', () => ({ markSystemFlag: mocks.markSystemFlag, logApiUsage: vi.fn() }));

const url = (params: Record<string, string>) =>
    `http://localhost/api/reading-lists/match?${new URLSearchParams(params)}`;
const lookup = (over: Record<string, string> = {}) =>
    getMatch(getReq(url({ listId: 'list_1', provider: 'COMICVINE', issueId: '20288', ...over })));

const cvIssue = {
    id: 20288, name: 'Days of Future Past', issue_number: '141', cover_date: '1981-01-01',
    image: { medium_url: 'https://cv/141.jpg' }, volume: { id: 2133, name: 'Uncanny X-Men' },
    site_detail_url: 'https://comicvine.gamespot.com/uncanny-x-men-141/4000-20288/',
};
const localRow = (over: Record<string, any> = {}) => ({
    id: 'iss_1', number: '141', filePath: null, isAnnual: false, attachedVolumeId: null, attachedVolume: null,
    createdAt: new Date('2024-01-01'),
    series: { id: 'ser_1', name: 'Uncanny X-Men', metadataId: '2133', metadataSource: 'COMICVINE' },
    ...over,
});

describe('GET /api/reading-lists/match', () => {
    beforeEach(() => {
        clearIssueMatchMemo();
        vi.stubEnv('CV_API_KEY', '');
        mocks.getServerSession.mockResolvedValue(userSession());
        mocks.listFindUnique.mockResolvedValue({ id: 'list_1', userId: 'user_1' });
        mocks.itemFindFirst.mockResolvedValue(null);
        mocks.issueFindMany.mockResolvedValue([]);
        mocks.access.mockResolvedValue('ALL');
        mocks.settingFindUnique.mockResolvedValue({ key: 'cv_api_key', value: 'cv_key' });
        mocks.cachedCvGet.mockResolvedValue({ data: { status_code: 1, results: cvIssue }, cached: false });
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('401s without a session', async () => {
        mocks.getServerSession.mockResolvedValue(null);
        const res = await lookup();
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it.each([
        ['a missing listId', { listId: '' }, 'listId is required.'],
        ['a bad provider', { provider: 'ANILIST' }, 'provider must be COMICVINE or METRON.'],
        ['a bad id', { issueId: 'abc' }, 'Enter a positive numeric issue ID from the selected provider.'],
        ['a volume id', { issueId: '4050-2133' }, "That's a ComicVine volume ID (4050-…). Enter the issue ID (4000-…)."],
        ['an empty id', { issueId: '' }, 'Enter an issue ID.'],
    ])('400s on %s before any lookup', async (_label, over, error) => {
        const res = await lookup(over);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error, code: 'INVALID_INPUT' });
        expect(mocks.listFindUnique).not.toHaveBeenCalled();
        expect(mocks.cachedCvGet).not.toHaveBeenCalled();
    });

    it.each([
        ['a non-editor', { id: 'list_1', userId: 'other' }],
        ['a system list (USER)', { id: 'list_1', userId: null }],
        ['a missing list', null],
    ])('403s for %s with no provider call', async (_label, list) => {
        mocks.listFindUnique.mockResolvedValue(list);
        const res = await lookup();
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Forbidden', code: 'FORBIDDEN' });
        expect(mocks.cachedCvGet).not.toHaveBeenCalled();
        expect(mocks.issueFindMany).not.toHaveBeenCalled();
    });

    it('returns the match, the local copy and the scope', async () => {
        mocks.issueFindMany.mockResolvedValue([localRow()]);
        const res = await lookup({ issueId: 'https://comicvine.gamespot.com/uncanny-x-men-141/4000-20288/' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({
            match: expect.objectContaining({
                provider: 'COMICVINE', issueId: 20288, seriesId: 2133, seriesName: 'Uncanny X-Men', issueNumber: '141',
                issueTitle: 'Days of Future Past', displayTitle: 'Uncanny X-Men #141',
                siteUrl: 'https://comicvine.gamespot.com/uncanny-x-men-141/4000-20288/',
            }),
            local: { issueId: 'iss_1', seriesId: 'ser_1', seriesName: 'Uncanny X-Men', number: '141', hasFile: false },
            mislabeled: null,
            accessScope: 'self',
            keepable: false,
        });
    });

    describe('keepable (does keepLocalLink survive the save?)', () => {
        const linkedRow = (over: Record<string, any> = {}) => ({
            issueId: 'old_issue',
            issue: {
                metadataSource: 'LOCAL', metadataId: 'unmatched_1',
                series: { libraryId: 'lib1' },
                ...over,
            },
        });

        it('is false without an itemId — the request asked nothing about the entry', async () => {
            await lookup();
            expect(mocks.itemFindFirst).not.toHaveBeenCalled();
            expect((await (await lookup()).json()).keepable).toBe(false);
        });

        it('is true for a linked entry the library cannot contradict, read scoped by listId', async () => {
            mocks.itemFindFirst.mockResolvedValue(linkedRow());
            const body = await (await lookup({ itemId: 'item_1' })).json();
            expect(mocks.itemFindFirst).toHaveBeenCalledWith({
                where: { id: 'item_1', listId: 'list_1' },
                select: { issueId: true, issue: { select: { metadataSource: true, metadataId: true, series: { select: { libraryId: true } } } } },
            });
            expect(body.keepable).toBe(true);
        });

        it('is false when the library has a same-provider id (a contradiction)', async () => {
            mocks.itemFindFirst.mockResolvedValue(linkedRow({ metadataSource: 'COMICVINE', metadataId: '999' }));
            expect((await (await lookup({ itemId: 'item_1' })).json()).keepable).toBe(false);
        });

        it('is false for an item outside the list (an IDOR probe is just a miss)', async () => {
            mocks.itemFindFirst.mockResolvedValue(null);
            const body = await (await lookup({ itemId: 'other_users_item' })).json();
            expect(mocks.itemFindFirst.mock.calls[0][0].where).toEqual({ id: 'other_users_item', listId: 'list_1' });
            expect(body.keepable).toBe(false);
        });

        // The regression: the link is the OWNER's to lose, so the OWNER's libraries decide.
        it('is false when an ADMIN edits an entry linked into a library the owner cannot access', async () => {
            mocks.getServerSession.mockResolvedValue(adminSession());
            mocks.listFindUnique.mockResolvedValue({ id: 'list_1', userId: 'user_9' });
            mocks.userFindUnique.mockResolvedValue({ role: 'USER' });
            mocks.access.mockResolvedValue(['lib9']);
            mocks.itemFindFirst.mockResolvedValue(linkedRow());
            const body = await (await lookup({ itemId: 'item_1' })).json();
            expect(body.accessScope).toBe('owner');
            expect(body.keepable).toBe(false);
        });
    });

    it('reports a mislabeled copy instead of linking it', async () => {
        mocks.issueFindMany.mockResolvedValue([localRow({ number: '142' })]);
        const body = await (await lookup()).json();
        expect(body).toMatchObject({ local: null, mislabeled: { seriesName: 'Uncanny X-Men', number: '142' } });
    });

    it("filters by a restricted owner's libraries", async () => {
        mocks.access.mockResolvedValue(['lib1']);
        await lookup();
        expect(mocks.access).toHaveBeenCalledWith('user_1', 'USER');
        expect(mocks.issueFindMany.mock.calls[0][0].where).toEqual({
            metadataId: '20288', metadataSource: 'COMICVINE', series: { libraryId: { in: ['lib1'] } },
        });
    });

    it("checks the OWNER's libraries for an ADMIN on a user's list", async () => {
        mocks.getServerSession.mockResolvedValue(adminSession());
        mocks.listFindUnique.mockResolvedValue({ id: 'list_1', userId: 'user_9' });
        mocks.userFindUnique.mockResolvedValue({ role: 'USER' });
        mocks.access.mockResolvedValue(['lib9']);
        const body = await (await lookup()).json();
        expect(body.accessScope).toBe('owner');
        expect(mocks.access).toHaveBeenCalledWith('user_9', 'USER');
        expect(mocks.issueFindMany.mock.calls[0][0].where.series).toEqual({ libraryId: { in: ['lib9'] } });
    });

    it("is 'self' for an ADMIN on a system list", async () => {
        mocks.getServerSession.mockResolvedValue(adminSession());
        mocks.listFindUnique.mockResolvedValue({ id: 'list_1', userId: null });
        const body = await (await lookup()).json();
        expect(body.accessScope).toBe('self');
        expect(mocks.issueFindMany.mock.calls[0][0].where).not.toHaveProperty('series');
    });

    it('looks up Metron ids through MetronProvider', async () => {
        mocks.getIssueSummary.mockResolvedValue({
            id: 4521, number: '1', title: null, seriesId: 77, seriesName: 'Saga', seriesYearBegan: 2012,
            publisher: 'Image', coverDate: null, storeDate: null, image: null,
        });
        const body = await (await lookup({ provider: 'METRON', issueId: 'https://metron.cloud/issue/4521/' })).json();
        expect(mocks.getIssueSummary).toHaveBeenCalledWith('4521');
        expect(body.match).toMatchObject({ provider: 'METRON', issueId: 4521, seriesStartYear: 2012, displayTitle: 'Saga #1' });
    });

    it.each([
        ['an unconfigured provider', () => mocks.settingFindUnique.mockResolvedValue(null), 503, 'PROVIDER_NOT_CONFIGURED'],
        ['an unknown issue', () => mocks.cachedCvGet.mockRejectedValue({ response: { status: 404 } }), 404, 'ISSUE_NOT_FOUND'],
        ['a rate limit', () => mocks.cachedCvGet.mockRejectedValue({ response: { status: 420 } }), 429, 'RATE_LIMITED'],
        ['a provider outage', () => mocks.cachedCvGet.mockRejectedValue({ response: { status: 502 } }), 502, 'PROVIDER_ERROR'],
        ['a Metron rate limit', () => {
            mocks.getIssueSummary.mockRejectedValue(new Error('METRON_RATE_LIMITED'));
        }, 429, 'RATE_LIMITED', 'METRON'],
    ])('maps %s to its status and code', async (_label, arrange, status, code, provider = 'COMICVINE') => {
        arrange();
        const res = await lookup({ provider });
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ error: expect.any(String), code });
        expect(mocks.issueFindMany).not.toHaveBeenCalled();
    });

    it('500s on unexpected errors', async () => {
        mocks.issueFindMany.mockRejectedValue(new Error('db down'));
        const res = await lookup();
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'db down' });
    });
});

describe('GET /api/reading-lists/match/providers', () => {
    beforeEach(() => {
        vi.stubEnv('CV_API_KEY', '');
        mocks.getServerSession.mockResolvedValue(userSession());
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    const settings = (rows: Record<string, string>) =>
        mocks.settingFindMany.mockResolvedValue(Object.entries(rows).map(([key, value]) => ({ key, value })));

    it('401s without a session', async () => {
        mocks.getServerSession.mockResolvedValue(null);
        const res = await getProviders();
        expect(res.status).toBe(401);
        expect(mocks.settingFindMany).not.toHaveBeenCalled();
    });

    it('returns booleans and the primary provider — never the secret values', async () => {
        settings({ cv_api_key: 'SECRET_CV_KEY_123', metron_user: 'metron_login', metron_pass: 'SECRET_PASS_456', primary_metadata_source: 'METRON' });
        const res = await getProviders();
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ providers: { COMICVINE: true, METRON: true }, primary: 'METRON' });
        expect(text).not.toContain('SECRET_CV_KEY_123');
        expect(text).not.toContain('SECRET_PASS_456');
        expect(text).not.toContain('metron_login');
    });

    it('defaults the primary to ComicVine and reports unusable secrets as unconfigured', async () => {
        settings({ cv_api_key: '********', metron_user: 'u', metron_pass: 'enc:v2:x' });
        expect(await (await getProviders()).json()).toEqual({ providers: { COMICVINE: false, METRON: false }, primary: 'COMICVINE' });
    });

    it('works for a non-admin user (no /api/admin access needed)', async () => {
        settings({ cv_api_key: 'k' });
        const res = await getProviders();
        expect(res.status).toBe(200);
        expect((await res.json()).providers).toEqual({ COMICVINE: true, METRON: false });
    });
});
