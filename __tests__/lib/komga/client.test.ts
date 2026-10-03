import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KomgaClient, buildKomgaUrl, parseSseChunk, type KomgaClientOptions } from '@/lib/komga/client';
import { KomgaError, isKomgaError } from '@/lib/komga/types';
import {
    startFakeKomga,
    makeKomgaBook,
    makeKomgaLibrary,
    makeKomgaReadList,
    makeKomgaUser,
    waitUntil,
    type FakeKomga,
} from '../../helpers/fake-komga';

/** Awaits `p` and returns the KomgaError it rejected with (fails the test on success or another error). */
async function caught(p: Promise<unknown>): Promise<KomgaError> {
    try {
        await p;
    } catch (e) {
        if (isKomgaError(e)) return e;
        throw e;
    }
    throw new Error('expected a KomgaError');
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
}

/** A base URL nothing listens on: start a fake, note its URL, close it. */
async function closedPortUrl(): Promise<string> {
    const f = await startFakeKomga();
    const url = f.url;
    await f.close();
    return url;
}

describe('buildKomgaUrl', () => {
    it('appends the path to a sub-path base and trims trailing slashes', () => {
        expect(buildKomgaUrl('http://h/komga/', '/api/v1/x')).toBe('http://h/komga/api/v1/x');
        expect(buildKomgaUrl('http://h/komga///', '/api/v1/x')).toBe('http://h/komga/api/v1/x');
        expect(buildKomgaUrl('http://h:25600', '/api/v1/x?y=1')).toBe('http://h:25600/api/v1/x?y=1');
        expect(buildKomgaUrl(' http://h/komga ', 'api/v1/x')).toBe('http://h/komga/api/v1/x');
    });
});

describe('parseSseChunk', () => {
    it('parses Spring-style frames with no space after the colon', () => {
        const { frames, rest } = parseSseChunk('event:TaskQueueStatus\ndata:{"count":1,"countByType":{"ScanLibrary":1}}\n\n');
        expect(frames).toEqual([{ event: 'TaskQueueStatus', data: '{"count":1,"countByType":{"ScanLibrary":1}}' }]);
        expect(rest).toBe('');
    });

    it('accepts a single space after the colon (only one is stripped)', () => {
        const { frames } = parseSseChunk('event: TaskQueueStatus\ndata: {"count":0}\n\ndata:  two\n\n');
        expect(frames).toEqual([
            { event: 'TaskQueueStatus', data: '{"count":0}' },
            { event: null, data: ' two' },
        ]);
    });

    it('handles CRLF and lone CR line endings', () => {
        expect(parseSseChunk('event:A\r\ndata:1\r\n\r\n').frames).toEqual([{ event: 'A', data: '1' }]);
        expect(parseSseChunk('event:B\rdata:2\r\r').frames).toEqual([{ event: 'B', data: '2' }]);
    });

    it('ignores comments / heartbeats, id and retry fields, and frames without data', () => {
        const { frames, rest } = parseSseChunk(':heartbeat\n\nid:7\nretry:1000\nevent:A\ndata:x\n\nevent:NoData\n\n: another comment\n');
        expect(frames).toEqual([{ event: 'A', data: 'x' }]);
        expect(rest).toBe(': another comment\n');
    });

    it('joins multi-line data with newlines', () => {
        expect(parseSseChunk('event:A\ndata:line1\ndata:line2\ndata\n\n').frames).toEqual([{ event: 'A', data: 'line1\nline2\n' }]);
    });

    it('returns an incomplete frame as rest and completes it with the next chunk', () => {
        const first = parseSseChunk('event:TaskQueueStatus\ndata:{"cou');
        expect(first.frames).toEqual([]);
        const second = parseSseChunk(`${first.rest}nt":2}\n`);
        expect(second.frames).toEqual([]);
        const third = parseSseChunk(`${second.rest}\nevent:Next\n`);
        expect(third.frames).toEqual([{ event: 'TaskQueueStatus', data: '{"count":2}' }]);
        expect(third.rest).toBe('event:Next\n');
    });

    it('does not split a frame when a CRLF is cut between chunks', () => {
        const a = parseSseChunk('event:A\r\ndata:1\r');
        expect(a.frames).toEqual([]);
        const b = parseSseChunk(`${a.rest}\ndata:2\r\n\r\n`);
        expect(b.frames).toEqual([{ event: 'A', data: '1\n2' }]);
        expect(b.rest).toBe('');
    });

    it('dispatches a frame completed by a trailing CR at once; the following LF is harmless', () => {
        const a = parseSseChunk('event:A\r\ndata:1\r\n\r');
        expect(a.frames).toEqual([{ event: 'A', data: '1' }]);
        const b = parseSseChunk(`${a.rest}\nevent:B\r\ndata:2\r\n\r\n`);
        expect(b.frames).toEqual([{ event: 'B', data: '2' }]);
        // Lone-CR streams: a frame-ending CR split from its predecessor still completes the frame.
        const c = parseSseChunk('data:x\r');
        expect(c.frames).toEqual([]);
        expect(parseSseChunk(`${c.rest}\r`).frames).toEqual([{ event: null, data: 'x' }]);
    });
});

describe('isKomgaError', () => {
    it('recognises instances and structurally identical errors from another bundle', () => {
        expect(isKomgaError(new KomgaError('timeout', null, 'x'))).toBe(true);
        expect(isKomgaError(Object.assign(new Error('x'), { name: 'KomgaError', kind: 'server', status: 500 }))).toBe(true);
        expect(isKomgaError(Object.assign(new Error('x'), { name: 'KomgaError', kind: 'bogus' }))).toBe(false);
        expect(isKomgaError(new Error('x'))).toBe(false);
        expect(isKomgaError(null)).toBe(false);
    });
});

describe('KomgaClient (against the fake Komga)', () => {
    let fake: FakeKomga;
    const client = (opts: Partial<KomgaClientOptions> = {}) =>
        new KomgaClient({ baseUrl: fake.url, apiKey: fake.state.apiKey, ...opts });

    beforeEach(async () => {
        fake = await startFakeKomga();
    });
    afterEach(async () => {
        await fake.close();
    });

    describe('error mapping', () => {
        it('400 → badRequest with Komga\'s message as detail', async () => {
            fake.state.failures.push({ path: '/api/v1/libraries', status: 400, body: { status: 400, error: 'Bad Request', message: 'bad thing' } });
            const e = await caught(client().listLibraries());
            expect(e).toBeInstanceOf(KomgaError);
            expect(e.kind).toBe('badRequest');
            expect(e.status).toBe(400);
            expect(e.detail).toBe('bad thing');
            expect(e.message).toContain('bad thing');
            expect(e.message).toContain('GET /api/v1/libraries');
        });

        it('401 → unauthorized (bad key, empty body)', async () => {
            const e = await caught(client({ apiKey: 'wrong-key' }).getMe());
            expect(e.kind).toBe('unauthorized');
            expect(e.status).toBe(401);
            expect(e.detail).toBeNull();
        });

        it('403 → forbidden for a non-admin key', async () => {
            fake.state.user = makeKomgaUser({ roles: ['USER'] });
            fake.state.libraries = [makeKomgaLibrary({ id: 'L1' })];
            const e = await caught(client().scanLibrary('L1', false));
            expect(e.kind).toBe('forbidden');
            expect(e.status).toBe(403);
            expect(e.message).toContain('ADMIN');
        });

        it('404 → notFound', async () => {
            const e = await caught(client().getBook('NOPE'));
            expect(e.kind).toBe('notFound');
            expect(e.status).toBe(404);
        });

        it('5xx and other non-2xx → server', async () => {
            fake.state.failures.push({ path: '/api/v1/libraries', status: 500, times: 1 });
            fake.state.failures.push({ path: '/api/v1/libraries', status: 502, body: null, times: 1 });
            fake.state.failures.push({ path: '/api/v1/libraries', status: 418, body: null, times: 1 });
            for (const status of [500, 502, 418]) {
                const e = await caught(client().listLibraries());
                expect(e.kind).toBe('server');
                expect(e.status).toBe(status);
            }
        });

        it('closed port → unreachable with no status', async () => {
            const url = await closedPortUrl();
            const e = await caught(new KomgaClient({ baseUrl: url, apiKey: 'k' }).listLibraries());
            expect(e.kind).toBe('unreachable');
            expect(e.status).toBeNull();
            expect(e.message).toContain('ECONNREFUSED');
        });

        it('an invalid base URL → unreachable', async () => {
            const e = await caught(new KomgaClient({ baseUrl: 'not a url', apiKey: 'k' }).listLibraries());
            expect(e.kind).toBe('unreachable');
        });

        it('no response within timeoutMs → timeout', async () => {
            fake.state.failures.push({ path: '/api/v1/libraries', status: 200, body: [], delayMs: 2000 });
            const started = Date.now();
            const e = await caught(client({ timeoutMs: 100 }).listLibraries());
            expect(e.kind).toBe('timeout');
            expect(e.status).toBeNull();
            expect(Date.now() - started).toBeLessThan(1500);
        });

        it('a 200 HTML page (proxy / login page) → server, with a hint', async () => {
            fake.state.failures.push({ path: '/api/v1/libraries', status: 200, body: '<!DOCTYPE html><html><body>Sign in</body></html>' });
            const e = await caught(client().listLibraries());
            expect(e.kind).toBe('server');
            expect(e.message).toMatch(/non-JSON/);
            expect(e.message).toMatch(/HTML/);
        });

        it('a JSON body of the wrong shape → server', async () => {
            fake.state.failures.push({ path: '/api/v1/libraries', status: 200, body: { not: 'an array' } });
            expect((await caught(client().listLibraries())).kind).toBe('server');
        });

        it('does not follow redirects (the key would go to the redirect target) and names only the origin', async () => {
            fake.state.failures.push({
                path: '/api/v1/libraries', status: 302, body: null,
                headers: { Location: 'https://elsewhere.example/steal?token=abc' },
            });
            const e = await caught(client().listLibraries());
            expect(e.kind).toBe('server');
            expect(e.status).toBe(302);
            expect(e.message).toContain('https://elsewhere.example');
            expect(e.message).not.toContain('steal');
            expect(fake.requests).toHaveLength(1);
        });

        it('maps Komga validation violations into the detail', async () => {
            const e = await caught(client().createReadList({ name: 'X', summary: '', ordered: true, bookIds: [] }));
            expect(e.kind).toBe('badRequest');
            expect(e.detail).toBe('bookIds: must not be empty');
        });

        it('uses the injected fetchImpl and maps its network errors', async () => {
            const fetchImpl = vi.fn(async () => {
                throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
            });
            const e = await caught(new KomgaClient({ baseUrl: 'http://komga.lan', apiKey: 'k', fetchImpl }).getMe());
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect(fetchImpl.mock.calls[0]).toBeDefined();
            expect(e.kind).toBe('unreachable');
            expect(e.message).toContain('komga.lan');
            expect(e.message).toContain('ECONNRESET');
        });
    });

    describe('headers and API key safety', () => {
        it('sends X-API-Key, Accept, User-Agent and the custom headers; custom headers cannot override the key', async () => {
            await client({ headers: { 'CF-Access-Client-Id': 'cf-id', 'X-Custom': 'v1', 'x-api-key': 'evil' } }).getMe();
            const h = fake.requests[0].headers;
            expect(h['x-api-key']).toBe(fake.state.apiKey);
            expect(h.accept).toBe('application/json');
            expect(h['user-agent']).toBe('Omnibus/1.0');
            expect(h['cf-access-client-id']).toBe('cf-id');
            expect(h['x-custom']).toBe('v1');
        });

        it('health() is anonymous: no key, but custom headers still go out', async () => {
            const res = await client({ apiKey: 'wrong-key', headers: { 'X-Custom': 'v1' } }).health();
            expect(res).toEqual({ status: 'UP' });
            expect(fake.requests[0].headers['x-api-key']).toBeUndefined();
            expect(fake.requests[0].headers['x-custom']).toBe('v1');
        });

        it('sends JSON bodies with Content-Type application/json', async () => {
            fake.state.books = [makeKomgaBook({ id: 'B1' })];
            await client().createReadList({ name: 'A', summary: 's', ordered: true, bookIds: ['B1'] });
            expect(fake.requests[0].headers['content-type']).toBe('application/json');
            expect(fake.requests[0].body).toEqual({ name: 'A', summary: 's', ordered: true, bookIds: ['B1'] });
        });

        it('never puts the key into error messages, even when a proxy echoes it', async () => {
            const key = fake.state.apiKey;
            fake.state.failures.push({ path: '/api/v1/libraries', status: 500, body: { message: `upstream saw X-API-Key: ${key}` } });
            const errors = [
                await caught(client().listLibraries()),
                await caught(client({ apiKey: `${key}-wrong` }).getMe()),
                await caught(new KomgaClient({ baseUrl: await closedPortUrl(), apiKey: key }).getMe()),
            ];
            fake.state.failures.push({ path: '/api/v2/users/me', status: 200, body: {}, delayMs: 1000 });
            errors.push(await caught(client({ timeoutMs: 50 }).getMe()));
            for (const e of errors) {
                expect(e.message).not.toContain(key);
                expect(String(e.detail)).not.toContain(key);
                expect(JSON.stringify(e)).not.toContain(key);
            }
            expect(errors[0].message).toContain('[redacted]');
        });

        it('keeps the key out of the client object itself', () => {
            const c = client({ headers: { 'X-Secret-Header': 'super-secret-value' } });
            expect(JSON.stringify(c)).not.toContain(fake.state.apiKey);
            expect(JSON.stringify(c)).not.toContain('super-secret-value');
            expect(Object.values(c).join(' ')).not.toContain(fake.state.apiKey);
        });

        it('rejects an unsendable key without echoing it and without a request', async () => {
            const e = await caught(client({ apiKey: 'abc\ndef-secret' }).getMe());
            expect(e.kind).toBe('unauthorized');
            expect(e.message).not.toContain('def-secret');
            expect(fake.requests).toHaveLength(0);
        });
    });

    describe('sub-path base URL', () => {
        it('really requests under the sub-path', async () => {
            const sub = await startFakeKomga({ basePath: '/komga', state: { libraries: [makeKomgaLibrary({ id: 'L1', name: 'Comics' })] } });
            try {
                expect(sub.url).toMatch(/\/komga$/);
                const libs = await new KomgaClient({ baseUrl: `${sub.url}/`, apiKey: sub.state.apiKey }).listLibraries();
                expect(libs.map((l) => l.id)).toEqual(['L1']);
                expect(sub.requests.map((r) => r.path)).toEqual(['/komga/api/v1/libraries']);
                // Without the sub-path the fake (like a reverse proxy) answers 404.
                const root = sub.url.replace(/\/komga$/, '');
                const e = await caught(new KomgaClient({ baseUrl: root, apiKey: sub.state.apiKey }).listLibraries());
                expect(e.kind).toBe('notFound');
            } finally {
                await sub.close();
            }
        });
    });

    describe('server info', () => {
        it('health() reports DOWN as a server error with the status', async () => {
            fake.state.health = 'DOWN';
            const e = await caught(client().health());
            expect(e.kind).toBe('server');
            expect(e.status).toBe(503);
            expect(e.message).toContain('DOWN');
        });

        it('getMe() normalizes the omitted ageRestriction to null and keeps a present one', async () => {
            const me = await client().getMe();
            expect(me.roles).toContain('ADMIN');
            expect(me.ageRestriction).toBeNull();
            expect(me.labelsAllow).toEqual([]);
            fake.state.user = makeKomgaUser({ ageRestriction: { age: 16, restriction: 'ALLOW_ONLY' }, labelsExclude: ['adult'] });
            const restricted = await client().getMe();
            expect(restricted.ageRestriction).toEqual({ age: 16, restriction: 'ALLOW_ONLY' });
            expect(restricted.labelsExclude).toEqual(['adult']);
        });

        it('getInfo() reads build.version, null when absent', async () => {
            expect(await client().getInfo()).toEqual({ version: '1.28.1' });
            fake.state.version = null;
            expect(await client().getInfo()).toEqual({ version: null });
            expect(fake.requests[0].route).toBe('/actuator/info');
        });

        it('listLibraries() returns the DTOs with the admin root', async () => {
            fake.state.libraries = [makeKomgaLibrary({ id: 'L1', root: '/data/comics', scanDirectoryExclusions: ['#recycle'] })];
            const [lib] = await client().listLibraries();
            expect(lib).toMatchObject({ id: 'L1', root: '/data/comics', hashFiles: true, scanCbx: true, oneshotsDirectory: null });
            expect(lib.scanDirectoryExclusions).toEqual(['#recycle']);
        });
    });

    describe('scanLibrary', () => {
        it('POSTs the scan with the deep flag and resolves on 202', async () => {
            fake.state.libraries = [makeKomgaLibrary({ id: 'L1' })];
            await client().scanLibrary('L1', false);
            await client().scanLibrary('L1', true);
            expect(fake.state.scans).toEqual([{ libraryId: 'L1', deep: false }, { libraryId: 'L1', deep: true }]);
            expect(fake.requests.map((r) => `${r.method} ${r.route} ${r.query.deep}`)).toEqual([
                'POST /api/v1/libraries/L1/scan false',
                'POST /api/v1/libraries/L1/scan true',
            ]);
        });

        it('unknown library → notFound', async () => {
            expect((await caught(client().scanLibrary('NOPE', false))).kind).toBe('notFound');
        });
    });

    describe('readTaskQueue', () => {
        const status = { count: 3, countByType: { ScanLibrary: 1, AnalyzeBook: 2 } };

        it('returns the first TaskQueueStatus frame, skipping other events, then closes the connection', async () => {
            fake.state.taskQueueFrames = [status, { count: 0, countByType: {} }];
            fake.state.sse.extraEvents = [{ event: 'BookAdded', data: { bookId: 'B1', seriesId: 'S1', libraryId: 'L1' } }];
            // A long timeout, so the close below can only come from the explicit abort, not the timer.
            const res = await client().readTaskQueue({ timeoutMs: 10_000 });
            expect(res).toEqual({ ok: true, status });
            const req = fake.requests[0];
            expect(req.route).toBe('/sse/v1/events');
            expect(req.headers.accept).toBe('text/event-stream');
            expect(req.headers['x-api-key']).toBe(fake.state.apiKey);
            await waitUntil(() => fake.state.sseConnections.closed === 1, 500);
        });

        it('parses "data: " frames with CRLF line endings and heartbeats', async () => {
            fake.state.taskQueueFrames = [status];
            fake.state.sse = { ...fake.state.sse, frameStyle: 'data: ', lineEnding: '\r\n', heartbeat: true };
            expect(await client().readTaskQueue({ timeoutMs: 2000 })).toEqual({ ok: true, status });
        });

        it('no frame within the timeout → timeout, and the server sees the connection close', async () => {
            fake.state.taskQueueFrames = 'none';
            fake.state.sse.heartbeat = true;
            const started = Date.now();
            expect(await client().readTaskQueue({ timeoutMs: 200 })).toEqual({ ok: false, reason: 'timeout' });
            expect(Date.now() - started).toBeLessThan(1500);
            await waitUntil(() => fake.state.sseConnections.closed === 1);
            expect(fake.state.sseConnections.opened).toBe(1);
        });

        it('a non-admin never gets TaskQueueStatus → timeout', async () => {
            fake.state.user = makeKomgaUser({ roles: ['USER'] });
            expect(await client().readTaskQueue({ timeoutMs: 150 })).toEqual({ ok: false, reason: 'timeout' });
        });

        it('response headers not received within the timeout → timeout', async () => {
            fake.state.failures.push({ path: '/sse/v1/events', delayMs: 2000 });
            expect(await client().readTaskQueue({ timeoutMs: 100 })).toEqual({ ok: false, reason: 'timeout' });
        });

        it('404 → unsupported', async () => {
            fake.state.failures.push({ path: '/sse/v1/events', status: 404 });
            expect(await client().readTaskQueue({ timeoutMs: 500 })).toEqual({ ok: false, reason: 'unsupported' });
        });

        it('stream closed before a frame → ended', async () => {
            fake.state.taskQueueFrames = [];
            fake.state.sse.endAfterFrames = true;
            expect(await client().readTaskQueue({ timeoutMs: 2000 })).toEqual({ ok: false, reason: 'ended' });
        });

        it('throws for 401 / 403 / unreachable', async () => {
            expect((await caught(client({ apiKey: 'wrong' }).readTaskQueue({ timeoutMs: 500 }))).kind).toBe('unauthorized');
            fake.state.failures.push({ path: '/sse/v1/events', status: 403 });
            expect((await caught(client().readTaskQueue({ timeoutMs: 500 }))).kind).toBe('forbidden');
            const url = await closedPortUrl();
            expect((await caught(new KomgaClient({ baseUrl: url, apiKey: 'k' }).readTaskQueue({ timeoutMs: 500 }))).kind).toBe('unreachable');
        });
    });

    describe('listBooks', () => {
        const LIB = 'L1';
        const seed = (n: number) => {
            // Inserted out of url order; plus a soft-deleted book and one from another library.
            const books = Array.from({ length: n }, (_, i) => makeKomgaBook({ id: `B${i}`, libraryId: LIB, url: `/comics/S/${String(n - i).padStart(3, '0')}.cbz` }));
            books.push(makeKomgaBook({ id: 'DEL', libraryId: LIB, url: '/comics/S/000-deleted.cbz', deleted: true }));
            books.push(makeKomgaBook({ id: 'OTHER', libraryId: 'L2', url: '/other/001.cbz' }));
            fake.state.books = books;
        };
        const pagesRequested = () => fake.requests.filter((r) => r.route === '/api/v1/books/list').map((r) => Number(r.query.page));

        it('iterates every page in url order with the library + not-deleted condition', async () => {
            seed(5);
            const books = await collect(client().listBooks(LIB, { pageSize: 2 }));
            expect(books.map((b) => b.url)).toEqual(['001', '002', '003', '004', '005'].map((n) => `/comics/S/${n}.cbz`));
            expect(pagesRequested()).toEqual([0, 1, 2]);
            const req = fake.requests[0];
            expect(req.method).toBe('POST');
            expect(req.query).toEqual({ page: '0', size: '2', sort: 'url,asc' });
            expect(req.body).toEqual({
                condition: { allOf: [{ libraryId: { operator: 'is', value: LIB } }, { deleted: { operator: 'isFalse' } }] },
            });
        });

        it('defaults to KOMGA_BOOKS_PAGE_SIZE and clamps the page size at 2000', async () => {
            seed(1);
            await collect(client().listBooks(LIB));
            await collect(client().listBooks(LIB, { pageSize: 5000 }));
            expect(fake.requests.map((r) => r.query.size)).toEqual(['1000', '2000']);
        });

        it('an empty library yields nothing after one request', async () => {
            expect(await collect(client().listBooks('EMPTY'))).toEqual([]);
            expect(pagesRequested()).toEqual([0]);
        });

        it('restarts once from page 0 when totalElements changes mid-iteration, yielding only the second pass', async () => {
            seed(5);
            let added = false;
            fake.state.onBooksListPage = (page, state) => {
                if (page === 1 && !added) {
                    added = true;
                    state.books.push(makeKomgaBook({ id: 'NEW', libraryId: LIB, url: '/comics/S/0025.cbz' }));
                }
            };
            const books = await collect(client().listBooks(LIB, { pageSize: 2 }));
            expect(pagesRequested()).toEqual([0, 1, 0, 1, 2]);
            expect(books.map((b) => b.id).sort()).toEqual(['B0', 'B1', 'B2', 'B3', 'B4', 'NEW']);
            expect(new Set(books.map((b) => b.id)).size).toBe(books.length);
        });

        it('accepts the second pass even if totalElements changes again (restart only once)', async () => {
            seed(5);
            let n = 0;
            fake.state.onBooksListPage = (page, state) => {
                if (page === 1) state.books.push(makeKomgaBook({ id: `NEW${n++}`, libraryId: LIB, url: `/comics/S/9${n}.cbz` }));
            };
            const books = await collect(client().listBooks(LIB, { pageSize: 2 }));
            expect(pagesRequested().filter((p) => p === 0)).toHaveLength(2);
            expect(pagesRequested()).toEqual([0, 1, 0, 1, 2, 3]);
            expect(books).toHaveLength(7);
        });

        it('a failure during the first pass throws without yielding anything', async () => {
            seed(5);
            fake.state.onBooksListPage = (page, state) => {
                if (page === 0) state.failures.push({ path: '/api/v1/books/list', status: 500, times: 1 });
            };
            const yielded: string[] = [];
            const e = await caught((async () => {
                for await (const b of client().listBooks(LIB, { pageSize: 2 })) yielded.push(b.id);
            })());
            expect(e.kind).toBe('server');
            expect(yielded).toEqual([]);
        });

        it('applies the per-page timeout', async () => {
            seed(1);
            fake.state.failures.push({ path: '/api/v1/books/list', delayMs: 2000 });
            const e = await caught(collect(client().listBooks(LIB, { pageTimeoutMs: 100 })));
            expect(e.kind).toBe('timeout');
        });
    });

    describe('getBook', () => {
        it('returns the BookDto with the plain filesystem url, links and fileLastModified', async () => {
            fake.state.books = [makeKomgaBook({
                id: 'B1', url: '/comics/Saga (2012)/Saga 001.cbz', fileLastModified: '2026-03-04T05:06:07Z',
                metadata: { links: [{ label: 'comicvine.gamespot.com', url: 'https://comicvine.gamespot.com/x/4000-1/' }] },
            })];
            const b = await client().getBook('B1');
            expect(b.url).toBe('/comics/Saga (2012)/Saga 001.cbz');
            expect(b.fileLastModified).toBe('2026-03-04T05:06:07Z');
            expect(b.metadata.links[0].label).toBe('comicvine.gamespot.com');
        });
    });

    describe('scanMetricsCount', () => {
        it('404 (never recorded) → 0', async () => {
            expect(await client().scanMetricsCount()).toBe(0);
            expect(fake.requests[0].route).toBe('/actuator/metrics/komga.tasks.execution');
            expect(fake.requests[0].query).toEqual({ tag: 'type:ScanLibrary' });
        });

        it('parses the COUNT measurement', async () => {
            fake.state.scanMetricsCount = 7;
            expect(await client().scanMetricsCount()).toBe(7);
        });

        it('other failures → null (never throws)', async () => {
            fake.state.user = makeKomgaUser({ roles: ['USER'] });
            expect(await client().scanMetricsCount()).toBeNull();
            fake.state.user = makeKomgaUser();
            fake.state.failures.push({ path: '/actuator/metrics/komga.tasks.execution', status: 200, body: { name: 'x', measurements: [] } });
            expect(await client().scanMetricsCount()).toBeNull();
            const url = await closedPortUrl();
            expect(await new KomgaClient({ baseUrl: url, apiKey: 'k' }).scanMetricsCount()).toBeNull();
        });
    });

    describe('read lists', () => {
        beforeEach(() => {
            fake.state.books = [
                makeKomgaBook({ id: 'B1' }),
                makeKomgaBook({ id: 'B2' }),
                makeKomgaBook({ id: 'B3', deleted: true }),
            ];
        });

        it('lists with ?unpaged=true and never ?search=', async () => {
            fake.state.readLists = [makeKomgaReadList({ id: 'R2', name: 'Zeta' }), makeKomgaReadList({ id: 'R1', name: 'Alpha' })];
            const lists = await client().listReadLists();
            expect(lists.map((l) => l.id)).toEqual(['R1', 'R2']);
            expect(fake.requests[0].query).toEqual({ unpaged: 'true' });
        });

        it('creates a list, preserving book order (soft-deleted books pass the FK check)', async () => {
            const created = await client().createReadList({ name: 'Civil War', summary: 'm', ordered: true, bookIds: ['B2', 'B3', 'B1'] });
            expect(created.id).toBeTruthy();
            expect(created).toMatchObject({ name: 'Civil War', summary: 'm', ordered: true, bookIds: ['B2', 'B3', 'B1'], filtered: false });
            expect(fake.state.readLists).toHaveLength(1);
        });

        it('duplicate name (case-insensitive) → badRequest with Komga\'s message', async () => {
            fake.state.readLists = [makeKomgaReadList({ name: 'Civil War', bookIds: ['B1'] })];
            const e = await caught(client().createReadList({ name: 'civil war', summary: '', ordered: true, bookIds: ['B1'] }));
            expect(e.kind).toBe('badRequest');
            expect(e.detail).toBe('Read list name already exists');
        });

        it('duplicate bookIds → badRequest; unknown bookId → server with no change', async () => {
            expect((await caught(client().createReadList({ name: 'A', summary: '', ordered: true, bookIds: ['B1', 'B1'] }))).kind).toBe('badRequest');
            const e = await caught(client().createReadList({ name: 'A', summary: '', ordered: true, bookIds: ['B1', 'GONE'] }));
            expect(e.kind).toBe('server');
            expect(e.status).toBe(500);
            expect(fake.state.readLists).toEqual([]);
        });

        it('PATCHes only the given fields and fully replaces bookIds', async () => {
            fake.state.readLists = [makeKomgaReadList({ id: 'R1', name: 'Arc', summary: 'keep', bookIds: ['B1', 'B2'] })];
            await client().updateReadList('R1', { bookIds: ['B2'], name: undefined });
            const req = fake.requests[0];
            expect(req.method).toBe('PATCH');
            expect(req.route).toBe('/api/v1/readlists/R1');
            expect(JSON.parse(req.rawBody)).toEqual({ bookIds: ['B2'] });
            expect(fake.state.readLists[0]).toMatchObject({ name: 'Arc', summary: 'keep', bookIds: ['B2'] });
        });

        it('PATCH errors: unknown list → notFound; unknown book → server with no change; empty bookIds → badRequest', async () => {
            fake.state.readLists = [makeKomgaReadList({ id: 'R1', bookIds: ['B1'] })];
            expect((await caught(client().updateReadList('NOPE', { bookIds: ['B1'] }))).kind).toBe('notFound');
            expect((await caught(client().updateReadList('R1', { bookIds: ['B1', 'GONE'] }))).kind).toBe('server');
            expect((await caught(client().updateReadList('R1', { bookIds: [] }))).kind).toBe('badRequest');
            expect(fake.state.readLists[0].bookIds).toEqual(['B1']);
        });

        it('deletes a list (204) and maps an unknown id to notFound', async () => {
            fake.state.readLists = [makeKomgaReadList({ id: 'R1', bookIds: ['B1'] })];
            await client().deleteReadList('R1');
            expect(fake.state.readLists).toEqual([]);
            expect((await caught(client().deleteReadList('R1'))).kind).toBe('notFound');
        });

        it('read-list writes need ADMIN → forbidden', async () => {
            fake.state.user = makeKomgaUser({ roles: ['USER'] });
            expect((await caught(client().createReadList({ name: 'A', summary: '', ordered: true, bookIds: ['B1'] }))).kind).toBe('forbidden');
        });
    });
});
