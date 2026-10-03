// __tests__/api/reading-lists-route.test.ts
//
// GET /api/reading-lists auto-link: links follow the list OWNER's library access, a title's "#N"
// vetoes a mislabeled copy, file-backed copies win, and writes are conditional.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/reading-lists/route';
import { userSession, adminSession } from '../helpers/session';
import { getReq } from '../helpers/request';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    listFindMany: vi.fn(),
    issueFindMany: vi.fn(),
    itemUpdateMany: vi.fn(),
    userFindUnique: vi.fn(),
    transaction: vi.fn(),
    access: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: {
        readingList: { findMany: mocks.listFindMany },
        issue: { findMany: mocks.issueFindMany },
        readingListItem: { updateMany: mocks.itemUpdateMany },
        user: { findUnique: mocks.userFindUnique },
        $transaction: mocks.transaction,
    },
}));
vi.mock('@/lib/library-access', async (orig) => ({
    ...(await orig<typeof import('@/lib/library-access')>()),
    getAccessibleLibraryIds: mocks.access,
}));

const ACCESS: Record<string, string[]> = { user_1: ['lib1'], user_9: ['lib2'] };
const item = (id: string, over: Record<string, any> = {}) => ({
    id, issueId: null, cvIssueId: 900, metadataSource: 'COMICVINE', title: 'X-Men #141', issue: null, ...over,
});
const lists = () => [
    { id: 'L1', userId: 'user_1', isGlobal: false, items: [item('i1')] },
    { id: 'L2', userId: 'user_9', isGlobal: true, items: [item('i2')] },
    { id: 'L3', userId: null, isGlobal: false, items: [item('i3')] },
];
const candidate = (id: string, libraryId: string | null, over: Record<string, any> = {}) => ({
    id, metadataId: '900', metadataSource: 'COMICVINE', number: '141', filePath: `/c/${id}.cbz`, attachedVolumeId: null,
    series: { libraryId }, ...over,
});

const linkedTo = () => Object.fromEntries(
    mocks.itemUpdateMany.mock.calls.map(([args]) => [args.where.id, args.data.issueId]),
);

describe('GET /api/reading-lists auto-link', () => {
    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue(userSession());
        mocks.access.mockImplementation(async (userId: string, role?: string) => (role === 'ADMIN' ? 'ALL' : (ACCESS[userId] ?? [])));
        mocks.userFindUnique.mockImplementation(async ({ where }: any) => (where.id in ACCESS ? { role: 'USER' } : null));
        mocks.listFindMany.mockResolvedValue(lists());
        mocks.issueFindMany.mockResolvedValue([]);
        mocks.itemUpdateMany.mockResolvedValue({ count: 1 });
        mocks.transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
    });

    it("links each list only within its owner's libraries", async () => {
        mocks.issueFindMany.mockResolvedValue([candidate('in_lib2', 'lib2'), candidate('in_lib1', 'lib1')]);
        const res = await GET(getReq('http://localhost/api/reading-lists'));
        expect(res.status).toBe(200);
        expect(linkedTo()).toEqual({ i1: 'in_lib1', i2: 'in_lib2', i3: 'in_lib2' });
        expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { id: 'user_9' }, select: { role: true } });
        expect(mocks.access).toHaveBeenCalledWith('user_9', 'USER');
    });

    it("never links into a library the owner can't access, even when the viewer is an ADMIN", async () => {
        mocks.getServerSession.mockResolvedValue(adminSession());
        mocks.issueFindMany.mockResolvedValue([candidate('in_lib1', 'lib1')]);
        await GET(getReq('http://localhost/api/reading-lists'));
        // L1 (user_1: lib1) and L3 (system: ALL) link; L2 (user_9: lib2 only) does not.
        expect(linkedTo()).toEqual({ i1: 'in_lib1', i3: 'in_lib1' });
    });

    it('treats a candidate in a library-less series as inaccessible to restricted owners', async () => {
        mocks.issueFindMany.mockResolvedValue([candidate('orphan', null)]);
        await GET(getReq('http://localhost/api/reading-lists'));
        expect(linkedTo()).toEqual({ i3: 'orphan' });
    });

    it('prefers a file-backed candidate over an older wanted row', async () => {
        mocks.listFindMany.mockResolvedValue([lists()[2]]);
        mocks.issueFindMany.mockResolvedValue([candidate('wanted', 'lib1', { filePath: null }), candidate('owned', 'lib1')]);
        await GET(getReq('http://localhost/api/reading-lists'));
        expect(linkedTo()).toEqual({ i3: 'owned' });
        expect(mocks.issueFindMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'asc' });
    });

    it("vetoes a candidate whose number contradicts the title's #N, but not attached-lane rows", async () => {
        mocks.listFindMany.mockResolvedValue([lists()[2]]);
        mocks.issueFindMany.mockResolvedValue([candidate('wrong', 'lib1', { number: '142' })]);
        await GET(getReq('http://localhost/api/reading-lists'));
        expect(mocks.itemUpdateMany).not.toHaveBeenCalled();

        mocks.issueFindMany.mockResolvedValue([candidate('wrong', 'lib1', { number: '142' }), candidate('lane', 'lib1', { number: '7', attachedVolumeId: 'av_1' })]);
        await GET(getReq('http://localhost/api/reading-lists'));
        expect(linkedTo()).toEqual({ i3: 'lane' });
    });

    it('skips the number check when the title has no #N (story-name titles)', async () => {
        mocks.listFindMany.mockResolvedValue([{ ...lists()[2], items: [item('i3', { title: 'Days of Future Past' })] }]);
        mocks.issueFindMany.mockResolvedValue([candidate('any', 'lib1', { number: '142' })]);
        await GET(getReq('http://localhost/api/reading-lists'));
        expect(linkedTo()).toEqual({ i3: 'any' });
    });

    it('matches numbers canonically (#13½ vs "13.5")', async () => {
        mocks.listFindMany.mockResolvedValue([{ ...lists()[2], items: [item('i3', { title: 'Saga #13½' })] }]);
        mocks.issueFindMany.mockResolvedValue([candidate('half', 'lib1', { number: '13.5' })]);
        await GET(getReq('http://localhost/api/reading-lists'));
        expect(linkedTo()).toEqual({ i3: 'half' });
    });

    it('only links same-source candidates (CV and Metron ids share the column)', async () => {
        mocks.listFindMany.mockResolvedValue([{ ...lists()[2], items: [item('i3', { metadataSource: 'METRON' })] }]);
        mocks.issueFindMany.mockResolvedValue([candidate('cv_row', 'lib1')]);
        await GET(getReq('http://localhost/api/reading-lists'));
        expect(mocks.issueFindMany.mock.calls[0][0].where).toEqual({ OR: [{ metadataId: '900', metadataSource: 'METRON' }] });
        expect(mocks.itemUpdateMany).not.toHaveBeenCalled();
    });

    it('writes conditionally so a concurrent rematch or clear wins', async () => {
        mocks.listFindMany.mockResolvedValue([lists()[2]]);
        mocks.issueFindMany.mockResolvedValue([candidate('c1', 'lib1')]);
        await GET(getReq('http://localhost/api/reading-lists'));
        expect(mocks.itemUpdateMany).toHaveBeenCalledWith({
            where: { id: 'i3', issueId: null, cvIssueId: 900, metadataSource: 'COMICVINE' },
            data: { issueId: 'c1' },
        });
    });

    it('re-reads the lists only when a link actually landed', async () => {
        mocks.issueFindMany.mockResolvedValue([candidate('c1', 'lib1')]);
        mocks.itemUpdateMany.mockResolvedValue({ count: 0 });
        await GET(getReq('http://localhost/api/reading-lists'));
        expect(mocks.transaction).toHaveBeenCalledOnce();
        expect(mocks.listFindMany).toHaveBeenCalledTimes(1);

        mocks.listFindMany.mockClear();
        mocks.itemUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });
        await GET(getReq('http://localhost/api/reading-lists'));
        expect(mocks.listFindMany).toHaveBeenCalledTimes(2);
    });

    it('does nothing (no issue query) when no entry needs linking', async () => {
        mocks.listFindMany.mockResolvedValue([{ id: 'L1', userId: 'user_1', items: [item('i1', { issueId: 'x' }), item('i2', { cvIssueId: null })] }]);
        await GET(getReq('http://localhost/api/reading-lists'));
        expect(mocks.issueFindMany).not.toHaveBeenCalled();
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it("keeps the restricted viewer's item visibility filter unchanged", async () => {
        await GET(getReq('http://localhost/api/reading-lists'));
        const args = mocks.listFindMany.mock.calls[0][0];
        expect(args.where).toEqual({ OR: [{ userId: 'user_1' }, { isGlobal: true }, { userId: null }] });
        expect(args.include.items).toEqual({
            where: { OR: [{ issueId: null }, { issue: { series: { libraryId: { in: ['lib1'] } } } }] },
            orderBy: { order: 'asc' },
            include: { issue: { include: { series: true } } },
        });
    });

    it('401s without a session', async () => {
        mocks.getServerSession.mockResolvedValue(null);
        const res = await GET(getReq('http://localhost/api/reading-lists'));
        expect(res.status).toBe(401);
        expect(mocks.listFindMany).not.toHaveBeenCalled();
    });
});
