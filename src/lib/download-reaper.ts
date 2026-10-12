// src/lib/download-reaper.ts
//
// The zombie-download reaper (production incident layer 4, DEFAULTS TO FAILING stale rows).
//
// The incident: 159 Usenet requests sat in DOWNLOADING at progress=0 for 9+ days while the
// download client had paused every one of them as duplicates. Nothing in Omnibus failed them,
// nothing told the user, and every poll cycle even refreshed their updatedAt — so nothing that
// reasoned over "stale rows" could ever see them.
//
// This sweep reaps them: a DOWNLOADING row with progress=0 whose updatedAt has not moved for a
// configurable number of days (SystemSetting `download_reaper_stale_days`, default 3) AND whose
// client-side state confirms it is not actively progressing (client reports a paused/errored
// state, or the job is simply no longer in the client's queue) is marked FAILED with a
// human-readable reason in clientStatusMessage — the same field the request UI renders.
//
// Explicitly NOT done here: rows are never deleted, and nothing is re-enqueued automatically.
// The FAILED state keeps the row visible (red Failed tab on the requests page) and the existing
// retry route is the re-queue path.
//
// Safety rails:
//   • progress > 0 or any recent updatedAt movement disqualifies a row outright — the candidate
//     query enforces progress=0 and updatedAt < cutoff, so a row the poller touched minutes ago
//     can never be reaped regardless of age.
//   • A row whose client cannot be read (API down) is NOT reaped — "unknown" is never treated
//     as "absent"; the next sweep re-examines it once the client answers again.
//   • A row whose queue item is actively progressing client-side (normal state) is NOT reaped.

import { prisma } from './db';
import { DownloadService, listClientQueueItems } from './download-clients';
import { mirrorClientStatus } from './client-state-mirror';
import { Logger } from './logger';
import { getErrorMessage } from './utils/error';

export const DOWNLOAD_REAPER_STALE_DAYS_KEY = 'download_reaper_stale_days';
export const DOWNLOAD_REAPER_DEFAULT_DAYS = 3;

export interface ReaperResult {
    reaped: number;
    examined: number;
    skippedClientUnreadable: number;
    skippedActivelyProgressing: number;
}

interface ReaperCandidate {
    id: string;
    activeDownloadName: string | null;
    clientDownloadId: string | null;
    downloadClientId: string | null;
    downloadLink: string | null;
}

function reapReason(staleDays: number, clientLeg: string): string {
    return `Automatically failed after ${staleDays} days with no progress at 0% while the download client reported: ${clientLeg}. Use Retry to re-queue this download.`;
}

export async function reapStaleDownloads(): Promise<ReaperResult> {
    const setting = await prisma.systemSetting.findUnique({ where: { key: DOWNLOAD_REAPER_STALE_DAYS_KEY } });
    const staleDays = Math.max(1, parseInt(setting?.value || '', 10) || DOWNLOAD_REAPER_DEFAULT_DAYS);
    const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);

    // Candidate gate is the WHOLE age/staleness story: DOWNLOADING + progress 0 + no updatedAt
    // movement since the cutoff. Anything the poller still touches (progress moving, status
    // writes) is newer than the cutoff and invisible to this sweep by construction.
    const candidates: ReaperCandidate[] = await prisma.request.findMany({
        where: {
            status: 'DOWNLOADING',
            progress: 0,
            updatedAt: { lt: cutoff }
        },
        select: { id: true, activeDownloadName: true, clientDownloadId: true, downloadClientId: true, downloadLink: true }
    });

    const result: ReaperResult = { reaped: 0, examined: candidates.length, skippedClientUnreadable: 0, skippedActivelyProgressing: 0 };
    if (candidates.length === 0) return result;

    const tracked = new Set<string>();
    for (const r of candidates) {
        const trackedId = r.clientDownloadId || r.downloadLink;
        if (trackedId) tracked.add(trackedId);
    }

    // One queue read per configured client — not per row. Clients that fail to answer make every
    // row they own "unknown" this pass; those rows are skipped, not reaped.
    const clients = await prisma.downloadClient.findMany();
    const queueByClientId = new Map<string, Array<{ id: string, name: string, status: string, progress: number }>>();
    for (const client of clients) {
        try {
            queueByClientId.set(client.id, await listClientQueueItems(client));
        } catch (e) {
            Logger.log(`[Reaper] Could not read queue of "${client.name}" (${getErrorMessage(e)}); its stale rows are left untouched this pass.`, 'warn');
        }
    }

    // Resolve a candidate's queue items: its own client when known, else every readable client
    // (a row can carry clientDownloadId without downloadClientId when it predates the id fix).
    const itemsFor = (r: ReaperCandidate): Array<{ id: string, name: string, status: string, progress: number }> | null => {
        if (r.downloadClientId) return queueByClientId.get(r.downloadClientId) ?? null;
        const all: Array<{ id: string, name: string, status: string, progress: number }> = [];
        for (const items of queueByClientId.values()) all.push(...items);
        return all;
    };

    for (const r of candidates) {
        const trackedId = (r.clientDownloadId || r.downloadLink || '').toLowerCase();

        if (r.downloadClientId || r.clientDownloadId) {
            const items = itemsFor(r);
            if (items === null) {
                // The row's client could not be read — absence is NOT proof, leave it alone.
                result.skippedClientUnreadable++;
                continue;
            }

            const item = items.find(i => trackedId && i.id.toLowerCase() === trackedId)
                // Legacy name fallback, same shape the poller uses for untracked rows.
                || (r.activeDownloadName ? items.find(i => i.name === r.activeDownloadName) : undefined);

            if (item) {
                if (item.progress >= 100) {
                    result.skippedActivelyProgressing++; // client finished it; the importer owns this row
                    continue;
                }
                const mirrored = mirrorClientStatus(item);
                if (!mirrored) {
                    result.skippedActivelyProgressing++; // client says the job is in a normal state
                    continue;
                }
                // Client confirms it is parked/errored — reap, quoting the client's own words.
                const leg = mirrored.message ? `${mirrored.status} — ${mirrored.message}` : mirrored.status;
                await reapRow(r.id, staleDays, leg, item.status);
                result.reaped++;
                continue;
            }

            // Genuinely absent from the client's queue after the stale window: the classic zombie
            // (the poller will never match it again either).
            await reapRow(r.id, staleDays, 'the job is no longer present in the download client\'s queue', null);
            result.reaped++;
            continue;
        }

        // Untracked row (no client job at all — a DDL/engine hand-off that never reported).
        // With zero client-side state to contradict it and 3+ days of total silence at 0%,
        // the stale window itself is the confirmation.
        await reapRow(r.id, staleDays, 'no download client job is tracking it', null);
        result.reaped++;
    }

    Logger.log(`[Reaper] Examined ${result.examined} stale DOWNLOADING row(s): reaped ${result.reaped}, skipped (client unreadable) ${result.skippedClientUnreadable}, skipped (actively progressing) ${result.skippedActivelyProgressing}.`, result.reaped > 0 ? 'warn' : 'info');
    return result;
}

async function reapRow(requestId: string, staleDays: number, clientLeg: string, clientStatus: string | null) {
    await prisma.request.update({
        where: { id: requestId },
        // `as any` matches the cron poller's own request.update idiom (the LSP's Prisma-client
        // program lags the generated types; tsc --noEmit is the gate).
        data: {
            status: 'FAILED',
            progress: 0,
            clientStatus,
            clientStatusMessage: reapReason(staleDays, clientLeg)
        } as any
    });
    Logger.log(`[Reaper] Reaped zombie download ${requestId} (${clientLeg}).`, 'warn');
}

/** Persist the sweep's JobLog row (called by the DOWNLOAD_REAPER BullMQ job). */
export async function logReaperSweep(result: ReaperResult, durationMs: number): Promise<void> {
    await prisma.jobLog.create({
        data: {
            jobType: 'DOWNLOAD_REAPER',
            status: 'COMPLETED',
            durationMs,
            message: `Zombie reaper: examined ${result.examined} stale DOWNLOADING row(s), reaped ${result.reaped}, skipped ${result.skippedClientUnreadable} unreadable-client and ${result.skippedActivelyProgressing} actively-progressing row(s).`
        }
    });
}

// Re-exported for the worker/trigger routes so callers don't import DownloadService themselves.
export { DownloadService };
