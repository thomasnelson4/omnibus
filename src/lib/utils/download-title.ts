// src/lib/utils/download-title.ts
//
// Pure title comparison for download-queue dedupe (see DownloadService.checkDuplicateDownload):
// decides whether a client queue/history item is "the same download" as the title Omnibus is
// about to enqueue. Match by NZB/torrent URL when both sides expose one, then fall back to a
// normalised series-name + issue-number comparison — the same normalisation rule the calendar's
// cross-provider series bridge (series-match.ts) uses, plus isSameIssue from the issue parser so
// "#½"-style fractions and negative/reprint numbering don't collide.
//
// Deliberately dependency-free (no prisma/axios) so it is unit-testable in isolation and safe to
// import from either download-clients.ts or the cron poller without import cycles.

import { normalizeSeriesName } from './series-match';
import { extractIssueNumber, isSameIssue } from './issue-parser';

// Zero-padded issue numbers are everywhere in release names ("King In Black 001 (2021)" vs the
// requested "King In Black #1 (2021)") — collapse leading zeros so the two normalise the same.
function stripZeroPadding(normalizedName: string): string {
    return normalizedName.replace(/\b0+(\d)/g, '$1');
}

/**
 * Do a queue item's and a request's titles refer to the same release?
 *
 * Two tiers:
 * 1. The normalised series names (zero-padding collapsed) are equal AND both sides' issue
 *    numbers (when parseable) are the same issue. A request title with an issue number and a
 *    queue item without one is NOT a match — "Batman" (a pack/whole-run item) must not block
 *    "Batman #5"; an un-numbered title matches an item numbered #1 (the issue parser's
 *    documented default), the common whole-issue-request shape.
 * 2. Fallback for release names that carry quality tags ("sword.007.2021.webrip"): same issue
 *    AND ≥50% word overlap of the digit-stripped names. Weaker than the cron poller's 0.7
 *    because equal issue numbers are a strong pre-filter; it still rejects distinct series
 *    ("Batman" vs "Batman Eternal Annual" ≈ 0.33).
 */
export function isSameDownloadTitle(itemTitle: string | null | undefined, requestTitle: string | null | undefined): boolean {
    const itemIssue = extractIssueNumber(itemTitle || '');
    const reqIssue = extractIssueNumber(requestTitle || '');

    const a = stripZeroPadding(normalizeSeriesName(itemTitle));
    const b = stripZeroPadding(normalizeSeriesName(requestTitle));
    if (!a || !b) return false;

    if (a === b && isSameIssue(itemIssue, reqIssue)) return true;

    // SAB/nzbfast rename NZB names to a dotted form where the year is GLUED to the issue number
    // ("sword.007.2021.webrip" parses as issue "7.2021", not "7"). For the tier-2 fallback,
    // strip standalone year tokens from both sides before extracting, so "7.2021" reads as "7".
    const yearStripped = (t: string | null | undefined) => (t || '').replace(/\(?\b(19|20)\d{2}\b\)?/g, ' ');
    if (!isSameIssue(extractIssueNumber(yearStripped(itemTitle)), extractIssueNumber(yearStripped(requestTitle)))) return false;

    // Tier 2: digit-stripped word overlap (parity with the cron poller's fallback matcher,
    // which strips digits and compares word ratios for exactly these release-name shapes).
    const stripDigits = (s: string) => s.replace(/[0-9]/g, ' ').split(/\s+/).filter(w => w.length > 1);
    const wordsA = stripDigits(a);
    const wordsB = stripDigits(b);
    if (wordsA.length === 0 || wordsB.length === 0) return false;
    let matches = 0;
    for (const w of wordsA) { if (wordsB.includes(w)) matches++; }
    return matches / Math.max(wordsA.length, wordsB.length) >= 0.5;
}

/**
 * Compare an item's source URL (when the client exposes one) with the URL Omnibus is about to
 * submit. Trivial string equality after trimming — URLs are the strongest signal when present.
 */
export function isSameDownloadUrl(itemUrl: string | null | undefined, downloadUrl: string | null | undefined): boolean {
    const a = (itemUrl || '').trim();
    const b = (downloadUrl || '').trim();
    return !!a && !!b && a === b;
}
