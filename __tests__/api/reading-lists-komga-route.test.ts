// __tests__/api/reading-lists-komga-route.test.ts
//
// GET/PATCH /api/reading-lists/komga — the admin toggle and the status line's data source.
//
// Only admins may toggle: a Komga read list is visible to every Komga user with library access, so
// pushing is an integration decision rather than a per-user one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, PATCH } from '@/app/api/reading-lists/komga/route';
import { adminSession, userSession } from '../helpers/session';
import { getReq, makePostJson } from '../helpers/request';
import { auditLog } from '../helpers/setup-global';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    settingFindUnique: vi.fn(),
    listFindUnique: vi.fn(),
    listUpdate: vi.fn(),
    syncStateFindFirst: vi.fn(),
    enqueueReconcile: vi.fn(),
    triggerPush: vi.fn(),
    triggerDelete: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findUnique: mocks.settingFindUnique },
        readingList: { findUnique: mocks.listFindUnique, update: mocks.listUpdate },
        komgaSyncState: { findFirst: mocks.syncStateFindFirst },
    },
}));
vi.mock('@/lib/komga/queue', () => ({ enqueueKomgaReconcile: mocks.enqueueReconcile }));
vi.mock('@/lib/komga/readlist-trigger', () => ({
    triggerReadListPush: mocks.triggerPush,
    triggerReadListRemoteDelete: mocks.triggerDelete,
    triggerReadListPushSoon: vi.fn(),
    triggerReadListRemoteDeleteSoon: vi.fn(),
}));

const patch = makePostJson('http://localhost/api/reading-lists/komga');
const LINK = {
    id: 'link1', readingListId: 'L1', komgaReadListId: 'KL1',
    lastPushedName: 'My List (alice)', lastPushedBookIds: '["BK1"]', lastPushedAt: new Date('2026-01-01T00:00:00Z'),
    status: 'synced', pushedCount: 38, skippedCount: 14,
    skippedSummary: JSON.stringify({ placeholder: 0, notDownloaded: 9, unsupportedFormat: 0, libraryUnmapped: 0, awaitingScan: 5, duplicate: 0 }),
    lastError: null, createdAt: new Date(), updatedAt: new Date(),
};

beforeEach(() => {
    mocks.getServerSession.mockResolvedValue(adminSession());
    mocks.settingFindUnique.mockResolvedValue({ value: 'true' });
    mocks.listFindUnique.mockResolvedValue({ id: 'L1', komgaSync: true, komgaReadListLink: LINK });
    mocks.listUpdate.mockResolvedValue({});
    mocks.syncStateFindFirst.mockResolvedValue(null);
    mocks.enqueueReconcile.mockResolvedValue(undefined);
    mocks.triggerPush.mockResolvedValue(true);
    mocks.triggerDelete.mockResolvedValue(true);
});

describe('access control', () => {
    it('refuses a non-admin', async () => {
        mocks.getServerSession.mockResolvedValue(userSession());
        expect((await PATCH(patch({ listId: 'L1', komgaSync: true }))).status).toBe(401);
        expect((await GET(getReq('http://localhost/api/reading-lists/komga?listId=L1'))).status).toBe(401);
        expect(mocks.listUpdate).not.toHaveBeenCalled();
    });

    it('refuses an anonymous caller', async () => {
        mocks.getServerSession.mockResolvedValue(null);
        expect((await PATCH(patch({ listId: 'L1', komgaSync: false }))).status).toBe(401);
    });

    it('allows the call while setup is incomplete (bootstrapping)', async () => {
        mocks.settingFindUnique.mockResolvedValue({ value: 'false' });
        mocks.getServerSession.mockResolvedValue(userSession());
        expect((await PATCH(patch({ listId: 'L1', komgaSync: true }))).status).toBe(200);
    });
});

describe('PATCH validation', () => {
    it('rejects a missing listId', async () => {
        const res = await PATCH(patch({ komgaSync: true }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/listId/);
    });

    it('rejects a non-boolean komgaSync', async () => {
        expect((await PATCH(patch({ listId: 'L1', komgaSync: 'yes' }))).status).toBe(400);
    });

    it('rejects a non-object body', async () => {
        expect((await PATCH(patch([1, 2, 3]))).status).toBe(400);
        expect((await PATCH(new Request('http://localhost/api/reading-lists/komga', { method: 'PATCH' }))).status).toBe(400);
    });

    it('404s an unknown list', async () => {
        mocks.listFindUnique.mockResolvedValue(null);
        expect((await PATCH(patch({ listId: 'nope', komgaSync: true }))).status).toBe(404);
    });
});

describe('PATCH: turning sync ON', () => {
    it('updates the list, audits it and enqueues a push', async () => {
        const res = await PATCH(patch({ listId: 'L1', komgaSync: true }));
        expect(res.status).toBe(200);
        expect(mocks.listUpdate).toHaveBeenCalledWith({ where: { id: 'L1' }, data: { komgaSync: true } });
        expect(auditLog).toHaveBeenCalledWith('KOMGA_READLIST_SYNC_TOGGLE', { listId: 'L1', komgaSync: true }, 'admin_1');
        expect(mocks.triggerPush).toHaveBeenCalledWith('L1');
        expect(mocks.triggerDelete).not.toHaveBeenCalled();
    });

    it('enqueues a reconcile FIRST when a library has never been reconciled', async () => {
        // Without a reconcile there is no identity map, so every entry would look like awaitingScan.
        mocks.syncStateFindFirst.mockResolvedValue({ omnibusLibraryId: 'lib1' });
        await PATCH(patch({ listId: 'L1', komgaSync: true }));
        expect(mocks.enqueueReconcile).toHaveBeenCalledWith('readlist-sync-on');
        expect(mocks.enqueueReconcile.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.triggerPush.mock.invocationCallOrder[0]);
    });

    it('does not enqueue a reconcile when one already ran', async () => {
        await PATCH(patch({ listId: 'L1', komgaSync: true }));
        expect(mocks.enqueueReconcile).not.toHaveBeenCalled();
    });
});

describe('PATCH: turning sync OFF', () => {
    it('enqueues a REMOTE delete, not a push', async () => {
        const res = await PATCH(patch({ listId: 'L1', komgaSync: false }));
        expect(res.status).toBe(200);
        expect(mocks.listUpdate).toHaveBeenCalledWith({ where: { id: 'L1' }, data: { komgaSync: false } });
        expect(mocks.triggerDelete).toHaveBeenCalledWith('L1');
        expect(mocks.triggerPush).not.toHaveBeenCalled();
        // Un-syncing must not drag a reconcile in with it.
        expect(mocks.enqueueReconcile).not.toHaveBeenCalled();
    });
});

describe('GET', () => {
    it('returns the link status with skippedSummary parsed', async () => {
        const res = await GET(getReq('http://localhost/api/reading-lists/komga?listId=L1'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.komgaSync).toBe(true);
        expect(body.link.status).toBe('synced');
        expect(body.link.pushedCount).toBe(38);
        // Parsed, not a raw JSON string — the UI renders the breakdown directly.
        expect(body.link.skipped).toEqual({
            placeholder: 0, notDownloaded: 9, unsupportedFormat: 0, libraryUnmapped: 0, awaitingScan: 5, duplicate: 0,
        });
        expect(typeof body.link.skipped).toBe('object');
    });

    it('returns a null link for a list that was never pushed', async () => {
        mocks.listFindUnique.mockResolvedValue({ id: 'L1', komgaSync: false, komgaReadListLink: null });
        const body = await (await GET(getReq('http://localhost/api/reading-lists/komga?listId=L1'))).json();
        expect(body.link).toBeNull();
        expect(body.komgaSync).toBe(false);
    });

    it('survives an unreadable skippedSummary column', async () => {
        mocks.listFindUnique.mockResolvedValue({
            id: 'L1', komgaSync: true, komgaReadListLink: { ...LINK, skippedSummary: '{truncated' },
        });
        const body = await (await GET(getReq('http://localhost/api/reading-lists/komga?listId=L1'))).json();
        expect(body.link.skipped.notDownloaded).toBe(0);
    });

    it('requires listId and 404s an unknown list', async () => {
        expect((await GET(getReq('http://localhost/api/reading-lists/komga'))).status).toBe(400);
        mocks.listFindUnique.mockResolvedValue(null);
        expect((await GET(getReq('http://localhost/api/reading-lists/komga?listId=x'))).status).toBe(404);
    });

    it('never leaks the Komga api key or the summary column', async () => {
        const body = await (await GET(getReq('http://localhost/api/reading-lists/komga?listId=L1'))).json();
        expect(JSON.stringify(body)).not.toMatch(/apiKey|instanceId|lastPushedSummary|lastPushedBookIds/);
    });
});