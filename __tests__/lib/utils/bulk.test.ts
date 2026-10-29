// runBulk: the one place a bulk action learns which of its parallel requests the server actually
// accepted. Found in the v1.4.7 permission sweep: bulk approve/deny, bulk retry, bulk cancel and
// bulk mark-read all did `await Promise.all(fetches)` and reported success — fetch only rejects on
// a network failure, so every 4xx/5xx counted as done.
import { describe, it, expect, vi } from 'vitest';
import { runBulk } from '@/lib/utils/bulk';

const res = (status: number, body?: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => { if (body === undefined) throw new SyntaxError('Unexpected end of JSON input'); return body; },
}) as unknown as Response;

describe('runBulk', () => {
    it('sends one request per item and reports them all done when every answer is 2xx', async () => {
        const send = vi.fn(async (_id: string) => res(200, { success: true }));
        const out = await runBulk(['a', 'b', 'c'], send);

        expect(send.mock.calls.map(c => c[0])).toEqual(['a', 'b', 'c']);
        expect(out).toEqual({ succeeded: ['a', 'b', 'c'], failed: [], firstError: null });
    });

    it('counts a 4xx/5xx answer as a failure and keeps the server\'s error text', async () => {
        const out = await runBulk(['a', 'b', 'c'], async (id) =>
            id === 'b' ? res(500, { error: 'database is locked' }) : res(200, { success: true }));

        expect(out.succeeded).toEqual(['a', 'c']);
        expect(out.failed).toEqual(['b']);
        expect(out.firstError).toBe('database is locked');
    });

    it('counts a rejected fetch (network failure) as a failure', async () => {
        const out = await runBulk(['a', 'b'], async (id) => {
            if (id === 'a') throw new TypeError('Failed to fetch');
            return res(200, {});
        });

        expect(out.succeeded).toEqual(['b']);
        expect(out.failed).toEqual(['a']);
        expect(out.firstError).toBe('Failed to fetch');
    });

    it('falls back to the HTTP status when a refusal has no JSON error', async () => {
        const out = await runBulk(['a'], async () => res(404));
        expect(out.failed).toEqual(['a']);
        expect(out.firstError).toBe('HTTP 404');
    });

    it('keeps the FIRST failure\'s reason in item order, whichever answer arrives first', async () => {
        const out = await runBulk(['slow', 'fast'], async (id) => {
            if (id === 'slow') {
                await new Promise(r => setTimeout(r, 10));
                return res(403, { error: 'Forbidden' });
            }
            return res(500, { error: 'boom' });
        });

        expect(out.failed).toEqual(['slow', 'fast']);
        expect(out.firstError).toBe('Forbidden');
    });

    it('does nothing for an empty selection', async () => {
        const send = vi.fn();
        expect(await runBulk([], send)).toEqual({ succeeded: [], failed: [], firstError: null });
        expect(send).not.toHaveBeenCalled();
    });
});
