// __tests__/lib/komga/readlist-resolver.test.ts
//
// The pure half of the Komga read-list resolver: ordering, all six skip reasons, dedupe, the
// provider-id lookup, and the promise that it never WRITES an item's issueId back.
//
// The async half (resolveReadListForPush) is covered at the end with an in-memory prisma fake.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    issueFindMany: vi.fn(),
    itemUpdateMany: vi.fn(),
    itemUpdate: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { issue: { findMany: mocks.issueFindMany, updateMany: mocks.itemUpdateMany, update: mocks.itemUpdate } } }));

import {
    orderResolverItems,
    parseSkippedSummary,
    providerKey,
    resolveReadList,
    resolveReadListForPush,
    serializeSkippedSummary,
    type ResolveContext,
    type ResolverItem,
} from '@/lib/komga/readlist-resolver';
import { findIssueForProviderId, normalizeMetadataSource, pickIssueForProviderId } from '@/lib/reading-list-links';
import type { ResolvedKomgaLibrary, OmnibusLibraryRef } from '@/lib/komga/libraries';

const SCAN = { scanCbx: true, scanPdf: true, scanEpub: true, scanDirectoryExclusions: [] as string[] };
const MAPPINGS = [{ omnibus: '/data', komga: '/comics' }];

const komgaLib = (over: Partial<ResolvedKomgaLibrary> = {}): ResolvedKomgaLibrary => ({
    komgaLibraryId: 'KL1',
    name: 'Comics',
    root: '/comics/manga',
    translatedRoot: '/data/manga',
    omnibusLibraryId: 'lib-manga',
    settings: { ...SCAN, hashFiles: true, importComicInfoBook: true, importComicInfoReadList: false, emptyTrashAfterScan: false, scanForceModifiedTime: false, convertToCbz: false, repairExtensions: false, oneshotsDirectory: null },
    unavailable: false,
    ...over,
});
const omnibusLib = (over: Partial<OmnibusLibraryRef> = {}): OmnibusLibraryRef =>
    ({ id: 'lib-manga', name: 'Manga', path: '/data/manga', ...over });

const item = (over: Partial<ResolverItem> = {}): ResolverItem =>
    ({ id: 'i1', order: 0, issueId: 'e1', cvIssueId: null, metadataSource: 'COMICVINE', title: 'X #1', ...over });

const issue = (id: string, over: Record<string, unknown> = {}) => ({ id, filePath: `/data/manga/S/${id}.cbz`, libraryId: 'lib-manga', ...over });
const link = (issueId: string, bookId: string, over: Record<string, unknown> = {}) =>
    ({ issueId, komgaBookId: bookId, komgaLibraryId: 'KL1', omnibusPath: `/data/manga/S/${issueId}.cbz`, ...over });

function ctx(over: Partial<ResolveContext> = {}): ResolveContext {
    return {
        items: [],
        issuesById: new Map(),
        issuesByProviderId: new Map(),
        linksByIssueId: new Map(),
        komgaLibs: [komgaLib()],
        omnibusLibraries: [omnibusLib()],
        pathMappings: MAPPINGS,
        ...over,
    };
}

describe('orderResolverItems', () => {
    it('orders by order, then by id for ties', () => {
        const items = [item({ id: 'c', order: 1 }), item({ id: 'a', order: 1 }), item({ id: 'b', order: 0 })];
        expect(orderResolverItems(items).map(i => i.id)).toEqual(['b', 'a', 'c']);
    });

    it('does not mutate the input', () => {
        const items = [item({ id: 'b', order: 2 }), item({ id: 'a', order: 1 })];
        orderResolverItems(items);
        expect(items.map(i => i.id)).toEqual(['b', 'a']);
    });
});

describe('resolveReadList: classification', () => {
    it('resolves a downloaded, scannable, mapped, linked issue to its book id', () => {
        const r = resolveReadList(ctx({
            items: [item({ id: 'i1', issueId: 'e1' }), item({ id: 'i2', order: 1, issueId: 'e2' })],
            issuesById: new Map([['e1', issue('e1')], ['e2', issue('e2')]]),
            linksByIssueId: new Map([['e1', link('e1', 'B1')], ['e2', link('e2', 'B2')]]),
        }));
        expect(r.bookIds).toEqual(['B1', 'B2']);
        expect(r.resolvedCount).toBe(2);
        expect(r.skipped).toEqual({ placeholder: 0, notDownloaded: 0, unsupportedFormat: 0, libraryUnmapped: 0, awaitingScan: 0, duplicate: 0 });
    });

    it('counts an issue with no file as notDownloaded', () => {
        const r = resolveReadList(ctx({
            items: [item()],
            issuesById: new Map([['e1', issue('e1', { filePath: null })]]),
            linksByIssueId: new Map([['e1', link('e1', 'B1')]]),
        }));
        expect(r.bookIds).toEqual([]);
        expect(r.skipped.notDownloaded).toBe(1);
        expect(r.entries[0].reason).toBe('notDownloaded');
    });

    it('treats a blank file path as not downloaded', () => {
        const r = resolveReadList(ctx({ items: [item()], issuesById: new Map([['e1', issue('e1', { filePath: '   ' })]]) }));
        expect(r.skipped.notDownloaded).toBe(1);
    });

    it('counts a format Komga will not scan as unsupportedFormat', () => {
        // scanCbx gates cbz/zip/cbr/rar together, and .cb7 is never indexed by Komga.
        const r = resolveReadList(ctx({
            items: [item()],
            issuesById: new Map([['e1', issue('e1', { filePath: '/data/manga/S/e1.cb7' })]]),
            linksByIssueId: new Map([['e1', link('e1', 'B1')]]),
        }));
        expect(r.skipped.unsupportedFormat).toBe(1);
    });

    it('counts a file the Komga library settings exclude as unsupportedFormat', () => {
        const r = resolveReadList(ctx({
            items: [item()],
            issuesById: new Map([['e1', issue('e1')]]),
            linksByIssueId: new Map([['e1', link('e1', 'B1')]]),
            komgaLibs: [komgaLib({ settings: { ...komgaLib().settings, scanCbx: false } })],
        }));
        expect(r.skipped.unsupportedFormat).toBe(1);
    });

    it('counts a file no path mapping covers as unsupportedFormat', () => {
        const r = resolveReadList(ctx({
            items: [item()],
            issuesById: new Map([['e1', issue('e1', { filePath: '/elsewhere/e1.cbz' })]]),
            linksByIssueId: new Map([['e1', link('e1', 'B1')]]),
        }));
        expect(r.skipped.unsupportedFormat).toBe(1);
    });

    it('counts an issue in a library Komga does not serve as libraryUnmapped', () => {
        const r = resolveReadList(ctx({
            items: [item()],
            issuesById: new Map([['e1', issue('e1', { libraryId: 'lib-other' })]]),
            linksByIssueId: new Map([['e1', link('e1', 'B1')]]),
            omnibusLibraries: [omnibusLib(), omnibusLib({ id: 'lib-other', name: 'Other', path: '/data/other' })],
        }));
        expect(r.skipped.libraryUnmapped).toBe(1);
    });

    it('counts a missing book link as awaitingScan', () => {
        const r = resolveReadList(ctx({ items: [item()], issuesById: new Map([['e1', issue('e1')]]) }));
        expect(r.skipped.awaitingScan).toBe(1);
    });

    it('counts a stale link (path moved) as awaitingScan', () => {
        const r = resolveReadList(ctx({
            items: [item()],
            issuesById: new Map([['e1', issue('e1')]]),
            linksByIssueId: new Map([['e1', link('e1', 'B1', { omnibusPath: '/data/manga/S/old.cbz' })]]),
        }));
        expect(r.skipped.awaitingScan).toBe(1);
    });

    it('counts a title-only entry as placeholder', () => {
        const r = resolveReadList(ctx({ items: [item({ issueId: null, cvIssueId: null, title: 'Mystery Arc 12' })] }));
        expect(r.skipped.placeholder).toBe(1);
        expect(r.entries[0].issueId).toBeNull();
    });

    it('counts an entry whose provider issue is not in the library as placeholder', () => {
        const r = resolveReadList(ctx({ items: [item({ issueId: null, cvIssueId: 900 })] }));
        expect(r.skipped.placeholder).toBe(1);
    });

    it('resolves an unlinked entry through its provider id, preferring the file-backed copy', () => {
        const r = resolveReadList(ctx({
            items: [item({ id: 'i1', issueId: null, cvIssueId: 900 })],
            issuesByProviderId: new Map([[providerKey('COMICVINE', 900), issue('e-file')]]),
            linksByIssueId: new Map([['e-file', link('e-file', 'B9')]]),
        }));
        expect(r.bookIds).toEqual(['B9']);
        expect(r.entries[0].issueId).toBe('e-file');
    });

    it('keeps the first occurrence of a repeated book and counts the rest as duplicate', () => {
        const r = resolveReadList(ctx({
            items: [item({ id: 'i1', issueId: 'e1' }), item({ id: 'i2', order: 1, issueId: 'e2' }), item({ id: 'i3', order: 2, issueId: 'e1' })],
            issuesById: new Map([['e1', issue('e1')], ['e2', issue('e2')]]),
            linksByIssueId: new Map([['e1', link('e1', 'B1')], ['e2', link('e2', 'B1')]]),
        }));
        expect(r.bookIds).toEqual(['B1']);
        // Three entries, one book: the second AND the third are duplicates of the first.
        expect(r.skipped.duplicate).toBe(2);
        expect(r.entries[2].reason).toBe('duplicate');
    });

    it('reports every entry once, so the counts add up to the list length', () => {
        const r = resolveReadList(ctx({
            items: [
                item({ id: 'a', issueId: 'e1', order: 0 }),
                item({ id: 'b', issueId: null, cvIssueId: null, order: 1 }),
                item({ id: 'c', issueId: 'e3', order: 2 }),
                item({ id: 'd', issueId: 'e4', order: 3 }),
                item({ id: 'e', issueId: 'e5', order: 4 }),
            ],
            issuesById: new Map([
                ['e1', issue('e1')],
                ['e3', issue('e3', { filePath: null })],
                ['e4', issue('e4', { libraryId: 'lib-other' })],
                ['e5', issue('e5')],
            ]),
            linksByIssueId: new Map([['e1', link('e1', 'B1')]]),
            omnibusLibraries: [omnibusLib(), omnibusLib({ id: 'lib-other', name: 'O', path: '/data/o' })],
        }));
        expect(r.total).toBe(5);
        expect(r.resolvedCount + Object.values(r.skipped).reduce((x, y) => x + y, 0)).toBe(5);
    });

    it('returns an empty result for an empty list rather than throwing', () => {
        const r = resolveReadList(ctx());
        expect(r).toEqual({ bookIds: [], entries: [], skipped: expect.any(Object), total: 0, resolvedCount: 0 });
    });
});

describe('skippedSummary (de)serialisation', () => {
    it('round-trips', () => {
        const s = { placeholder: 1, notDownloaded: 9, unsupportedFormat: 0, libraryUnmapped: 2, awaitingScan: 5, duplicate: 1 };
        expect(parseSkippedSummary(serializeSkippedSummary(s))).toEqual(s);
    });

    it('reads garbage as all-zero instead of throwing', () => {
        expect(parseSkippedSummary('{not json').notDownloaded).toBe(0);
        expect(parseSkippedSummary(null).awaitingScan).toBe(0);
        expect(parseSkippedSummary('{"notDownloaded":"x"}').notDownloaded).toBe(0);
    });

    it('ignores negative and unknown keys', () => {
        expect(parseSkippedSummary('{"duplicate":-3,"placeholder":2}')).toEqual({
            placeholder: 2, notDownloaded: 0, unsupportedFormat: 0, libraryUnmapped: 0, awaitingScan: 0, duplicate: 0,
        });
    });
});

describe('the shared provider-id rule (reading-list-links)', () => {
    const row = (id: string, over: Record<string, unknown> = {}) => ({
        id, metadataId: '900', metadataSource: 'COMICVINE', number: '1', filePath: null, attachedVolumeId: null, ...over,
    });

    it('matches on metadataId AND source', () => {
        expect(pickIssueForProviderId([row('a', { metadataSource: 'METRON' })], 900, 'COMICVINE')).toBeNull();
        expect(pickIssueForProviderId([row('a', { metadataId: '901' })], 900, 'COMICVINE')).toBeNull();
    });

    it('prefers a file-backed copy', () => {
        expect(pickIssueForProviderId([row('a'), row('b', { filePath: '/x/b.cbz' })], 900, 'COMICVINE')?.id).toBe('b');
    });

    it('falls back to the first row when nothing has a file', () => {
        expect(pickIssueForProviderId([row('a'), row('b')], 900, 'COMICVINE')?.id).toBe('a');
    });

    it('treats a blank source as COMICVINE (the column default)', () => {
        expect(normalizeMetadataSource(null)).toBe('COMICVINE');
        expect(pickIssueForProviderId([row('a', { metadataSource: '' })], 900, null)?.id).toBe('a');
    });

    it('vetoes a copy whose number contradicts the entry title, unless it is an attached lane', () => {
        expect(pickIssueForProviderId([row('a', { number: '5' })], 900, 'COMICVINE', 1)).toBeNull();
        expect(pickIssueForProviderId([row('a', { number: '5', attachedVolumeId: 'v1' })], 900, 'COMICVINE', 1)?.id).toBe('a');
        expect(pickIssueForProviderId([row('a', { number: '1' })], 900, 'COMICVINE', 1)?.id).toBe('a');
    });

    it('findIssueForProviderId queries by {metadataId, metadataSource} and returns the library', async () => {
        mocks.issueFindMany.mockResolvedValue([row('a'), row('b', { filePath: '/x/b.cbz', series: { libraryId: 'lib-x' } })]);
        const found = await findIssueForProviderId(900, 'COMICVINE');
        expect(mocks.issueFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { metadataId: '900', metadataSource: 'COMICVINE' },
        }));
        expect(found).toEqual({ id: 'b', filePath: '/x/b.cbz', libraryId: 'lib-x' });
    });

    it('findIssueForProviderId returns null when nothing matches', async () => {
        mocks.issueFindMany.mockResolvedValue([]);
        expect(await findIssueForProviderId(900, 'METRON')).toBeNull();
    });
});

describe('resolveReadListForPush', () => {
    const db = () => ({
        readingListItem: { findMany: vi.fn(async () => [item({ id: 'i1', issueId: 'e1' })]) },
        issue: {
            findMany: vi.fn(async ({ where }: any) => (where?.id
                ? [{ id: 'e1', filePath: '/data/manga/S/e1.cbz', series: { libraryId: 'lib-manga' } }]
                : [])),
        },
        komgaBookLink: { findMany: vi.fn(async () => [link('e1', 'B1')]) },
        komgaLibrary: { findMany: vi.fn(async () => [{ komgaLibraryId: 'KL1', name: 'Comics', root: '/comics/manga', translatedRoot: '/data/manga', omnibusLibraryId: 'lib-manga', settings: JSON.stringify({ ...SCAN }), unavailable: false }]) },
        library: { findMany: vi.fn(async () => [omnibusLib()]) },
    });

    it('returns null when the list does not exist', async () => {
        const d = db();
        d.readingListItem.findMany = vi.fn(async () => []);
        // An empty list is not "missing"; the caller distinguishes by the empty item array.
        const r = await resolveReadListForPush('L1', { db: d as never });
        expect(r?.result.bookIds).toEqual([]);
    });

    it('loads links, the library cache and the mappings, then classifies', async () => {
        const d = db();
        const r = await resolveReadListForPush('L1', {
            db: d as never,
            settings: { pathMappings: MAPPINGS } as never,
        });
        expect(r?.result.bookIds).toEqual(['B1']);
        expect(d.komgaBookLink.findMany).toHaveBeenCalled();
        expect(d.komgaLibrary.findMany).toHaveBeenCalled();
    });

    it('never writes the provider-id lookup back onto the item', async () => {
        const d = db();
        d.readingListItem.findMany = vi.fn(async () => [item({ id: 'i1', issueId: null, cvIssueId: 900 })]);
        mocks.issueFindMany.mockResolvedValue([
            { id: 'e9', metadataId: '900', metadataSource: 'COMICVINE', number: '1', filePath: '/data/manga/S/e9.cbz', attachedVolumeId: null, series: { libraryId: 'lib-manga' } },
        ]);
        d.komgaBookLink.findMany = vi.fn(async () => [link('e9', 'B9')]);
        const r = await resolveReadListForPush('L1', { db: d as never, settings: { pathMappings: MAPPINGS } as never });
        expect(r?.result.bookIds).toEqual(['B9']);
        // The auto-link owns that write; the resolver only reads.
        expect(mocks.itemUpdateMany).not.toHaveBeenCalled();
        expect(mocks.itemUpdate).not.toHaveBeenCalled();
    });
});