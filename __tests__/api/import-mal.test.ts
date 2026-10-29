// __tests__/api/import-mal.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/reading-lists/import-mal/route';
import { processAutomationQueue } from '@/lib/automation';
import { JOB_PRIORITY } from '@/lib/job-priority';

const mocks = vi.hoisted(() => ({
    userFindUnique: vi.fn(),
    seriesFindMany: vi.fn(),
    requestFindFirst: vi.fn(),
    requestCreate: vi.fn().mockResolvedValue({ id: 'req_mal' }),
    readingListDeleteMany: vi.fn(),
    readingListCreate: vi.fn().mockResolvedValue({ id: 'list_mal' }),
    issueFindMany: vi.fn().mockResolvedValue([]),
    readingListItemCreateMany: vi.fn()
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findUnique: mocks.userFindUnique },
        series: { findMany: mocks.seriesFindMany },
        request: { findFirst: mocks.requestFindFirst, create: mocks.requestCreate },
        readingList: { deleteMany: mocks.readingListDeleteMany, create: mocks.readingListCreate },
        issue: { findMany: mocks.issueFindMany },
        readingListItem: { createMany: mocks.readingListItemCreateMany }
    }
}));

vi.mock('next-auth/next', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'user_1', role: 'ADMIN' } })
}));

vi.mock('@/lib/automation', () => ({ processAutomationQueue: vi.fn().mockResolvedValue(true) }));

global.fetch = vi.fn();

describe('API Route: MyAnimeList Import', () => {
    beforeEach(() => {
        mocks.userFindUnique.mockResolvedValue({ role: 'ADMIN', canRequest: true });
    });

    it('queues the missing manga as a bulk ask, behind a single request and ahead of the monitor', async () => {
        mocks.seriesFindMany.mockResolvedValue([{ id: 'series_aot', name: 'Attack on Titan' }]);
        mocks.requestFindFirst.mockResolvedValue(null);

        // One page of a public Jikan manga list: one title the library has, one it doesn't.
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: [
                    { status: 1, manga: { title: 'Shingeki no Kyojin', title_english: 'Attack on Titan' } },
                    { status: 1, manga: { title: 'Chainsaw Man', published: { prop: { from: { year: 2018 } } } } }
                ],
                pagination: { has_next_page: false }
            })
        } as unknown as Response);

        const res = await POST(new Request('http://localhost/api/reading-lists/import-mal', {
            method: 'POST',
            body: JSON.stringify({ username: 'testuser', requestMissing: true, isGlobal: false })
        }));
        const data = await res.json();

        expect(data.success).toBe(true);
        expect(data.message).toContain('Queued 1 missing');
        expect(processAutomationQueue).toHaveBeenCalledWith(
            [expect.objectContaining({ id: 'req_mal', name: 'Chainsaw Man', year: '2018', isManga: true })],
            JOB_PRIORITY.BULK
        );
    });
});
