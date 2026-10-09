// __tests__/api/reading-list-match-keep-link.test.ts
//
// Regression (#1 of the adversarial review): the Fix match PREVIEW and the SAVE must never disagree
// about whether the entry's current link survives.
//
// The scenario: an ADMIN edits a restricted owner's entry that is linked into a library the OWNER
// cannot access. Link access follows the OWNER (linkAccessForList), so the save drops that link —
// but the dialog used to decide "stays linked" from the item it already had, which the client can
// only evaluate against the ADMIN's view. The preview now carries `keepable`, the exact predicate
// PATCH applies, and the dialog believes the server.
//
// This suite drives BOTH routes against one mock set and asserts they return the SAME answer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET as getMatch } from '@/app/api/reading-lists/match/route';
import { PATCH } from '@/app/api/reading-lists/items/route';
import { clearIssueMatchMemo } from '@/lib/metadata/issue-match';
import { adminSession } from '../helpers/session';
import { getReq } from '../helpers/request';

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
vi.mock('@/lib/metadata/providers/metron', () => ({ MetronProvider: class { getIssueSummary = vi.fn(); } }));
vi.mock('@/lib/utils/system-flags', () => ({ markSystemFlag: mocks.markSystemFlag, logApiUsage: vi.fn() }));

const cvIssue = {
    id: 20288, name: 'Days of Future Past', issue_number: '141', cover_date: '1981-01-01',
    image: {}, volume: { id: 2133, name: 'Uncanny X-Men' },
};

// The owner's entry: linked to an UNMATCHED local file in lib_secret, a library the owner was never
// granted. Everything about it says "keepable" to a client that only looks at the item.
const item = {
    id: 'item_1', listId: 'list_1', title: 'Uncanny X-Men #1', cvIssueId: null, metadataSource: 'COMICVINE',
    issueId: 'old_issue', order: 0,
    issue: {
        id: 'old_issue', number: '1', filePath: '/secret/x1.cbz', metadataSource: 'LOCAL', metadataId: 'unmatched_1',
        series: { id: 'ser_old', name: 'Uncanny X-Men', libraryId: 'lib_secret', metadataId: '2133', metadataSource: 'COMICVINE' },
    },
};

// One mutable row stands in for the DB: PATCH reads it, writes it, then RE-READS it, so the re-read
// has to see the write. A per-call mockResolvedValueOnce queue can't express that (and leaks across
// tests — vitest's clearMocks does not drain a `once` queue).
let row: any = null;
const resetRow = () => { row = { ...item, issue: { ...item.issue } }; };
const issues: Record<string, any> = {
    old_issue: { id: 'old_issue', number: '1', filePath: '/secret/x1.cbz', metadataSource: 'LOCAL', metadataId: 'unmatched_1', series: { id: 'ser_old', name: 'Uncanny X-Men', libraryId: 'lib_secret', metadataId: '2133', metadataSource: 'COMICVINE' } },
    iss_1: { id: 'iss_1', number: '141', filePath: null, metadataSource: 'COMICVINE', metadataId: '20288', series: { id: 'ser_1', name: 'Uncanny X-Men', libraryId: 'lib9', metadataId: '2133', metadataSource: 'COMICVINE' } },
};

const preview = () => getMatch(getReq('http://localhost/api/reading-lists/match?' + new URLSearchParams({
    listId: 'list_1', itemId: 'item_1', provider: 'COMICVINE', issueId: '20288',
})));
const save = () => new Request('http://localhost/api/reading-lists/items', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ listId: 'list_1', itemId: 'item_1', action: 'rematch', provider: 'COMICVINE', providerIssueId: 20288, keepLocalLink: true }),
});

describe('preview/save agreement on keepLocalLink (ADMIN over a restricted owner)', () => {
    beforeEach(() => {
        clearIssueMatchMemo();
        vi.stubEnv('CV_API_KEY', '');
        resetRow();
        mocks.getServerSession.mockResolvedValue(adminSession());
        mocks.listFindUnique.mockResolvedValue({ id: 'list_1', userId: 'user_9' });
        mocks.userFindUnique.mockResolvedValue({ role: 'USER' });
        // The owner has been granted lib9 only — lib_secret is invisible to them.
        mocks.access.mockResolvedValue(['lib9']);
        mocks.itemFindFirst.mockImplementation(() => Promise.resolve(row));
        mocks.itemUpdateMany.mockImplementation(({ data }: any) => {
            Object.assign(row, data);
            row.issue = row.issueId ? issues[row.issueId] : null;
            return Promise.resolve({ count: 1 });
        });
        mocks.issueFindMany.mockResolvedValue([]);
        mocks.settingFindUnique.mockResolvedValue({ key: 'cv_api_key', value: 'cv_key' });
        mocks.cachedCvGet.mockResolvedValue({ data: { status_code: 1, results: cvIssue }, cached: false });
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('reports keepable:false and, on save, unlinks — the preview promised nothing', async () => {
        const body = await (await preview()).json();
        expect(body.accessScope).toBe('owner');
        expect(body.local).toBeNull();
        expect(body.keepable).toBe(false);

        const res = await PATCH(save());
        expect(res.status).toBe(200);
        expect(mocks.itemUpdateMany.mock.calls[0][0].data.issueId).toBeNull();
        // The save reports what it actually did; the toast is built from this, not from the preview.
        expect(await res.json()).toMatchObject({ link: 'none', linked: false });
    });

    it('the ADMIN\'s own access is never consulted for the keep decision', async () => {
        await preview();
        expect(mocks.access).not.toHaveBeenCalledWith('admin_1', 'ADMIN');
        expect(mocks.access).toHaveBeenCalledWith('user_9', 'USER');
    });

    it('flips to keepable:true once the owner is granted that library, and the save keeps', async () => {
        mocks.access.mockResolvedValue(['lib9', 'lib_secret']);
        expect((await (await preview()).json()).keepable).toBe(true);

        const res = await PATCH(save());
        expect(mocks.itemUpdateMany.mock.calls[0][0].data.issueId).toBe('old_issue');
        expect(await res.json()).toMatchObject({ link: 'kept', linked: true, hasFile: true });
    });

    it('flips to keepable:false when the library gains a same-provider id', async () => {
        row.issue = { ...row.issue, metadataSource: 'COMICVINE', metadataId: '999' };
        expect((await (await preview()).json()).keepable).toBe(false);

        const res = await PATCH(save());
        expect(mocks.itemUpdateMany.mock.calls[0][0].data.issueId).toBeNull();
        expect(await res.json()).toMatchObject({ link: 'none' });
    });

    it('a local copy in the OWNER\'s access wins over keepable, on both routes', async () => {
        mocks.access.mockResolvedValue(['lib9']);
        mocks.issueFindMany.mockResolvedValue([{
            id: 'iss_1', number: '141', filePath: null, isAnnual: false, attachedVolumeId: null, attachedVolume: null,
            createdAt: new Date('2024-01-01'),
            series: { id: 'ser_1', name: 'Uncanny X-Men', metadataId: '2133', metadataSource: 'COMICVINE' },
        }]);
        const body = await (await preview()).json();
        expect(body.local).toMatchObject({ issueId: 'iss_1' });
        // The current link lives in lib_secret, which the owner still can't see — so it isn't
        // keepable even though the SAVE links a different, accessible row instead.
        expect(body.keepable).toBe(false);

        const res = await PATCH(save());
        expect(mocks.itemUpdateMany.mock.calls[0][0].data.issueId).toBe('iss_1');
        // The linked row is a wanted issue (no file), so the entry is linked but nothing to read.
        expect(await res.json()).toMatchObject({ link: 'matched', linked: true, hasFile: false });
    });
});