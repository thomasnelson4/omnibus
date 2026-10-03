import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runSystemHealthCheck } from '@/lib/health-checker';
import fs from 'fs-extra';

// 1. Hoist Mocks
const mocks = vi.hoisted(() => ({
    upsertSetting: vi.fn(),
    findManySettings: vi.fn(),
    findManyLibraries: vi.fn(),
    findManyRequests: vi.fn().mockResolvedValue([]),
    countDownloadClients: vi.fn().mockResolvedValue(1),
    komgaSyncStateFindMany: vi.fn().mockResolvedValue([]),
    komgaLibraryCount: vi.fn().mockResolvedValue(0),
    jobLogCount: vi.fn().mockResolvedValue(0),
    log: vi.fn(),
    sendAlert: vi.fn().mockResolvedValue(true),
    fetch: vi.fn()
}));

// 2. Mock Dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { 
            upsert: mocks.upsertSetting, 
            findMany: mocks.findManySettings 
        },
        library: { findMany: mocks.findManyLibraries },
        downloadClient: { count: mocks.countDownloadClients },
        request: { findMany: mocks.findManyRequests },
        // Komga: the health check reads these three DB-only (never calls Komga).
        komgaSyncState: { findMany: mocks.komgaSyncStateFindMany },
        komgaLibrary: { count: mocks.komgaLibraryCount },
        jobLog: { count: mocks.jobLogCount }
    }
}));


// Mock fs-extra (which the file uses instead of node:fs)
vi.mock('fs-extra', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(true),
        constants: { W_OK: 2, R_OK: 4 },
        promises: {
            access: vi.fn().mockResolvedValue(undefined),
            statfs: vi.fn()
        }
    }
}));

describe('System Health & Diagnostics', () => {
    beforeEach(() => {
        
        vi.stubGlobal('fetch', mocks.fetch);
        mocks.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false })
        });

        // Add ALL required settings to avoid secondary warnings
        mocks.findManySettings.mockResolvedValue([
            { key: 'cv_api_key', value: 'valid_key' },
            { key: 'download_path', value: '/downloads' },
            { key: 'last_backup_sync', value: Date.now().toString() },
            { key: 'cloudflare_block_time', value: '0' },
            { key: 'cv_rate_limit_time', value: '0' },
            { key: 'metron_rate_limit_time', value: '0' }
        ]);

        // Mock BOTH a standard library and a manga library to satisfy lines 85-88
        mocks.findManyLibraries.mockResolvedValue([
            { id: 'lib_1', name: 'Main', path: '/comics', isManga: false },
            { id: 'lib_2', name: 'Manga', path: '/manga', isManga: true }
        ]);
        
        // Ensure some download clients exist to satisfy line 161
        mocks.countDownloadClients.mockResolvedValue(1);
    });

    it('should return DEGRADED status when disk space is critically low (< 2GB)', async () => {
        // Mock 1.5GB free
        const bsize = 1024;
        const bavail = (1.5 * 1024 * 1024 * 1024) / bsize;

        vi.mocked(fs.promises.statfs).mockResolvedValue({ bsize, bavail } as any);

        const result = await runSystemHealthCheck();

        // status becomes 'DEGRADED' if any internal check status is 'error'
        expect(result.status).toBe('DEGRADED'); 
        
        const diskCheck = result.checks.find(c => c.id === 'disk_space');
        expect(diskCheck?.status).toBe('error');
        expect(diskCheck?.message).toContain('Critically full');

        // Verify database persistence for the UI flag
        expect(mocks.upsertSetting).toHaveBeenCalledWith(expect.objectContaining({
            where: { key: 'is_disk_full' },
            update: { value: 'true' }
        }));
    });

    it('warns while the Cloudflare solver is flagged unresponsive, and clears once the flag is stale', async () => {
        // 2026-07-26 field incident: a wedged FlareSolverr (nodriver loop crash, climbing task
        // queue) silently converted every gated download to manual. The engine's circuit breaker
        // stamps solver_unresponsive_time; the health panel must surface it with the remedy.
        vi.mocked(fs.promises.statfs).mockResolvedValue({ bsize: 1024, bavail: 10 * 1024 * 1024 * 1024 / 1024 } as any);
        const baseSettings = [
            { key: 'cv_api_key', value: 'valid_key' },
            { key: 'download_path', value: '/downloads' },
            { key: 'last_backup_sync', value: Date.now().toString() },
            { key: 'cloudflare_block_time', value: '0' },
            { key: 'flaresolverr_url', value: 'http://192.168.2.234:8191' },
        ];

        mocks.findManySettings.mockResolvedValue([
            ...baseSettings,
            { key: 'solver_unresponsive_time', value: (Date.now() - 5 * 60 * 1000).toString() }, // 5 min ago
        ]);
        let result = await runSystemHealthCheck();
        const warn = result.checks.find(c => c.id === 'solver_unresponsive');
        expect(warn?.status).toBe('warning');
        expect(warn?.message.toLowerCase()).toContain('restart');

        mocks.findManySettings.mockResolvedValue([
            ...baseSettings,
            { key: 'solver_unresponsive_time', value: (Date.now() - 2 * 60 * 60 * 1000).toString() }, // 2h ago — stale
        ]);
        result = await runSystemHealthCheck();
        const ok = result.checks.find(c => c.id === 'solver_unresponsive');
        expect(ok?.status).toBe('ok');
    });

    it('should return a warning when a library folder is read-only', async () => {
        // 10GB free (Healthy space)
        vi.mocked(fs.promises.statfs).mockResolvedValue({ 
            bsize: 1024, 
            bavail: 10 * 1024 * 1024 * 1024 / 1024 
        } as any);

        // Fail write access for the library path
        vi.mocked(fs.promises.access).mockImplementation((path) => {
            if (path === '/comics') return Promise.reject(new Error('EACCES'));
            return Promise.resolve();
        });

        const result = await runSystemHealthCheck();

        // Find check by ID or partial name
        const permCheck = result.checks.find(c => c.id.startsWith('lib_write_'));
        expect(permCheck?.status).toBe('warning');
        expect(permCheck?.message).toContain('read-only');
    });

    it('reports an unreachable engine as ERROR with the compose-upgrade hint (issue #187)', async () => {
        // Healthy disk so nothing else degrades the run.
        vi.mocked(fs.promises.statfs).mockResolvedValue({
            bsize: 1024,
            bavail: 10 * 1024 * 1024 * 1024 / 1024
        } as any);

        // The engine /health fetch dies the way undici reports a missing container ("fetch
        // failed") — the exact symptom of a v1.1.x compose file with no omnibus-engine service.
        mocks.fetch.mockImplementation((url: string) => {
            if (String(url).includes(':8000/health')) return Promise.reject(new TypeError('fetch failed'));
            return Promise.resolve({
                ok: true,
                json: async () => ({ currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false })
            });
        });

        const result = await runSystemHealthCheck();

        const engineCheck = result.checks.find(c => c.id === 'engine_version');
        expect(engineCheck?.status).toBe('error');
        // The message must be actionable: name the URL it tried and the v1.1.x compose cause.
        expect(engineCheck?.message).toContain('http://127.0.0.1:8000');
        expect(engineCheck?.message).toContain('omnibus-engine service');
        expect(engineCheck?.message).toContain('v1.1.x');
        // An unreachable engine degrades overall health — it is not a cosmetic warning.
        expect(result.status).toBe('DEGRADED');
    });

    describe('Engine handshake probe (prod incident 2026-07-20: secret mismatch read as healthy)', () => {
        const healthyDisk = () => {
            vi.mocked(fs.promises.statfs).mockResolvedValue({ bsize: 1024, bavail: 15 * 1024 * 1024 * 1024 / 1024 } as any);
            vi.mocked(fs.promises.access).mockResolvedValue(undefined);
        };

        // Route engine fetches: /health answers as a healthy dev build; the authed probe's
        // response is the variable under test. Everything else keeps the default update-check shape.
        const routeEngineFetches = (authProbe: { ok: boolean, status?: number }) => {
            mocks.fetch.mockImplementation((url: string) => {
                const u = String(url);
                if (u.includes('/api/health/auth')) return Promise.resolve({ ...authProbe, json: async () => ({ ok: authProbe.ok }) });
                if (u.includes(':8000/health')) return Promise.resolve({ ok: true, json: async () => ({ version: '1.0.0', release: false }) });
                return Promise.resolve({ ok: true, json: async () => ({ currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false }) });
            });
        };

        it('maps a 401 from the authed probe to a NEXTAUTH_SECRET-mismatch ERROR (engine up, jobs doomed)', async () => {
            healthyDisk();
            routeEngineFetches({ ok: false, status: 401 });

            const result = await runSystemHealthCheck();

            const auth = result.checks.find(c => c.id === 'engine_auth');
            expect(auth?.status).toBe('error');
            expect(auth?.message).toContain('NEXTAUTH_SECRET');
            expect(auth?.message).toContain('sha256sum');
            // The engine itself still reads as reachable — the mismatch is its own named failure.
            expect(result.checks.find(c => c.id === 'engine_version')?.status).toBe('ok');
            expect(result.status).toBe('DEGRADED');
        });

        it('verifies the handshake with a green entry when the authed probe returns 200', async () => {
            healthyDisk();
            routeEngineFetches({ ok: true, status: 200 });

            const result = await runSystemHealthCheck();

            const auth = result.checks.find(c => c.id === 'engine_auth');
            expect(auth?.status).toBe('ok');
            expect(result.status).toBe('HEALTHY');
        });

        it('renders NO handshake verdict for an older engine without the endpoint (404) — never a false alarm', async () => {
            healthyDisk();
            routeEngineFetches({ ok: false, status: 404 });

            const result = await runSystemHealthCheck();

            expect(result.checks.find(c => c.id === 'engine_auth')).toBeUndefined();
            expect(result.status).toBe('HEALTHY');
        });
    });

    it('should return HEALTHY status when all systems are green', async () => {
        // 15GB free
        vi.mocked(fs.promises.statfs).mockResolvedValue({ 
            bsize: 1024, 
            bavail: 15 * 1024 * 1024 * 1024 / 1024 
        } as any);
        
        vi.mocked(fs.promises.access).mockResolvedValue(undefined);

        const result = await runSystemHealthCheck();

        // If this still says WARNING, check result.checks to see which ID has the warning
        if (result.status !== 'HEALTHY') {
            console.log('Failing Checks:', result.checks.filter(c => c.status !== 'ok'));
        }

        expect(result.status).toBe('HEALTHY');
        
        expect(mocks.upsertSetting).toHaveBeenCalledWith(expect.objectContaining({
            where: { key: 'is_disk_full' },
            update: { value: 'false' }
        }));
    });

    describe('Stalled vs. Awaiting-availability (issue #175)', () => {
        beforeEach(() => {
            // Healthy disk + access so the only variable is the request state.
            vi.mocked(fs.promises.statfs).mockResolvedValue({ bsize: 1024, bavail: 15 * 1024 * 1024 * 1024 / 1024 } as any);
            vi.mocked(fs.promises.access).mockResolvedValue(undefined);
        });

        // Route the shared request.findMany mock by the status it's querying.
        const routeRequestsByStatus = (byStatus: Record<string, any[]>) => {
            mocks.findManyRequests.mockImplementation((args: any) => {
                const status = args?.where?.status;
                return Promise.resolve(byStatus[status] || []);
            });
        };

        it('flags genuinely STALLED imports as an error (DEGRADED)', async () => {
            routeRequestsByStatus({ STALLED: [{ id: 'r1', activeDownloadName: 'Broken Import #1' }] });
            const result = await runSystemHealthCheck();
            const stalled = result.checks.find(c => c.id === 'stalled_dls');
            expect(stalled?.status).toBe('error');
            expect(result.status).toBe('DEGRADED');
        });

        it('does NOT flag AWAITING_RELEASE items — reports them as informational ok', async () => {
            routeRequestsByStatus({ AWAITING_RELEASE: [{ id: 'r2', activeDownloadName: 'The Dogsitter #1' }] });
            const result = await runSystemHealthCheck();

            const awaiting = result.checks.find(c => c.id === 'awaiting_release');
            expect(awaiting?.status).toBe('ok');
            expect(awaiting?.details).toContain('The Dogsitter #1');

            // Stalled check stays green, and one "not out yet" item must not degrade the instance.
            expect(result.checks.find(c => c.id === 'stalled_dls')?.status).toBe('ok');
            expect(result.status).toBe('HEALTHY');
        });

        it('honors the flag_stalled_requests=false toggle (stalled no longer errors)', async () => {
            mocks.findManySettings.mockResolvedValueOnce([
                { key: 'cv_api_key', value: 'valid_key' },
                { key: 'download_path', value: '/downloads' },
                { key: 'last_backup_sync', value: Date.now().toString() },
                { key: 'cloudflare_block_time', value: '0' },
                { key: 'cv_rate_limit_time', value: '0' },
                { key: 'metron_rate_limit_time', value: '0' },
                { key: 'flag_stalled_requests', value: 'false' }
            ]);
            routeRequestsByStatus({ STALLED: [{ id: 'r1', activeDownloadName: 'Broken Import #1' }] });

            const result = await runSystemHealthCheck();
            const stalled = result.checks.find(c => c.id === 'stalled_dls');
            expect(stalled?.status).toBe('ok');
            expect(stalled?.message).toContain('disabled');
            expect(result.status).toBe('HEALTHY');
        });
    });

    describe('Komga (DB-only — no live HTTP call)', () => {
        beforeEach(() => {
            // The "Stalled vs. Awaiting-availability" describe above leaves a STALLED request in
            // its shared mock (clearMocks keeps implementations), which would make these
            // otherwise-green runs DEGRADED for a reason that has nothing to do with Komga.
            mocks.findManyRequests.mockResolvedValue([]);
        });

        const HOUR = 60 * 60 * 1000;
        const healthy = () => {
            vi.mocked(fs.promises.statfs).mockResolvedValue({ bsize: 1024, bavail: 15 * 1024 * 1024 * 1024 / 1024 } as any);
            vi.mocked(fs.promises.access).mockResolvedValue(undefined);
        };
        /** The base settings plus the Komga master switch. */
        const withKomga = (rows: { key: string, value: string }[] = []) => {
            mocks.findManySettings.mockResolvedValue([
                { key: 'cv_api_key', value: 'valid_key' },
                { key: 'download_path', value: '/downloads' },
                { key: 'last_backup_sync', value: Date.now().toString() },
                { key: 'cloudflare_block_time', value: '0' },
                { key: 'komga_enabled', value: 'true' },
                { key: 'komga_url', value: 'http://komga.internal:25600' },
                { key: 'komga_api_key', value: 'SUPER-SECRET-KEY' },
                ...rows,
            ]);
        };
        const syncState = (over: Record<string, any> = {}) => ({
            omnibusLibraryId: 'lib_1', consecutiveFailures: 0, lastError: null,
            lastReconciledAt: new Date(Date.now() - HOUR), ...over,
        });

        it('is entirely absent when the integration is disabled — and never touches its tables', async () => {
            healthy();
            mocks.findManySettings.mockResolvedValue([
                { key: 'cv_api_key', value: 'valid_key' },
                { key: 'download_path', value: '/downloads' },
                { key: 'last_backup_sync', value: Date.now().toString() },
            ]);

            const result = await runSystemHealthCheck();

            expect(result.checks.filter(c => c.id.startsWith('komga_'))).toHaveLength(0);
            expect(mocks.komgaSyncStateFindMany).not.toHaveBeenCalled();
            expect(mocks.komgaLibraryCount).not.toHaveBeenCalled();
            expect(mocks.jobLogCount).not.toHaveBeenCalled();
            expect(result.status).toBe('HEALTHY');
        });

        it('reports all-green entries when enabled and healthy', async () => {
            healthy();
            withKomga();
            mocks.komgaSyncStateFindMany.mockResolvedValue([syncState()]);
            mocks.komgaLibraryCount.mockResolvedValue(0);
            mocks.jobLogCount.mockResolvedValue(0);

            const result = await runSystemHealthCheck();

            const ids = ['komga_failures', 'komga_unmapped', 'komga_safety_valve', 'komga_reconcile_stale', 'komga_verify_giveups'];
            for (const id of ids) {
                expect(result.checks.find(c => c.id === id)?.status).toBe('ok');
            }
            expect(result.status).toBe('HEALTHY');
        });

        it('surfaces consecutiveFailures and lastError with the library name and a settings link', async () => {
            healthy();
            withKomga();
            mocks.komgaSyncStateFindMany.mockResolvedValue([
                syncState(),
                syncState({ omnibusLibraryId: 'lib_2', consecutiveFailures: 4, lastError: 'scan failed: Komga answered 500' }),
            ]);

            const result = await runSystemHealthCheck();

            const check = result.checks.find(c => c.id === 'komga_failures');
            expect(check?.status).toBe('warning');
            expect(check?.message).toContain('Manga');           // the library NAME, not the id
            expect(check?.message).toContain('4 consecutive failures');
            expect(check?.message).toContain('scan failed: Komga answered 500');
            expect(check?.actionLink).toBe('/admin/settings');
            expect(check?.details).toContain('Manga — 4 consecutive failure(s): scan failed: Komga answered 500');
            // A failing optional integration degrades nothing else.
            expect(result.checks.find(c => c.id === 'cf_block')?.status).toBe('ok');
        });

        it('warns on unmapped Komga libraries and on a tripped safety valve', async () => {
            healthy();
            withKomga();
            mocks.komgaLibraryCount.mockResolvedValue(2);
            mocks.komgaSyncStateFindMany.mockResolvedValue([
                syncState({ consecutiveFailures: 1, lastError: 'reconcile safety valve: Comics: Komga listed 0 books while 120 link(s) exist' }),
            ]);

            const result = await runSystemHealthCheck();

            const unmapped = result.checks.find(c => c.id === 'komga_unmapped');
            expect(unmapped?.status).toBe('warning');
            expect(unmapped?.message).toContain('2 Komga libraries');

            const valve = result.checks.find(c => c.id === 'komga_safety_valve');
            expect(valve?.status).toBe('warning');
            // The prefix the valve writes is stripped from the detail, not shown twice.
            expect(valve?.details?.[0]).toBe('Main: Comics: Komga listed 0 books while 120 link(s) exist');
            expect(valve?.details?.[0]).not.toContain('reconcile safety valve:');
            expect(valve?.actionLink).toBe('/admin/settings');
        });

        it('flags a map that has not been reconciled in 48 hours, and clears once it has', async () => {
            healthy();
            withKomga();

            mocks.komgaSyncStateFindMany.mockResolvedValue([syncState({ lastReconciledAt: new Date(Date.now() - 72 * HOUR) })]);
            let result = await runSystemHealthCheck();
            const stale = result.checks.find(c => c.id === 'komga_reconcile_stale');
            expect(stale?.status).toBe('warning');
            expect(stale?.message).toContain('over 48 hours');
            expect(stale?.message).toContain('72');

            mocks.komgaSyncStateFindMany.mockResolvedValue([syncState({ lastReconciledAt: new Date(Date.now() - 47 * HOUR) })]);
            result = await runSystemHealthCheck();
            expect(result.checks.find(c => c.id === 'komga_reconcile_stale')?.status).toBe('ok');
        });

        it('treats a map that has never reconciled as stale rather than silently fresh', async () => {
            healthy();
            withKomga();
            mocks.komgaSyncStateFindMany.mockResolvedValue([syncState({ lastReconciledAt: null })]);

            const result = await runSystemHealthCheck();
            const stale = result.checks.find(c => c.id === 'komga_reconcile_stale');
            expect(stale?.status).toBe('warning');
            expect(stale?.message).toContain('never completed');
        });

        it('counts verification give-ups in the last 24 hours via the shared message prefix', async () => {
            healthy();
            withKomga();

            mocks.jobLogCount.mockResolvedValue(3);
            const result = await runSystemHealthCheck();
            const giveUps = result.checks.find(c => c.id === 'komga_verify_giveups');
            expect(giveUps?.status).toBe('warning');
            expect(giveUps?.message).toContain('3 scan verifications');
            expect(giveUps?.message).toContain('.cb7');

            // The query must match the prefix verify.ts actually writes, and be windowed to 24 h.
            const arg = mocks.jobLogCount.mock.calls[0][0];
            expect(arg.where.jobType).toBe('KOMGA_SCAN');
            expect(arg.where.message.startsWith).toBe('Komga did not pick up');
            expect(arg.where.createdAt.gte).toBeInstanceOf(Date);
            const ageH = (Date.now() - arg.where.createdAt.gte.getTime()) / HOUR;
            expect(ageH).toBeGreaterThan(23.9);
            expect(ageH).toBeLessThan(24.1);
        });

        it('NEVER calls Komga over HTTP — the section is database-only', async () => {
            healthy();
            withKomga();
            mocks.komgaSyncStateFindMany.mockResolvedValue([syncState({ consecutiveFailures: 2, lastError: 'boom' })]);
            mocks.komgaLibraryCount.mockResolvedValue(1);
            mocks.jobLogCount.mockResolvedValue(1);

            const result = await runSystemHealthCheck();

            // The health check runs often, so a live probe here would be a latency and side-effect
            // bug. Only the app's own loopback update check and the engine may be contacted.
            const urls = mocks.fetch.mock.calls.map(([url]) => String(url));
            expect(urls.some(u => /komga/i.test(u))).toBe(false);
            expect(urls.some(u => u.includes('25600'))).toBe(false);
            // The configured key must not have leaked into the rendered panel either.
            const serialised = JSON.stringify(result);
            expect(serialised).not.toContain('SUPER-SECRET-KEY');
            expect(result.checks.filter(c => c.id.startsWith('komga_'))).toHaveLength(5);
        });

        it('survives a failure of the Komga read rather than failing the whole check', async () => {
            healthy();
            withKomga();
            mocks.komgaSyncStateFindMany.mockRejectedValue(new Error('no such table: KomgaSyncState'));

            const result = await runSystemHealthCheck();

            expect(result.checks.filter(c => c.id.startsWith('komga_'))).toHaveLength(0);
            expect(result.status).toBe('HEALTHY');
            expect(mocks.upsertSetting).toHaveBeenCalled();
        });
    });
});
