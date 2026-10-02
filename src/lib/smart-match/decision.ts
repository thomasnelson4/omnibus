import { canonicalNumber, isAnnualFormat, isCollectedFormat, titleSimilarity, type Domain, type ExactId, type MatchEvidence, type ParsedSignals, type Provider } from './signals';

export interface Candidate {
    id: string; metadataSource: Provider; name: string; year?: number | null;
    publisher?: string; format?: string; run?: number; count?: number;
    image?: string | null; description?: string;
}
export interface MatchIssue {
    id: string; number: string; domain: Domain; date?: string | null;
}
export interface Details { candidate: Candidate; issues: MatchIssue[]; complete: boolean }
export interface Gateway {
    configured: Provider[];
    search(provider: Provider, title: string, page: number): Promise<{ candidates: Candidate[]; hasMore: boolean }>;
    details(candidate: Candidate, evidence: ParsedSignals[]): Promise<Details>;
    resolve(id: ExactId): Promise<string | null>;
}
export class MatchFailure extends Error {
    constructor(public kind: 'provider_error' | 'rate_limited' | 'deferred', message: string) { super(message); }
}
export interface EvaluatedCandidate {
    candidate: Candidate; similarity: number; score: number; positive: string[];
    contradictions: string[]; reasons: string[]; validated: boolean; exact: boolean;
}
export interface Decision {
    status: 'high' | 'medium' | 'low' | 'ambiguous' | 'not_found' | 'conflict' | 'provider_error' | 'rate_limited' | 'deferred' | 'ignored';
    confidence: 'high' | 'medium' | 'low';
    safeToAccept: boolean; autoAccept: boolean; selected?: Candidate; candidates: EvaluatedCandidate[];
    reasons: string[]; parsed: ParsedSignals; files: ParsedSignals[]; queries: string[];
}
export interface Policy { mode: string; threshold: number; provider: Provider; allowSearch?: boolean }

function seed(candidate: Candidate, evidence: MatchEvidence, exact = false): EvaluatedCandidate {
    const parsed = evidence.parsed;
    const similarity = Math.max(titleSimilarity(parsed.title, candidate.name), ...parsed.alternateTitles.map(t => titleSimilarity(t, candidate.name)));
    const e: EvaluatedCandidate = { candidate, similarity, score: similarity * .75, positive: [], contradictions: [], reasons: [], validated: false, exact };
    const all = [parsed, ...evidence.files];
    const hasAnnual = all.some(p => p.domain === 'annual');
    const hasCollected = all.some(p => p.domain === 'collected');
    const candidateText = candidate.name + ' ' + (candidate.format || '');
    const candidateDomain: Domain = isAnnualFormat(candidateText) ? 'annual' : isCollectedFormat(candidateText) ? 'collected' : 'regular';
    if (candidateDomain === 'annual' && !hasAnnual || candidateDomain === 'collected' && !hasCollected) e.contradictions.push(`Unexpected ${candidateDomain} edition`);
    if (parsed.domain === 'collected' && candidateDomain !== 'collected') e.contradictions.push('Collected format is not confirmed');
    for (const p of all) {
        if (p.seriesYear && candidate.year) {
            if (p.seriesYear.confidence === 'low') e.reasons.push('Scanned year has no confirmed series-start provenance');
            else if (Math.abs(p.seriesYear.value - candidate.year) > 1) e.contradictions.push(`Series start ${candidate.year} contradicts ${p.seriesYear.value} (${p.seriesYear.source})`);
            else e.positive.push('Series-start year agrees');
        }
        if (p.publisher && candidate.publisher && !/^(unknown|other)$/i.test(candidate.publisher)) {
            if (titleSimilarity(p.publisher.value.replace(/\bcomics\b/gi, ''), candidate.publisher.replace(/\bcomics\b/gi, '')) < .5) e.contradictions.push(`Publisher contradicts ${p.publisher.value}`);
            else e.positive.push('Publisher agrees');
        }
        if (p.run) {
            if (candidate.run && candidate.run !== p.run.value) e.contradictions.push(`Run volume contradicts ${p.run.value}`);
            else if (candidate.run) e.positive.push('Run volume agrees');
            else e.reasons.push('Provider does not confirm the run volume');
        }
    }
    if (candidateDomain !== 'regular' && candidateDomain === parsed.domain) e.positive.push('Edition format agrees');
    if (exact) {
        e.positive.push('Embedded provider identity');
        if (similarity < .4) e.contradictions.push('Embedded identity contradicts the local title');
    }
    return e;
}

export function validateCandidate(detail: Details, evidence: MatchEvidence, exact = false): EvaluatedCandidate {
    const e = seed(detail.candidate, evidence, exact);
    e.validated = true;
    for (const id of evidence.ids.filter(i => i.kind === 'issue' && i.provider === detail.candidate.metadataSource)) {
        const found = detail.issues.find(i => i.id === id.id);
        if (found && (id.issueNumber && canonicalNumber(found.number) !== id.issueNumber || id.domain && found.domain !== id.domain)) e.contradictions.push('Embedded issue ID contradicts the local issue number or domain');
        else if (!found) e.reasons.push('Embedded issue ID is not confirmed by the series issue list');
    }
    const samples = evidence.files.length ? evidence.files : [evidence.parsed];
    for (const file of samples) {
        if (!file.issue) { if (evidence.files.length) e.reasons.push(`Issue number unknown for ${file.title}`); continue; }
        const sameNumber = detail.issues.filter(i => canonicalNumber(i.number) === file.issue!.value);
        const issue = sameNumber.find(i => i.domain === file.domain);
        if (!issue) {
            if (sameNumber.length) e.contradictions.push(`Issue #${file.issue.value} is in a different numbering domain`);
            else if (detail.complete) e.contradictions.push(`Issue #${file.issue.value} does not exist in this series`);
            else e.reasons.push(`Issue #${file.issue.value} was not verified in the bounded issue lookup`);
            continue;
        }
        e.positive.push(`Issue #${file.issue.value} exists (${file.domain})`);
        if (file.publicationYear) {
            const year = Number(issue.date?.slice(0, 4));
            if (year) {
                if (Math.abs(year - file.publicationYear.value) > 1) e.contradictions.push(`Issue #${file.issue.value} publication ${year} contradicts ${file.publicationYear.value}`);
                else e.positive.push(`Issue #${file.issue.value} publication year agrees`);
            } else e.reasons.push(`Issue #${file.issue.value} has no provider publication date`);
        }
    }
    e.positive = [...new Set(e.positive)];
    e.contradictions = [...new Set(e.contradictions)];
    e.reasons = [...new Set(e.reasons)];
    const extra = (e.exact ? .2 : 0) + (e.positive.includes('Series-start year agrees') ? .1 : 0)
        + (e.positive.some(p => p.includes('exists')) ? .1 : 0) + (e.positive.some(p => p.includes('publication year agrees')) ? .15 : 0)
        + (e.positive.includes('Publisher agrees') ? .04 : 0) + (e.positive.includes('Edition format agrees') ? .04 : 0);
    e.score = Math.max(0, Math.min(1, e.score + extra - e.contradictions.length * .3));
    return e;
}

export function decide(evidence: MatchEvidence, candidates: EvaluatedCandidate[], policy: Policy, queries: string[] = []): Decision {
    candidates.sort((a, b) => b.score - a.score || `${a.candidate.metadataSource}:${a.candidate.id}`.localeCompare(`${b.candidate.metadataSource}:${b.candidate.id}`));
    const best = candidates[0];
    const plausible = candidates.filter(c => !c.contradictions.length && c.similarity >= .4);
    const lead = plausible[0];
    const runner = plausible[1];
    const gap = lead ? lead.score - (runner?.score || 0) : 0;
    let status: Decision['status'] = !best ? 'not_found' : !lead ? 'conflict' : lead.similarity < .7 ? 'low' : 'medium';
    const reasons = [...evidence.parsed.warnings];
    if (evidence.incomplete) reasons.push('Folder evidence exceeded the read limit or could not be read completely');
    if (lead) {
        const positiveIdentity = lead.exact || lead.positive.includes('Series-start year agrees') || lead.positive.some(p => p.includes('publication year agrees'));
        const uncertain = lead.reasons.some(r => r !== 'Scanned year has no confirmed series-start provenance') || [evidence.parsed, ...evidence.files].some(p => p.warnings.length > 0) || evidence.incomplete;
        if (runner && gap < .08) { status = 'ambiguous'; reasons.push('No clear lead over the runner-up'); }
        else if (lead.validated && positiveIdentity && !uncertain && lead.similarity >= Math.max(.9, policy.threshold)) status = 'high';
        else reasons.push('More positive evidence or manual review is required');
    }
    const safeToAccept = status === 'high' && policy.mode !== 'custom';
    const autoAccept = safeToAccept && !!lead && (lead.exact || policy.mode === 'trust' || policy.mode === 'auto' && lead.similarity >= .97);
    return { status, confidence: status === 'high' ? 'high' : ['medium', 'ambiguous'].includes(status) ? 'medium' : 'low', safeToAccept, autoAccept, selected: lead?.candidate, candidates: candidates.slice(0, 8), reasons, parsed: evidence.parsed, files: evidence.files, queries };
}

/** The UI and sweep both call this implementation. Adapters bound individual HTTP calls too. */
export async function evaluateMatch(evidence: MatchEvidence, gateway: Gateway, policy: Policy): Promise<Decision> {
    const evaluated = new Map<string, EvaluatedCandidate>();
    const found = new Map<string, Candidate>();
    const queries: string[] = [];
    const key = (c: Candidate) => `${c.metadataSource}:${c.id}`;
    const failures: string[] = [];
    try {
        const identities = new Map<Provider, Set<string>>();
        for (const id of evidence.ids.slice(0, 8)) {
            const seriesId = id.kind === 'series' ? id.id : await gateway.resolve(id);
            if (!seriesId) throw new MatchFailure('provider_error', `Embedded ${id.provider} issue identity could not be resolved`);
            if (!identities.has(id.provider)) identities.set(id.provider, new Set());
            identities.get(id.provider)!.add(seriesId);
        }
        if ([...identities.values()].some(ids => ids.size > 1)) {
            return { ...decide(evidence, [], policy), status: 'conflict', reasons: ['Conflicting embedded series IDs in the folder'] };
        }
        for (const [provider, ids] of identities) {
            if (!gateway.configured.includes(provider)) throw new MatchFailure('provider_error', `${provider} is not configured for embedded ID verification`);
            for (const id of ids) {
                const c: Candidate = { id, metadataSource: provider, name: evidence.parsed.title };
                evaluated.set(key(c), validateCandidate(await gateway.details(c, evidence.files.length ? evidence.files : [evidence.parsed]), evidence, true));
            }
        }
        if (identities.size) {
            const values = [...evaluated.values()];
            // Cross-provider IDs may refer to the same run; require metadata agreement before
            // treating them as corroboration rather than competing identities.
            if (values.length > 1) {
                const a = values[0], b = values[1];
                if (titleSimilarity(a.candidate.name, b.candidate.name) < .9 || a.candidate.year && b.candidate.year && Math.abs(a.candidate.year - b.candidate.year) > 1 || values.some(c => c.contradictions.length)) {
                    return { ...decide(evidence, values, policy), status: 'conflict', safeToAccept: false, autoAccept: false, reasons: ['Embedded provider IDs identify contradictory runs'] };
                }
                return decide(evidence, [values.find(v => v.candidate.metadataSource === policy.provider) || a], policy);
            }
            return decide(evidence, values, policy);
        }
        if (policy.allowSearch === false) return { ...decide(evidence, [], policy), status: 'medium', reasons: ['Name search requires admin review in this confidence mode'] };
        const providers = [policy.provider, ...gateway.configured.filter(p => p !== policy.provider)].filter(p => gateway.configured.includes(p));
        if (!providers.length) throw new MatchFailure('provider_error', 'No metadata provider is configured');
        const titles = [...new Set([evidence.parsed.title, ...evidence.parsed.alternateTitles])].slice(0, 3);
        let searches = 0;
        let details = 0;
        for (const provider of providers) {
            for (const title of titles) {
                for (let page = 1; page <= 2 && searches < 4; page++) {
                    const queryKey = `${provider}:${title.toLowerCase()}:${page}`;
                    if (queries.includes(queryKey)) continue;
                    queries.push(queryKey); searches++;
                    const result = await gateway.search(provider, title, page);
                    for (const c of result.candidates) found.set(key(c), c);
                    const shortlist = [...found.values()].map(c => seed(c, evidence)).sort((a, b) => b.score - a.score).filter(c => c.similarity >= .4 && !c.contradictions.length);
                    // Generate a bounded page pool before spending the detail budget on tied
                    // reboots. A unique strong first-page lead can still finish immediately.
                    const uniqueStrongLead = shortlist[0]?.similarity >= .9 && (!shortlist[1] || shortlist[0].score - shortlist[1].score >= .08);
                    const detailCap = page === 1 && result.hasMore && !uniqueStrongLead ? 0 : 4;
                    for (const c of shortlist.slice(0, detailCap)) {
                        if (evaluated.has(key(c.candidate)) || details >= 4) continue;
                        details++;
                        evaluated.set(key(c.candidate), validateCandidate(await gateway.details(c.candidate, evidence.files.length ? evidence.files : [evidence.parsed]), evidence));
                    }
                    const ranked = [...found.values()].map(c => evaluated.get(key(c)) || seed(c, evidence));
                    const decision = decide(evidence, ranked, policy, queries);
                    if (decision.safeToAccept) return decision;
                    if (!result.hasMore) break;
                }
                if (searches >= 4) break;
            }
        }
    } catch (error) {
        const failure = error instanceof MatchFailure ? error : new MatchFailure('provider_error', 'Provider request failed');
        failures.push(failure.message);
        return { ...decide(evidence, [...evaluated.values()], policy, queries), status: failure.kind, confidence: 'low', safeToAccept: false, autoAccept: false, reasons: failures };
    }
    return decide(evidence, [...found.values()].map(c => evaluated.get(key(c)) || seed(c, evidence)), policy, queries);
}
