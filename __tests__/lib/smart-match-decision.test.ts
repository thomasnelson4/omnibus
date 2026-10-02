import { describe, expect, it, vi } from 'vitest';
import fixtures from '../fixtures/smart-match-parser.json';
import { canonicalNumber, parseSignals, titleSimilarity, type MatchEvidence, type Provider } from '@/lib/smart-match/signals';
import { decide, evaluateMatch, MatchFailure, validateCandidate, type Candidate, type Details, type Gateway, type Policy } from '@/lib/smart-match/decision';

const policy: Policy = { provider: 'COMICVINE', mode: 'auto', threshold: .9 };
const candidate = (id = '1', year = 2016, name = 'Batman'): Candidate => ({ id, year, name, metadataSource: 'COMICVINE', publisher: 'DC Comics', count: 2 });
const evidence = (name = 'Batman 100 (2020)'): MatchEvidence => ({ parsed: parseSignals(name, 'filename'), files: [parseSignals(name, 'filename')], ids: [], incomplete: false });
const detail = (c = candidate(), date: string | null = '2020-01-01', number = '100'): Details => ({ candidate: c, complete: true, issues: [{ id: 'issue1', number, domain: 'regular', date }] });
function gateway(results: Candidate[] = [candidate()]): Gateway {
    return { configured: ['COMICVINE'], search: vi.fn(async () => ({ candidates: results, hasMore: false })), details: vi.fn(async c => detail(c)), resolve: vi.fn(async () => '1') };
}

describe('structured matching regression corpus', () => {
    it.each(fixtures)('$name ($kind)', f => {
        const result = parseSignals(f.name, f.kind as 'series' | 'filename', 'known' in f ? String(f.known) : undefined);
        expect(result.title).toBe(f.title);
        expect(result.domain).toBe(f.domain);
        expect(result.issue?.value).toBe('issue' in f ? f.issue : undefined);
        expect(result.publicationYear?.value).toBe('publicationYear' in f ? f.publicationYear : undefined);
        expect(result.seriesYear?.value).toBe('seriesYear' in f ? f.seriesYear : undefined);
        expect(result.run?.value).toBe('run' in f ? f.run : undefined);
    });
    it('retains release, publisher and collected identity evidence', () => {
        expect(parseSignals(fixtures[0].name, 'filename').releaseTags).toEqual(['Digital', 'Zone-Empire']);
        expect(parseSignals(fixtures[1].name, 'filename').publisher?.value).toBe('DC Comics');
        expect(parseSignals('Saga Compendium One TPB', 'filename')).toMatchObject({ title: 'Saga Compendium One', alternateTitles: ['Saga'], format: { value: 'Compendium' } });
    });
    it('retains a collected volume number and an alternate run interpretation', () => {
        expect(parseSignals('Saga Vol. 2 (2020)', 'filename')).toMatchObject({ title: 'Saga', domain: 'collected', issue: { value: '2', confidence: 'medium' } });
        expect(parseSignals('Saga Vol. 2 (2020)', 'filename').warnings).not.toHaveLength(0);
    });
    it.each(['0', '-001', '013½', '000.50', '012au'])('canonicalizes %s without inventing identity', n => {
        expect(canonicalNumber(canonicalNumber(n))).toBe(canonicalNumber(n));
    });
    it.each([['Batman Batman Batman', 'Batman'], ['Hack/Slash', 'Hack Slash'], ['Pokémon', 'Ｐｏｋéｍｏｎ'], ["Spider-Man’s", 'Spider Mans']])('bounded symmetric normalization %s / %s', (a, b) => {
        const similarity = titleSimilarity(a, b);
        expect(similarity).toBeGreaterThanOrEqual(0); expect(similarity).toBeLessThanOrEqual(1);
        expect(similarity).toBe(titleSimilarity(b, a));
    });
    it('never supplies confident #1 for a numberless filename or numeric series title', () => {
        expect(parseSignals('Kaiju No. 8', 'filename').issue).toBeUndefined();
        expect(parseSignals('Revolver', 'filename').issue).toBeUndefined();
    });
});

describe('issue evidence and confidence', () => {
    it('identifies an old run by issue publication date, independent of its start year', async () => {
        const result = await evaluateMatch(evidence(), gateway(), policy);
        expect(result).toMatchObject({ status: 'high', safeToAccept: true, autoAccept: true, selected: { id: '1', year: 2016 } });
    });
    it('does not turn a guessed scanned publication year into a reboot identity', async () => {
        const e = evidence();
        e.parsed.seriesYear = { value: 2020, source: 'scan', confidence: 'low' };
        const result = await evaluateMatch(e, gateway(), policy);
        expect(result.status).toBe('high'); expect(result.safeToAccept).toBe(true);
        expect(result.candidates[0].contradictions).toEqual([]);
    });
    it('equal reboot candidates remain ambiguous when both exact issue dates fit', async () => {
        const result = await evaluateMatch(evidence(), gateway([candidate('1', 2011), candidate('2', 2016)]), policy);
        expect(result.status).toBe('ambiguous'); expect(result.safeToAccept).toBe(false);
        expect(result.candidates).toHaveLength(2);
    });
    it('rejects the wrong issue date without comparing it with series start', async () => {
        const g = gateway([candidate('1', 2011), candidate('2', 2016)]);
        g.details = vi.fn(async c => detail(c, c.id === '1' ? '2012-01-01' : '2020-01-01'));
        const result = await evaluateMatch(evidence(), g, policy);
        expect(result.status).toBe('high'); expect(result.selected?.id).toBe('2');
    });
    it('issue count is not the maximum number', () => {
        const e = evidence('Batman 2400 (2020)');
        expect(validateCandidate(detail(candidate(), '2020-01-01', '2400'), e).contradictions).toEqual([]);
    });
    it.each(['-1', '0', '13.5', '12AU'])('checks exact issue identity %s', n => {
        expect(validateCandidate(detail(candidate(), '2020-01-01', n), evidence(`Batman #${n} (2020)`)).positive.some(p => p.includes('exists'))).toBe(true);
    });
    it('missing dates and incomplete provider pages are unknown rather than contradictions', () => {
        const e = evidence();
        const result = validateCandidate(detail(candidate(), null), e);
        expect(result.contradictions).toEqual([]); expect(result.reasons.join()).toContain('no provider publication date');
        expect(validateCandidate({ candidate: candidate(), complete: false, issues: [] }, e).contradictions).toEqual([]);
    });
    it('unknown issue numbers require manual review', async () => {
        const result = await evaluateMatch(evidence('Batman (2020)'), gateway(), policy);
        expect(result.safeToAccept).toBe(false);
    });
    it('never confidently accepts an annual without annual evidence', async () => {
        const result = await evaluateMatch(evidence(), gateway([candidate('1', 2016, 'Batman Annual')]), policy);
        expect(result.safeToAccept).toBe(false);
    });
    it('rejects numbering-domain and publisher contradictions', () => {
        const e = evidence('Batman Annual 100 (2020)');
        const validated = validateCandidate(detail(), e);
        expect(validated.contradictions.join()).toContain('numbering domain');
        const d = detail(); d.candidate.publisher = 'Marvel';
        expect(validateCandidate(d, evidence('Batman 100 (2020) (DC Comics)')).contradictions.join()).toContain('Publisher');
    });
    it('aggregate files can contradict an otherwise convincing candidate', async () => {
        const e = evidence(); e.files.push(parseSignals('Batman 001 (2011)', 'filename'));
        const result = await evaluateMatch(e, gateway(), policy);
        expect(result.safeToAccept).toBe(false);
    });
    it('custom mode never authorizes automation; confirm requires review for name search', async () => {
        const g = gateway();
        expect((await evaluateMatch(evidence(), g, { ...policy, mode: 'custom' })).autoAccept).toBe(false);
        expect((await evaluateMatch(evidence(), g, { ...policy, mode: 'confirm' })).autoAccept).toBe(false);
    });
});

describe('evidence-first identities and bounded fallbacks', () => {
    it('embedded IDs run before searches and contradictory file IDs block matching', async () => {
        const e = evidence(); e.ids = [{ provider: 'COMICVINE', kind: 'series', id: '1', source: 'later archive' }];
        const g = gateway();
        expect((await evaluateMatch(e, g, { ...policy, mode: 'confirm', allowSearch: false })).autoAccept).toBe(true);
        expect(g.search).not.toHaveBeenCalled();
        e.ids.push({ provider: 'COMICVINE', kind: 'series', id: '2', source: 'first archive' });
        expect((await evaluateMatch(e, g, policy)).status).toBe('conflict');
    });
    it('embedded issue IDs resolve first and cannot contradict local number/domain', async () => {
        const e = evidence(); e.ids = [{ provider: 'COMICVINE', kind: 'issue', id: 'issue1', source: 'notes', issueNumber: '1', domain: 'regular' }];
        const g = gateway();
        expect((await evaluateMatch(e, g, policy)).safeToAccept).toBe(false);
        expect(g.resolve).toHaveBeenCalledTimes(1); expect(g.search).not.toHaveBeenCalled();
    });
    it('conflicting cross-provider run IDs are rejected', async () => {
        const e = evidence(); e.ids = (['COMICVINE', 'METRON'] as Provider[]).map(provider => ({ provider, kind: 'series', id: '1', source: 'files' }));
        const g = gateway(); g.configured.push('METRON');
        g.details = vi.fn(async c => detail({ ...c, name: 'Batman', year: c.metadataSource === 'METRON' ? 2011 : 2016 }));
        expect((await evaluateMatch(e, g, policy)).status).toBe('conflict');
    });
    it('finds a correct later-page reboot after three plausible wrong page-one candidates', async () => {
        const g = gateway();
        g.search = vi.fn(async (_p, _q, page) => ({ candidates: page === 1 ? [candidate('1'), candidate('2'), candidate('3')] : [candidate('4')], hasMore: page === 1 }));
        g.details = vi.fn(async c => detail(c, c.id === '4' ? '2020-01-01' : '2012-01-01'));
        const result = await evaluateMatch(evidence(), g, policy);
        expect(result).toMatchObject({ status: 'high', selected: { id: '4' } });
        expect(g.details).toHaveBeenCalledTimes(4); expect(g.search).toHaveBeenCalledTimes(2);
    });
    it('tries a second configured provider on a miss and stops after a convincing match', async () => {
        const g = gateway(); g.configured.push('METRON');
        g.search = vi.fn(async p => ({ candidates: p === 'COMICVINE' ? [] : [{ ...candidate(), metadataSource: 'METRON' as const }], hasMore: false }));
        expect((await evaluateMatch(evidence(), g, policy)).selected?.metadataSource).toBe('METRON');
        expect(g.search).toHaveBeenCalledTimes(2);
    });
    it('deduplicates candidates, alternate queries and caps pages/searches', async () => {
        const e = evidence(); e.parsed.alternateTitles = ['Batman', 'Batman', 'Batman Comic', 'Batman Story'];
        const g = gateway(); g.search = vi.fn(async () => ({ candidates: [candidate(), candidate()], hasMore: true }));
        g.details = vi.fn(async c => detail(c, null));
        const result = await evaluateMatch(e, g, policy);
        expect(result.queries.length).toBeLessThanOrEqual(4); expect(g.details).toHaveBeenCalledTimes(1);
        expect(result.candidates).toHaveLength(1);
    });
    it.each(['provider_error', 'rate_limited', 'deferred'] as const)('distinguishes %s from a true miss and halts calls', async kind => {
        const g = gateway(); g.search = vi.fn(async () => { throw new MatchFailure(kind, 'test failure'); });
        expect((await evaluateMatch(evidence(), g, policy)).status).toBe(kind);
        expect(g.search).toHaveBeenCalledTimes(1);
    });
    it('an unconfigured provider is a configuration failure rather than not found', async () => {
        const g = gateway(); g.configured = [];
        expect((await evaluateMatch(evidence(), g, policy)).status).toBe('provider_error');
    });
    it('selected identity is explicit even when a rejected candidate sorts ahead', () => {
        const e = evidence();
        const accepted = validateCandidate(detail(candidate('2')), e);
        const rejected = { ...accepted, candidate: candidate('1'), score: 1, contradictions: ['wrong format'] };
        expect(decide(e, [rejected, accepted], policy).selected?.id).toBe('2');
    });
});
