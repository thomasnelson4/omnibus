import { describe, it, expect, vi, beforeEach } from 'vitest';

// changes.ts is the HOT PATH. The first test is the load-bearing one: it proves the module graph
// contains no queue/redis/HTTP layer. A single stray import of bullmq here would mean every one of
// the ~25 `void recordLibraryChange(...)` call sites opens a Redis connection on a user action.
const mocks = vi.hoisted(() => ({
    hotFlags: vi.fn(),
    libraryRootEntries: vi.fn(),
    seriesFindMany: vi.fn(),
    issueFindMany: vi.fn(),
    stateFindUnique: vi.fn(),
    stateUpsert: vi.fn(),
}));

vi.unmock('@/lib/komga/changes');

vi.mock('@/lib/komga/settings', () => ({ getKomgaHotFlags: mocks.hotFlags }));
vi.mock('@/lib/library-roots', () => ({ getLibraryRootEntries: mocks.libraryRootEntries }));
vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findMany: mocks.seriesFindMany },
        issue: { findMany: mocks.issueFindMany },
        komgaSyncState: { findUnique: mocks.stateFindUnique, upsert: mocks.stateUpsert },
    },
}));

import {
    recordLibraryChange,
    mergePendingPaths,
    resolveLibraryForPath,
} from '@/lib/komga/changes';
import { loggerLog } from '../../helpers/setup-global';

const LIBS = [
    { id: 'lib-a', path: '/data/manga' },
    { id: 'lib-b', path: '/data/manga/nested/deep' },
    { id: 'lib-c', path: '/data/comics' },
];

beforeEach(() => {
    mocks.hotFlags.mockResolvedValue({ enabled: true, scanOnChange: true, readListsEnabled: false });
    mocks.libraryRootEntries.mockResolvedValue(LIBS);
    mocks.seriesFindMany.mockResolvedValue([]);
    mocks.issueFindMany.mockResolvedValue([]);
    mocks.stateFindUnique.mockResolvedValue(null);
    mocks.stateUpsert.mockResolvedValue({});
});

describe('the hot path imports nothing that can block or do IO over the network', () => {
    it('has no queue, redis, client or factory in its module graph', async () => {
        // If any of these were imported (statically or lazily) the module would fail to load.
        for (const forbidden of ['bullmq', 'ioredis']) {
            vi.doMock(forbidden, () => { throw new Error(`hot path imported ${forbidden}`); });
        }
        await expect(import('@/lib/komga/changes')).resolves.toBeDefined();
    });

    it('resolves even when every dependency throws', async () => {
        mocks.hotFlags.mockRejectedValue(new Error('db down'));
        await expect(recordLibraryChange({ paths: ['/data/manga/a.cbz'], reason: 'import' })).resolves.toBeUndefined();
        expect(mocks.stateUpsert).not.toHaveBeenCalled();
    });

    it('never rejects when the upsert throws (callers use void, so this would be unhandled)', async () => {
        mocks.stateUpsert.mockRejectedValue(new Error('write failed'));
        await expect(recordLibraryChange({ paths: ['/data/manga/a.cbz'], reason: 'import' })).resolves.toBeUndefined();
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('recordLibraryChange failed'), 'debug');
    });
});

describe('the two gates', () => {
    it('does nothing when Komga is disabled', async () => {
        mocks.hotFlags.mockResolvedValue({ enabled: false, scanOnChange: true, readListsEnabled: false });
        await recordLibraryChange({ paths: ['/data/manga/a.cbz'], reason: 'import' });
        expect(mocks.libraryRootEntries).not.toHaveBeenCalled();
    });

    it('does nothing when scan-on-change is off', async () => {
        mocks.hotFlags.mockResolvedValue({ enabled: true, scanOnChange: false, readListsEnabled: false });
        await recordLibraryChange({ paths: ['/data/manga/a.cbz'], reason: 'import' });
        expect(mocks.libraryRootEntries).not.toHaveBeenCalled();
    });

    it('does nothing when there are no libraries', async () => {
        mocks.libraryRootEntries.mockResolvedValue([]);
        await recordLibraryChange({ paths: ['/data/manga/a.cbz'], reason: 'import' });
        expect(mocks.stateUpsert).not.toHaveBeenCalled();
    });

    it('does nothing for an empty change', async () => {
        await recordLibraryChange({ reason: 'import' });
        expect(mocks.stateUpsert).not.toHaveBeenCalled();
    });
});

describe('resolveLibraryForPath', () => {
    it('picks the library whose root contains the path', () => {
        expect(resolveLibraryForPath('/data/manga/Series/1.cbz', LIBS)).toBe('lib-a');
        expect(resolveLibraryForPath('/data/comics/Series/1.cbz', LIBS)).toBe('lib-c');
    });

    it('prefers the LONGEST matching root, so a nested library wins over its parent', () => {
        expect(resolveLibraryForPath('/data/manga/nested/deep/1.cbz', LIBS)).toBe('lib-b');
    });

    it('resolves the root itself', () => {
        expect(resolveLibraryForPath('/data/manga', LIBS)).toBe('lib-a');
    });

    it('respects the folder boundary', () => {
        // '/data/manga2' must NOT match the '/data/manga' root.
        expect(resolveLibraryForPath('/data/manga2/1.cbz', LIBS)).toBeNull();
    });

    it('returns null for a path outside every root', () => {
        expect(resolveLibraryForPath('/tmp/staging/1.cbz', LIBS)).toBeNull();
    });

    it('is case sensitive', () => {
        expect(resolveLibraryForPath('/DATA/MANGA/1.cbz', LIBS)).toBeNull();
    });

    it('rejects a traversal path', () => {
        expect(resolveLibraryForPath('/data/manga/../../etc/passwd', LIBS)).toBeNull();
    });

    it('handles a folder path, not just a file', () => {
        expect(resolveLibraryForPath('/data/comics/Some Series', LIBS)).toBe('lib-c');
    });

    it('treats / as a root containing everything', () => {
        expect(resolveLibraryForPath('/anything/at/all', [{ id: 'root', path: '/' }])).toBe('root');
    });
});

describe('mergePendingPaths', () => {
    it('returns null when there is nothing to store, so the column is cleared not set to "[]"', () => {
        expect(mergePendingPaths(null, [])).toEqual({ json: null, overflow: false });
        expect(mergePendingPaths('[]', [])).toEqual({ json: null, overflow: false });
    });

    it('merges new paths into the stored list, keeping order', () => {
        expect(mergePendingPaths(JSON.stringify(['/a/1.cbz']), ['/a/2.cbz']).json)
            .toBe(JSON.stringify(['/a/1.cbz', '/a/2.cbz']));
    });

    it('dedupes, including across a trailing slash and duplicate separators', () => {
        const { json } = mergePendingPaths(null, ['/a/1.cbz', '/a/1.cbz', '/a/1.cbz/']);
        expect(JSON.parse(json as string)).toEqual(['/a/1.cbz']);
    });

    it('caps the list and reports the overflow', () => {
        const many = Array.from({ length: 10 }, (_, i) => `/a/${i}.cbz`);
        const { json, overflow } = mergePendingPaths(null, many, 4);
        expect(JSON.parse(json as string)).toHaveLength(4);
        expect(overflow).toBe(true);
    });

    it('reports overflow once the cap is reached even if the extra path is a duplicate', () => {
        const { overflow } = mergePendingPaths(null, ['/a/1.cbz', '/a/1.cbz'], 1);
        expect(overflow).toBe(false);
    });

    it('normalizes each stored path, so a corrupt entry cannot poison the list', () => {
        const { json } = mergePendingPaths(null, ['/a//1.cbz', '/a/../b.cbz', '']);
        expect(JSON.parse(json as string)).toEqual(['/a/1.cbz']);
    });

    it('drops a corrupt stored column instead of throwing', () => {
        expect(mergePendingPaths('{not json', ['/a/1.cbz']).json).toBe(JSON.stringify(['/a/1.cbz']));
    });

    it('ignores non-strings in a stored column', () => {
        expect(mergePendingPaths('[1,"/a/1.cbz",null]', []).json).toBe(JSON.stringify(['/a/1.cbz']));
    });
});

describe('recordLibraryChange: path resolution', () => {
    it('marks the owning library dirty with the path', async () => {
        await recordLibraryChange({ paths: ['/data/manga/Series/1.cbz'], reason: 'import' });
        expect(mocks.stateUpsert).toHaveBeenCalledTimes(1);
        const arg = mocks.stateUpsert.mock.calls[0][0];
        expect(arg.where.omnibusLibraryId).toBe('lib-a');
        expect(JSON.parse(arg.create.pendingPaths)).toEqual(['/data/manga/Series/1.cbz']);
    });

    it('DROPS a path outside every root and does NOT mark anything dirty', async () => {
        // The deliberate narrowing of PLAN's wording: staging/unmatched writes are common, and
        // marking every library dirty for them would scan the whole server.
        await recordLibraryChange({ paths: ['/tmp/downloads/x.cbz'], reason: 'import' });
        expect(mocks.stateUpsert).not.toHaveBeenCalled();
    });

    it('records both the old and the new path of a rename in ONE upsert', async () => {
        await recordLibraryChange({ paths: ['/data/manga/S/old.cbz', '/data/manga/S/new.cbz'], reason: 'rename' });
        expect(mocks.stateUpsert).toHaveBeenCalledTimes(1);
        expect(JSON.parse(mocks.stateUpsert.mock.calls[0][0].create.pendingPaths))
            .toEqual(['/data/manga/S/old.cbz', '/data/manga/S/new.cbz']);
    });

    it('groups paths by library, one upsert each', async () => {
        await recordLibraryChange({ paths: ['/data/manga/a.cbz', '/data/comics/b.cbz'], reason: 'import' });
        expect(mocks.stateUpsert).toHaveBeenCalledTimes(2);
        const ids = mocks.stateUpsert.mock.calls.map(c => c[0].where.omnibusLibraryId).sort();
        expect(ids).toEqual(['lib-a', 'lib-c']);
    });

    it('records a folder path (series delete / relocate) as-is', async () => {
        await recordLibraryChange({ paths: ['/data/comics/Dead Series'], reason: 'series-delete' });
        expect(JSON.parse(mocks.stateUpsert.mock.calls[0][0].create.pendingPaths)).toEqual(['/data/comics/Dead Series']);
    });
});

describe('recordLibraryChange: series and issue ids', () => {
    it('uses a series libraryId directly', async () => {
        mocks.seriesFindMany.mockResolvedValue([{ id: 's1', libraryId: 'lib-c', folderPath: '/data/comics/S' }]);
        await recordLibraryChange({ seriesIds: ['s1'], reason: 'rename' });
        expect(mocks.stateUpsert.mock.calls[0][0].where.omnibusLibraryId).toBe('lib-c');
    });

    it('falls back to the series folderPath when libraryId is null', async () => {
        mocks.seriesFindMany.mockResolvedValue([{ id: 's1', libraryId: null, folderPath: '/data/comics/S' }]);
        await recordLibraryChange({ seriesIds: ['s1'], reason: 'rename' });
        expect(mocks.stateUpsert.mock.calls[0][0].where.omnibusLibraryId).toBe('lib-c');
    });

    it("adds an issue's own filePath to its series' library", async () => {
        mocks.issueFindMany.mockResolvedValue([
            { filePath: '/data/comics/S/1.cbz', series: { libraryId: 'lib-c', folderPath: '/data/comics/S' } },
        ]);
        await recordLibraryChange({ issueIds: ['i1'], reason: 'issue-move' });
        expect(mocks.stateUpsert.mock.calls[0][0].where.omnibusLibraryId).toBe('lib-c');
        expect(JSON.parse(mocks.stateUpsert.mock.calls[0][0].create.pendingPaths)).toEqual(['/data/comics/S/1.cbz']);
    });

    it('resolves an issue whose series has a null libraryId via its folderPath', async () => {
        mocks.issueFindMany.mockResolvedValue([
            { filePath: '/data/comics/S/1.cbz', series: { libraryId: null, folderPath: '/data/comics/S' } },
        ]);
        await recordLibraryChange({ issueIds: ['i1'], reason: 'issue-move' });
        expect(mocks.stateUpsert.mock.calls[0][0].where.omnibusLibraryId).toBe('lib-c');
    });

    it('ignores null/empty ids in the input', async () => {
        mocks.seriesFindMany.mockResolvedValue([{ id: 's1', libraryId: 'lib-a', folderPath: '/data/manga/S' }]);
        await recordLibraryChange({ seriesIds: ['s1', null, undefined, ''], reason: 'rename' });
        expect(mocks.seriesFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: { in: ['s1'] } } }),
        );
    });
});

describe('recordLibraryChange: the mark-all fallback', () => {
    it('marks EVERY library when ids cannot be classified at all', async () => {
        mocks.seriesFindMany.mockResolvedValue([]); // the rows are gone
        await recordLibraryChange({ seriesIds: ['gone'], reason: 'import' });
        expect(mocks.stateUpsert).toHaveBeenCalledTimes(LIBS.length);
        const ids = mocks.stateUpsert.mock.calls.map(c => c[0].where.omnibusLibraryId).sort();
        expect(ids).toEqual(['lib-a', 'lib-b', 'lib-c']);
    });

    it('marks all with NO paths, since none could be attributed', async () => {
        mocks.seriesFindMany.mockResolvedValue([]);
        await recordLibraryChange({ seriesIds: ['gone'], reason: 'import' });
        expect(mocks.stateUpsert.mock.calls[0][0].create.pendingPaths).toBeNull();
    });

    it('does NOT fire when a path resolved, even if the ids did not', async () => {
        mocks.seriesFindMany.mockResolvedValue([]);
        await recordLibraryChange({ paths: ['/data/manga/a.cbz'], seriesIds: ['gone'], reason: 'import' });
        expect(mocks.stateUpsert).toHaveBeenCalledTimes(1);
        expect(mocks.stateUpsert.mock.calls[0][0].where.omnibusLibraryId).toBe('lib-a');
    });

    it('does NOT fire for an out-of-root path alone (an explicit skip, not an unresolvable id)', async () => {
        await recordLibraryChange({ paths: ['/tmp/x.cbz'], reason: 'issue-delete' });
        expect(mocks.stateUpsert).not.toHaveBeenCalled();
    });

    it('does NOT fire when one of several ids resolved', async () => {
        mocks.seriesFindMany.mockResolvedValue([{ id: 's1', libraryId: 'lib-c', folderPath: '/data/comics/S' }]);
        await recordLibraryChange({ seriesIds: ['s1', 'gone'], reason: 'import' });
        expect(mocks.stateUpsert).toHaveBeenCalledTimes(1);
        expect(mocks.stateUpsert.mock.calls[0][0].where.omnibusLibraryId).toBe('lib-c');
    });
});

describe('recordLibraryChange: the sync-state write', () => {
    it('keeps dirtySince at the FIRST change of a burst', async () => {
        const first = new Date('2026-01-01T00:00:00Z');
        mocks.stateFindUnique.mockResolvedValue({ dirtySince: first, pendingPaths: null, pendingOverflow: false });
        await recordLibraryChange({ paths: ['/data/manga/a.cbz'], reason: 'import' });
        expect(mocks.stateUpsert.mock.calls[0][0].update.dirtySince).toEqual(first);
    });

    it('sets dirtySince on a library that had never been dirty', async () => {
        mocks.stateFindUnique.mockResolvedValue({ dirtySince: null, pendingPaths: null, pendingOverflow: false });
        await recordLibraryChange({ paths: ['/data/manga/a.cbz'], reason: 'import' });
        expect(mocks.stateUpsert.mock.calls[0][0].update.dirtySince).toBeInstanceOf(Date);
    });

    it('merges with the stored pendingPaths', async () => {
        mocks.stateFindUnique.mockResolvedValue({
            dirtySince: new Date(), pendingPaths: JSON.stringify(['/data/manga/old.cbz']), pendingOverflow: false,
        });
        await recordLibraryChange({ paths: ['/data/manga/new.cbz'], reason: 'import' });
        expect(JSON.parse(mocks.stateUpsert.mock.calls[0][0].update.pendingPaths))
            .toEqual(['/data/manga/old.cbz', '/data/manga/new.cbz']);
    });

    it('keeps the overflow flag STICKY until a scan clears it', async () => {
        mocks.stateFindUnique.mockResolvedValue({
            dirtySince: new Date(), pendingPaths: null, pendingOverflow: true,
        });
        await recordLibraryChange({ paths: ['/data/manga/a.cbz'], reason: 'import' });
        expect(mocks.stateUpsert.mock.calls[0][0].update.pendingOverflow).toBe(true);
    });

    it('stamps lastChangeAt on every call', async () => {
        await recordLibraryChange({ paths: ['/data/manga/a.cbz'], reason: 'import' });
        expect(mocks.stateUpsert.mock.calls[0][0].update.lastChangeAt).toBeInstanceOf(Date);
    });
});
