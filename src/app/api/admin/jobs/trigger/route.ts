import { NextResponse } from 'next/server';
import { omnibusQueue } from '@/lib/queue';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Komga job triggers, kept apart from `jobMap` on purpose. The VALUES are the names the
 * `omnibus-komga` worker knows; the KEYS are the `job` values the Admin → Jobs buttons post.
 * Every one of them is enqueued through `await import('@/lib/komga/queue')` inside
 * `runKomgaTrigger`, never through `omnibusQueue` — that worker's switch has no case for a Komga
 * name and would throw `Unknown job type`.
 */
const komgaJobMap: Record<string, string> = {
    'komga_sync': 'KOMGA_SYNC',
    'komga_rebuild_id_map': 'KOMGA_RECONCILE',
    'komga_readlist_push': 'KOMGA_READLIST_PUSH',
};

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;

        const { job } = await request.json();
        
        const jobMap: Record<string, string> = {
            'watched_sync': 'WATCHED_FOLDER_SYNC',
            'backup': 'DATABASE_BACKUP',
            'converter': 'CBR_CONVERSION',
            'library': 'LIBRARY_SCAN',
            'metadata': 'METADATA_SYNC',
            'embed_metadata': 'EMBED_METADATA',
            'export_series_json': 'EXPORT_SERIES_JSON',
            'monitor': 'SERIES_MONITOR',
            'diagnostics': 'DIAGNOSTICS',
            'popular': 'DISCOVER_SYNC',
            'for_you': 'FOR_YOU_SYNC',
            'storage_scan': 'STORAGE_SCAN',
            'health_check': 'SYSTEM_HEALTH_CHECK',
            'update_check': 'UPDATE_CHECK',
            'weekly_digest': 'WEEKLY_DIGEST',
            'cache_cleanup': 'CACHE_CLEANUP',
            'unmatched_sweep': 'UNMATCHED_SWEEP'
        };

        // Komga triggers get their OWN map and their OWN queue. `omnibusQueue`'s worker throws
        // `Unknown job type` for a name it does not know, so a Komga job sent there would be a dead
        // job rather than a slow one. Checked BEFORE jobMap so the two can never overlap.
        if (komgaJobMap[job]) {
            return await runKomgaTrigger(job, userId);
        }

        const jobType = jobMap[job];

        if (!jobType) {
            return NextResponse.json({ error: "Invalid job specified" }, { status: 400 });
        }

        await omnibusQueue.add(jobType, { type: jobType }, {
            jobId: `${jobType}_${Date.now()}`
        });

        Logger.log(`[Queue] Successfully enqueued job: ${jobType}`, "info");

        // Do not audit log if the heartbeat triggers it, only if a user ID is present (Admin click)
        if (userId) {
            await AuditLogger.log('ADMIN_TRIGGERED_JOB', { job: jobType }, userId);
        }

        return NextResponse.json({ 
            success: true, 
            message: `${jobType} has been added to the background queue.` 
        });

    } catch (error: unknown) {
        Logger.log(`[Queue] Failed to enqueue job: ${getErrorMessage(error)}`, "error");
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

/**
 * The Komga triggers, on the `omnibus-komga` queue. Everything Komga-side is reached through
 * `await import(...)`: queue.ts and libraries.ts pull in bullmq/ioredis, so this admin route must
 * not load them — or open Redis — unless an admin actually presses a Komga button.
 */
async function runKomgaTrigger(job: string, userId?: string) {
    const komgaJobType = komgaJobMap[job];
    try {
        // The worker drops every Komga job while the integration is off, so say so here instead of
        // answering "queued" for something that will never run.
        const { getKomgaSettings } = await import('@/lib/komga/settings');
        if (!(await getKomgaSettings()).enabled) {
            return NextResponse.json({ error: 'The Komga integration is disabled. Enable it in Settings → Media Servers.' }, { status: 400 });
        }

        let summary: string;
        if (komgaJobType === 'KOMGA_SYNC') {
            // Same selection as the nightly reconcile: runtime containment, not the cached
            // omnibusLibraryId column — one Komga library over a parent folder serves several
            // Omnibus libraries and is stored against only the best match.
            const [{ enqueueKomgaSync }, { loadCachedKomgaLibraries, komgaLibrariesForOmnibusLibrary }] =
                await Promise.all([import('@/lib/komga/queue'), import('@/lib/komga/libraries')]);
            const [omnibusLibraries, komgaLibs] = await Promise.all([
                prisma.library.findMany({ select: { id: true, name: true, path: true } }),
                loadCachedKomgaLibraries(),
            ]);
            const usable = komgaLibs.filter(l => !l.unavailable);
            const mapped = omnibusLibraries.filter(lib => komgaLibrariesForOmnibusLibrary(lib, usable).length > 0);
            for (const lib of mapped) {
                await enqueueKomgaSync({ omnibusLibraryId: lib.id, reason: 'admin trigger' });
            }
            summary = mapped.length === 0
                ? 'No Omnibus library is mapped to a Komga library, so nothing was queued. Check the path mappings in Settings → Media Servers.'
                : `Queued for ${mapped.length} librar${mapped.length === 1 ? 'y' : 'ies'}.`;
        } else if (komgaJobType === 'KOMGA_RECONCILE') {
            const { enqueueKomgaReconcile } = await import('@/lib/komga/queue');
            await enqueueKomgaReconcile('admin trigger: rebuild id map');
            summary = 'The ID map will be rebuilt from a full sync of every mapped library.';
        } else {
            // KOMGA_READLIST_PUSH. The 10 s debounce lives in the enqueue helper, and the trigger is
            // fire-and-forget on purpose: a route must not wait on Redis.
            const { triggerReadListPushSoon } = await import('@/lib/komga/readlist-trigger');
            const lists = await prisma.readingList.findMany({ where: { komgaSync: true }, select: { id: true } });
            for (const list of lists) triggerReadListPushSoon(list.id);
            summary = lists.length === 0
                ? 'No reading list is opted in to Komga yet. Turn on the Komga toggle on a reading list first.'
                : `Queued for ${lists.length} reading list${lists.length === 1 ? '' : 's'}.`;
        }

        Logger.log(`[Komga] Admin trigger "${job}" → ${komgaJobType}: ${summary}`, 'info');

        // Do not audit log if the heartbeat triggers it, only if a user ID is present (Admin click).
        if (userId) {
            await AuditLogger.log('KOMGA_ADMIN_TRIGGERED', { trigger: job, jobType: komgaJobType, summary }, userId);
        }

        return NextResponse.json({ success: true, message: `${komgaJobType} has been added to the Komga queue. ${summary}` });
    } catch (error: unknown) {
        const msg = getErrorMessage(error);
        Logger.log(`[Komga] Failed to enqueue ${komgaJobType}: ${msg}`, 'error');
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}