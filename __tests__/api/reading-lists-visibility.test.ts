// __tests__/api/reading-lists-visibility.test.ts
//
// PATCH /api/reading-lists — the post-creation visibility flip. The rules under test:
//   * owner or ADMIN, and a list with no owner (userId null) is ADMIN-only;
//   * canCreateGlobalLists gates PROMOTION only — an owner without it must still be able to take
//     their own public list back down (an ADMIN may have made it global for them);
//   * a refused promotion is a loud 403, not a silent coercion to false;
//   * demoting revokes the share link, because /reading-lists/shared/[shareId] has no auth;
//   * a no-owner list is visible to everyone whatever the flag says, and the response admits it;
//   * a komgaSync list is re-pushed, because the Phase 4 remote name depends on the flag.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PATCH } from '@/app/api/reading-lists/route';
import { userSession, adminSession } from '../helpers/session';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    pushSoon: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: { readingList: { findUnique: mocks.findUnique, update: mocks.update } },
}));
vi.mock('@/lib/komga/readlist-trigger', () => ({
    triggerReadListPushSoon: mocks.pushSoon,
    triggerReadListRemoteDelete: vi.fn(),
}));

const patchReq = (body: any, raw?: string) => new Request('http://localhost/api/reading-lists', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    ...(raw !== undefined ? { body: raw } : { body: JSON.stringify(body) }),
});

/** A stored list; `update` merges the written fields back the way Prisma would. */
const store = (list: Record<string, any>) => {
    mocks.findUnique.mockImplementation(async ({ where }: any) => (where.id === list.id ? { ...list } : null));
    mocks.update.mockImplementation(async ({ where, data }: any) => ({ ...list, ...data, id: where.id }));
};

const owned = (over: Record<string, any> = {}) =>
    store({ id: 'L1', name: 'Dawn of X', userId: 'user_1', isGlobal: false, shareId: null, komgaSync: false, ...over });

const body = (res: Response) => res.json();

describe('PATCH /api/reading-lists — visibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue(userSession());
    });

    it('promotes an owned list when the user may publish', async () => {
        mocks.getServerSession.mockResolvedValue(userSession({ canCreateGlobalLists: true }));
        owned();
        const res = await PATCH(patchReq({ id: 'L1', isGlobal: true }));
        expect(res.status).toBe(200);
        expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'L1' }, data: { isGlobal: true } });
        expect(await body(res)).toMatchObject({ success: true, isPrivate: false, shareRevoked: false, list: { isGlobal: true } });
    });

    it('refuses promotion for an owner without canCreateGlobalLists, and writes nothing', async () => {
        owned();
        const res = await PATCH(patchReq({ id: 'L1', isGlobal: true }));
        expect(res.status).toBe(403);
        expect(await body(res)).toMatchObject({ code: 'FORBIDDEN_GLOBAL' });
        expect(mocks.update).not.toHaveBeenCalled();
    });

    it('lets that same owner DEMOTE their own public list without the permission', async () => {
        owned({ isGlobal: true, shareId: 'ab12' });
        const res = await PATCH(patchReq({ id: 'L1', isGlobal: false }));
        expect(res.status).toBe(200);
        // "Private" must mean private: the unauthenticated share page keys only on shareId.
        expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'L1' }, data: { isGlobal: false, shareId: null } });
        expect(await body(res)).toMatchObject({ isPrivate: true, shareRevoked: true });
    });

    it("403s a non-owner", async () => {
        mocks.getServerSession.mockResolvedValue(userSession({ id: 'user_9', canCreateGlobalLists: true }));
        owned();
        const res = await PATCH(patchReq({ id: 'L1', isGlobal: true }));
        expect(res.status).toBe(403);
        expect(await body(res)).toMatchObject({ code: 'FORBIDDEN' });
        expect(mocks.update).not.toHaveBeenCalled();
    });

    it('lets an ADMIN flip any list, including one they do not own', async () => {
        mocks.getServerSession.mockResolvedValue(adminSession());
        owned({ userId: 'user_1', isGlobal: true });
        const res = await PATCH(patchReq({ id: 'L1', isGlobal: false }));
        expect(res.status).toBe(200);
        expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'L1' }, data: { isGlobal: false, shareId: null } });
    });

    it('401s without a session, before touching the database', async () => {
        mocks.getServerSession.mockResolvedValue(null);
        const res = await PATCH(patchReq({ id: 'L1', isGlobal: true }));
        expect(res.status).toBe(401);
        expect(mocks.findUnique).not.toHaveBeenCalled();
        expect(mocks.update).not.toHaveBeenCalled();
    });

    it('404s an unknown id', async () => {
        store({ id: 'other', userId: 'user_1' });
        const res = await PATCH(patchReq({ id: 'L1', isGlobal: true }));
        expect(res.status).toBe(404);
        expect(mocks.update).not.toHaveBeenCalled();
    });

    it('treats a no-owner (system) list as ADMIN-only', async () => {
        owned({ userId: null, isGlobal: false });
        const forbidden = await PATCH(patchReq({ id: 'L1', isGlobal: false }));
        expect(forbidden.status).toBe(403);

        mocks.getServerSession.mockResolvedValue(adminSession());
        const res = await PATCH(patchReq({ id: 'L1', isGlobal: true }));
        expect(res.status).toBe(200);
        // userId null means "visible to everyone" on its own, so the flag changed nothing.
        expect(await body(res)).toMatchObject({ isPrivate: false, notice: expect.stringContaining('no owner') });
    });

    it('does not revoke the share link on a system list, which never becomes private', async () => {
        mocks.getServerSession.mockResolvedValue(adminSession());
        owned({ userId: null, isGlobal: true, shareId: 'keepme' });
        const res = await PATCH(patchReq({ id: 'L1', isGlobal: false }));
        expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'L1' }, data: { isGlobal: false } });
        expect(await body(res)).toMatchObject({ shareRevoked: false, isPrivate: false });
    });

    it('never destroys a share link on a no-op demotion', async () => {
        owned({ isGlobal: false, shareId: 'keepme' });
        const res = await PATCH(patchReq({ id: 'L1', isGlobal: false }));
        expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'L1' }, data: { isGlobal: false } });
        expect(await body(res)).toMatchObject({ shareRevoked: false });
    });

    it('keeps the share link when promoting', async () => {
        mocks.getServerSession.mockResolvedValue(adminSession());
        owned({ isGlobal: false, shareId: 'keepme' });
        const res = await PATCH(patchReq({ id: 'L1', isGlobal: true }));
        expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'L1' }, data: { isGlobal: true } });
        expect(await body(res)).toMatchObject({ shareRevoked: false });
    });

    it('re-pushes a komgaSync list so the remote name cannot drift, and only that list', async () => {
        owned({ komgaSync: true, isGlobal: true });
        await PATCH(patchReq({ id: 'L1', isGlobal: false }));
        expect(mocks.pushSoon).toHaveBeenCalledWith('L1');

        mocks.pushSoon.mockClear();
        owned({ komgaSync: false, isGlobal: true });
        await PATCH(patchReq({ id: 'L1', isGlobal: false }));
        expect(mocks.pushSoon).not.toHaveBeenCalled();

        mocks.pushSoon.mockClear();
        owned({ komgaSync: true, isGlobal: true });
        await PATCH(patchReq({ id: 'L1', isGlobal: true }));
        expect(mocks.pushSoon).not.toHaveBeenCalled();
    });

    it('hand-validates the body (no zod in this repo)', async () => {
        owned();
        const cases: Array<[string, any]> = [
            ['missing id', { isGlobal: true }],
            ['non-string id', { id: { not: '' }, isGlobal: true }],
            ['missing isGlobal', { id: 'L1' }],
            ['truthy string isGlobal', { id: 'L1', isGlobal: 'true' }],
            ['null isGlobal', { id: 'L1', isGlobal: null }],
        ];
        for (const [label, b] of cases) {
            const res = await PATCH(patchReq(b));
            expect(res.status, label).toBe(400);
            expect(await body(res), label).toMatchObject({ code: 'INVALID_INPUT' });
        }
        expect(mocks.findUnique).not.toHaveBeenCalled();
        expect(mocks.update).not.toHaveBeenCalled();
    });

    it('rejects a malformed or array body without reaching Prisma', async () => {
        owned();
        expect((await PATCH(patchReq(null, '{not json'))).status).toBe(400);
        expect((await PATCH(patchReq([{ id: 'L1', isGlobal: true }]))).status).toBe(400);
        expect(mocks.findUnique).not.toHaveBeenCalled();
    });
});