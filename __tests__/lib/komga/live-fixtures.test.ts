// Contract test: the Phase 1 client, path map and connection test fed the responses captured from a
// real Komga 1.28.1 (__tests__/fixtures/komga, recorded in docs/komga-integration/LIVE_VERIFICATION.md).
// The fake Komga in helpers/ builds its own DTOs; this file guards the hand-written types and the
// error/SSE parsing against what the server actually sent (status, body and content-type as captured).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ libraryFindMany: vi.fn(), issueCount: vi.fn() }));
vi.mock('@/lib/db', () => ({
    prisma: { library: { findMany: mocks.libraryFindMany }, issue: { count: mocks.issueCount } },
}));

import { KomgaClient, parseSseChunk } from '@/lib/komga/client';
import { isKomgaError, type KomgaBookDto, type KomgaError, type KomgaLibraryDto, type KomgaPage } from '@/lib/komga/types';
import { normalizeKomgaPath, toOmnibusPath, isKomgaScannable, type KomgaPathMapping } from '@/lib/komga/path-map';
import { snapshotLibrarySettings, resolveKomgaLibraries, computeLibraryWarnings } from '@/lib/komga/libraries';
import { testKomgaConnection } from '@/lib/komga/connection-test';

const FIXTURES = path.resolve(process.cwd(), '__tests__/fixtures/komga');
const text = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');
const json = <T = unknown>(name: string): T => JSON.parse(text(name)) as T;

const KEY = 'live-fixture-api-key-0123456789';
const BASE = 'http://komga.test:25601';
const ACTUATOR_JSON = 'application/vnd.spring-boot.actuator.v3+json';

interface Seen { method: string; path: string; headers: Headers; body: unknown }
type Handler = (req: Seen) => Response | Promise<Response>;

/** Body as Komga sent it: null → no body and no content-type (204s, empty 404s). */
function reply(status: number, body: unknown, contentType = 'application/json'): Response {
    if (body === null || body === undefined) return new Response(null, { status });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

/** A text/event-stream that delivers `payload` in small chunks (frames split mid-line) and then stays open unless `end`. */
function sseStream(payload: string, opts: { chunk?: number; end?: boolean } = {}) {
    const state = { cancelled: false };
    const size = opts.chunk ?? 7;
    const bytes = new TextEncoder().encode(payload);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= bytes.length) {
                if (opts.end) controller.close();
                return new Promise<void>(() => {});   // idle, like a live stream between frames
            }
            controller.enqueue(bytes.slice(offset, offset + size));
            offset += size;
        },
        cancel() { state.cancelled = true; },
    });
    return { response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }), state };
}

function clientFor(routes: Record<string, Handler>) {
    const seen: Seen[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const req: Seen = {
            method: (init?.method ?? 'GET').toUpperCase(),
            path: url.pathname,
            headers: new Headers(init?.headers),
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        };
        seen.push(req);
        const handler = routes[`${req.method} ${req.path}`];
        if (!handler) return reply(404, { status: 404, error: 'Not Found', message: 'No static resource', path: req.path });
        return handler(req);
    }) as typeof fetch;
    return { client: new KomgaClient({ baseUrl: BASE, apiKey: KEY, fetchImpl }), seen };
}

async function caught(p: Promise<unknown>): Promise<KomgaError> {
    try {
        await p;
    } catch (e) {
        if (isKomgaError(e)) return e;
        throw e;
    }
    throw new Error('expected a KomgaError');
}

const library = json<KomgaLibraryDto>('library.json');
const OMNIBUS_ROOT = '/omnibus/live-a';
const mappings: KomgaPathMapping[] = [{ omnibus: OMNIBUS_ROOT, komga: library.root }];

function liveRoutes(over: Record<string, Handler> = {}): Record<string, Handler> {
    return {
        'GET /actuator/health': () => reply(200, { status: 'UP' }, ACTUATOR_JSON),
        'GET /api/v2/users/me': () => reply(200, json('user-me.json')),
        'GET /actuator/info': () => reply(200, json('actuator-info.json'), ACTUATOR_JSON),
        'GET /api/v1/libraries': () => reply(200, [library]),
        ...over,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.libraryFindMany.mockResolvedValue([{ id: 'omni-a', name: 'Live A', path: OMNIBUS_ROOT }]);
    mocks.issueCount.mockResolvedValue(0);
});

describe('live fixtures: actuator, user, libraries', () => {
    it('reads build.version from the actuator v3 content type, and health goes out without the key', async () => {
        const { client, seen } = clientFor(liveRoutes());
        expect(await client.health()).toEqual({ status: 'UP' });
        expect(await client.getInfo()).toEqual({ version: '1.28.1' });
        expect(seen[0].headers.has('X-API-Key')).toBe(false);
        expect(seen[1].headers.get('X-API-Key')).toBe(KEY);
    });

    it('treats the absent ageRestriction of an unrestricted admin as null', async () => {
        const raw = json<Record<string, unknown>>('user-me.json');
        expect('ageRestriction' in raw).toBe(false);
        const { client } = clientFor(liveRoutes());
        const me = await client.getMe();
        expect(me.roles).toContain('ADMIN');
        expect(me.ageRestriction).toBeNull();
        expect(me.labelsAllow).toEqual([]);
        expect(me.labelsExclude).toEqual([]);
    });

    it('carries every library field the warnings and the scannability check read', async () => {
        const { client } = clientFor(liveRoutes());
        const [dto] = await client.listLibraries();
        expect(snapshotLibrarySettings(dto)).toEqual({
            hashFiles: true, importComicInfoBook: true, importComicInfoReadList: true, emptyTrashAfterScan: false,
            scanForceModifiedTime: false, convertToCbz: false, repairExtensions: false,
            scanCbx: true, scanPdf: true, scanEpub: true, scanDirectoryExclusions: [], oneshotsDirectory: null,
        });
        expect(normalizeKomgaPath(dto.root)).toBe(dto.root);   // plain absolute path, not a file: URL

        const [resolved] = resolveKomgaLibraries([dto], mappings, [{ id: 'omni-a', name: 'Live A', path: OMNIBUS_ROOT }]);
        expect(resolved).toMatchObject({ komgaLibraryId: dto.id, translatedRoot: OMNIBUS_ROOT, omnibusLibraryId: 'omni-a', unavailable: false });
        const warnings = computeLibraryWarnings(resolved, { mappedOmnibusPaths: [OMNIBUS_ROOT], mappings });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/Import ComicInfo read lists/);
    });

    it('passes the connection test end to end with the captured responses', async () => {
        const { client, seen } = clientFor(liveRoutes());
        const result = await testKomgaConnection(BASE, KEY, { pathMappings: mappings, includeLibraries: false, client });
        expect(result).toMatchObject({ success: true, version: '1.28.1' });
        expect(result.message).toBe('Connected to Komga 1.28.1 as admin@omnibus.local: 1 library, 1 mapped to Omnibus.');
        expect(result.warnings).toEqual([expect.stringMatching(/^Komga library "Live A": "Import ComicInfo read lists" is on/)]);
        expect(seen.map(r => `${r.method} ${r.path}`)).toEqual([
            'GET /actuator/health', 'GET /api/v2/users/me', 'GET /actuator/info', 'GET /api/v1/libraries',
        ]);
        expect(JSON.stringify(result)).not.toContain(KEY);
    });

    it('fails the connection test for the restricted-admin shape recorded live', async () => {
        const restricted = { ...json<Record<string, unknown>>('user-me.json'), ageRestriction: { age: 10, restriction: 'ALLOW_ONLY' }, labelsExclude: ['nsfw'] };
        const { client } = clientFor(liveRoutes({ 'GET /api/v2/users/me': () => reply(200, restricted) }));
        const result = await testKomgaConnection(BASE, KEY, { client });
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/content restrictions \(age restriction \(allow only 10\+\); excluded labels: nsfw\)/);
    });
});

describe('live fixtures: books', () => {
    it('pages the captured books/list envelope and yields plain paths that map back to Omnibus', async () => {
        const page0 = json<KomgaPage<KomgaBookDto>>('books-page.json');
        expect(page0).toMatchObject({ number: 0, totalPages: 2, totalElements: 9, last: false });
        const rest = page0.content.slice(0, 4).map((b, i) => ({ ...b, id: `P1-${i}`, url: `${library.root}/Gamma (2022)/Gamma 00${i + 1} (2022).cbz` }));
        const page1 = { ...page0, content: rest, number: 1, first: false, last: true, numberOfElements: rest.length };
        const { client, seen } = clientFor({
            'POST /api/v1/books/list': (req) => {
                expect(req.body).toEqual({ condition: { allOf: [{ libraryId: { operator: 'is', value: library.id } }, { deleted: { operator: 'isFalse' } }] } });
                return reply(200, seen.length === 1 ? page0 : page1);
            },
        });

        const books: KomgaBookDto[] = [];
        for await (const b of client.listBooks(library.id, { pageSize: 5 })) books.push(b);
        expect(books).toHaveLength(9);
        expect(books.slice(0, 5).map(b => b.id)).toEqual(page0.content.map(b => b.id));

        const scan = { root: library.root, scanCbx: true, scanPdf: true, scanEpub: true, scanDirectoryExclusions: [] };
        for (const b of books) {
            expect(normalizeKomgaPath(b.url)).toBe(b.url);
            expect(toOmnibusPath(b.url, mappings)?.startsWith(`${OMNIBUS_ROOT}/`)).toBe(true);
            expect(isKomgaScannable(b.url, scan)).toBe(true);
        }
    });

    it('reads the identity fields of the captured BookDto', async () => {
        const book = json<KomgaBookDto>('book.json');
        const { client } = clientFor({ [`GET /api/v1/books/${book.id}`]: () => reply(200, book) });
        const got = await client.getBook(book.id);
        expect(got.fileHash).toMatch(/^[0-9a-f]{32}$/);
        expect(got.fileLastModified).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(got.metadata.links).toEqual([{ label: 'comicvine.gamespot.com', url: 'https://comicvine.gamespot.com/x/4000-100101/' }]);
        expect(got.deleted).toBe(false);
    });

    it('maps the empty-bodied 404 for an unknown book to notFound without needing JSON', async () => {
        const { client } = clientFor({ 'GET /api/v1/books/0ZZZZZZZZZZZZ': () => reply(404, null) });
        const e = await caught(client.getBook('0ZZZZZZZZZZZZ'));
        expect(e).toMatchObject({ kind: 'notFound', status: 404, detail: null });
    });
});

describe('live fixtures: task queue and metrics', () => {
    it('skips the domain-event flood and heartbeats and returns the first TaskQueueStatus', async () => {
        const live = sseStream(text('sse-frames.txt'));
        const { client, seen } = clientFor({ 'GET /sse/v1/events': () => live.response });
        const read = await client.readTaskQueue({ timeoutMs: 2000 });
        expect(read).toEqual({ ok: true, status: { count: 437, countByType: { RefreshBookMetadata: 396, RefreshSeriesMetadata: 39, ScanLibrary: 2 } } });
        expect(seen[0].headers.get('Accept')).toBe('text/event-stream');
        expect(live.state.cancelled).toBe(true);
    });

    it('reads the idle frame as count 0 with an empty countByType', async () => {
        const live = sseStream(text('sse-frames-idle.txt'));
        const { client } = clientFor({ 'GET /sse/v1/events': () => live.response });
        expect(await client.readTaskQueue({ timeoutMs: 2000 })).toEqual({ ok: true, status: { count: 0, countByType: {} } });
        expect(live.state.cancelled).toBe(true);
    });

    it('reports ended when the stream closes before any TaskQueueStatus frame', async () => {
        const all = text('sse-frames.txt');
        const live = sseStream(all.slice(0, all.indexOf('event:TaskQueueStatus')), { end: true });
        const { client } = clientFor({ 'GET /sse/v1/events': () => live.response });
        expect(await client.readTaskQueue({ timeoutMs: 2000 })).toEqual({ ok: false, reason: 'ended' });
    });

    it('parses the captured frames exactly (no space after the colon, heartbeat comments ignored)', () => {
        const { frames, rest } = parseSseChunk(text('sse-frames.txt'));
        expect(rest).toBe('');
        expect(frames.map(f => f.event)).toEqual(['BookAdded', 'BookAdded', 'TaskQueueStatus', 'BookChanged', 'BookChanged']);
        expect(() => frames.forEach(f => JSON.parse(f.data))).not.toThrow();
    });

    it('reads COUNT from the captured metric, and the empty-bodied 404 as 0', async () => {
        const metricPath = 'GET /actuator/metrics/komga.tasks.execution';
        const { client } = clientFor({ [metricPath]: () => reply(200, json('metrics-scan.json'), ACTUATOR_JSON) });
        expect(await client.scanMetricsCount()).toBe(11);
        const { client: fresh } = clientFor({ [metricPath]: () => reply(404, null) });
        expect(await fresh.scanMetricsCount()).toBe(0);
    });
});

describe('live fixtures: read-list responses', () => {
    interface Captured { status: number; body: unknown }
    const errors = json<Record<string, Captured>>('errors.json');
    const readList = json<Record<string, unknown>>('readlist.json');
    const create = { name: 'RL', summary: '', ordered: true, bookIds: ['0RT153YNBXQWF'] };

    function capturedClient(entry: Captured) {
        return clientFor({
            'POST /api/v1/readlists': () => reply(entry.status, entry.body),
            'PATCH /api/v1/readlists/RL1': () => reply(entry.status, entry.body),
            'DELETE /api/v1/readlists/RL1': () => reply(entry.status, entry.body),
        }).client;
    }

    it.each([
        ['createWithUnknownBookId', 'create', 'server', 500, /FOREIGN KEY constraint failed/],
        ['patchWithUnknownBookId', 'patch', 'server', 500, /FOREIGN KEY constraint failed/],
        ['patchNameAndUnknownBookId', 'patch', 'server', 500, /FOREIGN KEY constraint failed/],
        ['patchUnknownReadList', 'patch', 'notFound', 404, /^404 NOT_FOUND$/],
        ['deleteAgain', 'delete', 'notFound', 404, /^404 NOT_FOUND$/],
        ['createEmptyBookIds', 'create', 'badRequest', 400, /^bookIds: must not be empty$/],
        ['createDuplicateBookIds', 'create', 'badRequest', 400, /^bookIds: must only contain unique elements$/],
        ['createBlankName', 'create', 'badRequest', 400, /^name: must not be blank$/],
        ['patchEmptyBookIds', 'patch', 'badRequest', 400, /^bookIds: must be null; bookIds: must not be empty$/],
        ['patchDuplicateBookIds', 'patch', 'badRequest', 400, /^bookIds: must only contain unique elements$/],
        ['createDuplicateNameSameCase', 'create', 'badRequest', 400, /^Read list name already exists$/],
        ['createDuplicateNameDifferentCase', 'create', 'badRequest', 400, /^Read list name already exists$/],
        ['patchRenameToExistingNameDifferentCase', 'patch', 'badRequest', 400, /^Read list name already exists$/],
    ] as const)('%s → %s', async (key, op, kind, status, detail) => {
        const entry = errors[key];
        expect(entry.status).toBe(status);
        const client = capturedClient(entry);
        const call = op === 'create' ? client.createReadList(create)
            : op === 'patch' ? client.updateReadList('RL1', { bookIds: ['x'] })
            : client.deleteReadList('RL1');
        const e = await caught(call);
        expect(e.kind).toBe(kind);
        expect(e.status).toBe(status);
        expect(e.detail).toMatch(detail);
        expect(e.message).not.toContain(KEY);
    });

    it.each(['patchOk', 'patchRenameSelfCaseOnly', 'deleteOk'])('%s (204, empty body) resolves', async (key) => {
        const entry = errors[key];
        expect(entry).toMatchObject({ status: 204, body: null });
        const client = capturedClient(entry);
        await expect(key === 'deleteOk' ? client.deleteReadList('RL1') : client.updateReadList('RL1', { name: 'rl valid' })).resolves.toBeUndefined();
    });

    it('returns the created list, names untrimmed, with the live defaults for summary and ordered', async () => {
        const created = await capturedClient(errors.createDuplicateNameTrailingSpace).createReadList(create);
        expect(created.name).toBe('RL Valid ');
        const defaults = await capturedClient(errors.createMissingSummaryOrdered).createReadList(create);
        expect(defaults).toMatchObject({ summary: '', ordered: true, filtered: false });
    });

    it('lists read lists from the unpaged page envelope', async () => {
        const page = { content: [readList], totalElements: 1, totalPages: 1, number: 0, size: 1, numberOfElements: 1, first: true, last: true, empty: false };
        const { client } = clientFor({ 'GET /api/v1/readlists': () => reply(200, page) });
        const lists = await client.listReadLists();
        expect(lists).toHaveLength(1);
        expect(lists[0]).toMatchObject({ id: '0RT15EJXKXV79', name: 'RL Valid', ordered: true, filtered: false });
        expect(lists[0].bookIds).toHaveLength(3);
    });
});
