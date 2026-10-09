// src/lib/komga/readlist-trigger.ts
//
// The ONLY entry point the reading-list routes use to reach the Komga queue. Two rules it enforces
// so no call site has to remember them:
//
//   1. Only lists with `komgaSync` are ever enqueued. A push job for an unsynced list would resolve
//      the whole list, hit Komga and then do nothing.
//   2. The queue is imported LAZILY (`await import('./queue')`). queue.ts pulls in bullmq and ioredis,
//      and the reading-list routes are the hottest pages in the app: without this, every list edit
//      would load the Redis client into its bundle. Nothing here imports './queue' statically.
//
// Never throws: a list edit must not fail because Redis is down.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getKomgaHotFlags } from './settings';

const log = (msg: string) => Logger.log(`[Komga] ${msg}`, 'debug');

/** Debounced push of one list. Returns true when a job was actually enqueued. */
export async function triggerReadListPush(readingListId: string): Promise<boolean> {
    if (!readingListId) return false;
    try {
        const flags = await getKomgaHotFlags();
        if (!flags.enabled || !flags.readListsEnabled) return false;
        const list = await prisma.readingList.findUnique({ where: { id: readingListId }, select: { komgaSync: true } });
        if (!list?.komgaSync) return false;
        const { enqueueKomgaReadListPush } = await import('./queue');
        await enqueueKomgaReadListPush(readingListId);
        return true;
    } catch (e) {
        log(`could not enqueue a read-list push for ${readingListId}: ${getErrorMessage(e)}`);
        return false;
    }
}

/**
 * Read the link BEFORE the caller deletes the list, and hand the remote id to the delete job. The
 * job re-checks the ownership marker, so this is safe to call for a list that was never pushed.
 */
export async function triggerReadListRemoteDelete(readingListId: string): Promise<boolean> {
    if (!readingListId) return false;
    try {
        const link = await prisma.komgaReadListLink.findUnique({
            where: { readingListId },
            select: { komgaReadListId: true },
        });
        if (!link?.komgaReadListId) return false;
        // Fire-and-forget from here on: a route must not wait on Redis (see enqueueKomgaReadListDeleteNow).
        enqueueKomgaReadListDeleteNow(link.komgaReadListId, readingListId);
        return true;
    } catch (e) {
        log(`could not enqueue a read-list delete for ${readingListId}: ${getErrorMessage(e)}`);
        return false;
    }
}

/**
 * Enqueue a remote delete for an ALREADY-KNOWN Komga id, WITHOUT blocking the caller.
 *
 * Two reasons it exists:
 *  - the cascade paths (re-import deleteMany, user deletion) cannot use triggerReadListRemoteDelete:
 *    that helper looks the link up by reading list id, and the row it needs is gone by the time a
 *    fire-and-forget call gets there. Callers read the id first and pass it in.
 *  - it deliberately does NOT await the queue. A route handler that awaits a BullMQ `add` while
 *    Redis is unreachable stalls the user's response until the connection gives up. The enqueue is
 *    a background concern; the Komga id was already captured, so nothing is lost by not waiting.
 */
export function enqueueKomgaReadListDeleteNow(komgaReadListId: string, readingListId: string): void {
    if (!komgaReadListId || !readingListId) return;
    void (async () => {
        try {
            const { enqueueKomgaReadListDelete } = await import('./queue');
            await enqueueKomgaReadListDelete({ komgaReadListId, readingListId });
        } catch (e) {
            log(`could not enqueue a read-list delete for ${readingListId}: ${getErrorMessage(e)}`);
        }
    })();
}

/** Fire-and-forget variant for route handlers: a push failure must not fail the user's edit. */
export function triggerReadListPushSoon(readingListId: string): void {
    if (!readingListId) return;
    void triggerReadListPush(readingListId);
}

/** Fire-and-forget variant of the delete trigger. */
export function triggerReadListRemoteDeleteSoon(readingListId: string): void {
    if (!readingListId) return;
    void triggerReadListRemoteDelete(readingListId);
}