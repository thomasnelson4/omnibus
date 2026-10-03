// __tests__/lib/reading-list-links.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findLocalIssueForMatch, linkAccessForList, rowIdentityMismatch } from '@/lib/reading-list-links';
import { loggerLog } from '../helpers/setup-global';

const mocks = vi.hoisted(() => ({
    issueFindMany: vi.fn(),
    userFindUnique: vi.fn(),
    access: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findMany: mocks.issueFindMany },
        user: { findUnique: mocks.userFindUnique },
    },
}));
vi.mock('@/lib/library-access', async (orig) => ({
    ...(await orig<typeof import('@/lib/library-access')>()),
    getAccessibleLibraryIds: mocks.access,
}));

const match = { seriesId: 2133, issueNumber: '141' };
const row = (over: Record<string, any> = {}) => ({
    id: 'iss_1', number: '141', filePath: '/c/x141.cbz', isAnnual: false, attachedVolumeId: null, attachedVolume: null,
    createdAt: new Date('2024-01-01'),
    series: { id: 'ser_1', name: 'Uncanny X-Men', metadataId: '2133', metadataSource: 'COMICVINE' },
    ...over,
});

describe('findLocalIssueForMatch', () => {
    beforeEach(() => {
        mocks.issueFindMany.mockResolvedValue([]);
    });

    it('queries the provider id within the given libraries', async () => {
        await findLocalIssueForMatch('COMICVINE', 20288, match, ['lib1']);
        const args = mocks.issueFindMany.mock.calls[0][0];
        expect(args.where).toEqual({ metadataId: '20288', metadataSource: 'COMICVINE', series: { libraryId: { in: ['lib1'] } } });
        expect(args.orderBy).toEqual({ createdAt: 'asc' });
        expect(args.take).toBe(20);
        expect(args.select.attachedVolume).toEqual({ select: { volumeId: true, metadataSource: true } });
    });

    it('has no library filter for ALL', async () => {
        await findLocalIssueForMatch('METRON', 4521, match, 'ALL');
        const { where } = mocks.issueFindMany.mock.calls[0][0];
        expect(where).toEqual({ metadataId: '4521', metadataSource: 'METRON' });
        expect(where).not.toHaveProperty('series');
    });

    it('prefers a file-backed row over an older wanted row', async () => {
        mocks.issueFindMany.mockResolvedValue([
            row({ id: 'wanted', filePath: null }),
            row({ id: 'owned', filePath: '/c/x141.cbz' }),
        ]);
        await expect(findLocalIssueForMatch('COMICVINE', 20288, match, 'ALL')).resolves.toEqual({
            local: { issueId: 'owned', seriesId: 'ser_1', seriesName: 'Uncanny X-Men', number: '141', hasFile: true },
            mislabeled: null,
        });
    });

    it('links a wanted-only row with hasFile false (blank paths are not files)', async () => {
        mocks.issueFindMany.mockResolvedValue([row({ id: 'w1', filePath: '  ' }), row({ id: 'w2', filePath: null })]);
        const { local } = await findLocalIssueForMatch('COMICVINE', 20288, match, 'ALL');
        expect(local).toMatchObject({ issueId: 'w1', hasFile: false });
    });

    it('returns nothing when no row is tagged', async () => {
        await expect(findLocalIssueForMatch('COMICVINE', 20288, match, 'ALL')).resolves.toEqual({ local: null, mislabeled: null });
    });

    describe('identity guard (#194)', () => {
        it('drops a row whose number disagrees and reports it as mislabeled', async () => {
            mocks.issueFindMany.mockResolvedValue([row({ id: 'bad', number: '142' })]);
            await expect(findLocalIssueForMatch('COMICVINE', 20288, match, 'ALL')).resolves.toEqual({
                local: null,
                mislabeled: { seriesName: 'Uncanny X-Men', number: '142' },
            });
            expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('Skipping mislabeled local issue bad'), 'warn');
        });

        it('keeps a good row next to a mislabeled one', async () => {
            mocks.issueFindMany.mockResolvedValue([row({ id: 'bad', number: '142' }), row({ id: 'good', filePath: null })]);
            await expect(findLocalIssueForMatch('COMICVINE', 20288, match, 'ALL'))
                .resolves.toEqual({ local: expect.objectContaining({ issueId: 'good', hasFile: false }), mislabeled: null });
        });

        it('drops a row whose series is a different provider volume', async () => {
            mocks.issueFindMany.mockResolvedValue([row({ series: { id: 'ser_9', name: 'X-Men', metadataId: '999', metadataSource: 'COMICVINE' } })]);
            const r = await findLocalIssueForMatch('COMICVINE', 20288, match, 'ALL');
            expect(r.local).toBeNull();
            expect(r.mislabeled).toEqual({ seriesName: 'X-Men', number: '141' });
        });

        it('keeps an attached-lane row: anchored to the attached volume, number not compared', async () => {
            mocks.issueFindMany.mockResolvedValue([row({
                id: 'lane', number: '7', attachedVolumeId: 'av_1', attachedVolume: { volumeId: '2133', metadataSource: 'COMICVINE' },
                series: { id: 'ser_2', name: 'X-Men', metadataId: '4511', metadataSource: 'COMICVINE' },
            })]);
            const { local } = await findLocalIssueForMatch('COMICVINE', 20288, match, 'ALL');
            expect(local).toMatchObject({ issueId: 'lane', number: '7' });
        });

        it('drops an attached-lane row whose attached volume disagrees', async () => {
            mocks.issueFindMany.mockResolvedValue([row({
                number: '7', attachedVolumeId: 'av_1', attachedVolume: { volumeId: '5555', metadataSource: 'COMICVINE' },
            })]);
            expect((await findLocalIssueForMatch('COMICVINE', 20288, match, 'ALL')).local).toBeNull();
        });

        it('skips the parent check for an unattached annual but still checks the number', async () => {
            const annualSeries = { id: 'ser_1', name: 'X-Men', metadataId: '4511', metadataSource: 'COMICVINE' };
            mocks.issueFindMany.mockResolvedValue([row({ id: 'ann', isAnnual: true, number: '141', series: annualSeries })]);
            expect((await findLocalIssueForMatch('COMICVINE', 20288, match, 'ALL')).local).toMatchObject({ issueId: 'ann' });

            mocks.issueFindMany.mockResolvedValue([row({ id: 'ann', isAnnual: true, number: '2', series: annualSeries })]);
            expect((await findLocalIssueForMatch('COMICVINE', 20288, match, 'ALL')).local).toBeNull();
        });
    });
});

describe('rowIdentityMismatch', () => {
    const base = row();

    it('accepts the matching row', () => {
        expect(rowIdentityMismatch(base, 'COMICVINE', match)).toBeNull();
    });

    it('compares numbers canonically (fractions, leading zeros)', () => {
        expect(rowIdentityMismatch({ ...base, number: '013.5' }, 'COMICVINE', { seriesId: 2133, issueNumber: '13.5' })).toBeNull();
        expect(rowIdentityMismatch({ ...base, number: '13½' }, 'COMICVINE', { seriesId: 2133, issueNumber: '13.5' })).toBeNull();
    });

    it('ignores the series id when the series is matched to the other provider', () => {
        const metronSeries = { ...base.series, metadataId: '77', metadataSource: 'METRON' };
        expect(rowIdentityMismatch({ ...base, series: metronSeries }, 'COMICVINE', match)).toBeNull();
    });

    it('treats an unmatched_ series id as no evidence (number still checked)', () => {
        const unmatched = { ...base.series, metadataId: 'unmatched_abc', metadataSource: 'COMICVINE' };
        expect(rowIdentityMismatch({ ...base, series: unmatched }, 'COMICVINE', match)).toBeNull();
        expect(rowIdentityMismatch({ ...base, number: '9', series: unmatched }, 'COMICVINE', match)).toMatch(/issue #141/);
    });

    it('skips the parent check when the provider payload has no series id', () => {
        expect(rowIdentityMismatch({ ...base, series: { ...base.series, metadataId: '999' } }, 'COMICVINE', { seriesId: null, issueNumber: '141' })).toBeNull();
    });

    it('reports a volume mismatch', () => {
        expect(rowIdentityMismatch({ ...base, series: { ...base.series, metadataId: '999' } }, 'COMICVINE', match))
            .toBe('resolved to volume 2133 but the series is volume 999');
    });
});

describe('linkAccessForList', () => {
    beforeEach(() => {
        mocks.access.mockResolvedValue(['lib1']);
    });

    it("gives system lists ALL with no DB call", async () => {
        await expect(linkAccessForList({ userId: null }, { id: 'admin_1', role: 'ADMIN' })).resolves.toBe('ALL');
        expect(mocks.access).not.toHaveBeenCalled();
        expect(mocks.userFindUnique).not.toHaveBeenCalled();
    });

    it("uses the viewer's own access on their own list", async () => {
        await expect(linkAccessForList({ userId: 'user_1' }, { id: 'user_1', role: 'USER' })).resolves.toEqual(['lib1']);
        expect(mocks.access).toHaveBeenCalledWith('user_1', 'USER');
        expect(mocks.userFindUnique).not.toHaveBeenCalled();
    });

    it("uses the OWNER's access when someone else (even an admin) acts on the list", async () => {
        mocks.userFindUnique.mockResolvedValue({ role: 'USER' });
        mocks.access.mockResolvedValue(['lib2']);
        await expect(linkAccessForList({ userId: 'user_9' }, { id: 'admin_1', role: 'ADMIN' })).resolves.toEqual(['lib2']);
        expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { id: 'user_9' }, select: { role: true } });
        expect(mocks.access).toHaveBeenCalledWith('user_9', 'USER');
    });

    it('gives an admin owner ALL through getAccessibleLibraryIds', async () => {
        mocks.userFindUnique.mockResolvedValue({ role: 'ADMIN' });
        mocks.access.mockResolvedValue('ALL');
        await expect(linkAccessForList({ userId: 'admin_2' }, { id: 'user_1', role: 'USER' })).resolves.toBe('ALL');
        expect(mocks.access).toHaveBeenCalledWith('admin_2', 'ADMIN');
    });

    it('gives a missing owner no libraries', async () => {
        mocks.userFindUnique.mockResolvedValue(null);
        await expect(linkAccessForList({ userId: 'ghost' }, { id: 'admin_1', role: 'ADMIN' })).resolves.toEqual([]);
        expect(mocks.access).not.toHaveBeenCalled();
    });

    it('dedupes repeated owners through the cache', async () => {
        mocks.userFindUnique.mockResolvedValue({ role: 'USER' });
        const cache = new Map();
        const viewer = { id: 'user_1', role: 'USER' };
        await Promise.all([
            linkAccessForList({ userId: 'user_9' }, viewer, cache),
            linkAccessForList({ userId: 'user_9' }, viewer, cache),
            linkAccessForList({ userId: 'user_1' }, viewer, cache),
            linkAccessForList({ userId: 'user_1' }, viewer, cache),
        ]);
        expect(mocks.userFindUnique).toHaveBeenCalledTimes(1);
        expect(mocks.access).toHaveBeenCalledTimes(2);
    });
});
