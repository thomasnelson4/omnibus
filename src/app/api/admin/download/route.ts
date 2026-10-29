import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { DownloadService } from '@/lib/download-clients';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';
import { settleDuplicateOnLink } from '@/lib/request-dedupe';

export async function POST(req: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    const body = await req.json();
    const { guid, downloadUrl, title, protocol, requestId, infoHash } = body; 

    if (!requestId) return NextResponse.json({ error: 'Request ID missing' }, { status: 400 });

    const urlToDownload = downloadUrl || guid;
    if (!urlToDownload) return NextResponse.json({ error: 'Download URL missing' }, { status: 400 });

    // Fetch the download clients configured by the admin
    const clients = await prisma.downloadClient.findMany();
    if (clients.length === 0) {
        return NextResponse.json({ error: 'No download client configured in Settings.' }, { status: 400 });
    }

    // Try to match the client by protocol (torrent vs usenet), otherwise fallback to the first available client
    const client = clients.find(c => c.protocol.toLowerCase() === protocol.toLowerCase()) || clients[0];

    const downloadHash = infoHash || guid;

    if (downloadHash) {
        const duplicateDownload = await settleDuplicateOnLink(downloadHash, requestId);

        if (duplicateDownload.action === 'park') {
             Logger.log(`[Admin Download] Batch torrent already downloading (${downloadHash}). Queuing for batch extraction.`, 'info');
             await prisma.request.update({
                 where: { id: requestId },
                 data: { status: 'DOWNLOADING', downloadLink: downloadHash, clientDownloadId: duplicateDownload.clientDownloadId, downloadClientId: duplicateDownload.downloadClientId, progress: 0 }
             });
             return NextResponse.json({ success: true });
        }
        if (duplicateDownload.action === 'join') {
             // #240 PR B: the pack is already in the watched folder for another request — the
             // request waits on that import (the reconciler closes it) instead of re-downloading.
             Logger.log(`[Admin Download] Pack already in the watched folder (${downloadHash}). Joining its wait.`, 'info');
             await prisma.request.update({
                 where: { id: requestId },
                 data: { status: 'IMPORTING', progress: 100, downloadLink: downloadHash }
             });
             return NextResponse.json({ success: true, waiting: true });
        }
        if (duplicateDownload.action === 'settle') {
             return NextResponse.json({ success: true, settled: duplicateDownload.status });
        }
    }

    // Resolve manga-vs-comics from the request's series so the download is filed under the right
    // category/label in the client (manga → second configured category).
    const dlReq = await prisma.request.findUnique({ where: { id: requestId }, select: { volumeId: true, metadataSource: true, clientDownloadId: true, downloadClientId: true } });
    const dlSeries = dlReq ? await prisma.series.findFirst({ where: { metadataId: dlReq.volumeId, metadataSource: dlReq.metadataSource }, select: { isManga: true } }) : null;

    // Re-fire guard (production incident layer 2): re-sending a request that still has a live
    // job in this client's queue creates the second copy the client then pauses as a duplicate.
    if (dlReq?.clientDownloadId && (!dlReq.downloadClientId || dlReq.downloadClientId === client.id)) {
        const alive = await DownloadService.jobExistsInClient(client, dlReq.clientDownloadId).catch(() => true); // unreadable client = leave alone
        if (alive) {
            Logger.log(`[Admin Download] Request ${requestId} still has live job ${dlReq.clientDownloadId} in ${client.name}; not re-sending.`, 'warn');
            return NextResponse.json({ success: true, message: 'Download already active in the client queue.' });
        }
        Logger.log(`[Admin Download] Previous job ${dlReq.clientDownloadId} is gone from ${client.name}; clearing it and re-sending.`, 'info');
        await prisma.request.update({ where: { id: requestId }, data: { clientDownloadId: null, downloadClientId: null } });
    }

    // Enqueue-time dedupe (production incident layer 1): skip when the client already holds this
    // download and track its existing job instead of creating a paused duplicate.
    const existingClientJob = await DownloadService.checkDuplicateDownload(client, urlToDownload, title).catch(() => null);
    if (existingClientJob) {
        Logger.log(`[Admin Download] ${client.name} already holds "${existingClientJob.name}" (job ${existingClientJob.id}); tracking it instead of re-sending.`, 'warn');
        await prisma.request.update({
            where: { id: requestId },
            data: { status: 'DOWNLOADING', downloadLink: downloadHash || 'PENDING_MATCH', clientDownloadId: existingClientJob.id, downloadClientId: client.id, progress: 0 }
        });
        if (userId) await AuditLogger.log('ADMIN_SENT_TO_CLIENT', { title, protocol }, userId);
        return NextResponse.json({ success: true, message: 'Download already present in the client queue — tracked the existing job.' });
    }

    // Send the link to the unified DownloadService
    const submission = await DownloadService.addDownload(client, urlToDownload, title, 0, 0, dlSeries?.isManga ?? false);

    await prisma.request.update({
      where: { id: requestId },
      data: {
        status: 'DOWNLOADING',
        downloadLink: downloadHash || "PENDING_MATCH",
        clientDownloadId: submission?.downloadId || null,
        downloadClientId: client.id,
        progress: 0
      }
    });

    if (userId) {
        await AuditLogger.log('ADMIN_SENT_TO_CLIENT', { title, protocol }, userId);
    }

    return NextResponse.json({ success: true });

  } catch (error: unknown) {
    Logger.log(`Download Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: 'Failed to send to client' }, { status: 500 });
  }
}
