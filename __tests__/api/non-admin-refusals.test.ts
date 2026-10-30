// A signed-in non-admin asking for an admin-only action is FORBIDDEN (403), not UNAUTHENTICATED (401).
// Since #204 the client reads a 401 from our /api as "your session may have ended", so these routes
// answering a regular user's valid session with 401 is how the Library page's read of the admin
// settings signed every non-admin out (2026-10-12). 401 stays for "no session at all".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getServerSession: vi.fn(), getToken: vi.fn() }));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));
// A refusal must never reach the database; every model call fails loudly if one does.
vi.mock('@/lib/db', () => {
    const model = () => new Proxy({}, { get: () => vi.fn(async () => { throw new Error('a refusal touched the DB'); }) });
    return { prisma: { systemSetting: model(), trophy: model(), request: model(), user: model(), series: model(), library: model() } };
});
// The real queue module dials Redis at import time — never load it in a unit test.
vi.mock('@/lib/queue', () => ({ syncSchedules: vi.fn(), omnibusQueue: { add: vi.fn() } }));
vi.mock('@/lib/encryption', () => ({ encryptSecret: vi.fn(async (v: string) => v), decryptSecret: vi.fn(async (v: string) => v) }));
vi.mock('@/lib/annas-test', () => ({ testAnnasArchiveKey: vi.fn() }));
vi.mock('@/lib/automation', () => ({ searchAndDownload: vi.fn(), processAutomationQueue: vi.fn() }));
vi.mock('@/lib/trophy-evaluator', () => ({ evaluateTrophies: vi.fn() }));
vi.mock('@/lib/manga-detector', () => ({ detectManga: vi.fn() }));
vi.mock('@/lib/metadata-fetcher', () => ({ syncSeriesMetadata: vi.fn() }));
vi.mock('@/lib/metadata/providers/metron-cover', () => ({ getMetronCover: vi.fn() }));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: vi.fn() }));
vi.mock('@/lib/follows', () => ({ followSeries: vi.fn(), followSeriesByCatalogId: vi.fn() }));

import { GET as configGET } from '@/app/api/admin/config/route';
import { GET as trophiesGET, POST as trophiesPOST, DELETE as trophiesDELETE } from '@/app/api/trophies/route';
import { POST as repackPOST } from '@/app/api/library/repack/route';
import { POST as snoozePOST } from '@/app/api/request/snooze/route';
import { PATCH as requestPATCH } from '@/app/api/request/route';

const json = (path: string, method: string, body: unknown) =>
    new NextRequest(`http://localhost${path}`, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

const ROUTES: [string, () => Promise<Response>][] = [
    ['GET /api/admin/config (read by the Library + Series pages)', () => configGET(new Request('http://localhost/api/admin/config'))],
    ['GET /api/trophies', () => trophiesGET()],
    ['POST /api/trophies', () => trophiesPOST(json('/api/trophies', 'POST', { name: 'x', actionType: 'READ', targetValue: 1 }))],
    ['DELETE /api/trophies', () => trophiesDELETE(new Request('http://localhost/api/trophies?id=t1', { method: 'DELETE' }))],
    ['POST /api/library/repack', () => repackPOST(json('/api/library/repack', 'POST', { seriesIds: ['s1'] }))],
    ['POST /api/request/snooze', () => snoozePOST(json('/api/request/snooze', 'POST', { requestId: 'r1' }))],
    ['PATCH /api/request', () => requestPATCH(json('/api/request', 'PATCH', { id: 'r1', status: 'COMPLETED' }))],
];

describe('admin-only routes: a signed-in non-admin gets 403, a missing session gets 401', () => {
    beforeEach(() => vi.clearAllMocks());

    it.each(ROUTES)('%s — signed-in USER → 403', async (_name, call) => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1', role: 'USER' } });
        mocks.getToken.mockResolvedValue({ id: 'user_1', role: 'USER' });
        const res = await call();
        expect(res.status).toBe(403);
    });

    it.each(ROUTES)('%s — no session → 401', async (_name, call) => {
        mocks.getServerSession.mockResolvedValue(null);
        mocks.getToken.mockResolvedValue(null);
        const res = await call();
        expect(res.status).toBe(401);
    });
});
