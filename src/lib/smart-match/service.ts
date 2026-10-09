import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { collectEvidence } from './sources';
import { createGateway } from './providers';
import { decide, evaluateMatch, type Decision, type Policy } from './decision';
import { MATCH_VERSION, type MatchEvidence, type Provider } from './signals';

export const DECISION_PREFIX = 'smart_match_v1_';
const SETTING_KEYS = ['cv_api_key', 'metron_user', 'metron_pass', 'filter_foreign_publishers', 'primary_metadata_source',
    'matcher_mode', 'matcher_auto_threshold', 'metadata_cache_enabled', 'metadata_cache_detail_days', 'metadata_cache_list_hours', 'smart_match_cache_epoch'];
export interface ServerDecision extends Decision {
    fingerprint: string; algorithmVersion: string; expiresAt: number; requests: number;
}
const inFlight = new Map<string, Promise<ServerDecision>>();
const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function settings() {
    const rows = await prisma.systemSetting.findMany({ where: { key: { in: SETTING_KEYS } } });
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
export function decisionFingerprint(evidence: MatchEvidence, config: Record<string, string>, provider: Provider, purpose: string): string {
    // Only relevant policy/settings are selected. Credential rotations change the opaque digest;
    // no key/password, API counter, job timestamp or unrelated setting is stored in the decision.
    return digest({ version: MATCH_VERSION, evidence: evidence.fingerprintData || evidence, config: SETTING_KEYS.map(k => [k, config[k]]), provider, purpose });
}
function decisionTtl(config: Record<string, string>, status: Decision['status']): number {
    const hours = Number(config.metadata_cache_list_hours) > 0 ? Number(config.metadata_cache_list_hours) : 12;
    const days = Number(config.metadata_cache_detail_days) > 0 ? Number(config.metadata_cache_detail_days) : 7;
    return Math.min(status === 'not_found' ? 60_000 : 15 * 60_000, hours * 3600_000, days * 86400_000);
}

export async function getMatchDecision(itemId: string, options: { provider?: Provider; refresh?: boolean; purpose?: 'ui' | 'sweep'; maxRequests?: number } = {}): Promise<ServerDecision> {
    const evidence = await collectEvidence(itemId, !!options.refresh);
    const config = await settings();
    const provider = options.provider || (config.primary_metadata_source === 'METRON' ? 'METRON' : 'COMICVINE');
    const purpose = options.purpose || 'ui';
    const policy: Policy = { provider, mode: config.matcher_mode || 'confirm', threshold: Math.max(.5, Math.min(1, Number(config.matcher_auto_threshold) || .9)),
        allowSearch: purpose === 'ui' || ['auto', 'trust'].includes(config.matcher_mode) };
    const fingerprint = decisionFingerprint(evidence, config, provider, purpose);
    const cacheKey = DECISION_PREFIX + fingerprint;
    const stamp = (d: Decision, requests = 0): ServerDecision => ({ ...d, fingerprint, algorithmVersion: MATCH_VERSION, expiresAt: Date.now() + decisionTtl(config, d.status), requests });
    if (evidence.ignored || policy.mode === 'custom') return stamp({ ...decide(evidence, [], policy), status: 'ignored', reasons: ['Automatic matching is disabled for this item or confidence mode'] });
    if (purpose === 'sweep' && evidence.locked) return stamp({ ...decide(evidence, [], policy), status: 'medium', reasons: ['Custom metadata requires explicit admin review'] });
    if (!options.refresh) {
        const row = await prisma.systemSetting.findUnique({ where: { key: cacheKey } });
        if (row) {
            try {
                const cached: ServerDecision = JSON.parse(row.value);
                if (cached.algorithmVersion === MATCH_VERSION && cached.fingerprint === fingerprint && cached.expiresAt > Date.now()) return { ...cached, requests: 0 };
            } catch {}
        }
    }
    // Refresh and ordinary reads cannot share an older request. Matching requests with the same
    // evidence coalesce in-process; force refresh bypasses every provider response read.
    const key = fingerprint + ':' + !!options.refresh;
    if (inFlight.has(key)) return inFlight.get(key)!;
    const work = (async (): Promise<ServerDecision> => {
        const gateway = createGateway(config, !!options.refresh, options.maxRequests);
        const result = stamp(await evaluateMatch(evidence, gateway, policy), gateway.requests());
        const current = await settings();
        if (decisionFingerprint(evidence, current, provider, purpose) !== fingerprint) return { ...result, status: 'deferred', safeToAccept: false, autoAccept: false, reasons: ['Matching settings or cache generation changed; retry'] };
        if (!['provider_error', 'rate_limited', 'deferred', 'ignored'].includes(result.status)) {
            await prisma.systemSetting.upsert({ where: { key: cacheKey }, update: { value: JSON.stringify(result) }, create: { key: cacheKey, value: JSON.stringify(result) } });
        }
        if (options.refresh) await invalidateFormattedMatchCaches(result, evidence, gateway.urls());
        return result;
    })();
    inFlight.set(key, work);
    try { return await work; } finally { inFlight.delete(key); }
}

async function invalidateFormattedMatchCaches(decision: Decision, evidence: MatchEvidence, urls: string[]): Promise<void> {
    const searchKeys = decision.queries.flatMap(q => {
        const provider = q.slice(0, q.indexOf(':'));
        const page = q.slice(q.lastIndexOf(':') + 1);
        const title = q.slice(provider.length + 1, q.lastIndexOf(':'));
        const years = [evidence.parsed.seriesYear?.value, evidence.parsed.publicationYear?.value, ...evidence.files.map(f => f.publicationYear?.value)].filter(Boolean);
        const variants = [title, ...years.flatMap(y => [`${title} ${y}`, `${title} (${y})`, `${title} [${y}]`])];
        return variants.map(t => `search_v3_${provider}_${t.toLowerCase().replace(/[^a-z0-9]/g, '_')}_p${page}`);
    });
    const details = decision.candidates.map(c => `meta_details_v13_volume_${c.candidate.metadataSource}_${c.candidate.id}`);
    for (const id of evidence.ids) details.push(`meta_details_v13_${id.kind === 'series' ? 'volume' : 'issue'}_${id.provider}_${id.id}`);
    for (const url of urls) {
        const u = new URL(url);
        const cv = u.pathname.match(/\/issue\/4000-(\d+)/);
        const metron = u.pathname.match(/\/issue\/(\d+)/);
        if (cv || metron) details.push(`meta_details_v13_issue_${cv ? 'COMICVINE' : 'METRON'}_${(cv || metron)![1]}`);
    }
    await prisma.systemSetting.deleteMany({ where: { key: { in: [...searchKeys, ...details] } } });
}

export interface AutomaticMatchToken { itemId: string; provider: Provider; fingerprint: string }

/** Called before ANY moves/writes. The browser cannot authorize its own confidence or freshness.
 *  Returns the verified token so the route can revalidate again at each mutation boundary. */
export async function assertAutomaticMatch(body: any): Promise<AutomaticMatchToken> {
    const automatic = body.automaticMatch;
    if (!automatic || typeof automatic.itemId !== 'string' || typeof automatic.fingerprint !== 'string') throw new Error('Automatic match requires a server decision');
    const provider: Provider = automatic.provider === 'METRON' ? 'METRON' : 'COMICVINE';
    const decision = await getMatchDecision(automatic.itemId, { provider });
    if (decision.fingerprint !== automatic.fingerprint || !decision.safeToAccept || !decision.selected ||
        String(body.metadataId ?? body.cvId) !== decision.selected.id || body.metadataSource !== decision.selected.metadataSource) {
        throw new Error('Suggestion is stale, ambiguous or unsafe; refresh or review the match manually');
    }
    const token: AutomaticMatchToken = { itemId: automatic.itemId, provider, fingerprint: decision.fingerprint };
    await revalidateAutomaticMatch(token, body);
    return token;
}

/** Cheap re-check for the moment right before a write: local source evidence (stat-cached) and the
 *  relevant settings only, never provider work. Provider/detail/collision reads between route entry
 *  and the first mutation can take seconds, during which the source or policy may have changed. */
export async function revalidateAutomaticMatch(token: AutomaticMatchToken, body: any): Promise<void> {
    const evidence = await collectEvidence(token.itemId);
    if (evidence.folderPath !== body.oldFolderPath || evidence.ignored) throw new Error('Match source changed; refresh before accepting');
    const config = await settings();
    if (decisionFingerprint(evidence, config, token.provider, 'ui') !== token.fingerprint) throw new Error('Match evidence changed during validation');
}
