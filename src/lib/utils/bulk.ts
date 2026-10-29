// src/lib/utils/bulk.ts
//
// Bulk actions send one request per selected item in parallel. fetch only rejects on a network
// failure, so `await Promise.all(fetches)` counts every 4xx/5xx as done — bulk approve/deny, retry,
// cancel and mark-read all announced success that way (found in the v1.4.7 permission sweep).
// runBulk reports which items the server actually accepted, so a page can say "1 of 2 failed" and
// keep only the failed ones selected.
import { getErrorMessage } from './error';

export interface BulkOutcome<T> {
    succeeded: T[];
    failed: T[];
    /** The first failed item's reason (in item order): the server's `error` text, else `HTTP <status>`. */
    firstError: string | null;
}

async function reasonFor(result: PromiseSettledResult<Response>): Promise<string> {
    if (result.status === 'rejected') return getErrorMessage(result.reason);
    const body = await result.value.json().catch(() => null);
    return (body && typeof body.error === 'string' && body.error) || `HTTP ${result.value.status}`;
}

export async function runBulk<T>(items: T[], send: (item: T) => Promise<Response>): Promise<BulkOutcome<T>> {
    const results = await Promise.allSettled(items.map(item => send(item)));
    const outcome: BulkOutcome<T> = { succeeded: [], failed: [], firstError: null };
    for (let i = 0; i < items.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled' && result.value.ok) {
            outcome.succeeded.push(items[i]);
        } else {
            outcome.failed.push(items[i]);
            if (outcome.firstError === null) outcome.firstError = await reasonFor(result);
        }
    }
    return outcome;
}
