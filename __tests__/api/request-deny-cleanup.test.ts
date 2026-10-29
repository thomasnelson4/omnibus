// PATCH /api/request with CANCELLED (an admin denial) also deletes the series skeleton the request
// created, when nothing was downloaded and no other request still wants it. A bulk deny sends one
// PATCH per request in parallel; for several issues of the same series each PATCH saves its own
// CANCELLED, then each sees "no other active request" and deletes the series — every loser's
// `series.delete` threw P2025 (record not found) and answered 500 for a denial that had already
// been saved. That 500 was hidden behind the bulk action's unconditional success toast; once the
// dashboard reports failures honestly (found in the v1.4.7 permission sweep) it would show as a
// false failure. The cleanup must be safe to run twice.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getToken: vi.fn(),
    request: { findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
    series: { findFirst: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    issue: { count: vi.fn(), deleteMany: vi.fn() },
}));

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));
vi.mock('@/lib/db', () => ({ prisma: { request: mocks.request, series: mocks.series, issue: mocks.issue } }));
vi.mock('@/lib/automation', () => ({ searchAndDownload: vi.fn().mockResolvedValue(undefined), processAutomationQueue: vi.fn() }));
vi.mock('@/lib/trophy-evaluator', () => ({ evaluateTrophies: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/manga-detector', () => ({ detectManga: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/metadata-fetcher', () => ({ syncSeriesMetadata: vi.fn().mockResolvedValue(undefined) }));

import { PATCH } from '@/app/api/request/route';

const deny = (id: string) => PATCH(new NextRequest('http://localhost/api/request', {
    method: 'PATCH', body: JSON.stringify({ id, status: 'CANCELLED' }),
}));

// Prisma's "record to delete does not exist" — what a second delete of the same row throws.
const p2025 = () => Object.assign(new Error('An operation failed because it depends on one or more records that were required but not found. Record to delete does not exist.'), { code: 'P2025' });

describe('PATCH /api/request — denial cleanup of the series skeleton', () => {
    let seriesRows: Set<string>;

    beforeEach(() => {
        seriesRows = new Set(['ser-1']);
        mocks.getToken.mockResolvedValue({ id: 'admin-1', role: 'ADMIN', name: 'Admin' });
        mocks.request.findUnique.mockImplementation(async ({ where }: any) => ({
            id: where.id, userId: 'user-1', volumeId: '555', metadataSource: 'COMICVINE',
            activeDownloadName: `Batman #${where.id}`, downloadLink: null, createdAt: new Date(),
            user: { username: 'reader', email: null },
        }));
        mocks.request.update.mockResolvedValue({});
        mocks.request.count.mockResolvedValue(0); // the sibling denial already landed
        mocks.issue.count.mockResolvedValue(0);   // nothing downloaded
        mocks.issue.deleteMany.mockResolvedValue({ count: 3 });
        mocks.series.findFirst.mockResolvedValue({ id: 'ser-1' });
        mocks.series.delete.mockImplementation(async ({ where }: any) => {
            if (!seriesRows.delete(where.id)) throw p2025();
            return { id: where.id };
        });
        mocks.series.deleteMany.mockImplementation(async ({ where }: any) => ({ count: seriesRows.delete(where.id) ? 1 : 0 }));
    });

    it('removes the empty series skeleton on a denial', async () => {
        const res = await deny('1');
        expect(res.status).toBe(200);
        expect(seriesRows.has('ser-1')).toBe(false);
    });

    it('answers 200 for the second denial of the same series even though the first already removed it', async () => {
        // Both denials read the series before either deleted it — the parallel bulk-deny interleaving.
        const [a, b] = await Promise.all([deny('1'), deny('2')]);

        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(mocks.request.update).toHaveBeenCalledTimes(2);
        expect(seriesRows.has('ser-1')).toBe(false);
    });

    it('keeps the series when another request still wants it', async () => {
        mocks.request.count.mockResolvedValue(1);
        const res = await deny('1');
        expect(res.status).toBe(200);
        expect(seriesRows.has('ser-1')).toBe(true);
        expect(mocks.issue.deleteMany).not.toHaveBeenCalled();
    });
});
