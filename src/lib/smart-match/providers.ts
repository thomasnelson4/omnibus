import { apiClient } from '@/lib/api-client';
import { prisma } from '@/lib/db';
import { getCachedResponse, putCachedResponse, normalizeCacheUrl } from '@/lib/metadata/metadata-cache';
import { countApiUsage, logApiUsage, markSystemFlag } from '@/lib/utils/system-flags';
import { canonicalNumber, isAnnualFormat, isCollectedFormat, type Domain, type ExactId, type Provider } from './signals';
import { MatchFailure, type Candidate, type Details, type Gateway, type MatchIssue } from './decision';

const endpoints = { COMICVINE: 'https://comicvine.gamespot.com/api', METRON: 'https://metron.cloud/api' };
export const MAX_PROVIDER_REQUESTS = 16;
export const MATCH_DEADLINE_MS = 45_000;
const inflight = new Map<string, Promise<any>>();
// Serialize matching HTTP work across requests to keep usage checks + reservations coherent.
let providerTurn: Promise<unknown> = Promise.resolve();
const lastRequest = { COMICVINE: 0, METRON: 0 };
// Series type / per-issue format decide the numbering domain — never an issue's story title.
const domain = (text: string): Domain => isAnnualFormat(text) ? 'annual' : isCollectedFormat(text) ? 'collected' : 'regular';
const number = (v: unknown) => Number(v) || null;

function candidate(provider: Provider, data: any): Candidate {
    return {
        id: String(data.id), metadataSource: provider,
        name: provider === 'METRON' ? data.series || data.name || '' : data.name || '',
        year: number(provider === 'METRON' ? data.year_began : data.start_year),
        publisher: typeof data.publisher === 'string' ? data.publisher : data.publisher?.name || '',
        format: provider === 'METRON' ? data.series_type?.name || '' : '',
        run: number(data.volume) || undefined,
        count: number(data.issue_count ?? data.count_of_issues) || 0,
        image: data.image?.medium_url || (typeof data.image === 'string' ? data.image : null),
        description: data.deck || data.desc || '',
    };
}

export function createGateway(config: Record<string, string>, refresh: boolean, maxRequests = MAX_PROVIDER_REQUESTS): Gateway & { requests: () => number; urls: () => string[] } {
    const valid = (v?: string) => !!v && v !== '********' && !v.startsWith('enc:');
    const configured: Provider[] = [];
    if (valid(config.cv_api_key)) configured.push('COMICVINE');
    if (valid(config.metron_user) && valid(config.metron_pass)) configured.push('METRON');
    const blocked = (config.filter_foreign_publishers || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const allowed = (c: Candidate) => !blocked.some(p => (c.publisher || '').toLowerCase().includes(p));
    let requests = 0;
    const deadline = Date.now() + MATCH_DEADLINE_MS;
    const memo = new Map<string, Promise<any>>();
    const visited: string[] = [];

    async function get(provider: Provider, endpoint: string, params: Record<string, string | number> = {}): Promise<any> {
        if (!configured.includes(provider)) throw new MatchFailure('provider_error', `${provider} credentials are missing or invalid`);
        const url = new URL(endpoints[provider] + endpoint);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
        if (provider === 'COMICVINE') {
            url.searchParams.set('api_key', config.cv_api_key); url.searchParams.set('format', 'json');
        }
        const normalized = normalizeCacheUrl(url.toString());
        visited.push(normalized);
        if (memo.has(normalized)) return memo.get(normalized)!;
        const service = provider === 'COMICVINE' ? 'comicvine' : 'metron';
        const requestKey = `${normalized}:${refresh}:${config.smart_match_cache_epoch || ''}`;
        if (inflight.has(requestKey)) return inflight.get(requestKey)!;
        const work = providerTurn.catch(() => {}).then(async () => {
            if (Date.now() >= deadline) throw new MatchFailure('deferred', 'Matching deadline reached');
            if (!refresh) {
                const hit = await getCachedResponse(service, url.toString());
                if (hit !== null) return hit;
            } else {
                // Evict only this resource/query across field-list and paging variants, so the
                // manual dialog cannot immediately restore older metadata after a forced retry.
                const rows = await prisma.metadataCache.findMany({ where: { url: { startsWith: url.origin + url.pathname } }, select: { key: true, url: true } });
                const targetQuery = url.searchParams.get('query') ?? url.searchParams.get('name');
                const keys = rows.filter(r => {
                    const u = new URL(r.url);
                    return u.pathname === url.pathname && (targetQuery == null || (u.searchParams.get('query') ?? u.searchParams.get('name')) === targetQuery);
                }).map(r => r.key);
                if (keys.length) await prisma.metadataCache.deleteMany({ where: { key: { in: keys } } });
            }
            // Only live HTTP counts against the per-item cap: a cached body costs nothing, and a
            // zero budget (sweep freshness re-check) may still answer from cache but never from network.
            if (requests >= Math.min(MAX_PROVIDER_REQUESTS, Math.max(0, maxRequests))) throw new MatchFailure('deferred', 'Per-item provider request budget reached');
            requests++;
            // Reserve room for interactive work; both processes write these same counters.
            const used = await countApiUsage(service);
            if (used >= (provider === 'COMICVINE' ? 170 : 4_500)) throw new MatchFailure('deferred', `${provider} budget reserved for normal app work`);
            {
                const pause = Math.max(0, lastRequest[provider] + (provider === 'METRON' ? 1100 : 1000) - Date.now());
                if (Date.now() + pause >= deadline) throw new MatchFailure('deferred', 'Matching deadline reached');
                if (pause) await new Promise(r => setTimeout(r, pause));
                lastRequest[provider] = Date.now();
            }
            await logApiUsage(service, endpoint.split('/').slice(0, 2).join('/'));
            try {
                const res = await apiClient.get(url.toString(), {
                    timeout: Math.max(1, Math.min(8000, deadline - Date.now())),
                    ...(provider === 'METRON' ? { auth: { username: config.metron_user, password: config.metron_pass } } : {}),
                });
                if (provider === 'COMICVINE' && res.data?.status_code !== undefined && res.data.status_code !== 1) {
                    throw new MatchFailure('provider_error', 'ComicVine rejected the request');
                }
                const epoch = await prisma.systemSetting.findUnique({ where: { key: 'smart_match_cache_epoch' } });
                if ((epoch?.value || '') === (config.smart_match_cache_epoch || '')) await putCachedResponse(service, url.toString(), res.data);
                return res.data;
            } catch (error: any) {
                if ([420, 429].includes(error.response?.status)) {
                    await markSystemFlag(provider === 'COMICVINE' ? 'cv_rate_limit_time' : 'metron_rate_limit_time');
                    throw new MatchFailure('rate_limited', `${provider} rate limit reached; retry later`);
                }
                if (error instanceof MatchFailure) throw error;
                // Never return credential-bearing URLs or Axios configs in a decision/error.
                throw new MatchFailure('provider_error', `${provider} request failed${error.response?.status ? ` (HTTP ${error.response.status})` : ' or timed out'}`);
            }
        });
        providerTurn = work;
        inflight.set(requestKey, work);
        memo.set(normalized, work);
        try { return await work; } finally { inflight.delete(requestKey); }
    }

    return {
        configured, requests: () => requests, urls: () => visited,
        async search(provider, title, page) {
            const data = provider === 'COMICVINE'
                ? await get(provider, '/search/', { query: title.replace(/[\/\\]/g, ' '), resources: 'volume', limit: 40, page,
                    field_list: 'id,name,start_year,publisher,count_of_issues,image,deck' })
                : await get(provider, '/series/', { name: title, page });
            if (!Array.isArray(data?.results)) throw new MatchFailure('provider_error', `${provider} returned an invalid search response`);
            return { candidates: data.results.map((r: any) => candidate(provider, r)).filter(allowed),
                hasMore: provider === 'COMICVINE' ? page * 40 < data.number_of_total_results : !!data.next };
        },
        async resolve(id: ExactId) {
            if (id.kind === 'series') return id.id;
            const data = id.provider === 'COMICVINE'
                ? (await get(id.provider, `/issue/4000-${id.id}/`, { field_list: 'id,volume' })).results
                : await get(id.provider, `/issue/${id.id}/`);
            const resolved = data?.volume?.id ?? data?.series?.id ?? data?.series_id;
            return resolved == null ? null : String(resolved);
        },
        async details(c, evidence): Promise<Details> {
            const provider = c.metadataSource;
            const data = provider === 'COMICVINE'
                ? (await get(provider, `/volume/4050-${c.id}/`, { field_list: 'id,name,start_year,publisher,count_of_issues,image,issues' })).results
                : await get(provider, `/series/${c.id}/`);
            if (!data?.id) throw new MatchFailure('provider_error', `${provider} series details were not found`);
            const full = candidate(provider, data);
            if (!allowed(full)) throw new MatchFailure('provider_error', 'Publisher is excluded by matching policy');
            const issues: MatchIssue[] = [];
            let complete = true;
            if (provider === 'COMICVINE') {
                // Volume stubs contain exact numbers, not publication dates. Fetch only requested
                // strongest-file numbers, never infer a maximum from count_of_issues.
                const stubs = data.issues;
                if (!Array.isArray(stubs)) throw new MatchFailure('provider_error', 'ComicVine returned no issue list');
                const requested = [...new Set(evidence.flatMap(e => e.issue ? [e.issue.value] : []))];
                const matches = stubs.filter((i: any) => requested.includes(canonicalNumber(i.issue_number)));
                for (const stub of stubs) issues.push({ id: String(stub.id), number: stub.issue_number, domain: domain(full.name + ' ' + (full.format || '')) });
                for (const stub of matches.slice(0, 2)) {
                    const issue = (await get(provider, `/issue/4000-${stub.id}/`, { field_list: 'id,issue_number,cover_date,store_date,volume,name' })).results;
                    if (!issue || String(issue.volume?.id) !== c.id) throw new MatchFailure('provider_error', 'Issue detail identifies a different series');
                    const found = issues.find(i => i.id === String(stub.id));
                    if (found) found.date = issue.store_date || issue.cover_date || null;
                }
                if (matches.length > 2) complete = false;
            } else {
                let page = 1;
                while (page <= 2) {
                    const list = await get(provider, `/series/${c.id}/issue_list/`, { page });
                    if (!Array.isArray(list.results)) throw new MatchFailure('provider_error', 'Metron returned an invalid issue list');
                    for (const i of list.results) issues.push({ id: String(i.id), number: i.number, domain: domain(full.name + ' ' + (full.format || '') + ' ' + (i.format || '')), date: i.store_date || i.cover_date || null });
                    if (!list.next) break;
                    complete = false; page++;
                    if (page === 2) complete = true;
                }
            }
            return { candidate: full, issues, complete };
        },
    };
}
