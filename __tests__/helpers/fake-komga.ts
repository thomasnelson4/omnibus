// __tests__/helpers/fake-komga.ts
//
// Dependency-free node:http fake of the Komga 1.28.1 endpoints Omnibus uses, for client, sync,
// reconcile and read-list tests. Bound to 127.0.0.1:0; every test (or file) starts its own.
//
//   const fake = await startFakeKomga({ basePath: '/komga', state: { books: [makeKomgaBook({ url: '/comics/A/A 001.cbz' })] } });
//   const client = new KomgaClient({ baseUrl: fake.url, apiKey: fake.state.apiKey });
//   ...
//   await fake.close();
//
// startFakeKomga(opts?) → { url, state, requests, close() }
//   url       base URL including opts.basePath, no trailing slash. Requests outside basePath → 404.
//   state     MUTABLE at any time by the test (see FakeKomgaState); handlers read it per request.
//   requests  every request received, in order: { method, path, route (basePath stripped), query,
//             headers (lower-cased), body (parsed JSON or undefined), rawBody }.
//   close()   clears timers, drops open connections (incl. SSE) and stops the server.
//
// Behaviour (mirrors the Kotlin controllers; error bodies are Spring Boot's error JSON
// {timestamp,status,error,message,path} or Komga's {violations:[{fieldName,message}]}):
//   auth         every route except GET /actuator/health needs `X-API-Key: state.apiKey`, else 401
//                with an empty body. Admin-only routes (actuator, scan, read-list writes) → 403
//                unless state.user.roles includes ADMIN. Non-admins get library root "" and book url
//                reduced to the file name, as Komga does.
//   failures     state.failures[]: first match on method (optional) + route (string = exact, RegExp)
//                wins; `times` limits how often it fires. It can delay (`delayMs`), drop the socket
//                (`destroy`) or answer with `status` + `body` + `headers`. A rule with only delayMs
//                delays and then falls through to the normal handler.
//   GET  /actuator/health                       {status} (503 when state.health !== 'UP'); anonymous
//   GET  /actuator/info                          {build:{version,…},java,os}; {} when state.version is null
//   GET  /actuator/metrics/komga.tasks.execution?tag=type:ScanLibrary
//                                                COUNT = state.scanMetricsCount; null → 404 (never recorded)
//   GET  /api/v2/users/me                        state.user (ageRestriction omitted when null, like NON_NULL)
//   GET  /api/v1/libraries                       state.libraries
//   POST /api/v1/libraries/{id}/scan?deep=       202, appended to state.scans; 404 unknown library
//   POST /api/v1/books/list?page=&size=&sort=&unpaged=
//                                                body {condition}: allOf/anyOf, libraryId/seriesId
//                                                is|isNot, deleted isTrue|isFalse (others match all);
//                                                sort url|name|id ,asc|desc; size default 20, clamped
//                                                to 2000; Spring Page JSON. state.onBooksListPage(page)
//                                                runs first, so tests can mutate books mid-iteration.
//   GET  /api/v1/books/{id}                      404 when unknown (soft-deleted books are returned)
//   GET  /api/v1/readlists[?unpaged=true]        Page<ReadListDto> sorted by name
//   GET  /api/v1/readlists/{id}                  404 when unknown
//   POST /api/v1/readlists                       200 ReadListDto. 400 violations: blank name, empty or
//                                                duplicate bookIds. 400 {"message":"Read list name already
//                                                exists"} on a case-insensitive name clash. 500 and NO
//                                                change when any bookId is not in state.books (FK).
//   PATCH /api/v1/readlists/{id}                 same validation (fields optional), then 404 unknown list;
//                                                bookIds fully replaces membership; 204
//   DELETE /api/v1/readlists/{id}                204 / 404
//   GET  /sse/v1/events                          text/event-stream. Emits state.sse.extraEvents, then one
//                                                TaskQueueStatus per state.sse.intervalMs from
//                                                state.taskQueueFrames (admins only, like Komga); 'none'
//                                                sends nothing. Frame style 'data:' (Spring) or 'data: ',
//                                                LF or CRLF, optional ':heartbeat' comments. After the
//                                                last frame the stream idles, or ends when endAfterFrames.
//                                                state.sseConnections counts opened / closed connections.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
    KomgaBookDto,
    KomgaBookMetadataDto,
    KomgaLibraryDto,
    KomgaReadListDto,
    KomgaTaskQueueStatus,
    KomgaUserDto,
} from '@/lib/komga/types';

export interface FakeKomgaFailure {
    /** Any method when omitted. */
    method?: string;
    /** Matched against the route (basePath stripped, no query): string = exact match. */
    path: string | RegExp;
    status?: number;
    /** JSON body; defaults to a Spring error body for `status`. Use null for an empty body. */
    body?: unknown;
    headers?: Record<string, string>;
    /** Wait before answering (or before falling through when no status is set). */
    delayMs?: number;
    /** Destroy the socket without answering (connection reset). */
    destroy?: boolean;
    /** Fire this many times, then stop matching. Unlimited when omitted. */
    times?: number;
}

export interface FakeKomgaSseOptions {
    frameStyle: 'data:' | 'data: ';
    lineEnding: '\n' | '\r\n';
    intervalMs: number;
    /** Send a `:heartbeat` comment before each frame (Komga >= 1.24.0 sends one every 15 s). */
    heartbeat: boolean;
    /** Other named events sent once, right after connecting. */
    extraEvents: { event: string; data: unknown }[];
    /** End the response after the last TaskQueueStatus frame instead of idling. */
    endAfterFrames: boolean;
}

export interface FakeKomgaState {
    apiKey: string;
    /** /actuator/info build.version; null → info without a build block. */
    version: string | null;
    health: string;
    user: KomgaUserDto;
    libraries: KomgaLibraryDto[];
    /** Includes soft-deleted books (deleted: true); removing a book from the array is a hard delete. */
    books: KomgaBookDto[];
    readLists: KomgaReadListDto[];
    taskQueueFrames: KomgaTaskQueueStatus[] | 'none';
    sse: FakeKomgaSseOptions;
    /** COUNT of komga.tasks.execution{type=ScanLibrary}; null → 404. */
    scanMetricsCount: number | null;
    failures: FakeKomgaFailure[];
    scans: { libraryId: string; deep: boolean }[];
    sseConnections: { opened: number; closed: number };
    /** Called with the requested page number before each POST /api/v1/books/list is answered. */
    onBooksListPage?: (page: number, state: FakeKomgaState) => void;
}

export interface FakeKomgaRequest {
    method: string;
    path: string;
    route: string;
    query: Record<string, string>;
    headers: http.IncomingHttpHeaders;
    body: unknown;
    rawBody: string;
}

export interface FakeKomga {
    url: string;
    state: FakeKomgaState;
    requests: FakeKomgaRequest[];
    close(): Promise<void>;
}

export interface StartFakeKomgaOptions {
    /** Serve under a sub-path, e.g. '/komga' (reverse-proxy style). */
    basePath?: string;
    state?: Partial<Omit<FakeKomgaState, 'sse'>> & { sse?: Partial<FakeKomgaSseOptions> };
}

// ------------------------------------------------------------------ fixtures

let idSeq = 0;
/** 13-character TSID-like id, as Komga uses. */
export const fakeKomgaId = (prefix: string): string => `${prefix}${String(++idSeq).padStart(13 - prefix.length, '0')}`;

const nowStamp = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export function makeKomgaLibrary(partial: Partial<KomgaLibraryDto> = {}): KomgaLibraryDto {
    return {
        id: fakeKomgaId('L'),
        name: 'Comics',
        root: '/comics',
        // Komga's own defaults (domain/model/Library.kt)
        importComicInfoBook: true,
        importComicInfoSeries: true,
        importComicInfoCollection: true,
        importComicInfoReadList: true,
        importComicInfoSeriesAppendVolume: true,
        importEpubBook: true,
        importEpubSeries: true,
        importMylarSeries: true,
        importLocalArtwork: true,
        importBarcodeIsbn: true,
        scanForceModifiedTime: false,
        scanInterval: 'EVERY_6H',
        scanOnStartup: false,
        scanCbx: true,
        scanPdf: true,
        scanEpub: true,
        scanDirectoryExclusions: [],
        repairExtensions: false,
        convertToCbz: false,
        emptyTrashAfterScan: false,
        seriesCover: 'FIRST',
        hashFiles: true,
        hashPages: false,
        hashKoreader: false,
        analyzeDimensions: true,
        oneshotsDirectory: null,
        unavailable: false,
        ...partial,
    };
}

export function makeKomgaBook(
    partial: Partial<Omit<KomgaBookDto, 'metadata'>> & { metadata?: Partial<KomgaBookMetadataDto> } = {},
): KomgaBookDto {
    const { metadata, ...rest } = partial;
    const url = rest.url ?? `/comics/Series/Book ${idSeq + 1}.cbz`;
    const fileName = url.split(/[\\/]/).pop() ?? url;
    const name = rest.name ?? fileName.replace(/\.[^.]+$/, '');
    const stamp = '2026-01-01T00:00:00Z';
    const sizeBytes = rest.sizeBytes ?? 1_048_576;
    return {
        id: fakeKomgaId('B'),
        seriesId: 'S000000000001',
        seriesTitle: 'Series',
        libraryId: 'L000000000001',
        number: 1,
        created: stamp,
        lastModified: stamp,
        fileLastModified: stamp,
        size: `${(sizeBytes / 1_048_576).toFixed(1)} MiB`,
        media: {
            status: 'READY', mediaType: 'application/zip', pagesCount: 20, comment: '',
            epubDivinaCompatible: false, epubIsKepub: false, mediaProfile: 'DIVINA',
        },
        readProgress: null,
        deleted: false,
        fileHash: '',
        oneshot: false,
        ...rest,
        url,
        name,
        sizeBytes,
        metadata: {
            title: name, titleLock: false, summary: '', summaryLock: false,
            number: '1', numberLock: false, numberSort: 1, numberSortLock: false,
            releaseDate: null, releaseDateLock: false, authors: [], authorsLock: false,
            tags: [], tagsLock: false, isbn: '', isbnLock: false, links: [], linksLock: false,
            created: stamp, lastModified: stamp,
            ...metadata,
        },
    };
}

export function makeKomgaReadList(partial: Partial<KomgaReadListDto> = {}): KomgaReadListDto {
    const stamp = nowStamp();
    return {
        id: fakeKomgaId('R'),
        name: 'Read List',
        summary: '',
        ordered: true,
        bookIds: [],
        createdDate: stamp,
        lastModifiedDate: stamp,
        filtered: false,
        ...partial,
    };
}

export function makeKomgaUser(partial: Partial<KomgaUserDto> = {}): KomgaUserDto {
    return {
        id: 'U000000000001',
        email: 'omnibus@example.com',
        roles: ['ADMIN', 'USER'],
        sharedAllLibraries: true,
        sharedLibrariesIds: [],
        labelsAllow: [],
        labelsExclude: [],
        ageRestriction: null,
        ...partial,
    };
}

/** Polls `predicate` until it is truthy (or throws after timeoutMs). */
export async function waitUntil(predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`waitUntil: condition not met within ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

// ------------------------------------------------------------------ server

const MAX_PAGE_SIZE = 2000;
const DEFAULT_PAGE_SIZE = 20;

const STATUS_TEXT: Record<number, string> = {
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 503: 'Service Unavailable',
};

const springError = (status: number, path: string, message = '') => ({
    timestamp: new Date().toISOString(), status, error: STATUS_TEXT[status] ?? 'Error', message, path,
});

const violations = (list: [string, string][]) => ({ violations: list.map(([fieldName, message]) => ({ fieldName, message })) });

function pageOf<T>(all: T[], page: number, size: number, unpaged: boolean) {
    const total = all.length;
    const effSize = unpaged ? Math.max(total, 1) : size;
    const content = unpaged ? all : all.slice(page * size, page * size + size);
    const number = unpaged ? 0 : page;
    const totalPages = Math.ceil(total / effSize);
    const sort = { empty: false, sorted: true, unsorted: false };
    return {
        content,
        pageable: unpaged ? 'INSTANCE' : { pageNumber: page, pageSize: size, sort, offset: page * size, paged: true, unpaged: false },
        totalElements: total,
        totalPages,
        last: number + 1 >= totalPages,
        size: unpaged ? total : size,
        number,
        sort,
        first: number === 0,
        numberOfElements: content.length,
        empty: content.length === 0,
    };
}

type Condition = Record<string, unknown>;

function matchesBook(book: KomgaBookDto, cond: unknown): boolean {
    if (!cond || typeof cond !== 'object') return true;
    const c = cond as Condition;
    if (Array.isArray(c.allOf)) return c.allOf.every((x) => matchesBook(book, x));
    if (Array.isArray(c.anyOf)) return c.anyOf.some((x) => matchesBook(book, x));
    const op = (v: unknown) => (v ?? {}) as { operator?: string; value?: unknown };
    if (c.libraryId) {
        const o = op(c.libraryId);
        return o.operator === 'isNot' ? book.libraryId !== o.value : book.libraryId === o.value;
    }
    if (c.seriesId) {
        const o = op(c.seriesId);
        return o.operator === 'isNot' ? book.seriesId !== o.value : book.seriesId === o.value;
    }
    if (c.deleted) return op(c.deleted).operator === 'isTrue' ? book.deleted : !book.deleted;
    return true;
}

function bookSorter(sortParam: string | undefined): ((a: KomgaBookDto, b: KomgaBookDto) => number) | null {
    if (!sortParam) return null;
    const [field, dir] = sortParam.split(',');
    const key = (b: KomgaBookDto): string => field === 'name' ? b.name : field === 'id' ? b.id : b.url;
    const sign = dir?.toLowerCase() === 'desc' ? -1 : 1;
    return (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * sign;
}

function defaultState(): FakeKomgaState {
    return {
        apiKey: 'fake-komga-key-7d1e5c2a9b8f4e60',
        version: '1.28.1',
        health: 'UP',
        user: makeKomgaUser(),
        libraries: [],
        books: [],
        readLists: [],
        taskQueueFrames: [{ count: 0, countByType: {} }],
        sse: { frameStyle: 'data:', lineEnding: '\n', intervalMs: 20, heartbeat: false, extraEvents: [], endAfterFrames: false },
        scanMetricsCount: null,
        failures: [],
        scans: [],
        sseConnections: { opened: 0, closed: 0 },
    };
}

export async function startFakeKomga(opts: StartFakeKomgaOptions = {}): Promise<FakeKomga> {
    const basePath = (opts.basePath ?? '').replace(/\/+$/, '');
    const base = defaultState();
    const { sse: sseOverrides, ...stateOverrides } = opts.state ?? {};
    const state: FakeKomgaState = { ...base, ...stateOverrides, sse: { ...base.sse, ...(sseOverrides ?? {}) } };
    const requests: FakeKomgaRequest[] = [];
    const timers = new Set<NodeJS.Timeout>();

    const later = (fn: () => void, ms: number) => {
        const t = setTimeout(() => {
            timers.delete(t);
            fn();
        }, ms);
        timers.add(t);
    };
    const every = (fn: () => void, ms: number) => {
        const t = setInterval(fn, ms);
        timers.add(t);
        return () => {
            clearInterval(t);
            timers.delete(t);
        };
    };

    const send = (res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
        if (res.headersSent || res.destroyed) return;
        if (body === undefined || body === null) {
            res.writeHead(status, headers);
            res.end();
            return;
        }
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
        res.end(text);
    };

    const isAdmin = () => state.user.roles.includes('ADMIN');
    const restrictBook = (b: KomgaBookDto): KomgaBookDto => isAdmin() ? b : { ...b, url: b.url.split(/[\\/]/).pop() ?? '' };
    const bookExists = (id: string) => state.books.some((b) => b.id === id);
    const nameTaken = (name: string, exceptId?: string) =>
        state.readLists.some((r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase());

    function handleSse(res: http.ServerResponse) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.flushHeaders();
        state.sseConnections.opened++;
        const nl = state.sse.lineEnding;
        const sp = state.sse.frameStyle === 'data: ' ? ' ' : '';
        const write = (text: string) => {
            if (!res.destroyed && !res.writableEnded) res.write(text);
        };
        const frame = (event: string, data: unknown) => `event:${sp}${event}${nl}data:${sp}${JSON.stringify(data)}${nl}${nl}`;
        for (const e of state.sse.extraEvents) write(frame(e.event, e.data));

        const frames = state.taskQueueFrames;
        let i = 0;
        const stop = every(() => {
            if (state.sse.heartbeat) write(`:heartbeat${nl}${nl}`);
            if (frames === 'none') return;
            if (i < frames.length) {
                if (isAdmin()) write(frame('TaskQueueStatus', frames[i]));
                i++;
            } else if (state.sse.endAfterFrames) {
                stop();
                if (!res.writableEnded) res.end();
            }
        }, state.sse.intervalMs);
        res.on('close', () => {
            stop();
            state.sseConnections.closed++;
        });
    }

    function handleBooksList(res: http.ServerResponse, query: Record<string, string>, body: unknown) {
        const page = Math.max(parseInt(query.page ?? '0', 10) || 0, 0);
        const size = Math.min(Math.max(parseInt(query.size ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
        state.onBooksListPage?.(page, state);
        const condition = (body as { condition?: unknown } | undefined)?.condition;
        let books = state.books.filter((b) => matchesBook(b, condition));
        const sorter = bookSorter(query.sort);
        if (sorter) books = [...books].sort(sorter);
        send(res, 200, pageOf(books.map(restrictBook), page, size, query.unpaged === 'true'));
    }

    function handleReadLists(req: http.IncomingMessage, res: http.ServerResponse, route: string, query: Record<string, string>, body: unknown) {
        const method = req.method ?? 'GET';
        const idMatch = route.match(/^\/api\/v1\/readlists\/([^/]+)$/);
        if (method !== 'GET' && !isAdmin()) return send(res, 403, springError(403, route, 'Access Denied'));

        if (route === '/api/v1/readlists' && method === 'GET') {
            const all = [...state.readLists].sort((a, b) => a.name.localeCompare(b.name));
            const page = Math.max(parseInt(query.page ?? '0', 10) || 0, 0);
            const size = Math.min(Math.max(parseInt(query.size ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
            return send(res, 200, pageOf(all, page, size, query.unpaged === 'true'));
        }

        const b = (body ?? {}) as { name?: unknown; summary?: unknown; ordered?: unknown; bookIds?: unknown };
        const validate = (creating: boolean): [string, string][] => {
            const errs: [string, string][] = [];
            if (creating || (b.name !== undefined && b.name !== null)) {
                if (typeof b.name !== 'string' || !b.name.trim()) errs.push(['name', 'must not be blank']);
            }
            if (creating || (b.bookIds !== undefined && b.bookIds !== null)) {
                if (!Array.isArray(b.bookIds) || b.bookIds.length === 0) errs.push(['bookIds', 'must not be empty']);
                else if (new Set(b.bookIds).size !== b.bookIds.length) errs.push(['bookIds', 'must only contain unique elements']);
            }
            return errs;
        };

        if (route === '/api/v1/readlists' && method === 'POST') {
            const errs = validate(true);
            if (errs.length) return send(res, 400, violations(errs));
            const name = b.name as string;
            if (nameTaken(name)) return send(res, 400, springError(400, route, 'Read list name already exists'));
            const bookIds = b.bookIds as string[];
            if (!bookIds.every(bookExists)) return send(res, 500, springError(500, route, 'FOREIGN KEY constraint failed'));
            const created = makeKomgaReadList({
                name,
                summary: typeof b.summary === 'string' ? b.summary : '',
                ordered: typeof b.ordered === 'boolean' ? b.ordered : true,
                bookIds: [...bookIds],
            });
            state.readLists.push(created);
            return send(res, 200, created);
        }

        if (idMatch) {
            const id = decodeURIComponent(idMatch[1]);
            const existing = state.readLists.find((r) => r.id === id);
            if (method === 'GET') return existing ? send(res, 200, existing) : send(res, 404, springError(404, route));
            if (method === 'DELETE') {
                if (!existing) return send(res, 404, springError(404, route));
                state.readLists = state.readLists.filter((r) => r.id !== id);
                return send(res, 204);
            }
            if (method === 'PATCH') {
                const errs = validate(false);
                if (errs.length) return send(res, 400, violations(errs));
                if (!existing) return send(res, 404, springError(404, route));
                const name = typeof b.name === 'string' ? b.name : existing.name;
                if (name.toLowerCase() !== existing.name.toLowerCase() && nameTaken(name, existing.id)) {
                    return send(res, 400, springError(400, route, 'Read list name already exists'));
                }
                const bookIds = Array.isArray(b.bookIds) ? b.bookIds as string[] : existing.bookIds;
                if (!bookIds.every(bookExists)) return send(res, 500, springError(500, route, 'FOREIGN KEY constraint failed'));
                Object.assign(existing, {
                    name,
                    summary: typeof b.summary === 'string' ? b.summary : existing.summary,
                    ordered: typeof b.ordered === 'boolean' ? b.ordered : existing.ordered,
                    bookIds: [...bookIds],
                    lastModifiedDate: nowStamp(),
                });
                return send(res, 204);
            }
        }
        return send(res, 404, springError(404, route));
    }

    function dispatch(req: http.IncomingMessage, res: http.ServerResponse, rec: FakeKomgaRequest) {
        const { route: r, query, body } = rec;
        const method = rec.method;

        if (r === '/actuator/health' && method === 'GET') {
            return send(res, state.health === 'UP' ? 200 : 503, { status: state.health });
        }
        if (req.headers['x-api-key'] !== state.apiKey) return send(res, 401);

        if (r.startsWith('/actuator/') && !isAdmin()) return send(res, 403, springError(403, r, 'Access Denied'));
        if (r === '/actuator/info' && method === 'GET') {
            if (state.version === null) return send(res, 200, {});
            return send(res, 200, {
                build: { artifact: 'komga', name: 'komga', time: '2026-10-02T00:00:00.000Z', version: state.version, group: 'org.gotson' },
                java: { version: '21.0.4' },
                os: { name: 'Linux', version: '6.1', arch: 'amd64' },
            });
        }
        if (r === '/actuator/metrics/komga.tasks.execution' && method === 'GET') {
            if (query.tag !== 'type:ScanLibrary' || state.scanMetricsCount === null) return send(res, 404);
            return send(res, 200, {
                name: 'komga.tasks.execution',
                baseUnit: 'seconds',
                measurements: [
                    { statistic: 'COUNT', value: state.scanMetricsCount },
                    { statistic: 'TOTAL_TIME', value: 12.5 },
                    { statistic: 'MAX', value: 0 },
                ],
                availableTags: [],
            });
        }
        if (r === '/api/v2/users/me' && method === 'GET') {
            const { ageRestriction, ...user } = state.user;
            return send(res, 200, ageRestriction ? { ...user, ageRestriction } : user);
        }
        if (r === '/api/v1/libraries' && method === 'GET') {
            return send(res, 200, state.libraries.map((l) => isAdmin() ? l : { ...l, root: '' }));
        }
        const scan = r.match(/^\/api\/v1\/libraries\/([^/]+)\/scan$/);
        if (scan && method === 'POST') {
            if (!isAdmin()) return send(res, 403, springError(403, r, 'Access Denied'));
            const libraryId = decodeURIComponent(scan[1]);
            if (!state.libraries.some((l) => l.id === libraryId)) return send(res, 404, springError(404, r));
            state.scans.push({ libraryId, deep: query.deep === 'true' });
            return send(res, 202);
        }
        if (r === '/api/v1/books/list' && method === 'POST') return handleBooksList(res, query, body);
        const book = r.match(/^\/api\/v1\/books\/([^/]+)$/);
        if (book && method === 'GET') {
            const found = state.books.find((b) => b.id === decodeURIComponent(book[1]));
            return found ? send(res, 200, restrictBook(found)) : send(res, 404);
        }
        if (r === '/api/v1/readlists' || r.startsWith('/api/v1/readlists/')) return handleReadLists(req, res, r, query, body);
        if (r === '/sse/v1/events' && method === 'GET') return handleSse(res);
        return send(res, 404, springError(404, r));
    }

    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const parsed = new URL(req.url ?? '/', 'http://fake.komga');
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let body: unknown;
            let badJson = false;
            if (rawBody) {
                try {
                    body = JSON.parse(rawBody);
                } catch {
                    badJson = true;
                }
            }
            const path = parsed.pathname;
            const inBase = !basePath || path === basePath || path.startsWith(`${basePath}/`);
            const rec: FakeKomgaRequest = {
                method: req.method ?? 'GET',
                path,
                route: inBase ? (path.slice(basePath.length) || '/') : path,
                query: Object.fromEntries(parsed.searchParams.entries()),
                headers: req.headers,
                body,
                rawBody,
            };
            requests.push(rec);
            if (!inBase) return send(res, 404, springError(404, path));
            if (badJson) return send(res, 400, springError(400, rec.route, 'JSON parse error'));

            const failure = state.failures.find((f) =>
                (!f.method || f.method.toUpperCase() === rec.method)
                && (typeof f.path === 'string' ? f.path === rec.route : f.path.test(rec.route))
                && (f.times === undefined || f.times > 0));
            if (!failure) return dispatch(req, res, rec);
            if (failure.times !== undefined) failure.times--;
            const act = () => {
                if (failure.destroy) return req.socket.destroy();
                if (failure.status === undefined) return dispatch(req, res, rec);
                const failBody = failure.body === undefined ? springError(failure.status, rec.route) : failure.body;
                send(res, failure.status, failBody, failure.headers);
            };
            if (failure.delayMs) later(act, failure.delayMs);
            else act();
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}${basePath}`,
        state,
        requests,
        close: async () => {
            for (const t of timers) clearTimeout(t);
            timers.clear();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
