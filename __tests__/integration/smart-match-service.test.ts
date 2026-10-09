// Real isolated SQLite + temporary archives; all provider operations are mocked.
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import AdmZip from 'adm-zip';
import { PrismaClient } from '@prisma/client';

const mocks = vi.hoisted(() => ({ prisma: null as any, root: '', roles: 'ADMIN', createGateway: vi.fn() }));
vi.mock('@/lib/db', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('@/lib/utils/paths', () => ({ get UNMATCHED_DIR() { return mocks.root; } }));
vi.mock('@/lib/smart-match/providers', () => ({ createGateway: mocks.createGateway }));
vi.mock('next-auth/next', () => ({ getServerSession: vi.fn(async () => ({ user: { role: mocks.roles, id: 'test-admin' } })) }));
import { collectEvidence, comicInfoEvidence } from '@/lib/smart-match/sources';
import { assertAutomaticMatch, decisionFingerprint, getMatchDecision } from '@/lib/smart-match/service';
import { DELETE as clearCache } from '@/app/api/admin/metadata-cache/route';
import { POST as adminScan } from '@/app/api/admin/smart-match/route';
import { POST as engineScan } from '@/app/api/internal/smart-match/route';
import { MatchFailure } from '@/lib/smart-match/decision';

let root: string;
let folder: string;
let calls = 0;
const request = (body: unknown, secret?: string) => new Request('http://fixture/api/internal/smart-match', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Internal-Secret': secret } : {}) }, body: JSON.stringify(body),
});
async function archive(file: string, tags: string) {
    const zip = new AdmZip(); zip.addFile('ComicInfo.xml', Buffer.from(`<ComicInfo>${tags}</ComicInfo>`));
    zip.writeZip(file);
}
async function setting(key: string, value: string) {
    await mocks.prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnibus-smart-match-'));
    mocks.root = root;
    const url = `file:${path.join(root, 'fixture.db')}`;
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 30_000,
    });
    mocks.prisma = new PrismaClient({ datasources: { db: { url } } });
    folder = path.join(root, 'Batman'); await fs.mkdir(folder);
}, 40_000);
afterAll(async () => { await mocks.prisma?.$disconnect(); await fs.rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
beforeEach(async () => {
    calls = 0; mocks.roles = 'ADMIN';
    await mocks.prisma.systemSetting.deleteMany(); await mocks.prisma.metadataCache.deleteMany();
    await mocks.prisma.series.deleteMany(); await mocks.prisma.library.deleteMany();
    for (const file of await fs.readdir(folder)) await fs.unlink(path.join(folder, file));
    await mocks.prisma.library.create({ data: { id: 'library', name: 'Fixture', path: root } });
    await mocks.prisma.series.create({ data: { id: 'series', name: 'Batman', year: 2020, publisher: 'DC Comics', folderPath: folder, libraryId: 'library' } });
    await archive(path.join(folder, 'Batman 100 (2020).cbz'), '<Series>Batman</Series><Number>100</Number><Year>2020</Year><Publisher>DC Comics</Publisher>');
    await setting('matcher_mode', 'auto'); await setting('cv_api_key', 'fake-test-key');
    mocks.createGateway.mockImplementation((_config: any, _refresh: boolean, maxRequests = 16) => ({
        configured: ['COMICVINE'], urls: () => ['https://comicvine.gamespot.com/api/issue/4000-100/'], requests: () => calls,
        search: vi.fn(async () => { if (!maxRequests) throw new MatchFailure('deferred', 'test budget'); calls++; return { candidates: [{ id: '1', name: 'Batman', metadataSource: 'COMICVINE', year: 2016, publisher: 'DC Comics' }], hasMore: false }; }),
        details: vi.fn(async () => { if (!maxRequests) throw new MatchFailure('deferred', 'test budget'); calls++; return { candidate: { id: '1', name: 'Batman', metadataSource: 'COMICVINE', year: 2016, publisher: 'DC Comics' }, complete: true, issues: [{ id: '100', number: '100', domain: 'regular', date: '2020-02-01' }] }; }),
        resolve: vi.fn(async () => { calls++; return '1'; }),
    }));
    vi.stubEnv('NEXTAUTH_SECRET', 'isolated-fixture-secret');
});

describe('shared server matching service', () => {
    it('admin scan and authenticated engine callback use identical selected identity/confidence', async () => {
        const ui = await (await adminScan(request({ itemId: 'series' }))).json();
        const engine = await (await engineScan(request({ itemId: 'series' }, 'isolated-fixture-secret'))).json();
        expect(ui).toMatchObject({ status: 'high', safeToAccept: true, selected: { id: '1', year: 2016 } });
        expect(engine).toMatchObject({ status: ui.status, selected: ui.selected, autoAccept: true, algorithmVersion: 'evidence-1' });
        expect(engine.fingerprint).not.toBe(ui.fingerprint); // purpose is part of the policy contract
    });
    it('authenticates both entry points before reading source evidence', async () => {
        mocks.roles = 'USER';
        expect((await adminScan(request({ itemId: 'series' }))).status).toBe(403);
        expect((await engineScan(request({ itemId: 'series' }, 'wrong-secret'))).status).toBe(401);
        expect(mocks.createGateway).not.toHaveBeenCalled();
    });
    it('caches/coalesces the decision and does not persist provider credentials', async () => {
        const [a, b] = await Promise.all([getMatchDecision('series'), getMatchDecision('series')]);
        expect(a.fingerprint).toBe(b.fingerprint); expect(mocks.createGateway).toHaveBeenCalledTimes(1);
        const cached = await getMatchDecision('series'); expect(cached.requests).toBe(0);
        expect(mocks.createGateway).toHaveBeenCalledTimes(1);
        const rows = await mocks.prisma.systemSetting.findMany({ where: { key: { startsWith: 'smart_match_v1_' } } });
        expect(JSON.stringify(rows)).not.toContain('fake-test-key');
    });
    it('keeps volatile API counters/job settings out of decision fingerprints', async () => {
        const first = await getMatchDecision('series');
        await setting('cv_api_usage', 'volatile'); await setting('last_unmatched_sweep', 'now');
        expect((await getMatchDecision('series')).fingerprint).toBe(first.fingerprint);
    });
    it('changed source metadata, policy and algorithm invalidate decisions', async () => {
        const first = await getMatchDecision('series');
        await setting('matcher_auto_threshold', '0.95');
        expect((await getMatchDecision('series')).fingerprint).not.toBe(first.fingerprint);
        await archive(path.join(folder, 'Batman 100 (2020).cbz'), '<Series>Batman</Series><Number>100</Number><Year>2011</Year>');
        const changed = await getMatchDecision('series'); expect(changed.fingerprint).not.toBe(first.fingerprint); expect(changed.safeToAccept).toBe(false);
        const e = await collectEvidence('series');
        expect(decisionFingerprint(e, {}, 'COMICVINE', 'ui')).not.toBe(decisionFingerprint(e, { matcher_mode: 'trust' }, 'COMICVINE', 'ui'));
    });
    it('expired decision and live TTL changes cause evaluation rather than browser reuse', async () => {
        const first = await getMatchDecision('series');
        await setting('smart_match_v1_' + first.fingerprint, JSON.stringify({ ...first, expiresAt: Date.now() - 1 }));
        await getMatchDecision('series'); expect(mocks.createGateway).toHaveBeenCalledTimes(2);
        await setting('metadata_cache_list_hours', '0.001');
        expect((await getMatchDecision('series')).expiresAt - Date.now()).toBeLessThanOrEqual(3600);
    });
    it('freshness callback with maxRequests=0 uses cached decisions and refuses changed evidence', async () => {
        const first = await getMatchDecision('series', { purpose: 'sweep' });
        const before = calls;
        const fresh = await (await engineScan(request({ itemId: 'series', expectedFingerprint: first.fingerprint, maxRequests: 0 }, 'isolated-fixture-secret'))).json();
        expect(fresh.autoAccept).toBe(true); expect(calls).toBe(before);
        await setting('matcher_mode', 'confirm');
        const stale = await (await engineScan(request({ itemId: 'series', expectedFingerprint: first.fingerprint, maxRequests: 0 }, 'isolated-fixture-secret'))).json();
        expect(stale.autoAccept).toBe(false); expect(calls).toBe(before);
    });
    it('refresh bypasses decision cache and clears only relevant formatted query/detail variants', async () => {
        await getMatchDecision('series');
        for (const key of ['search_v3_COMICVINE_batman_p1', 'search_v3_COMICVINE_batman_2020_p1', 'meta_details_v13_volume_COMICVINE_1', 'meta_details_v13_issue_COMICVINE_100', 'search_v3_COMICVINE_superman_p1']) await setting(key, 'old');
        await getMatchDecision('series', { refresh: true });
        expect(mocks.createGateway).toHaveBeenLastCalledWith(expect.any(Object), true, undefined);
        const keys = (await mocks.prisma.systemSetting.findMany()).map((s: any) => s.key);
        expect(keys).not.toContain('meta_details_v13_volume_COMICVINE_1'); expect(keys).not.toContain('meta_details_v13_issue_COMICVINE_100');
        expect(keys).not.toContain('search_v3_COMICVINE_batman_2020_p1'); expect(keys).toContain('search_v3_COMICVINE_superman_p1');
    });
    it('Clear Metadata Cache invalidates route caches and already-open decision tokens', async () => {
        const first = await getMatchDecision('series');
        for (const key of ['search_v3_COMICVINE_batman_p1', 'meta_details_v13_volume_COMICVINE_1', 'unrelated_cache']) await setting(key, 'old');
        expect((await clearCache()).status).toBe(200);
        expect((await getMatchDecision('series')).fingerprint).not.toBe(first.fingerprint);
        const keys = (await mocks.prisma.systemSetting.findMany()).map((s: any) => s.key);
        expect(keys).not.toContain('search_v3_COMICVINE_batman_p1'); expect(keys).toContain('unrelated_cache');
    });
    it('server validates identity/source tokens and refuses stale, ignored and ambiguous automatic accepts', async () => {
        const first = await getMatchDecision('series');
        const payload = { oldFolderPath: folder, metadataId: '1', metadataSource: 'COMICVINE', automaticMatch: { itemId: 'series', fingerprint: first.fingerprint, provider: 'COMICVINE' } };
        await expect(assertAutomaticMatch(payload)).resolves.toEqual({ itemId: 'series', provider: 'COMICVINE', fingerprint: first.fingerprint });
        await expect(assertAutomaticMatch({ ...payload, metadataId: '2' })).rejects.toThrow('stale');
        await mocks.prisma.series.update({ where: { id: 'series' }, data: { matchState: 'IGNORED' } });
        await expect(assertAutomaticMatch(payload)).rejects.toThrow('stale');
    });
    it('reads later archives, detects mixed folder IDs and preserves originating issue associations', async () => {
        await archive(path.join(folder, 'Batman 101 (2020).cbz'), '<Series>Batman</Series><Number>101</Number><Year>2020</Year><ComicVineVolumeId>2</ComicVineVolumeId><ComicVineIssueId>102</ComicVineIssueId>');
        await fs.writeFile(path.join(folder, 'series.json'), JSON.stringify({ metadata: { comicid: 1, publisher: 'Unknown' } }));
        const e = await collectEvidence('series');
        expect(e.ids).toContainEqual(expect.objectContaining({ id: '102', kind: 'issue', issueNumber: '101', domain: 'regular' }));
        expect(e.parsed.publisher?.value).toBe('DC Comics');
        expect((await getMatchDecision('series')).status).toBe('conflict');
    });
    it('a mis-tagged issue ID in a later archive is checked against that file\'s own number and blocks acceptance', async () => {
        // The provider says ID 100 is issue #100, but the later archive carrying ID 100 is issue #101.
        await archive(path.join(folder, 'Batman 101 (2020).cbz'), '<Series>Batman</Series><Number>101</Number><Year>2020</Year><ComicVineIssueId>100</ComicVineIssueId>');
        const decision = await getMatchDecision('series');
        expect(decision.safeToAccept).toBe(false);
        expect(decision.status).toBe('conflict');
        expect(decision.candidates[0].contradictions.join()).toContain('Embedded issue ID contradicts');
    });
    it('an embedded issue ID the bounded issue lookup cannot see stays unknown, not a confident success', async () => {
        // Same issue #100 twice (a re-release), the later copy tagged with an ID the provider list does not show.
        await archive(path.join(folder, 'Batman 100 (2020) (Digital).cbz'), '<Series>Batman</Series><Number>100</Number><Year>2020</Year><ComicVineIssueId>555</ComicVineIssueId>');
        const decision = await getMatchDecision('series');
        expect(decision.safeToAccept).toBe(false);
        expect(decision.candidates[0].contradictions).toEqual([]);
        expect(decision.candidates[0].reasons.join()).toContain('not confirmed by the series issue list');
    });
    it('unknown raw issue/metadata never defaults to confident #1 and rejects traversal IDs', async () => {
        const file = 'Revolver.cbz'; await archive(path.join(root, file), '<Series>Revolver</Series>');
        expect((await collectEvidence('raw_' + Buffer.from(file).toString('base64'))).parsed.issue).toBeUndefined();
        await expect(collectEvidence('raw_' + Buffer.from('../private.cbz').toString('base64'))).rejects.toThrow('Invalid');
    });
    it('ComicInfo Year and Volume have separate provenance and contradictory numbers stay visible', () => {
        const result = comicInfoEvidence({ Series: 'Batman', Number: '99', Year: '2020', Volume: '2016', ComicVineIssueId: '100' }, 'Batman #100 (2020).cbz');
        expect(result.parsed).toMatchObject({ publicationYear: { value: 2020 }, seriesYear: { value: 2016 } });
        expect(result.parsed.warnings.join()).toContain('contradicts');
        expect(result.ids[0]).toMatchObject({ issueNumber: '99', domain: 'regular' });
    });
});
