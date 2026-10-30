// GET /api/setup-status - the first-run checklist's facts, computed live (System Health's cache can
// be a quarter of an hour old, and a checklist that still says "No library folder" right after you
// added one is worse than none). Admins get the steps; everyone else only learns whether their
// library is empty and whether they may request, so the page can tell them what to do next.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getServerSession } from 'next-auth/next';
import { pinPlatform } from '../helpers/platform';

const mocks = vi.hoisted(() => ({
    getAccessibleLibraryIds: vi.fn(),
    access: vi.fn(),
    prisma: {
        series: { count: vi.fn() },
        library: { findMany: vi.fn() },
        systemSetting: { findMany: vi.fn(), upsert: vi.fn() },
        user: { findUnique: vi.fn() },
        indexer: { count: vi.fn() },
        downloadClient: { count: vi.fn() },
    },
}));

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/library-access', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/library-access')>()),
    getAccessibleLibraryIds: mocks.getAccessibleLibraryIds,
}));
vi.mock('fs', () => {
    const m = { promises: { access: mocks.access }, constants: { F_OK: 0, W_OK: 2 } };
    return { ...m, default: m };
});

import { GET } from '@/app/api/setup-status/route';

const ADMIN = { user: { id: 'admin-1', role: 'ADMIN' } };
const USER = { user: { id: 'user-1', role: 'USER' } };

type Settings = Record<string, string>;
const withSettings = (values: Settings) => {
    mocks.prisma.systemSetting.findMany.mockImplementation(async (args?: { where?: { key?: { in?: string[] } } }) =>
        Object.entries(values)
            .filter(([key]) => !args?.where?.key?.in || args.where.key.in.includes(key))
            .map(([key, value]) => ({ key, value })));
};
// Series counts: the first call is the caller's library, the second (admins only) the unmatched ones.
const withSeries = (total: number, unmatched = 0) => {
    mocks.prisma.series.count.mockImplementation(async (args?: { where?: { matchState?: string } }) =>
        args?.where?.matchState === 'UNMATCHED' ? unmatched : total);
};
const READY: Settings = { cv_api_key: 'enc:v2:abc', last_popular_sync: '2026-10-13T10:00:00.000Z' };

const status = async () => {
    const res = await GET();
    return { status: res.status, body: await res.json() };
};
const step = (body: { steps: { id: string }[] }, id: string) => body.steps.find(s => s.id === id) as Record<string, unknown>;

let restorePlatform: () => void;
beforeEach(() => {
    vi.clearAllMocks();
    restorePlatform = pinPlatform('linux');
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(ADMIN);
    mocks.getAccessibleLibraryIds.mockResolvedValue('ALL');
    mocks.access.mockResolvedValue(undefined);
    mocks.prisma.library.findMany.mockResolvedValue([{ name: 'Comics', path: '/data/comics' }]);
    mocks.prisma.indexer.count.mockResolvedValue(0);
    mocks.prisma.downloadClient.count.mockResolvedValue(0);
    mocks.prisma.systemSetting.upsert.mockResolvedValue({});
    withSettings(READY);
    withSeries(12);
});
afterEach(() => restorePlatform());

describe('GET /api/setup-status', () => {
    it('answers 401 without a session', async () => {
        (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
        expect((await status()).status).toBe(401);
    });

    it('tells a regular user only whether their library is empty and whether they may request', async () => {
        (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(USER);
        mocks.getAccessibleLibraryIds.mockResolvedValue(['lib-1']);
        mocks.prisma.user.findUnique.mockResolvedValue({ canRequest: true });
        withSeries(0);

        const { status: code, body } = await status();

        expect(code).toBe(200);
        expect(body).toEqual({ role: 'USER', libraryEmpty: true, canRequest: true });
        // Counted within the libraries this user may see.
        expect(mocks.prisma.series.count).toHaveBeenCalledWith({ where: { libraryId: { in: ['lib-1'] } } });
        expect(mocks.prisma.library.findMany).not.toHaveBeenCalled();
    });

    it('shows a fresh install every required step undone, with the reason', async () => {
        mocks.prisma.library.findMany.mockResolvedValue([]);
        withSettings({});
        withSeries(0);

        const { body } = await status();

        expect(body.role).toBe('ADMIN');
        expect(body.completed).toBe(false);
        expect(body.libraryEmpty).toBe(true);
        expect(step(body, 'library')).toMatchObject({ required: true, done: false, detail: 'No library folder is set up yet.' });
        expect(step(body, 'metadata')).toMatchObject({ required: true, done: false });
        expect(step(body, 'comics')).toMatchObject({ required: true, done: false, count: 0 });
        expect(step(body, 'discover')).toMatchObject({ required: true, done: false });
        expect(step(body, 'sources')).toMatchObject({ required: false, done: false });
        expect(mocks.prisma.systemSetting.upsert).not.toHaveBeenCalled();
    });

    it('names a library path the server cannot use, and checks it before touching the disk', async () => {
        mocks.prisma.library.findMany.mockResolvedValue([{ name: 'Comics', path: 'C:\\Comics' }]);

        const { body } = await status();

        expect(step(body, 'library')).toMatchObject({ done: false, detail: expect.stringContaining('Library "Comics": "C:\\Comics" is a Windows path') });
        expect(mocks.access).not.toHaveBeenCalled();
    });

    it('says when a library folder is missing or read-only', async () => {
        mocks.access.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        expect(step((await status()).body, 'library')).toMatchObject({ done: false, detail: 'Library "Comics": /data/comics doesn\'t exist on the server.' });

        mocks.access.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
        expect(step((await status()).body, 'library')).toMatchObject({ done: false, detail: 'Library "Comics": Omnibus can\'t write to /data/comics.' });
    });

    it('accepts Metron credentials instead of a ComicVine key', async () => {
        withSettings({ metron_api_token: 'enc:v2:tok', last_popular_sync: '2026-10-13T10:00:00.000Z' });
        expect(step((await status()).body, 'metadata')).toMatchObject({ done: true });
    });

    it('offers the Smart Matcher only as an optional step, with the count', async () => {
        withSeries(12, 3);
        expect(step((await status()).body, 'match')).toMatchObject({ required: false, done: false, count: 3 });
    });

    it('counts an indexer or a download client as the optional extra source', async () => {
        mocks.prisma.downloadClient.count.mockResolvedValue(1);
        expect(step((await status()).body, 'sources')).toMatchObject({ required: false, done: true });
    });

    it('marks setup complete once every required step is done - and remembers it', async () => {
        const { body } = await status();

        expect(body.completed).toBe(true);
        expect(mocks.prisma.systemSetting.upsert).toHaveBeenCalledWith({
            where: { key: 'first_run_completed' },
            update: { value: 'true' },
            create: { key: 'first_run_completed', value: 'true' },
        });
    });

    it('stays complete once remembered, even if a step comes undone later (System Health covers that)', async () => {
        withSettings({ first_run_completed: 'true' });
        withSeries(0);

        const { body } = await status();

        expect(body.completed).toBe(true);
        expect(step(body, 'comics')).toMatchObject({ done: false });
        expect(mocks.prisma.systemSetting.upsert).not.toHaveBeenCalled();
    });

    it('reports a dismissed checklist', async () => {
        withSettings({ hide_first_steps_banner: 'true' });
        withSeries(0);
        expect((await status()).body.dismissed).toBe(true);
    });
});
