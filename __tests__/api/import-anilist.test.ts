// __tests__/api/import-anilist.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/reading-lists/import-anilist/route';

const mocks = vi.hoisted(() => ({
    userFindUnique: vi.fn(),
    seriesFindMany: vi.fn(),
    requestFindFirst: vi.fn(),
    requestCreate: vi.fn().mockResolvedValue({ id: 'req_123' }),
    readingListDeleteMany: vi.fn(),
    readingListCreate: vi.fn().mockResolvedValue({ id: 'list_123' }),
    // Phase 4: a re-import reads the Komga links BEFORE deleteMany (they cascade with the list).
    komgaLinkFindMany: vi.fn().mockResolvedValue([]),
    issueFindMany: vi.fn().mockResolvedValue([]),
    readingListItemCreateMany: vi.fn(),
    log: vi.fn()
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findUnique: mocks.userFindUnique },
        series: { findMany: mocks.seriesFindMany },
        request: { findFirst: mocks.requestFindFirst, create: mocks.requestCreate },
        readingList: { deleteMany: mocks.readingListDeleteMany, create: mocks.readingListCreate },
        komgaReadListLink: { findMany: mocks.komgaLinkFindMany },
        issue: { findMany: mocks.issueFindMany },
        readingListItem: { createMany: mocks.readingListItemCreateMany }
    }
}));

vi.mock('next-auth/next', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'user_1', role: 'ADMIN' } })
}));

vi.mock('@/lib/automation', () => ({ processAutomationQueue: vi.fn().mockResolvedValue(true) }));

global.fetch = vi.fn();

describe('API Route: AniList Import', () => {
    beforeEach(() => {
        // Requester has the Request permission so auto-request-missing proceeds (gated in Phase 1).
        mocks.userFindUnique.mockResolvedValue({ role: 'ADMIN', canRequest: true });
    });

    it('should fuzzy match AniList titles to local series and queue missing ones', async () => {
        // Mock local database having "Attack on Titan"
        mocks.seriesFindMany.mockResolvedValue([
            { id: 'series_aot', name: 'Attack on Titan' }
        ]);

        // Mock AniList GraphQL Response (One matched, one missing)
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: {
                    MediaListCollection: {
                        lists: [{
                            name: "Reading",
                            entries: [
                                { media: { title: { english: "Attack on Titan", romaji: "Shingeki no Kyojin" } } },
                                { media: { title: { english: "Chainsaw Man" } } } // Missing locally
                            ]
                        }]
                    }
                }
            })
        } as any);

        mocks.requestFindFirst.mockResolvedValue(null); // Simulate no existing requests for missing manga

        const req = new Request('http://localhost/api/reading-lists/import-anilist', {
            method: 'POST',
            body: JSON.stringify({ username: 'testuser', requestMissing: true, isGlobal: false })
        });

        const res = await POST(req);
        const data = await res.json();

        expect(data.success).toBe(true);
        expect(data.message).toContain('Synced 1 manga');
        expect(data.message).toContain('Queued 1 missing');

        // Verify the matched series was put in a list
        expect(mocks.readingListCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ name: 'AniList: Reading', userId: 'user_1' })
        }));

        // Verify the missing series was requested
        expect(mocks.requestCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ activeDownloadName: 'Chainsaw Man' })
        }));
    });

    it('reads the Komga links before the re-import deletes the old list, and keeps komgaSync on', async () => {
        mocks.seriesFindMany.mockResolvedValue([{ id: 'series_aot', name: 'Attack on Titan' }]);
        mocks.komgaLinkFindMany.mockResolvedValue([{ readingListId: 'old_list', komgaReadListId: 'KL_OLD' }]);
        // mockResolvedValue, not Once: with clearMocks the base implementation is wiped between
        // tests, so a single-shot mock leaves later calls answering undefined and the route hangs.
        vi.mocked(global.fetch).mockResolvedValue({
            ok: true,
            json: async () => ({
                data: {
                    MediaListCollection: {
                        lists: [{
                            name: "Reading",
                            entries: [{ media: { title: { english: "Attack on Titan" } } }],
                        }],
                    },
                },
            }),
        } as any);
        mocks.requestFindFirst.mockResolvedValue(null);

        const req = new Request('http://localhost/api/reading-lists/import-anilist', {
            method: 'POST',
            body: JSON.stringify({ username: 'testuser', requestMissing: true, isGlobal: false }),
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        // The link lookup must happen while the rows still exist.
        expect(mocks.komgaLinkFindMany).toHaveBeenCalled();
        expect(mocks.komgaLinkFindMany.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.readingListDeleteMany.mock.invocationCallOrder[0]);
        // ...and the replacement inherits the sync opt-in so it adopts the old remote list.
        expect(mocks.readingListCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ komgaSync: true }),
        }));
    });
});