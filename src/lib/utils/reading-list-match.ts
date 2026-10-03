// src/lib/utils/reading-list-match.ts
//
// Shared, client-safe helpers for the reading-list "Fix match" flow: the dialog, the page and the
// server routes all parse provider issue IDs, read list titles and build stored titles through
// these ONE implementations, so a preview and the save that follows it can never disagree about
// which issue an input names. Pure on purpose (no prisma, no fetch) — imported by client components.
//
// ReadingListItem.cvIssueId holds a provider issue id in EITHER namespace; metadataSource says which
// (the GET auto-link already reads the pair that way). The two are always written together.
import { normalizeFractionNumbers } from '@/lib/utils/issue-parser';
import { requestNameFor } from '@/lib/utils/request-name';

export type MatchProvider = 'COMICVINE' | 'METRON';
export const MATCH_PROVIDERS: readonly MatchProvider[] = ['COMICVINE', 'METRON'];
/** ReadingListItem.cvIssueId is a Prisma Int (int4 on Postgres). */
export const MAX_PROVIDER_ISSUE_ID = 2_147_483_647;

export type MatchErrorCode = 'INVALID_INPUT' | 'PROVIDER_NOT_CONFIGURED' | 'ISSUE_NOT_FOUND'
    | 'RATE_LIMITED' | 'PROVIDER_ERROR' | 'FORBIDDEN' | 'ITEM_NOT_FOUND';

export interface ProviderIssueSummary {
    provider: MatchProvider;
    issueId: number;
    /** CV volume id / Metron series id (feeds the #194 identity guard). */
    seriesId: number | null;
    seriesName: string | null;
    /** Metron series.year_began; CV: null (no extra volume call). */
    seriesStartYear: number | null;
    /** Metron publisher.name; CV: null. */
    publisher: string | null;
    /** normalizeIssueNo(): "13.5", leading zeros stripped. */
    issueNumber: string;
    /** A real story title only — never a "Issue #3" placeholder or the series name. */
    issueTitle: string | null;
    coverDate: string | null;
    storeDate: string | null;
    /** "/api/library/cover?path=<encoded raw url>" or null. */
    image: string | null;
    /** A validated provider page, else providerIssueUrl(). */
    siteUrl: string;
    /** EXACTLY the value PATCH stores in ReadingListItem.title. */
    displayTitle: string;
}

export interface LocalIssueMatch { issueId: string; seriesId: string; seriesName: string; number: string; hasFile: boolean }
export interface MislabeledLocal { seriesName: string; number: string }
export interface MatchLookupResponse {
    match: ProviderIssueSummary;
    local: LocalIssueMatch | null;
    mislabeled: MislabeledLocal | null;
    accessScope: 'self' | 'owner';
    /**
     * Server answer to "would a Save with keepLocalLink keep the entry's CURRENT link?" — the exact
     * predicate PATCH applies (linked, the library can't contradict, AND the list OWNER can access
     * the link's library). Computed only when the request carries an itemId; false otherwise. The
     * client must not recompute it: an ADMIN editing a restricted owner's entry links the answer to
     * the owner's libraries, not the admin's, and only the server knows which.
     */
    keepable: boolean;
}

export function isMatchProvider(v: unknown): v is MatchProvider {
    return v === 'COMICVINE' || v === 'METRON';
}

/** A stored credential that can actually be sent: not empty, not the UI mask, not undecryptable. */
export function isUsableSecret(v?: string | null): boolean {
    return !!v && v !== '********' && !v.startsWith('enc:');
}

export type ParsedProviderIssueId =
    | { ok: true; id: number }
    | { ok: false; error: string; suggestProvider?: MatchProvider };

const POSITIVE_ID_ERROR = 'Enter a positive numeric issue ID from the selected provider.';

/**
 * Accepts what users actually paste: a bare id, CV's "4000-<id>" resource form, a ComicVine issue
 * page URL (with or without the slug, the form the engine writes into ComicInfo Web), the
 * ComicTagger "CVDB<id>" note form, or a numeric Metron issue URL. Volume ids, slugged Metron links
 * and cross-provider pastes get a specific message instead of a lookup that can only fail.
 */
export function parseProviderIssueId(provider: MatchProvider, raw: unknown): ParsedProviderIssueId {
    const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
    if (!s) return { ok: false, error: 'Enter an issue ID.' };

    let value = s;
    if (provider === 'COMICVINE') {
        if (/(?:^|[^0-9])4050-\d+/.test(s)) {
            return { ok: false, error: "That's a ComicVine volume ID (4050-…). Enter the issue ID (4000-…)." };
        }
        const resource = s.match(/(?:^|[^0-9])4000-(\d+)(?![0-9])/);
        const cvdb = s.match(/^CVDB(\d+)$/i);
        if (resource) value = resource[1];
        else if (cvdb) value = cvdb[1];
        else if (/metron\.cloud\//i.test(s)) {
            return { ok: false, error: "That's a Metron link — switch the provider to Metron.", suggestProvider: 'METRON' };
        } else if (/^https?:\/\//i.test(s)) {
            return { ok: false, error: "Couldn't find a ComicVine issue ID (4000-…) in that link." };
        }
    } else {
        const link = s.match(/metron\.cloud\/(?:api\/)?issue\/(\d+)\/?(?:[?#].*)?$/i);
        if (link) value = link[1];
        else if (/metron\.cloud\/(?:api\/)?issue\//i.test(s)) {
            return { ok: false, error: 'Metron issue links use a name slug — enter the numeric issue ID or use the Search tab.' };
        } else if (/comicvine\.gamespot\.com|(?:^|[^0-9])4000-\d+/i.test(s)) {
            return { ok: false, error: "That's a ComicVine ID — switch the provider to ComicVine.", suggestProvider: 'COMICVINE' };
        } else if (/^https?:\/\//i.test(s)) {
            return { ok: false, error: "That doesn't look like a Metron issue link." };
        }
    }

    if (!/^\d+$/.test(value)) return { ok: false, error: POSITIVE_ID_ERROR };
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_PROVIDER_ISSUE_ID) return { ok: false, error: POSITIVE_ID_ERROR };
    return { ok: true, id };
}

/** Canonical issue number for titles and comparisons: "13½"→"13.5", "001"→"1", "-01"→"-1". */
export function normalizeIssueNo(n: string | number | null | undefined): string {
    return normalizeFractionNumbers(String(n ?? '').trim()).replace(/^(-?)0+(?=\d)/, '$1');
}

const YEAR_GROUP = /[(\[]\s*((?:19|20)\d{2})\s*[)\]]/;

/**
 * Reads the "Series (Year) #N: Story" shapes reading-list titles come in. The LAST "#N" is the
 * issue (series names can carry their own "#"); a bracketed year anywhere is the series year.
 * Deliberately not seriesQueryFromName — that strips title digits ("Kaiju No. 8" would lose its 8).
 */
export function parseReadingListTitle(title: string | null | undefined): { series: string; number: string; year: number | null } {
    const t = normalizeFractionNumbers((title ?? '').trim());
    const y = t.match(YEAR_GROUP);
    const year = y ? Number(y[1]) : null;

    let number = '';
    let series = t;
    const hashes = Array.from(t.matchAll(/#\s*(-?\d+(?:\.\d+)?[a-z]*)/gi));
    const last = hashes[hashes.length - 1];
    if (last && last.index !== undefined) {
        number = normalizeIssueNo(last[1]);
        series = t.slice(0, last.index);
    }

    series = series
        .replace(new RegExp(YEAR_GROUP.source, 'g'), ' ')
        .replace(/[\s:–—-]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    return { series, number, year };
}

/** The stored title convention every list creator uses: "Series #N" (no year, no story title). */
export function buildReadingListItemTitle(seriesName: string | null | undefined, issueNumber: string | number | null | undefined): string {
    const n = normalizeIssueNo(issueNumber);
    const s = (seriesName ?? '').trim();
    if (s && n) return `${s} #${n}`;
    if (n) return `Issue #${n}`;
    return s || 'Unknown issue';
}

/** The slice of a GET /api/reading-lists item these helpers read (the page passes the raw row). */
export interface ReadingListItemLike {
    title?: string | null;
    cvIssueId?: number | null;
    metadataSource?: string | null;
    issueId?: string | null;
    issue?: {
        number: string;
        name?: string | null;
        isAnnual?: boolean | null;
        filePath?: string | null;
        releaseDate?: string | null;
        metadataSource?: string | null;
        metadataId?: string | null;
        series?: {
            name: string;
            year?: number | null;
            publisher?: string | null;
            metadataId?: string | null;
            metadataSource?: string | null;
        } | null;
    } | null;
}

/** Search-tab prefill: the linked issue when there is one, else whatever the title says. */
export function matchSearchPrefill(item: ReadingListItemLike): { query: string; number: string; annual: boolean } {
    const issue = item.issue;
    const series = issue?.series;
    if (issue && series?.name) {
        if (issue.isAnnual) return { query: `${series.name} Annual`, number: issue.number, annual: true };
        // Always the PARENTHESIZED year — the only year form /api/search honors.
        return { query: series.year ? `${series.name} (${series.year})` : series.name, number: issue.number, annual: false };
    }
    const parsed = parseReadingListTitle(item.title);
    return { query: parsed.year ? `${parsed.series} (${parsed.year})`.trim() : parsed.series, number: parsed.number, annual: false };
}

/** Human label for a row (aria-labels, confirmation copy). */
export function readingListItemLabel(item: ReadingListItemLike): string {
    const series = item.issue?.series;
    if (item.issue && series?.name) return `${series.name}${item.issue.isAnnual ? ' Annual' : ''} #${item.issue.number}`;
    return item.title || 'this entry';
}

export function providerLabel(p: string | null | undefined): 'ComicVine' | 'Metron' {
    return p === 'METRON' ? 'Metron' : 'ComicVine';
}

export function providerShortLabel(p: string | null | undefined): 'CV' | 'Metron' {
    return p === 'METRON' ? 'Metron' : 'CV';
}

/** Public issue page. CV uses the slug-less form the engine writes into ComicInfo <Web>. */
export function providerIssueUrl(p: MatchProvider, id: number | string): string {
    return p === 'METRON' ? `https://metron.cloud/issue/${id}/` : `https://comicvine.gamespot.com/issue/4000-${id}/`;
}

/**
 * True when the library has no provider identity for this row that could confirm or rule out a
 * match: it's matched to the other provider, or its metadataId isn't a provider id at all (LOCAL,
 * or "unmatched_*" — which the Rust scanner creates under a provider source too). A same-provider
 * row with a different numeric id is a contradiction, never "can't tell".
 */
export function libraryCannotContradict(issue: { metadataSource?: string | null; metadataId?: string | null }, provider: MatchProvider): boolean {
    return issue.metadataSource !== provider || !/^\d+$/.test(issue.metadataId ?? '');
}

/** House convention: "downloaded" = a non-blank filePath (library/issues/route.ts onDisk). */
export function isDownloaded(item: { issue?: { filePath?: string | null } | null }): boolean {
    return !!item.issue?.filePath?.trim();
}

/** Several rows can share a provider id: a file-backed copy wins, else the first (oldest) row. */
export function pickPreferredIssue<T extends { filePath?: string | null }>(rows: T[]): T | null {
    return rows.find(r => !!r.filePath?.trim()) ?? rows[0] ?? null;
}

export interface LinkedIssueRequest {
    cvId: string;
    name: string;
    issueNumber: string;
    year: string;
    publisher: string;
    metadataSource: MatchProvider;
    releaseDate: string | null;
}

/**
 * The /api/request payload for an entry linked to a not-downloaded issue: filed against the
 * SERIES volume with the shared request name, exactly like the library's Missing Issues view.
 * null when the series isn't genuinely matched (an unmatched_/LOCAL series has nothing to search).
 */
export function linkedIssueRequest(item: ReadingListItemLike, now: Date = new Date()): LinkedIssueRequest | null {
    const issue = item.issue;
    const series = issue?.series;
    if (!issue || !series) return null;
    if (!isMatchProvider(series.metadataSource) || !/^\d+$/.test(series.metadataId ?? '')) return null;
    const p = parseFloat(normalizeFractionNumbers(issue.number ?? ''));
    const { composite, reqNum } = requestNameFor({
        seriesName: series.name,
        number: issue.number,
        parsedNum: Number.isFinite(p) ? p : null,
        name: issue.name,
        isAnnual: !!issue.isAnnual,
    });
    return {
        cvId: series.metadataId as string,
        name: composite,
        issueNumber: reqNum,
        year: String(series.year || now.getFullYear()),
        publisher: series.publisher || 'Unknown',
        metadataSource: series.metadataSource,
        releaseDate: issue.releaseDate || null,
    };
}
