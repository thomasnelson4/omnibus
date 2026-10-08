import { isSameIssue } from '@/lib/utils/issue-parser';

// Issue #194: a metadata-sync race can leave an Issue row holding another issue's metadataId.
// Any path that fetches provider data BY that stored id (view-time enrichment, cover reset) must
// prove the fetched issue really is this row — same parent volume/series and same issue number —
// before writing, or the wrong id propagates into description/credits/covers and then gets locked
// in by DEEP_SYNCED. Returns a log-ready reason when the payload fails the check, null when it
// may be trusted.
//
// Checks are evidence-based: a dimension is only enforced when both sides are known, so e.g. a
// Metron payload without a resolvable series id (their fallback search failed) still gets the
// number check instead of being rejected outright.
//
// #238: a row in an attached lane (an annual or collected edition, #203) belongs to its ATTACHED
// volume, not the series' own — comparing it to the series refused every enrichment for it. Once a
// payload is proven to come from that volume the number is not checked: the lane binds by provider
// id, and its numbers are the user's own curation (chronological renumbering is supported).
export function issueIdentityMismatch(opts: {
    rowNumber: string;
    seriesMetadataId?: string | null;
    seriesMetadataSource?: string | null;
    /** The row's attached volume, when it belongs to an attached lane (#203). */
    attachedVolume?: { volumeId?: string | null; metadataSource?: string | null } | null;
    /** Provider the stored metadataId belongs to ('COMICVINE' | 'METRON'). */
    expectedSource: string;
    /** CV volume id / Metron series id carried by the fetched payload. */
    fetchedParentId?: string | null;
    fetchedIssueNumber?: string | number | null;
}): string | null {
    // A provider id is only comparable when it belongs to the same provider as the stored metadataId.
    const comparable = (id?: string | null, source?: string | null) => (source === opts.expectedSource ? id || null : null);
    const lane = opts.attachedVolume ?? null;
    const parentId = lane
        ? comparable(lane.volumeId, lane.metadataSource)
        : comparable(opts.seriesMetadataId, opts.seriesMetadataSource);

    if (opts.fetchedParentId && parentId && opts.fetchedParentId !== parentId) {
        const parentKind = opts.expectedSource === 'METRON' ? 'series' : 'volume';
        const owner = lane ? 'attached volume' : 'series';
        return `resolved to ${parentKind} ${opts.fetchedParentId} but the ${owner} is ${parentKind} ${parentId}`;
    }
    if (lane && parentId && opts.fetchedParentId === parentId) return null;

    const fetchedNum = opts.fetchedIssueNumber;
    if (fetchedNum !== null && fetchedNum !== undefined && String(fetchedNum).trim() !== ''
        && !isSameIssue(String(fetchedNum), opts.rowNumber)) {
        return `resolved to issue #${fetchedNum} but the row is issue #${opts.rowNumber}`;
    }

    return null;
}
