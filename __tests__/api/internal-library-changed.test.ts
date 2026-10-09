import { describe, it, expect, vi, beforeEach } from 'vitest';

// The engine's only way to tell Node that IT changed a library. Two properties matter most:
// the shared-secret guard (this is an unauthenticated route otherwise), and DROPPING malformed
// events rather than rejecting the whole batch — the engine coalesces ~3 s of work into one POST
// and a hard 400 would make it retry a payload that can never succeed.
const mocks = vi.hoisted(() => ({ recordLibraryChange: vi.fn().mockResolvedValue(undefined) }));

vi.unmock('@/lib/komga/changes');

import { secretsMatch } from '@/lib/api-auth';
import { loggerLog } from '../helpers/setup-global';

const SECRET = 'a-test-internal-secret';

function req(body: unknown, secret: string | null = SECRET) {
    return new Request('http://localhost:3000/api/internal/library-changed', {
        method: 'POST',
        headers: secret ? { 'x-internal-secret': secret, 'content-type': 'application/json' } : {},
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

async function load() {
    return import('@/app/api/internal/library-changed/route');
}

beforeEach(() => {
    vi.resetModules();
    // The route reads the REAL env var, not a globalThis key.
    process.env.NEXTAUTH_SECRET = SECRET;
    mocks.recordLibraryChange.mockClear();
    vi.doMock('@/lib/komga/changes', () => ({ recordLibraryChange: mocks.recordLibraryChange }));
});

describe('the shared-secret guard', () => {
    it('rejects a request with no secret', async () => {
        const { POST } = await load();
        const res = await POST(req({ events: [] }, null));
        expect(res.status).toBe(401);
        expect(mocks.recordLibraryChange).not.toHaveBeenCalled();
    });

    it('rejects a wrong secret', async () => {
        const { POST } = await load();
        const res = await POST(req({ events: [] }, 'wrong'));
        expect(res.status).toBe(401);
        expect(mocks.recordLibraryChange).not.toHaveBeenCalled();
    });

    it('accepts the configured secret', async () => {
        const { POST } = await load();
        const res = await POST(req({ events: [{ reason: 'import', paths: ['/a/1.cbz'] }] }));
        expect(res.status).toBe(202);
    });

    it('compares with secretsMatch, so a timing-safe compare is used', async () => {
        expect(secretsMatch(SECRET, SECRET)).toBe(true);
        expect(secretsMatch('nope', SECRET)).toBe(false);
    });
});

describe('body validation', () => {
    it('400s on malformed JSON', async () => {
        const { POST } = await load();
        const res = await POST(req('{not json'));
        expect(res.status).toBe(400);
    });

    it('400s when events is not an array', async () => {
        const { POST } = await load();
        const res = await POST(req({ events: 'nope' }));
        expect(res.status).toBe(400);
    });

    it('400s when events is missing entirely', async () => {
        const { POST } = await load();
        const res = await POST(req({}));
        expect(res.status).toBe(400);
    });

    it('accepts an empty batch with 202 and 0 accepted', async () => {
        const { POST } = await load();
        const res = await POST(req({ events: [] }));
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ accepted: 0 });
    });
});

describe('per-event handling', () => {
    it('forwards a well-formed event to recordLibraryChange with source engine', async () => {
        const { POST } = await load();
        await POST(req({ events: [{ reason: 'watched-import', paths: ['/a/1.cbz'], seriesIds: ['s1'] }] }));
        expect(mocks.recordLibraryChange).toHaveBeenCalledWith({
            reason: 'watched-import', paths: ['/a/1.cbz'], seriesIds: ['s1'], issueIds: [], source: 'engine',
        });
    });

    it('accepts seriesIds-only and issueIds-only events', async () => {
        const { POST } = await load();
        const res = await POST(req({ events: [{ reason: 'r', seriesIds: ['s1'] }, { reason: 'r', issueIds: ['i1'] }] }));
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ accepted: 2 });
    });

    it('drops an event with no reason', async () => {
        const { POST } = await load();
        const res = await POST(req({ events: [{ paths: ['/a/1.cbz'] }] }));
        expect(await res.json()).toEqual({ accepted: 0 });
        expect(mocks.recordLibraryChange).not.toHaveBeenCalled();
    });

    it('drops an event with a blank reason', async () => {
        const { POST } = await load();
        const res = await POST(req({ events: [{ reason: '   ', paths: ['/a/1.cbz'] }] }));
        expect(await res.json()).toEqual({ accepted: 0 });
    });

    it('drops an event carrying no paths and no ids', async () => {
        const { POST } = await load();
        const res = await POST(req({ events: [{ reason: 'r' }] }));
        expect(await res.json()).toEqual({ accepted: 0 });
    });

    it('drops non-strings inside the path/id arrays instead of failing the batch', async () => {
        const { POST } = await load();
        const res = await POST(req({ events: [{ reason: 'r', paths: ['/a/1.cbz', 42, null, {}], seriesIds: [7, 's1'] }] }));
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ accepted: 1 });
        expect(mocks.recordLibraryChange).toHaveBeenCalledWith(expect.objectContaining({
            paths: ['/a/1.cbz'], seriesIds: ['s1'],
        }));
    });

    it('drops a null event entry', async () => {
        const { POST } = await load();
        const res = await POST(req({ events: [null, { reason: 'r', paths: ['/a'] }] }));
        expect(await res.json()).toEqual({ accepted: 1 });
    });

    it('keeps the GOOD events when a bad one sits in the middle', async () => {
        const { POST } = await load();
        const res = await POST(req({
            events: [
                { reason: 'a', paths: ['/x'] },
                { reason: '', paths: ['/y'] },
                { reason: 'b', paths: ['/z'] },
            ],
        }));
        expect(await res.json()).toEqual({ accepted: 2 });
    });

    it('truncates an over-long reason', async () => {
        const { POST } = await load();
        await POST(req({ events: [{ reason: 'r'.repeat(200), paths: ['/a'] }] }));
        expect(mocks.recordLibraryChange.mock.calls[0][0].reason.length).toBeLessThanOrEqual(64);
    });
});

describe('caps', () => {
    it('reads at most 1000 events', async () => {
        const { POST } = await load();
        const events = Array.from({ length: 1200 }, (_, i) => ({ reason: 'r', paths: [`/a/${i}.cbz`] }));
        const res = await POST(req({ events }));
        expect(await res.json()).toEqual({ accepted: 1000 });
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('only the first 1000'), 'warn');
    });

    it('stops accumulating paths at the 5000 total budget', async () => {
        const { POST } = await load();
        // 3 events x 3000 paths = 9000 > 5000. The third must be dropped for having no paths left.
        const events = Array.from({ length: 3 }, () => ({
            reason: 'r', paths: Array.from({ length: 3000 }, (_, i) => `/a/${i}.cbz`),
        }));
        const res = await POST(req({ events }));
        const accepted = (await res.json()).accepted;
        expect(accepted).toBeLessThan(3);
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('path budget exhausted'), 'warn');
    });
});

describe('response shape', () => {
    it('returns 202 — recorded, but Komga has not been told yet', async () => {
        const { POST } = await load();
        const res = await POST(req({ events: [{ reason: 'r', paths: ['/a'] }] }));
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ accepted: 1 });
    });
});
