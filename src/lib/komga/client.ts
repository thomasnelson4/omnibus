// src/lib/komga/client.ts
//
// Minimal typed Komga client (REST + one short-lived SSE read) on global fetch. Every method maps
// failures to KomgaError (see types.ts) so callers branch on `kind`, never on fetch internals.
//
// Wire facts verified in the Komga 1.28.1 source (docs/komga-integration/PLAN.md §2):
//  - Auth is the X-API-Key header (Komga >= 1.20.0) on /api/**, /sse/** and actuator; only
//    /actuator/health is anonymous, so health() sends no key. No cookie jar is kept: an API key sent
//    together with a session returned empty content before 1.23.5.
//  - Error bodies are Spring Boot's error JSON ({status, error, message, path}; server.error.include-
//    message=always) or Komga's ValidationErrorResponse ({violations:[{fieldName, message}]}).
//    A bad key gets a bare 401 with no body.
//  - SSE frames come from Spring's SseEmitter: `event:Name\ndata:{json}\n\n` (no space after the
//    colon) and `:heartbeat\n\n` comments (Komga >= 1.24.0). TaskQueueStatus is admin-only and only
//    emitted every 10 s while at least one client is connected, so readTaskQueue() waits up to 25 s.
//  - /actuator/info carries `build.version`; /actuator/metrics/{name}?tag=k:v returns
//    {name, measurements:[{statistic:'COUNT'|'TOTAL_TIME'|'MAX', value}], availableTags}, and 404 for
//    a tag value that has never been recorded.
//
// The API key is a full Komga ADMIN credential: it lives in a #private field (invisible to
// JSON.stringify / console.log of the client), custom headers can never override it, redirects are
// not followed (fetch would forward X-API-Key to the redirect target), and every error message is
// scrubbed of it.
import {
    KOMGA_BOOKS_MAX_PAGE_SIZE,
    KOMGA_BOOKS_PAGE_SIZE,
    KOMGA_BOOKS_PAGE_TIMEOUT_MS,
    KOMGA_HTTP_TIMEOUT_MS,
    KOMGA_SSE_MAX_BUFFER_BYTES,
    KOMGA_SSE_TASK_QUEUE_EVENT,
    KOMGA_SSE_TIMEOUT_MS,
    KOMGA_USER_AGENT,
} from './constants';
import {
    KomgaError,
    isKomgaError,
    type KomgaBookDto,
    type KomgaErrorKind,
    type KomgaLibraryDto,
    type KomgaMetricDto,
    type KomgaPage,
    type KomgaReadListCreateDto,
    type KomgaReadListDto,
    type KomgaReadListUpdateDto,
    type KomgaTaskQueueStatus,
    type KomgaUserDto,
} from './types';

export interface KomgaClientOptions {
    /** May include a sub-path: http://host/komga */
    baseUrl: string;
    apiKey: string;
    /** Global custom headers (CustomHeader rows), applied like Prowlarr's. Cannot override X-API-Key. */
    headers?: Record<string, string>;
    /** Test seam; defaults to the global fetch (resolved per call, so vi.stubGlobal works). */
    fetchImpl?: typeof fetch;
    /** Per-request timeout for small calls; default KOMGA_HTTP_TIMEOUT_MS. */
    timeoutMs?: number;
}

/** `${base}${path}` with the base's trailing slashes trimmed. Never `new URL(path, base)`: that drops a sub-path base. */
export function buildKomgaUrl(base: string, path: string): string {
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${base.trim().replace(/\/+$/, '')}${p}`;
}

export type KomgaTaskQueueRead =
    | { ok: true; status: KomgaTaskQueueStatus }
    | { ok: false; reason: 'timeout' | 'ended' | 'unsupported' };   // "SSE unavailable"

export interface SseFrame { event: string | null; data: string }

/**
 * Splits complete SSE frames off `buffer` (frames end at a blank line) and returns the unconsumed
 * remainder to prepend to the next chunk. Accepts `field:value` and `field: value`, CRLF / LF / CR
 * line endings, multi-line data (joined with '\n'); ignores `:` comment lines (heartbeats), id/retry
 * and frames without data, as the EventSource spec does.
 */
export function parseSseChunk(buffer: string): { frames: SseFrame[]; rest: string } {
    // A trailing CR may be the first half of a CRLF split across chunks: if it doesn't complete a
    // frame, hold it back, since reading it as a line end would turn the next chunk's LF into a
    // spurious frame boundary. If it does complete one, a following LF is just a harmless empty line.
    let held = '';
    let normalized = buffer.replace(/\r\n?/g, '\n');
    if (buffer.endsWith('\r') && !normalized.endsWith('\n\n')) {
        held = '\r';
        normalized = normalized.slice(0, -1);
    }
    const frames: SseFrame[] = [];
    let start = 0;
    for (;;) {
        const end = normalized.indexOf('\n\n', start);
        if (end === -1) break;
        const frame = parseSseBlock(normalized.slice(start, end));
        if (frame) frames.push(frame);
        start = end + 2;
    }
    return { frames, rest: normalized.slice(start) + held };
}

function parseSseBlock(block: string): SseFrame | null {
    let event: string | null = null;
    const data: string[] = [];
    for (const line of block.split('\n')) {
        if (line === '' || line.startsWith(':')) continue;
        const idx = line.indexOf(':');
        const field = idx === -1 ? line : line.slice(0, idx);
        let value = idx === -1 ? '' : line.slice(idx + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
    }
    return data.length > 0 ? { event, data: data.join('\n') } : null;
}

function parseTaskQueueStatus(data: string): KomgaTaskQueueStatus | null {
    let o: unknown;
    try {
        o = JSON.parse(data);
    } catch {
        return null;
    }
    if (!o || typeof o !== 'object') return null;
    const raw = o as { count?: unknown; countByType?: unknown };
    const hasCount = typeof raw.count === 'number' && Number.isFinite(raw.count);
    const hasByType = !!raw.countByType && typeof raw.countByType === 'object';
    if (!hasCount && !hasByType) return null;
    const countByType: Record<string, number> = {};
    if (hasByType) {
        for (const [k, v] of Object.entries(raw.countByType as Record<string, unknown>)) {
            if (typeof v === 'number' && Number.isFinite(v)) countByType[k] = v;
        }
    }
    const count = hasCount ? raw.count as number : Object.values(countByType).reduce((a, b) => a + b, 0);
    return { count, countByType };
}

const MAX_ERROR_DETAIL = 300;
// Safety net for a server that keeps answering last=false; 10k pages of 1000 is far beyond any library.
const MAX_BOOK_PAGES = 10_000;

function truncate(s: string): string {
    return s.length > MAX_ERROR_DETAIL ? `${s.slice(0, MAX_ERROR_DETAIL)}…` : s;
}

function looksLikeHtml(text: string): boolean {
    return /^\s*(<!doctype html|<html|<head|<body)/i.test(text);
}

/** Komga's own explanation from an error body, if it sent one. Never throws. */
async function readErrorDetail(res: Response): Promise<string | null> {
    let text: string;
    try {
        text = (await res.text()).slice(0, 8000);
    } catch {
        return null;
    }
    if (!text.trim()) return null;
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        if (looksLikeHtml(text)) return 'an HTML page instead of a Komga response (reverse proxy or login page?)';
        return truncate(text.trim().replace(/\s+/g, ' '));
    }
    if (!body || typeof body !== 'object') return null;
    const b = body as { message?: unknown; violations?: unknown; status?: unknown; error?: unknown; detail?: unknown };
    if (typeof b.message === 'string' && b.message.trim() && b.message !== 'No message available') return truncate(b.message.trim());
    if (Array.isArray(b.violations)) {
        const parts = b.violations
            .map((v: { fieldName?: unknown; message?: unknown } | null) => {
                const msg = typeof v?.message === 'string' ? v.message : '';
                const field = typeof v?.fieldName === 'string' ? v.fieldName : '';
                return field && msg ? `${field}: ${msg}` : (msg || field);
            })
            .filter(Boolean);
        if (parts.length) return truncate(parts.join('; '));
    }
    if (typeof b.detail === 'string' && b.detail.trim()) return truncate(b.detail.trim());   // ProblemDetail
    if (typeof b.status === 'string' && b.status.trim()) return `status ${b.status.trim()}`;  // actuator health DOWN
    if (typeof b.error === 'string' && b.error.trim()) return truncate(b.error.trim());
    return null;
}

/** Short reason for a fetch() rejection: the socket error code when there is one. */
function describeNetworkError(e: unknown): string {
    const err = e as { message?: unknown; code?: unknown; cause?: unknown } | null;
    const cause = err?.cause as { code?: unknown; message?: unknown; errors?: { code?: unknown }[] } | undefined;
    const code = cause?.code ?? cause?.errors?.find((x) => typeof x?.code === 'string')?.code ?? err?.code;
    if (code === 'ERR_INVALID_URL') return 'invalid URL';
    if (typeof code === 'string' && code) return code;
    if (typeof cause?.message === 'string' && cause.message) return cause.message;
    if (typeof err?.message === 'string' && err.message) return err.message;
    return 'network error';
}

function describeStatus(status: number, where: string): { kind: KomgaErrorKind; message: string } {
    switch (status) {
        case 400: return { kind: 'badRequest', message: `Komga rejected ${where} (HTTP 400)` };
        case 401: return { kind: 'unauthorized', message: `Komga rejected the API key (HTTP 401) on ${where}` };
        case 403: return { kind: 'forbidden', message: `Komga denied ${where} (HTTP 403); the API key's user needs the ADMIN role` };
        case 404: return { kind: 'notFound', message: `Komga returned HTTP 404 for ${where}` };
        default: return { kind: 'server', message: `Komga returned HTTP ${status} for ${where}` };
    }
}

interface SendOptions {
    timeoutMs: number;
    signal: AbortSignal;
    body?: unknown;
    /** Send X-API-Key (default true). */
    auth?: boolean;
    accept?: string;
}

export class KomgaClient {
    readonly baseUrl: string;
    readonly #apiKey: string;
    readonly #headers: Record<string, string>;
    readonly #fetch: typeof fetch;
    readonly #timeoutMs: number;

    constructor(opts: KomgaClientOptions) {
        this.baseUrl = (opts.baseUrl ?? '').trim().replace(/\/+$/, '');
        this.#apiKey = (opts.apiKey ?? '').trim();
        this.#headers = { ...(opts.headers ?? {}) };
        this.#fetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
        this.#timeoutMs = opts.timeoutMs ?? KOMGA_HTTP_TIMEOUT_MS;
    }

    /** Anonymous reachability check; Komga answers {"status":"UP"} (503 + DOWN when unhealthy). */
    async health(): Promise<{ status: string }> {
        const body = await this.json<{ status?: unknown } | null>('GET', '/actuator/health', { auth: false });
        return { status: typeof body?.status === 'string' ? body.status : 'UNKNOWN' };
    }

    async getMe(): Promise<KomgaUserDto> {
        const path = '/api/v2/users/me';
        const u = await this.json<Partial<KomgaUserDto> | null>('GET', path);
        if (!u || typeof u !== 'object' || typeof u.id !== 'string') throw this.unexpected('GET', path);
        const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        return {
            ...u,
            id: u.id,
            email: typeof u.email === 'string' ? u.email : '',
            roles: list(u.roles),
            sharedAllLibraries: u.sharedAllLibraries === true,
            sharedLibrariesIds: list(u.sharedLibrariesIds),
            labelsAllow: list(u.labelsAllow),
            labelsExclude: list(u.labelsExclude),
            ageRestriction: u.ageRestriction ?? null,
        };
    }

    /** /actuator/info (ADMIN) → build.version, e.g. "1.28.1"; null when the build block is absent. */
    async getInfo(): Promise<{ version: string | null }> {
        const info = await this.json<{ build?: { version?: unknown } } | null>('GET', '/actuator/info');
        const v = info?.build?.version;
        return { version: typeof v === 'string' && v.trim() ? v.trim() : null };
    }

    async listLibraries(): Promise<KomgaLibraryDto[]> {
        const path = '/api/v1/libraries';
        const libs = await this.json<unknown>('GET', path);
        if (!Array.isArray(libs)) throw this.unexpected('GET', path);
        return (libs as KomgaLibraryDto[]).map((l) => ({
            ...l,
            scanDirectoryExclusions: Array.isArray(l.scanDirectoryExclusions) ? l.scanDirectoryExclusions : [],
            oneshotsDirectory: l.oneshotsDirectory ?? null,
        }));
    }

    /** Queues a library-wide scan (202). Komga merges a request into an identical queued scan. */
    async scanLibrary(libraryId: string, deep: boolean): Promise<void> {
        await this.noContent('POST', `/api/v1/libraries/${encodeURIComponent(libraryId)}/scan?deep=${deep ? 'true' : 'false'}`);
    }

    /**
     * Every non-deleted book of a library, in url order. Komga pages by offset, so books added or
     * removed while paging shift the window: if totalElements changes during the first pass, that
     * pass is discarded (it is buffered, nothing was yielded) and the listing restarts once from page
     * 0; the second pass is accepted as-is and streamed. A thrown error mid-iteration means the
     * listing is incomplete.
     */
    async *listBooks(libraryId: string, opts: { pageSize?: number; pageTimeoutMs?: number } = {}): AsyncGenerator<KomgaBookDto> {
        const requested = typeof opts.pageSize === 'number' && Number.isFinite(opts.pageSize) ? Math.floor(opts.pageSize) : KOMGA_BOOKS_PAGE_SIZE;
        const size = Math.min(Math.max(requested, 1), KOMGA_BOOKS_MAX_PAGE_SIZE);
        const timeoutMs = opts.pageTimeoutMs ?? KOMGA_BOOKS_PAGE_TIMEOUT_MS;
        const body = {
            condition: {
                allOf: [
                    { libraryId: { operator: 'is', value: libraryId } },
                    { deleted: { operator: 'isFalse' } },
                ],
            },
        };

        const firstPass: KomgaBookDto[] = [];
        let initialTotal: number | null = null;
        let unstable = false;
        for await (const page of this.bookPages(body, size, timeoutMs)) {
            if (initialTotal === null) initialTotal = page.totalElements;
            else if (page.totalElements !== initialTotal) {
                unstable = true;
                break;
            }
            for (const book of page.content) firstPass.push(book);
        }
        if (!unstable) {
            yield* firstPass;
            return;
        }
        firstPass.length = 0;
        for await (const page of this.bookPages(body, size, timeoutMs)) yield* page.content;
    }

    async getBook(bookId: string): Promise<KomgaBookDto> {
        return this.json<KomgaBookDto>('GET', `/api/v1/books/${encodeURIComponent(bookId)}`);
    }

    /** All read lists. Never uses ?search= (a Lucene query that breaks on `:` `-` `()`); filter client-side. */
    async listReadLists(): Promise<KomgaReadListDto[]> {
        const path = '/api/v1/readlists?unpaged=true';
        const page = await this.json<KomgaPage<KomgaReadListDto> | null>('GET', path);
        if (!page || !Array.isArray(page.content)) throw this.unexpected('GET', path);
        return page.content;
    }

    /** 200 + ReadListDto. 400 on empty/duplicate bookIds or a (case-insensitive) duplicate name; an unknown book id fails the whole insert. */
    async createReadList(body: KomgaReadListCreateDto): Promise<KomgaReadListDto> {
        const payload = { name: body.name, summary: body.summary, ordered: body.ordered, bookIds: body.bookIds };
        return this.json<KomgaReadListDto>('POST', '/api/v1/readlists', { body: payload });
    }

    /** PATCH (204). Omitted fields are untouched; bookIds, when present, fully replaces the membership. */
    async updateReadList(id: string, body: KomgaReadListUpdateDto): Promise<void> {
        // Only the fields being changed; Komga leaves absent (or null) fields as they are.
        const payload: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(body)) if (v !== undefined) payload[k] = v;
        await this.noContent('PATCH', `/api/v1/readlists/${encodeURIComponent(id)}`, { body: payload });
    }

    async deleteReadList(id: string): Promise<void> {
        await this.noContent('DELETE', `/api/v1/readlists/${encodeURIComponent(id)}`);
    }

    /**
     * Opens GET /sse/v1/events, returns the first TaskQueueStatus frame and ALWAYS aborts the
     * connection (every exit path goes through the finally). Throws KomgaError when Komga is
     * unreachable or rejects the key (401/403) or errors (5xx); 404 → 'unsupported', no frame within
     * the timeout → 'timeout', stream closed first → 'ended'.
     */
    async readTaskQueue(opts: { timeoutMs?: number } = {}): Promise<KomgaTaskQueueRead> {
        const timeoutMs = opts.timeoutMs ?? KOMGA_SSE_TIMEOUT_MS;
        const controller = new AbortController();
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = AbortSignal.any([controller.signal, timeout]);
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        try {
            let res: Response;
            try {
                res = await this.send('GET', '/sse/v1/events', { timeoutMs, signal, accept: 'text/event-stream' });
            } catch (e) {
                if (isKomgaError(e) && e.kind === 'notFound') return { ok: false, reason: 'unsupported' };
                if (isKomgaError(e) && e.kind === 'timeout') return { ok: false, reason: 'timeout' };
                throw e;
            }
            if (!res.body) return { ok: false, reason: 'ended' };
            reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                let chunk: ReadableStreamReadResult<Uint8Array>;
                try {
                    chunk = await reader.read();
                } catch {
                    return { ok: false, reason: timeout.aborted ? 'timeout' : 'ended' };
                }
                if (chunk.done) return { ok: false, reason: 'ended' };
                buffer += decoder.decode(chunk.value, { stream: true });
                const { frames, rest } = parseSseChunk(buffer);
                buffer = rest;
                for (const frame of frames) {
                    if (frame.event !== KOMGA_SSE_TASK_QUEUE_EVENT) continue;
                    const status = parseTaskQueueStatus(frame.data);
                    if (status) return { ok: true, status };
                }
                if (buffer.length > KOMGA_SSE_MAX_BUFFER_BYTES) return { ok: false, reason: 'ended' };
            }
        } finally {
            controller.abort();
            if (reader) reader.cancel().catch(() => {});
        }
    }

    /**
     * Cumulative count of successful ScanLibrary task executions (global, resets on Komga restart):
     * the fallback "a scan finished" signal. 404 → 0 (no scan has executed since startup); any other
     * failure → null (metrics unavailable). Never throws.
     */
    async scanMetricsCount(): Promise<number | null> {
        try {
            const m = await this.json<KomgaMetricDto | null>('GET', '/actuator/metrics/komga.tasks.execution?tag=type:ScanLibrary');
            const measurements = Array.isArray(m?.measurements) ? m.measurements : [];
            const value = measurements.find((x) => x?.statistic === 'COUNT')?.value;
            return typeof value === 'number' && Number.isFinite(value) ? value : null;
        } catch (e) {
            if (isKomgaError(e) && e.kind === 'notFound') return 0;
            return null;
        }
    }

    // ------------------------------------------------------------------ internals

    private async *bookPages(body: unknown, size: number, timeoutMs: number): AsyncGenerator<KomgaPage<KomgaBookDto>> {
        for (let page = 0; page < MAX_BOOK_PAGES; page++) {
            const path = `/api/v1/books/list?page=${page}&size=${size}&sort=url,asc`;
            const res = await this.json<KomgaPage<KomgaBookDto> | null>('POST', path, { body, timeoutMs });
            if (!res || !Array.isArray(res.content)) throw this.unexpected('POST', path);
            yield res;
            const last = typeof res.last === 'boolean'
                ? res.last
                : !(typeof res.totalPages === 'number' && page + 1 < res.totalPages);
            if (last || res.content.length === 0) return;
        }
        throw new KomgaError('server', null, `Komga book listing did not end after ${MAX_BOOK_PAGES} pages`);
    }

    private async json<T>(method: string, path: string, o: { body?: unknown; auth?: boolean; timeoutMs?: number } = {}): Promise<T> {
        const timeoutMs = o.timeoutMs ?? this.#timeoutMs;
        // One signal for the headers AND the body read, so a server that stalls mid-body still times out.
        const signal = AbortSignal.timeout(timeoutMs);
        const res = await this.send(method, path, { ...o, timeoutMs, signal });
        let text: string;
        try {
            text = await res.text();
        } catch (e) {
            throw this.networkError(e, method, path, timeoutMs, signal);
        }
        try {
            return JSON.parse(text) as T;
        } catch {
            const hint = looksLikeHtml(text) ? ' (an HTML page: is the URL pointing at Komga rather than a proxy or login page?)' : '';
            throw new KomgaError('server', res.status, `Komga returned a non-JSON response for ${method} ${path}${hint}`);
        }
    }

    private async noContent(method: string, path: string, o: { body?: unknown; timeoutMs?: number } = {}): Promise<void> {
        const timeoutMs = o.timeoutMs ?? this.#timeoutMs;
        const res = await this.send(method, path, { ...o, timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
        // Release the connection; 202/204 bodies are empty and their content is irrelevant.
        try {
            await res.body?.cancel();
        } catch {
            // ignore
        }
    }

    /** fetch with headers, timeout and error mapping. Resolves only for 2xx. */
    private async send(method: string, path: string, o: SendOptions): Promise<Response> {
        const where = `${method} ${path}`;
        const json = o.body !== undefined;
        const headers = this.buildHeaders(o.auth !== false, o.accept ?? 'application/json', json);
        let res: Response;
        try {
            res = await this.#fetch(buildKomgaUrl(this.baseUrl, path), {
                method,
                headers,
                body: json ? JSON.stringify(o.body) : undefined,
                signal: o.signal,
                redirect: 'manual',
                cache: 'no-store',
            });
        } catch (e) {
            throw this.networkError(e, method, path, o.timeoutMs, o.signal);
        }
        if (res.status >= 200 && res.status < 300) return res;

        if (res.status >= 300 && res.status < 400) {
            const target = this.originOf(res.headers.get('location'));
            try {
                await res.body?.cancel();
            } catch {
                // ignore
            }
            throw new KomgaError('server', res.status, this.scrub(
                `Komga answered ${where} with a redirect (HTTP ${res.status}${target ? ` to ${target}` : ''}); set the Komga URL to the final address`,
            ));
        }
        const detail = await readErrorDetail(res);
        const { kind, message } = describeStatus(res.status, where);
        const safeDetail = detail ? this.scrub(detail) : null;
        throw new KomgaError(kind, res.status, this.scrub(safeDetail ? `${message}: ${safeDetail}` : message), safeDetail);
    }

    private buildHeaders(auth: boolean, accept: string, json: boolean): Headers {
        const h = new Headers();
        h.set('User-Agent', KOMGA_USER_AGENT);
        for (const [k, v] of Object.entries(this.#headers)) {
            const name = String(k ?? '').trim();
            const value = String(v ?? '').trim();
            if (!name || !value) continue;
            try {
                h.set(name, value);
            } catch {
                // An unsendable custom header is skipped; the Headers error text would echo its value.
            }
        }
        h.set('Accept', accept);
        if (json) h.set('Content-Type', 'application/json');
        h.delete('X-API-Key');
        if (auth) {
            try {
                h.set('X-API-Key', this.#apiKey);
            } catch {
                throw new KomgaError('unauthorized', null, 'The Komga API key contains characters that cannot be sent in an HTTP header');
            }
        }
        return h;
    }

    private networkError(e: unknown, method: string, path: string, timeoutMs: number, signal?: AbortSignal): KomgaError {
        if (isKomgaError(e)) return e;
        const name = (e as { name?: unknown } | null)?.name;
        if (name === 'TimeoutError' || name === 'AbortError' || signal?.aborted) {
            return new KomgaError('timeout', null, `Komga did not respond within ${timeoutMs} ms (${method} ${path})`);
        }
        return new KomgaError('unreachable', null, this.scrub(
            `Could not reach Komga at ${this.host()} (${method} ${path}): ${describeNetworkError(e)}`,
        ));
    }

    private unexpected(method: string, path: string): KomgaError {
        return new KomgaError('server', null, `Komga returned an unexpected response shape for ${method} ${path}`);
    }

    private host(): string {
        try {
            return new URL(this.baseUrl).host || this.baseUrl;
        } catch {
            return '(invalid URL)';
        }
    }

    /** Origin only: a Location header's path/query could carry anything. */
    private originOf(location: string | null): string | null {
        if (!location) return null;
        try {
            return new URL(location, buildKomgaUrl(this.baseUrl, '/')).origin;
        } catch {
            return null;
        }
    }

    /** Belt and braces: Komga never echoes the key, but a proxy error page might echo headers. */
    private scrub(text: string): string {
        let out = text;
        const secrets = [this.#apiKey, ...Object.values(this.#headers).map((v) => String(v ?? '').trim())]
            .filter((s) => s.length >= 8);
        for (const s of secrets) out = out.split(s).join('[redacted]');
        return out;
    }
}
