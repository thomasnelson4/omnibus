// __tests__/api/reading-list-item-rematch.test.ts
//
// PATCH /api/reading-lists/items — Fix match (rematch | clear). Auth, IDOR scoping, owner-access
// links, the #194 guard, keep-link rules, provider error mapping, races and audit.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PATCH } from '@/app/api/reading-lists/items/route';
import { clearIssueMatchMemo } from '@/lib/metadata/issue-match';
import { adminSession, userSession } from '../helpers/session';
import { auditLog } from '../helpers/setup-global';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    listFindUnique: vi.fn(),
    itemFindFirst: vi.fn(),
    itemUpdateMany: vi.fn(),
    issueFindMany: vi.fn(),
    userFindUnique: vi.fn(),
    settingFindUnique: vi.fn(),
    access: vi.fn(),
    cachedCvGet: vi.fn(),
    getIssueSummary: vi.fn(),
    markSystemFlag: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: {
        readingList: { findUnique: mocks.listFindUnique },
        readingListItem: { findFirst: mocks.itemFindFirst, updateMany: mocks.itemUpdateMany },
        issue: { findMany: mocks.issueFindMany },
        user: { findUnique: mocks.userFindUnique },
        systemSetting: { findUnique: mocks.settingFindUnique },
    },
}));
vi.mock('@/lib/library-access', async (orig) => ({
    ...(await orig<typeof import('@/lib/library-access')>()),
    getAccessibleLibraryIds: mocks.access,
}));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: mocks.cachedCvGet }));
vi.mock('@/lib/metadata/providers/metron', () => ({ MetronProvider: class { getIssueSummary = mocks.getIssueSummary; } }));
vi.mock('@/lib/utils/system-flags', () => ({ markSystemFlag: mocks.markSystemFlag, logApiUsage: vi.fn() }));

const patch = (body: unknown, raw = false) => new Request('http://localhost/api/reading-lists/items', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
});
const rematch = (over: Record<string, unknown> = {}) =>
    patch({ listId: 'list_1', itemId: 'item_1', action: 'rematch', provider: 'COMICVINE', providerIssueId: 20288, ...over });

const cvIssue = {
    id: 20288, name: 'Days of Future Past', issue_number: '141', cover_date: '1981-01-01',
    image: { medium_url: 'https://cv/141.jpg' }, volume: { id: 2133, name: 'Uncanny X-Men' },
};
const localRow = (over: Record<string, any> = {}) => ({
    id: 'iss_1', number: '141', filePath: '/c/x141.cbz', isAnnual: false, attachedVolumeId: null, attachedVolume: null,
    createdAt: new Date('2024-01-01'),
    series: { id: 'ser_1', name: 'Uncanny X-Men', metadataId: '2133', metadataSource: 'COMICVINE' },
    ...over,
});
const unlinkedItem = { id: 'item_1', listId: 'list_1', title: 'Uncanny X-Men (1963) #141', cvIssueId: null, metadataSource: 'COMICVINE', issueId: null, issue: null, order: 3 };
const linkedItem = (issue: Record<string, any>, over: Record<string, any> = {}) => ({
    ...unlinkedItem,
    title: 'X-Men #1',
    issueId: issue.id ?? 'old_issue',
    issue: {
        id: 'old_issue', number: '1', filePath: '/c/old.cbz', metadataSource: 'COMICVINE', metadataId: '999',
        series: { id: 'ser_old', name: 'X-Men', libraryId: 'lib1', metadataId: '4511', metadataSource: 'COMICVINE' },
        ...issue,
    },
    ...over,
});

const lastUpdate = () => mocks.itemUpdateMany.mock.calls.at(-1)?.[0];
const providerCalls = () => mocks.cachedCvGet.mock.calls.length + mocks.getIssueSummary.mock.calls.length;

describe('PATCH /api/reading-lists/items', () => {
    beforeEach(() => {
        clearIssueMatchMemo();
        mocks.getServerSession.mockResolvedValue(userSession());
        mocks.listFindUnique.mockResolvedValue({ id: 'list_1', userId: 'user_1' });
        mocks.itemFindFirst.mockResolvedValue(unlinkedItem);
        mocks.itemUpdateMany.mockResolvedValue({ count: 1 });
        mocks.issueFindMany.mockResolvedValue([]);
        mocks.access.mockResolvedValue('ALL');
        mocks.settingFindUnique.mockResolvedValue({ key: 'cv_api_key', value: 'cv_key' });
        mocks.cachedCvGet.mockResolvedValue({ data: { status_code: 1, results: cvIssue }, cached: false });
    });

    it('401s without a session', async () => {
        mocks.getServerSession.mockResolvedValue(null);
        const res = await PATCH(rematch());
        expect(res.status).toBe(401);
        expect(mocks.listFindUnique).not.toHaveBeenCalled();
    });

    describe('input validation (400, no DB calls)', () => {
        it.each([
            ['invalid JSON', patch('{"listId":', true), 'Invalid JSON body.'],
            ['a null body', patch(null), 'Invalid JSON body.'],
            ['an array body', patch([{ listId: 'list_1' }]), 'Invalid JSON body.'],
            ['a missing listId', patch({ itemId: 'item_1', action: 'clear' }), 'listId and itemId are required.'],
            ['an operator-object listId', patch({ listId: { not: '' }, itemId: 'item_1', action: 'clear' }), 'listId and itemId are required.'],
            ['a numeric itemId', patch({ listId: 'list_1', itemId: 7, action: 'clear' }), 'listId and itemId are required.'],
            ['an empty itemId', patch({ listId: 'list_1', itemId: '', action: 'clear' }), 'listId and itemId are required.'],
            ['an unknown action', patch({ listId: 'list_1', itemId: 'item_1', action: 'nope' }), 'action must be "rematch" or "clear".'],
            ['an unsupported provider', rematch({ provider: 'ANILIST' }), 'provider must be COMICVINE or METRON.'],
            ['a volume id', rematch({ providerIssueId: '4050-1' }), "That's a ComicVine volume ID (4050-…). Enter the issue ID (4000-…)."],
            ['a missing id', rematch({ providerIssueId: undefined }), 'Enter an issue ID.'],
            ['an out-of-range id', rematch({ providerIssueId: 2147483648 }), 'Enter a positive numeric issue ID from the selected provider.'],
        ])('rejects %s', async (_label, req, error) => {
            const res = await PATCH(req);
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error, code: 'INVALID_INPUT' });
            expect(mocks.listFindUnique).not.toHaveBeenCalled();
            expect(mocks.itemFindFirst).not.toHaveBeenCalled();
            expect(mocks.itemUpdateMany).not.toHaveBeenCalled();
            expect(providerCalls()).toBe(0);
        });
    });

    describe('ownership (403)', () => {
        it.each([
            ["another user's list", { id: 'list_1', userId: 'other' }],
            ['a system list', { id: 'list_1', userId: null }],
            ['a missing list', null],
        ])('forbids a USER on %s with no provider call or write', async (_label, list) => {
            mocks.listFindUnique.mockResolvedValue(list);
            const res = await PATCH(rematch());
            expect(res.status).toBe(403);
            expect(await res.json()).toEqual({ error: 'Forbidden', code: 'FORBIDDEN' });
            expect(mocks.itemFindFirst).not.toHaveBeenCalled();
            expect(providerCalls()).toBe(0);
            expect(mocks.itemUpdateMany).not.toHaveBeenCalled();
            expect(auditLog).not.toHaveBeenCalled();
        });

        it('lets an ADMIN edit a system list', async () => {
            mocks.getServerSession.mockResolvedValue(adminSession());
            mocks.listFindUnique.mockResolvedValue({ id: 'list_1', userId: null });
            const res = await PATCH(rematch());
            expect(res.status).toBe(200);
            expect(mocks.access).not.toHaveBeenCalled();
            expect(mocks.issueFindMany.mock.calls[0][0].where).not.toHaveProperty('series');
        });
    });

    it('404s ITEM_NOT_FOUND for an item outside the list, scoping the read by listId', async () => {
        mocks.itemFindFirst.mockResolvedValue(null);
        const res = await PATCH(rematch());
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'This entry is no longer in the list.', code: 'ITEM_NOT_FOUND' });
        expect(mocks.itemFindFirst).toHaveBeenCalledWith({
            where: { id: 'item_1', listId: 'list_1' },
            include: { issue: { include: { series: true } } },
        });
        expect(providerCalls()).toBe(0);
        expect(mocks.itemUpdateMany).not.toHaveBeenCalled();
    });

    it('rematches by ComicVine id and links the accessible local copy', async () => {
        mocks.issueFindMany.mockResolvedValue([localRow()]);
        const updated = { ...unlinkedItem, cvIssueId: 20288, title: 'Uncanny X-Men #141', issueId: 'iss_1', issue: { id: 'iss_1', filePath: '/c/x141.cbz', series: {} } };
        mocks.itemFindFirst.mockResolvedValueOnce(unlinkedItem).mockResolvedValueOnce(updated);

        const res = await PATCH(rematch());
        expect(res.status).toBe(200);
        expect(lastUpdate()).toEqual({
            where: { id: 'item_1', listId: 'list_1' },
            data: { cvIssueId: 20288, metadataSource: 'COMICVINE', title: 'Uncanny X-Men #141', issueId: 'iss_1' },
        });
        const body = await res.json();
        expect(body).toMatchObject({ success: true, linked: true, link: 'matched', hasFile: true, item: { id: 'item_1', issueId: 'iss_1' } });
        expect(body.match).toMatchObject({ provider: 'COMICVINE', issueId: 20288, displayTitle: 'Uncanny X-Men #141' });
        expect(mocks.itemFindFirst).toHaveBeenCalledTimes(2);
        expect(mocks.itemFindFirst.mock.calls[1][0].where).toEqual({ id: 'item_1', listId: 'list_1' });
        expect(auditLog).toHaveBeenCalledWith('REMATCH_READING_LIST_ITEM', expect.objectContaining({
            listId: 'list_1', itemId: 'item_1', provider: 'COMICVINE', providerIssueId: 20288, link: 'matched', linkedIssueId: 'iss_1',
            previous: { cvIssueId: null, metadataSource: 'COMICVINE', issueId: null, title: 'Uncanny X-Men (1963) #141' },
        }), 'user_1');
    });

    it('accepts a pasted ComicVine URL as the id', async () => {
        await PATCH(rematch({ providerIssueId: 'https://comicvine.gamespot.com/uncanny-x-men-141/4000-20288/' }));
        expect(lastUpdate().data.cvIssueId).toBe(20288);
    });

    it('clears a stale link that the library contradicts', async () => {
        mocks.itemFindFirst.mockResolvedValue(linkedItem({ metadataSource: 'COMICVINE', metadataId: '999' }));
        const res = await PATCH(rematch());
        expect(lastUpdate().data).toEqual({ cvIssueId: 20288, metadataSource: 'COMICVINE', title: 'Uncanny X-Men #141', issueId: null });
        expect(await res.json()).toMatchObject({ link: 'none' });
    });

    it("searches only the restricted owner's libraries", async () => {
        mocks.access.mockResolvedValue(['lib1']);
        const res = await PATCH(rematch());
        expect(mocks.access).toHaveBeenCalledWith('user_1', 'USER');
        expect(mocks.issueFindMany.mock.calls[0][0].where).toEqual({
            metadataId: '20288', metadataSource: 'COMICVINE', series: { libraryId: { in: ['lib1'] } },
        });
        expect(lastUpdate().data.issueId).toBeNull();
        expect(await res.json()).toMatchObject({ linked: false, link: 'none', hasFile: false });
    });

    it("uses the OWNER's libraries when an ADMIN edits a user's list", async () => {
        mocks.getServerSession.mockResolvedValue(adminSession());
        mocks.listFindUnique.mockResolvedValue({ id: 'list_1', userId: 'user_9' });
        mocks.userFindUnique.mockResolvedValue({ role: 'USER' });
        mocks.access.mockResolvedValue(['lib9']);
        const res = await PATCH(rematch());
        expect(res.status).toBe(200);
        expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { id: 'user_9' }, select: { role: true } });
        expect(mocks.access).toHaveBeenCalledWith('user_9', 'USER');
        expect(mocks.access).not.toHaveBeenCalledWith('admin_1', 'ADMIN');
        expect(mocks.issueFindMany.mock.calls[0][0].where.series).toEqual({ libraryId: { in: ['lib9'] } });
        expect(auditLog).toHaveBeenCalledWith('REMATCH_READING_LIST_ITEM', expect.anything(), 'admin_1');
    });

    describe('keepLocalLink', () => {
        it.each([
            ['a LOCAL unmatched file', { metadataSource: 'LOCAL', metadataId: 'unmatched_1' }],
            ['an engine unmatched_ row under a provider source', { metadataSource: 'COMICVINE', metadataId: 'unmatched_x' }],
            ['a row matched to the other provider', { metadataSource: 'METRON', metadataId: '77' }],
        ])('keeps %s the library cannot contradict', async (_label, issue) => {
            mocks.itemFindFirst.mockResolvedValue(linkedItem(issue));
            const res = await PATCH(rematch({ keepLocalLink: true }));
            expect(lastUpdate().data.issueId).toBe('old_issue');
            expect(await res.json()).toMatchObject({ link: 'kept' });
        });

        it('drops a same-provider row with a different numeric id', async () => {
            mocks.itemFindFirst.mockResolvedValue(linkedItem({ metadataSource: 'COMICVINE', metadataId: '999' }));
            const res = await PATCH(rematch({ keepLocalLink: true }));
            expect(lastUpdate().data.issueId).toBeNull();
            expect(await res.json()).toMatchObject({ link: 'none' });
        });

        it("drops a link outside the owner's libraries", async () => {
            mocks.access.mockResolvedValue(['lib2']);
            mocks.itemFindFirst.mockResolvedValue(linkedItem({ metadataSource: 'LOCAL', metadataId: 'unmatched_1' }));
            await PATCH(rematch({ keepLocalLink: true }));
            expect(lastUpdate().data.issueId).toBeNull();
        });

        it('only counts a literal true', async () => {
            mocks.itemFindFirst.mockResolvedValue(linkedItem({ metadataSource: 'LOCAL', metadataId: 'unmatched_1' }));
            await PATCH(rematch({ keepLocalLink: 'true' }));
            expect(lastUpdate().data.issueId).toBeNull();
        });

        it('never overrides an identity-checked local copy', async () => {
            mocks.issueFindMany.mockResolvedValue([localRow()]);
            mocks.itemFindFirst.mockResolvedValue(linkedItem({ metadataSource: 'LOCAL', metadataId: 'unmatched_1' }));
            const res = await PATCH(rematch({ keepLocalLink: true }));
            expect(lastUpdate().data.issueId).toBe('iss_1');
            expect(await res.json()).toMatchObject({ link: 'matched' });
        });
    });

    it('does not link a mislabeled local row (#194)', async () => {
        mocks.issueFindMany.mockResolvedValue([localRow({ number: '142' })]);
        const res = await PATCH(rematch());
        expect(lastUpdate().data.issueId).toBeNull();
        expect(await res.json()).toMatchObject({ link: 'none', linked: false });
    });

    it('rematches by Metron id with a title from the series name', async () => {
        mocks.getIssueSummary.mockResolvedValue({
            id: 4521, number: '7', title: 'Chapter Seven', seriesId: 77, seriesName: 'Saga', seriesYearBegan: 2012,
            publisher: 'Image', coverDate: null, storeDate: null, image: null,
        });
        const res = await PATCH(rematch({ provider: 'METRON', providerIssueId: '4521' }));
        expect(res.status).toBe(200);
        expect(mocks.getIssueSummary).toHaveBeenCalledWith('4521');
        expect(mocks.cachedCvGet).not.toHaveBeenCalled();
        expect(mocks.issueFindMany.mock.calls[0][0].where).toMatchObject({ metadataId: '4521', metadataSource: 'METRON' });
        expect(lastUpdate().data).toEqual({ cvIssueId: 4521, metadataSource: 'METRON', title: 'Saga #7', issueId: null });
    });

    describe('provider errors never write', () => {
        beforeEach(() => { vi.stubEnv('CV_API_KEY', ''); });
        afterEach(() => { vi.unstubAllEnvs(); });

        it.each([
            ['an unconfigured provider', () => mocks.settingFindUnique.mockResolvedValue(null), 503, 'PROVIDER_NOT_CONFIGURED'],
            ['a ComicVine 404', () => mocks.cachedCvGet.mockRejectedValue({ response: { status: 404 } }), 404, 'ISSUE_NOT_FOUND'],
            ['a ComicVine 429', () => mocks.cachedCvGet.mockRejectedValue({ response: { status: 429 } }), 429, 'RATE_LIMITED'],
            ['a ComicVine timeout', () => mocks.cachedCvGet.mockRejectedValue({ code: 'ECONNABORTED' }), 502, 'PROVIDER_ERROR'],
        ])('maps %s', async (_label, arrange, status, code) => {
            arrange();
            const res = await PATCH(rematch());
            expect(res.status).toBe(status);
            expect(await res.json()).toMatchObject({ code, error: expect.any(String) });
            expect(mocks.itemUpdateMany).not.toHaveBeenCalled();
            expect(auditLog).not.toHaveBeenCalled();
        });
    });

    it('404s when the item vanished before the write', async () => {
        mocks.itemUpdateMany.mockResolvedValue({ count: 0 });
        const res = await PATCH(rematch());
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ code: 'ITEM_NOT_FOUND' });
        expect(auditLog).not.toHaveBeenCalled();
    });

    it('500s with the house error shape on unexpected failures', async () => {
        mocks.itemUpdateMany.mockRejectedValue(new Error('Foreign key constraint failed'));
        const res = await PATCH(rematch());
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Foreign key constraint failed' });
    });

    describe('clear', () => {
        const clear = () => patch({ listId: 'list_1', itemId: 'item_1', action: 'clear' });

        it('drops the provider identity and the link, keeping the title', async () => {
            mocks.itemFindFirst.mockResolvedValue(linkedItem({}, { title: 'Uncanny X-Men #141', cvIssueId: 20288 }));
            const res = await PATCH(clear());
            expect(res.status).toBe(200);
            expect(lastUpdate()).toEqual({
                where: { id: 'item_1', listId: 'list_1' },
                data: { cvIssueId: null, metadataSource: 'COMICVINE', issueId: null, title: 'Uncanny X-Men #141' },
            });
            expect(await res.json()).toMatchObject({ success: true, item: expect.any(Object) });
            expect(auditLog).toHaveBeenCalledWith('CLEAR_READING_LIST_ITEM_MATCH', {
                listId: 'list_1', itemId: 'item_1',
                previous: { cvIssueId: 20288, metadataSource: 'COMICVINE', issueId: 'old_issue', title: 'Uncanny X-Men #141' },
            }, 'user_1');
            expect(providerCalls()).toBe(0);
        });

        it('gives a linked entry with an empty title its "Series #N" title', async () => {
            mocks.itemFindFirst.mockResolvedValue(linkedItem({}, { title: '' }));
            await PATCH(clear());
            expect(lastUpdate().data.title).toBe('X-Men #1');
        });

        it("forbids clearing another user's list", async () => {
            mocks.listFindUnique.mockResolvedValue({ id: 'list_1', userId: 'other' });
            const res = await PATCH(clear());
            expect(res.status).toBe(403);
            expect(mocks.itemUpdateMany).not.toHaveBeenCalled();
        });
    });
});
