// src/lib/reading-list-links.ts
//
// Which local Issue a reading-list entry may link to. Two rules, shared by the Fix match preview
// (GET /api/reading-lists/match), the save (PATCH /api/reading-lists/items) and the GET auto-link:
//
//   1. Link ACCESS follows the list OWNER, whoever triggers the write. A restricted owner's entry
//      linked into a library they can't see is hidden from them by the list GET — an admin's
//      rematch or another viewer's page load must never make an owner's entry disappear.
//      System lists (userId null) can only be edited by admins and link into any library.
//   2. A candidate row must pass the #194 identity guard: a metadata-sync race can leave an Issue
//      row holding ANOTHER issue's metadataId, so the stored id alone doesn't prove the row is
//      the provider issue. Parent volume/series and issue number must agree when both are known.
//
// Lives in lib (not a route file) because route modules may only export handlers.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getAccessibleLibraryIds, nestedSeriesAccessWhere, type AccessibleLibraries } from '@/lib/library-access';
import { issueIdentityMismatch } from '@/lib/metadata/issue-identity';
import { isSameIssue } from '@/lib/utils/issue-parser';
import {
    pickPreferredIssue,
    type LocalIssueMatch,
    type MatchProvider,
    type MislabeledLocal,
    type ProviderIssueSummary,
} from '@/lib/utils/reading-list-match';

/**
 * Libraries a list's entries may link into: the OWNER's access ('ALL' for system lists).
 * `cache` (keyed by owner id, storing the promise) dedupes owners across the lists of one request.
 */
export async function linkAccessForList(
    list: { userId: string | null },
    viewer: { id: string; role?: string | null },
    cache?: Map<string, Promise<AccessibleLibraries>>,
): Promise<AccessibleLibraries> {
    const ownerId = list.userId;
    if (!ownerId) return 'ALL';
    const hit = cache?.get(ownerId);
    if (hit) return hit;
    const access: Promise<AccessibleLibraries> = ownerId === viewer.id
        ? getAccessibleLibraryIds(viewer.id, viewer.role)
        : prisma.user.findUnique({ where: { id: ownerId }, select: { role: true } })
            .then((owner: { role?: string | null } | null) => (owner ? getAccessibleLibraryIds(ownerId, owner.role) : []));
    cache?.set(ownerId, access);
    return access;
}

export interface LocalIssueCandidate {
    id: string;
    number: string;
    filePath: string | null;
    isAnnual: boolean;
    attachedVolumeId: string | null;
    attachedVolume: { volumeId: string; metadataSource: string } | null;
    series: { id: string; name: string; metadataId: string | null; metadataSource: string };
}

/**
 * THE shared rule for an UNLINKED reading-list entry (issueId null, provider id set): which local
 * Issue stands for it. Both the GET /api/reading-lists auto-link and the Komga read-list resolver
 * go through here, so a list can never resolve to a different issue in Komga than it does on screen.
 *
 * The rule (unchanged from the auto-link it came out of): match `{metadataId, metadataSource}`,
 * veto a copy whose number contradicts the entry title's "#N" (unless it is an attached lane, whose
 * number is user curation), then prefer a file-backed copy and the oldest. Access filtering is NOT
 * part of it — who may link is the caller's decision (the auto-link follows the list OWNER).
 */
export interface ProviderIdCandidate {
    id: string;
    metadataId?: string | null;
    metadataSource?: string | null;
    number?: string | null;
    filePath?: string | null;
    attachedVolumeId?: string | null;
    series?: { libraryId?: string | null } | null;
}

/** The column default is COMICVINE; an absent/blank source must not become a different provider. */
export function normalizeMetadataSource(source?: string | null): string {
    return source && source.trim() ? source : 'COMICVINE';
}

export function pickIssueForProviderId<T extends ProviderIdCandidate>(
    rows: readonly T[],
    providerIssueId: number,
    metadataSource?: string | null,
    /** The "#N" parsed off the entry title; null/undefined disables the veto (the resolver has none). */
    expectedNumber?: string | number | null,
): T | null {
    const wanted = String(providerIssueId);
    const source = normalizeMetadataSource(metadataSource);
    const candidates = rows.filter(r =>
        r.metadataId === wanted && normalizeMetadataSource(r.metadataSource) === source);
    const allowed = expectedNumber
        ? candidates.filter(c => !!c.attachedVolumeId || isSameIssue(c.number ?? '', expectedNumber))
        : candidates;
    return pickPreferredIssue(allowed);
}

/**
 * The same rule against the database, for callers that hold one unlinked entry rather than a
 * batch (the Komga resolver). Ordered oldest-first so the tie-break matches pickPreferredIssue.
 */
export async function findIssueForProviderId(
    providerIssueId: number,
    metadataSource?: string | null,
): Promise<{ id: string; filePath: string | null; libraryId: string | null } | null> {
    const rows = await prisma.issue.findMany({
        where: { metadataId: String(providerIssueId), metadataSource: normalizeMetadataSource(metadataSource) },
        select: { id: true, metadataId: true, metadataSource: true, number: true, filePath: true, attachedVolumeId: true, series: { select: { libraryId: true } } },
        orderBy: { createdAt: 'asc' },
        take: 20,
    });
    const pick = pickIssueForProviderId(rows, providerIssueId, metadataSource);
    return pick ? { id: pick.id, filePath: pick.filePath ?? null, libraryId: pick.series?.libraryId ?? null } : null;
}

/** A stored parent id is provider evidence only when it is a real numeric provider id. */
const providerParentId = (source: string | null | undefined, id: string | null | undefined, provider: MatchProvider): string | null =>
    source === provider && /^\d+$/.test(id ?? '') ? (id as string) : null;

/**
 * Why `row` is NOT the provider issue `match` (log-ready), or null when it may be linked.
 *   - Attached-lane rows (an annual/collected volume attached to a series) are anchored to the
 *     attached volume's id, and their number is user curation — so only the parent is compared.
 *   - Annual rows without an attachment live in the main series but come from a separate provider
 *     volume, so the parent check is skipped and only the number is compared.
 *   - Otherwise the series' own provider id must agree (when it is a numeric id of this provider;
 *     an unmatched_ placeholder carries no provider evidence) and so must the number.
 */
export function rowIdentityMismatch(
    row: Pick<LocalIssueCandidate, 'number' | 'isAnnual' | 'attachedVolumeId' | 'attachedVolume' | 'series'>,
    provider: MatchProvider,
    match: Pick<ProviderIssueSummary, 'seriesId' | 'issueNumber'>,
): string | null {
    const parentId = row.attachedVolume
        ? providerParentId(row.attachedVolume.metadataSource, row.attachedVolume.volumeId, provider)
        : (row.isAnnual ? null : providerParentId(row.series.metadataSource, row.series.metadataId, provider));
    return issueIdentityMismatch({
        rowNumber: row.number,
        seriesMetadataId: parentId,
        seriesMetadataSource: provider,
        expectedSource: provider,
        fetchedParentId: match.seriesId != null ? String(match.seriesId) : null,
        fetchedIssueNumber: row.attachedVolumeId ? null : match.issueNumber,
    });
}

/**
 * The local copy of provider issue `issueId` that a list entry may link to: rows tagged with the
 * id in a library the list owner can access (`access`), minus rows that fail the identity guard,
 * preferring a file-backed copy, then the oldest. `mislabeled` reports the first rejected row when
 * nothing passed, so the UI can say why an owned-looking copy won't be linked.
 */
export async function findLocalIssueForMatch(
    provider: MatchProvider,
    issueId: number,
    match: Pick<ProviderIssueSummary, 'seriesId' | 'issueNumber'>,
    access: AccessibleLibraries,
): Promise<{ local: LocalIssueMatch | null; mislabeled: MislabeledLocal | null }> {
    const rows: LocalIssueCandidate[] = await prisma.issue.findMany({
        where: { metadataId: String(issueId), metadataSource: provider, ...nestedSeriesAccessWhere(access) },
        select: {
            id: true, number: true, filePath: true, isAnnual: true, attachedVolumeId: true, createdAt: true,
            attachedVolume: { select: { volumeId: true, metadataSource: true } },
            series: { select: { id: true, name: true, metadataId: true, metadataSource: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
    });

    const good: LocalIssueCandidate[] = [];
    for (const row of rows) {
        const reason = rowIdentityMismatch(row, provider, match);
        if (reason) {
            Logger.log(`[Reading List Match] Skipping mislabeled local issue ${row.id} (${row.series.name} #${row.number}) tagged ${provider} ${issueId}: ${reason}.`, 'warn');
        } else {
            good.push(row);
        }
    }

    const pick = pickPreferredIssue(good);
    const local: LocalIssueMatch | null = pick
        ? { issueId: pick.id, seriesId: pick.series.id, seriesName: pick.series.name, number: pick.number, hasFile: !!pick.filePath?.trim() }
        : null;
    const mislabeled: MislabeledLocal | null = !pick && rows.length > 0
        ? { seriesName: rows[0].series.name, number: rows[0].number }
        : null;
    return { local, mislabeled };
}
