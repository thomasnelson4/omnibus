// src/lib/client-state-mirror.ts
//
// Client-state mirror (production incident layer 3). The poller already fetches every queue
// item with its client-side status and then discards it — which is why 159 requests sat at a
// blank 0% for 9+ days while the client had paused every one of them as duplicates. This helper
// classifies a queue item's client-reported state so the poller can PERSIST it on the Request
// (clientStatus / clientStatusMessage) and CLEAR it when the state resolves.
//
// Pure functions only — the cron poller owns the DB writes, and it must keep them idempotent
// (only write when the mirrored value actually changed): a per-cycle unconditional
// request.update touching updatedAt was the second half of the incident, blinding the reaper's
// "no movement for N days" signal to exactly the rows it needs to see.

export interface MirroredClientState {
    status: string;
    message: string | null;
}

// Status fragments the download clients use for a state that will not progress on its own:
// SABnzbd queue slots report "Paused"; qBittorrent reports "pausedDL"/"stalledDL"/"error";
// NZBGet reports "PAUSED"/"QUEUED" (running) and "FAILURE"/"WARNING". Anything matching this
// pattern is mirrored; everything else (Downloading/Seeding/Extracting/Completed/…) is
// "normal" and clears the mirror.
const PROBLEM_STATUS_PATTERN = /paus|stall|error|fail|duplicate|missing|unpacked|invalid/i;

/**
 * Classify one poller item's client-side state.
 * Returns null when the state is normal/resolved (the mirror should be cleared),
 * or { status, message } to persist. `message` carries a client-provided reason when it has
 * one (SABnzbd history fail_message) so the UI can say "Paused by download client: duplicate"
 * instead of just "Paused".
 */
export function mirrorClientStatus(item: { status?: string | null, statusMessage?: string | null, progress?: string | number | null }): MirroredClientState | null {
    const status = (item.status || '').trim();
    if (!status) return null;

    // A queue item that is actually delivering bytes is never a "problem" state even if its
    // status string looks odd; a >0 progress with a non-problem status resolves the mirror.
    if (!PROBLEM_STATUS_PATTERN.test(status)) return null;

    const message = (item.statusMessage || '').trim() || null;
    return { status, message };
}

