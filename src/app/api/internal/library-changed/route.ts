// src/app/api/internal/library-changed/route.ts
//
// Internal endpoint the Rust engine calls when IT writes into a library (watched imports, metadata
// embeds, CBR conversions, repacks, cover writes). Without it those writes never reach the Node
// side's change tracking, so Komga would only learn about them on its own periodic scan.
//
// NOT a public route: authenticated by the shared secret (NEXTAUTH_SECRET, already shared with the
// engine) in X-Internal-Secret, exactly like /api/internal/notify and /api/internal/log. src/middleware.ts
// exempts the whole /api/internal prefix, so the session check is this handler's job alone.
//
// Validation is hand-rolled — this repo has no zod. Anything malformed is DROPPED rather than
// rejected: a single bad event should not cost the caller its whole batch of legitimate ones.
// The engine coalesces ~3 s of work into one POST, so dropping the tail is nearly free and a hard
// 400 would make the engine retry a payload that can never succeed.
import { NextResponse } from 'next/server';
import { Logger } from '@/lib/logger';
import { secretsMatch } from '@/lib/api-auth';
import { recordLibraryChange } from '@/lib/komga/changes';

// A generous ceiling, not a tight one: one engine job over a large library can legitimately emit
// hundreds of paths, and the flush debounce absorbs whatever arrives.
const MAX_EVENTS = 1000;
const MAX_PATHS_TOTAL = 5000;
const MAX_IDS_PER_EVENT = 5000;

/** Keep only the entries that are the right primitive, and only strings. */
function stringList(value: unknown, cap: number): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        // Cap checked BEFORE the push: checking after would return one item for a cap of 0, which
        // is exactly the exhausted-budget case.
        if (out.length >= cap) break;
        if (typeof item !== 'string' || item.length === 0) continue;
        out.push(item);
    }
    return out;
}

export async function POST(request: Request) {
    const provided = request.headers.get('x-internal-secret');
    if (!secretsMatch(provided, process.env.NEXTAUTH_SECRET)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const events = (body as { events?: unknown })?.events;
    if (!Array.isArray(events)) {
        return NextResponse.json({ error: 'Missing events array' }, { status: 400 });
    }

    let pathBudget = MAX_PATHS_TOTAL;
    let accepted = 0;
    for (const raw of events.slice(0, MAX_EVENTS)) {
        const e = raw as { reason?: unknown; paths?: unknown; seriesIds?: unknown; issueIds?: unknown };
        if (!e || typeof e !== 'object') continue;
        const reason = typeof e.reason === 'string' && e.reason.trim() ? e.reason.trim().slice(0, 64) : '';
        // A reason is the only thing that makes an event auditable in the JobLog; without it there
        // is no point processing the rest.
        if (!reason) continue;

        const paths = stringList(e.paths, Math.max(0, pathBudget));
        pathBudget -= paths.length;
        const seriesIds = stringList(e.seriesIds, MAX_IDS_PER_EVENT);
        const issueIds = stringList(e.issueIds, MAX_IDS_PER_EVENT);
        if (paths.length === 0 && seriesIds.length === 0 && issueIds.length === 0) continue;

        // Sequential, and awaited: recordLibraryChange is non-blocking by design (no HTTP, no
        // queue), so this stays fast — and doing them in order keeps the pendingPaths merge
        // deterministic rather than racing N concurrent read-modify-writes for no benefit.
        await recordLibraryChange({ reason, paths, seriesIds, issueIds, source: 'engine' });
        accepted++;
    }

    if (events.length > MAX_EVENTS) {
        Logger.log(`[Komga] library-changed: ${events.length} events sent, only the first ${MAX_EVENTS} were read.`, 'warn');
    }
    if (pathBudget <= 0) {
        Logger.log('[Komga] library-changed: path budget exhausted; later events in this batch were dropped.', 'warn');
    }

    // 202: the change is recorded, but nothing has been told to Komga yet. The flush timer decides
    // that once the debounce expires.
    return NextResponse.json({ accepted }, { status: 202 });
}
