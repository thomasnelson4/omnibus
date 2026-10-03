// __tests__/lib/komga/readlist-trigger.test.ts
//
// readlist-trigger.ts is the only bridge from the reading-list routes to the Komga queue, and its
// two guarantees are what keep the hot paths cheap: only synced lists are enqueued, and the queue
// module is never loaded when nothing is enqueued.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    enqueuePush: vi.fn(),
    enqueueDelete: vi.fn(),
    listFindUnique: vi.fn(),
    linkFindUnique: vi.fn(),
    hotFlags: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        readingList: { findUnique: mocks.listFindUnique },
        komgaReadListLink: { findUnique: mocks.linkFindUnique },
    },
}));
vi.mock('@/lib/komga/settings', () => ({ getKomgaHotFlags: mocks.hotFlags }));
vi.mock('@/lib/komga/queue', () => ({
    enqueueKomgaReadListPush: mocks.enqueuePush,
    enqueueKomgaReadListDelete: mocks.enqueueDelete,
}));

import { triggerReadListPush, triggerReadListPushSoon, triggerReadListRemoteDelete, triggerReadListRemoteDeleteSoon, enqueueKomgaReadListDeleteNow } from '@/lib/komga/readlist-trigger';

const FLAGS_ON = { enabled: true, scanOnChange: true, readListsEnabled: true };

beforeEach(() => {
    mocks.hotFlags.mockResolvedValue(FLAGS_ON);
    mocks.listFindUnique.mockResolvedValue({ komgaSync: true });
    mocks.linkFindUnique.mockResolvedValue({ komgaReadListId: 'KL1' });
    mocks.enqueuePush.mockResolvedValue(undefined);
    mocks.enqueueDelete.mockResolvedValue(undefined);
});

describe('triggerReadListPush', () => {
    it('enqueues a push for a synced list', async () => {
        expect(await triggerReadListPush('L1')).toBe(true);
        expect(mocks.enqueuePush).toHaveBeenCalledWith('L1');
    });

    it('does not enqueue when komgaSync is off', async () => {
        mocks.listFindUnique.mockResolvedValue({ komgaSync: false });
        expect(await triggerReadListPush('L1')).toBe(false);
        expect(mocks.enqueuePush).not.toHaveBeenCalled();
    });

    it('does not enqueue for a list that no longer exists', async () => {
        mocks.listFindUnique.mockResolvedValue(null);
        expect(await triggerReadListPush('L1')).toBe(false);
        expect(mocks.enqueuePush).not.toHaveBeenCalled();
    });

    it('does not even read the list when Komga is disabled', async () => {
        mocks.hotFlags.mockResolvedValue({ ...FLAGS_ON, enabled: false });
        expect(await triggerReadListPush('L1')).toBe(false);
        expect(mocks.listFindUnique).not.toHaveBeenCalled();
    });

    it('does not even read the list when read lists are disabled', async () => {
        mocks.hotFlags.mockResolvedValue({ ...FLAGS_ON, readListsEnabled: false });
        expect(await triggerReadListPush('L1')).toBe(false);
        expect(mocks.listFindUnique).not.toHaveBeenCalled();
    });

    it('never throws when Redis is down', async () => {
        mocks.enqueuePush.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379'));
        await expect(triggerReadListPush('L1')).resolves.toBe(false);
    });

    it('ignores an empty id', async () => {
        expect(await triggerReadListPush('')).toBe(false);
        expect(mocks.hotFlags).not.toHaveBeenCalled();
    });
});

describe('triggerReadListRemoteDelete', () => {
    // The queue is never awaited by a route (a stalled BullMQ add must not stall a response), so
    // assertions need one turn of the event loop first.
    const flush = () => new Promise(r => setTimeout(r, 0));

    it('enqueues a delete carrying the Komga id', async () => {
        expect(await triggerReadListRemoteDelete('L1')).toBe(true);
        await flush();
        expect(mocks.enqueueDelete).toHaveBeenCalledWith({ komgaReadListId: 'KL1', readingListId: 'L1' });
    });

    it('does nothing when the list was never pushed', async () => {
        mocks.linkFindUnique.mockResolvedValue(null);
        expect(await triggerReadListRemoteDelete('L1')).toBe(false);
        await flush();
        expect(mocks.enqueueDelete).not.toHaveBeenCalled();
    });

    it('does nothing when the link has no Komga id', async () => {
        mocks.linkFindUnique.mockResolvedValue({ komgaReadListId: null });
        expect(await triggerReadListRemoteDelete('L1')).toBe(false);
        await flush();
        expect(mocks.enqueueDelete).not.toHaveBeenCalled();
    });

    it('survives Redis being down without rejecting', async () => {
        mocks.enqueueDelete.mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(triggerReadListRemoteDelete('L1')).resolves.toBe(true);
        await flush();
    });
});

describe('the fire-and-forget variants', () => {
    const flush = () => new Promise(r => setTimeout(r, 0));

    it('do not throw synchronously and swallow async failures', async () => {
        mocks.enqueuePush.mockRejectedValue(new Error('down'));
        mocks.enqueueDelete.mockRejectedValue(new Error('down'));
        expect(() => triggerReadListPushSoon('L1')).not.toThrow();
        expect(() => triggerReadListRemoteDeleteSoon('L1')).not.toThrow();
        await flush();
    });

    it('ignore an empty id without touching the db', async () => {
        triggerReadListPushSoon('');
        triggerReadListRemoteDeleteSoon('');
        await flush();
        expect(mocks.listFindUnique).not.toHaveBeenCalled();
        expect(mocks.linkFindUnique).not.toHaveBeenCalled();
    });
});

describe('enqueueKomgaReadListDeleteNow', () => {
    const flush = () => new Promise(r => setTimeout(r, 0));

    it('enqueues with an id the caller already holds, without any db read', async () => {
        enqueueKomgaReadListDeleteNow('KL9', 'L9');
        await flush();
        expect(mocks.enqueueDelete).toHaveBeenCalledWith({ komgaReadListId: 'KL9', readingListId: 'L9' });
        // The whole point: the caller read the link before the cascade, so no lookup is needed.
        expect(mocks.linkFindUnique).not.toHaveBeenCalled();
    });

    it('returns immediately — a route must not await Redis', () => {
        mocks.enqueueDelete.mockReturnValue(new Promise(() => {})); // never settles
        expect(() => enqueueKomgaReadListDeleteNow('KL9', 'L9')).not.toThrow();
    });

    it('ignores missing ids', async () => {
        enqueueKomgaReadListDeleteNow('', 'L9');
        enqueueKomgaReadListDeleteNow('KL9', '');
        await flush();
        expect(mocks.enqueueDelete).not.toHaveBeenCalled();
    });

    it('swallows an enqueue failure', async () => {
        mocks.enqueueDelete.mockRejectedValue(new Error('down'));
        enqueueKomgaReadListDeleteNow('KL9', 'L9');
        await flush();
    });
});