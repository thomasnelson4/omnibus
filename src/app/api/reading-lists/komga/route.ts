// src/app/api/reading-lists/komga/route.ts
//
// The admin-only toggle and status for one reading list's Komga sync.
//
// Admin-only, and not by accident: a Komga read list is visible to every Komga user with library
// access, so pushing is an integration-level decision, not a per-user one. Same inline shape as the
// other ADMIN routes (setup_complete gate → session → role), hand-validated, no zod.
//
//   PATCH {listId, komgaSync}  toggle; enqueues a push, or a remote delete when turned off
//   GET  ?listId=              the link status, with skippedSummary parsed
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { parseSkippedSummary } from '@/lib/komga/readlist-resolver';

export const dynamic = 'force-dynamic';

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

/** setup_complete gate first (so a fresh install can still bootstrap), then the session. */
async function requireAdmin(): Promise<{ userId: string } | NextResponse> {
    const setupStatus = await prisma.systemSetting.findUnique({ where: { key: 'setup_complete' } });
    if (setupStatus?.value === 'true') {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const user = session?.user as { id?: string; role?: string } | undefined;
        if (user?.role !== 'ADMIN') {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        return { userId: user.id ?? 'setup' };
    }
    return { userId: 'setup' };
}

export async function PATCH(request: Request) {
    try {
        const admin = await requireAdmin();
        if (admin instanceof NextResponse) return admin;

        let body: any;
        try {
            body = await request.json();
        } catch {
            return bad('Invalid JSON body.');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Invalid JSON body.');
        const { listId, komgaSync } = body;
        if (typeof listId !== 'string' || !listId) return bad('listId is required.');
        if (typeof komgaSync !== 'boolean') return bad('komgaSync must be a boolean.');

        const list = await prisma.readingList.findUnique({ where: { id: listId }, select: { id: true, komgaSync: true } });
        if (!list) return NextResponse.json({ error: 'Reading list not found.' }, { status: 404 });

        await prisma.readingList.update({ where: { id: listId }, data: { komgaSync } });
        await AuditLogger.log('KOMGA_READLIST_SYNC_TOGGLE', { listId, komgaSync }, admin.userId);

        if (komgaSync) {
            // A library that has never been reconciled has no identity map, so the push would see
            // everything as awaitingScan. Get the reconcile in first; the push is debounced 10 s and
            // reconcile is deduped, so the ordering is safe either way.
            const state = await prisma.komgaSyncState.findFirst({
                where: { lastReconciledAt: null },
                select: { omnibusLibraryId: true },
            });
            if (state) {
                const { enqueueKomgaReconcile } = await import('@/lib/komga/queue');
                await enqueueKomgaReconcile('readlist-sync-on');
            }
            const { triggerReadListPush } = await import('@/lib/komga/readlist-trigger');
            await triggerReadListPush(listId);
        } else {
            // Un-syncing removes the remote list, but only after the job has checked its marker.
            const { triggerReadListRemoteDelete } = await import('@/lib/komga/readlist-trigger');
            await triggerReadListRemoteDelete(listId);
        }

        return NextResponse.json({ success: true, listId, komgaSync });
    } catch (error: unknown) {
        Logger.log(`[Reading Lists Komga API] PATCH error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function GET(request: Request) {
    try {
        const admin = await requireAdmin();
        if (admin instanceof NextResponse) return admin;

        const listId = new URL(request.url).searchParams.get('listId');
        if (!listId) return bad('listId is required.');

        const list = await prisma.readingList.findUnique({
            where: { id: listId },
            select: { id: true, komgaSync: true, komgaReadListLink: true },
        });
        if (!list) return NextResponse.json({ error: 'Reading list not found.' }, { status: 404 });

        const link = list.komgaReadListLink;
        return NextResponse.json({
            listId: list.id,
            komgaSync: list.komgaSync,
            link: link
                ? {
                    komgaReadListId: link.komgaReadListId,
                    status: link.status,
                    lastPushedName: link.lastPushedName,
                    lastPushedAt: link.lastPushedAt,
                    pushedCount: link.pushedCount,
                    skippedCount: link.skippedCount,
                    skipped: parseSkippedSummary(link.skippedSummary),
                    lastError: link.lastError,
                    updatedAt: link.updatedAt,
                }
                : null,
        });
    } catch (error: unknown) {
        Logger.log(`[Reading Lists Komga API] GET error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}