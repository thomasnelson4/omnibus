// src/lib/metadata/issue-match.ts
//
// Single provider-issue lookup for reading-list Fix match (preview + save), with typed errors the
// dialog can show verbatim. Deliberately NOT /api/issue-details: that route is credit-heavy, writes
// a SystemSetting row per id, and turns most failures into a bare 500.
//
//   - ComicVine goes through cachedCvGet ONLY — it owns usage accounting (never log again here).
//     One call, no volume call. A cached body carrying a non-success status_code (cachedCvGet stores
//     any 200 object for up to the detail TTL) is re-fetched once with the cache bypassed.
//   - Metron goes through MetronProvider.getIssueSummary — the only failFast caller: no burst/429
//     sleeps, no retries, so a busy provider is an error the user can act on, not a hung dialog.
//   - A small per-process memo (successful summaries only) lets a save reuse its preview's lookup.
//     It is an optimization: if route bundles don't share module state, the save just calls again.
import { prisma } from '@/lib/db';
import { cachedCvGet } from '@/lib/metadata/metadata-cache';
import { MetronProvider } from '@/lib/metadata/providers/metron';
import { isCvRateLimited } from '@/lib/utils/metadata-policy';
import { markSystemFlag } from '@/lib/utils/system-flags';
import {
    buildReadingListItemTitle,
    isUsableSecret,
    MAX_PROVIDER_ISSUE_ID,
    normalizeIssueNo,
    providerIssueUrl,
    type MatchErrorCode,
    type MatchProvider,
    type ProviderIssueSummary,
} from '@/lib/utils/reading-list-match';

export class IssueMatchError extends Error {
    constructor(public code: MatchErrorCode, message: string, public status: number) {
        super(message);
        this.name = 'IssueMatchError';
    }
}

const CV_ISSUE_FIELDS = 'id,name,issue_number,cover_date,store_date,image,volume,site_detail_url';
const MEMO_TTL_MS = 10 * 60 * 1000;
const MEMO_MAX_ENTRIES = 500;
const memo = new Map<string, { at: number; value: ProviderIssueSummary }>();

/** Test hook: forget memoized lookups. */
export function clearIssueMatchMemo(): void {
    memo.clear();
}

const notFound = (provider: MatchProvider, id: number) => new IssueMatchError(
    'ISSUE_NOT_FOUND', `No ${provider === 'METRON' ? 'Metron' : 'ComicVine'} issue has ID ${id}. Check the provider and ID.`, 404);
const rateLimited = (provider: MatchProvider) => new IssueMatchError(
    'RATE_LIMITED', `${provider === 'METRON' ? 'Metron' : 'ComicVine'} is rate-limiting requests — try again in a few minutes.`, 429);
const unreachable = (provider: MatchProvider) => new IssueMatchError(
    'PROVIDER_ERROR', `Couldn't reach ${provider === 'METRON' ? 'Metron' : 'ComicVine'} — try again.`, 502);
const cvKeyRejected = () => new IssueMatchError(
    'PROVIDER_ERROR', 'ComicVine rejected the API key — check it in Settings → Metadata.', 502);
const metronLoginRejected = () => new IssueMatchError(
    'PROVIDER_ERROR', 'Metron rejected the login — check it in Settings → Metadata.', 502);
const notConfigured = (provider: MatchProvider) => new IssueMatchError(
    'PROVIDER_NOT_CONFIGURED',
    provider === 'METRON'
        ? "Metron isn't configured on this server — an admin can add a Metron login in Settings → Metadata."
        : "ComicVine isn't configured on this server — an admin can add an API key in Settings → Metadata.",
    503);

const proxiedCover = (raw: unknown): string | null =>
    typeof raw === 'string' && raw ? `/api/library/cover?path=${encodeURIComponent(raw)}` : null;

/** Which providers can serve a lookup right now. Booleans only — never a setting value. */
export async function getConfiguredProviders(): Promise<{ providers: Record<MatchProvider, boolean>; primary: MatchProvider }> {
    const rows = await prisma.systemSetting.findMany({
        where: { key: { in: ['cv_api_key', 'metron_user', 'metron_pass', 'primary_metadata_source'] } },
    });
    const cfg: Record<string, string | null | undefined> = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return {
        providers: {
            COMICVINE: isUsableSecret(cfg.cv_api_key) || !!process.env.CV_API_KEY,
            METRON: !!cfg.metron_user && isUsableSecret(cfg.metron_pass),
        },
        primary: cfg.primary_metadata_source === 'METRON' ? 'METRON' : 'COMICVINE',
    };
}

async function cvApiKey(): Promise<string> {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
    if (setting?.value && isUsableSecret(setting.value)) return setting.value;
    if (process.env.CV_API_KEY) return process.env.CV_API_KEY;
    throw notConfigured('COMICVINE');
}

async function cvErrorFromThrown(e: any, id: number): Promise<IssueMatchError> {
    const status = e?.response?.status;
    if (status === 404) return notFound('COMICVINE', id);
    if (isCvRateLimited(status)) {
        await markSystemFlag('cv_rate_limit_time');
        return rateLimited('COMICVINE');
    }
    if (status === 401 || status === 403) return cvKeyRejected();
    return unreachable('COMICVINE');
}

async function lookupComicVine(id: number): Promise<ProviderIssueSummary> {
    const key = await cvApiKey();
    const url = `https://comicvine.gamespot.com/api/issue/4000-${id}/`;
    const opts = {
        params: { api_key: key, format: 'json', field_list: CV_ISSUE_FIELDS },
        headers: { 'User-Agent': 'Omnibus/1.0' },
        timeout: 10000,
    };

    let data: any;
    try {
        let res = await cachedCvGet(url, opts);
        if (res.cached && res.data?.status_code != null && Number(res.data.status_code) !== 1) {
            res = await cachedCvGet(url, opts, true);
        }
        data = res.data;
    } catch (e) {
        throw await cvErrorFromThrown(e, id);
    }

    if (!data || typeof data !== 'object') throw unreachable('COMICVINE');
    if (data.status_code != null) {
        const code = Number(data.status_code);
        if (code === 100) throw cvKeyRejected();
        if (code === 101) throw notFound('COMICVINE', id);
        if (code === 107) {
            await markSystemFlag('cv_rate_limit_time');
            throw rateLimited('COMICVINE');
        }
        if (code !== 1) throw unreachable('COMICVINE');
    }

    const r = data.results;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Number(r.id) !== id) throw notFound('COMICVINE', id);

    const seriesName: string | null = typeof r.volume?.name === 'string' && r.volume.name.trim() ? r.volume.name : null;
    const seriesId = r.volume?.id ? Number(r.volume.id) || null : null;
    const issueNumber = normalizeIssueNo(r.issue_number);
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const issueTitle = name && name !== seriesName && !/^Issue\s*#?\s*-?\d+$/i.test(name) ? name : null;
    const img = r.image || {};
    const rawImage = img.medium_url || img.small_url || img.super_url || img.thumb_url || null;
    const siteUrl = typeof r.site_detail_url === 'string' && r.site_detail_url.startsWith('https://comicvine.gamespot.com/')
        ? r.site_detail_url
        : providerIssueUrl('COMICVINE', id);

    return {
        provider: 'COMICVINE',
        issueId: id,
        seriesId,
        seriesName,
        seriesStartYear: null,
        publisher: null,
        issueNumber,
        issueTitle,
        coverDate: r.cover_date || null,
        storeDate: r.store_date || null,
        image: proxiedCover(rawImage),
        siteUrl,
        displayTitle: buildReadingListItemTitle(seriesName, issueNumber),
    };
}

async function lookupMetron(id: number): Promise<ProviderIssueSummary> {
    let s;
    try {
        s = await new MetronProvider().getIssueSummary(String(id));
    } catch (e: any) {
        const message = String(e?.message ?? '');
        if (message === 'METRON_NOT_CONFIGURED') throw notConfigured('METRON');
        if (message === 'METRON_RATE_LIMITED' || message === 'FATAL_RATE_LIMIT') {
            await markSystemFlag('metron_rate_limit_time');
            throw rateLimited('METRON');
        }
        if (message === 'METRON_INVALID_ID') {
            throw new IssueMatchError('INVALID_INPUT', 'Enter a positive numeric issue ID from the selected provider.', 400);
        }
        if (/HTTP Error: 40[13]/.test(message)) throw metronLoginRejected();
        throw unreachable('METRON');
    }
    if (!s) throw notFound('METRON', id);

    const seriesName = s.seriesName?.trim() ? s.seriesName : null;
    const issueNumber = normalizeIssueNo(s.number);
    return {
        provider: 'METRON',
        issueId: id,
        seriesId: s.seriesId,
        seriesName,
        seriesStartYear: s.seriesYearBegan,
        publisher: s.publisher,
        issueNumber,
        issueTitle: s.title && s.title !== seriesName ? s.title : null,
        coverDate: s.coverDate,
        storeDate: s.storeDate,
        image: proxiedCover(s.image),
        siteUrl: providerIssueUrl('METRON', id),
        displayTitle: buildReadingListItemTitle(seriesName, issueNumber),
    };
}

/**
 * The provider's view of one issue, or an IssueMatchError (status + code + user-facing message).
 * `issueId` must already be validated (parseProviderIssueId); it is re-checked here because it
 * is interpolated into a credentialed provider URL.
 */
export async function lookupProviderIssue(provider: MatchProvider, issueId: number): Promise<ProviderIssueSummary> {
    if (provider !== 'COMICVINE' && provider !== 'METRON') {
        throw new IssueMatchError('INVALID_INPUT', 'provider must be COMICVINE or METRON.', 400);
    }
    if (!Number.isSafeInteger(issueId) || issueId <= 0 || issueId > MAX_PROVIDER_ISSUE_ID) {
        throw new IssueMatchError('INVALID_INPUT', 'Enter a positive numeric issue ID from the selected provider.', 400);
    }

    const key = `${provider}:${issueId}`;
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value;
    if (hit) memo.delete(key);

    const value = provider === 'METRON' ? await lookupMetron(issueId) : await lookupComicVine(issueId);

    memo.delete(key);
    memo.set(key, { at: Date.now(), value });
    while (memo.size > MEMO_MAX_ENTRIES) {
        const oldest = memo.keys().next().value;
        if (oldest === undefined) break;
        memo.delete(oldest);
    }
    return value;
}
