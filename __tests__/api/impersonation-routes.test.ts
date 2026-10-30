// Starting and stopping an impersonation (found in the v1.4.7 permission sweep). Stopping was the
// `stop` action of POST /api/admin/impersonate — behind the middleware's admin gate and the route's
// own ADMIN check, while the impersonating session's role IS the user's. Nothing could reach it, no
// page offered it, and the cookie lasted an hour. Stop now lives outside /api/admin: ending an
// impersonation can only return a session to the admin who started it (the jwt callback reverts
// only a swap it verified), so it needs no admin check — only a session that is impersonating.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { auditLog } from '../helpers/setup-global';
import { readImpersonationCookie, IMPERSONATION_MAX_AGE_S } from '@/lib/impersonation';

const SECRET = vi.hoisted(() => {
    process.env.NEXTAUTH_SECRET = 'super_secure_test_secret_key_1234567890';
    return process.env.NEXTAUTH_SECRET;
});
const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    getToken: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    get: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ set: mocks.set, delete: mocks.del, get: mocks.get })) }));

import { POST as impersonate } from '@/app/api/admin/impersonate/route';
import { POST as stop } from '@/app/api/impersonation/stop/route';

const post = (url: string, body?: unknown) =>
    new NextRequest(`http://localhost${url}`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('POST /api/admin/impersonate (start)', () => {
    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } });
    });

    it('sets a cookie bound to this admin and stamped with when it was issued', async () => {
        const before = Date.now();
        const res = await impersonate(post('/api/admin/impersonate', { userId: 'user_2', action: 'start' }));
        expect(res.status).toBe(200);

        const [name, value, options] = mocks.set.mock.calls[0];
        expect(name).toBe('omnibus_impersonate');
        expect(options).toEqual(expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: IMPERSONATION_MAX_AGE_S }));
        // Counts for a session signed in before it was issued…
        expect(readImpersonationCookie(value, { secret: SECRET!, adminId: 'admin_1', signedInAt: before - 1 })).toBe('user_2');
        // …and not for a sign-in that comes after it.
        expect(readImpersonationCookie(value, { secret: SECRET!, adminId: 'admin_1', signedInAt: Date.now() + 1000 })).toBeNull();
        expect(auditLog).toHaveBeenCalledWith('IMPERSONATE_USER_START', expect.objectContaining({ targetUserId: 'user_2' }), 'admin_1');
    });

    it('refuses a start without a user to impersonate', async () => {
        const res = await impersonate(post('/api/admin/impersonate', { action: 'start' }));
        expect(res.status).toBe(400);
        expect(mocks.set).not.toHaveBeenCalled();
    });

    it('no longer has a stop action (it could never be reached while impersonating a user)', async () => {
        const res = await impersonate(post('/api/admin/impersonate', { userId: 'user_2', action: 'stop' }));
        expect(res.status).toBe(400);
        expect(mocks.del).not.toHaveBeenCalled();
    });
});

describe('POST /api/impersonation/stop', () => {
    it('ends an impersonation: clears the cookie and logs it under the admin who started it', async () => {
        mocks.getToken.mockResolvedValue({ id: 'user_2', role: 'USER', isImpersonating: true, originalAdminId: 'admin_1' });
        const res = await stop(post('/api/impersonation/stop'));

        expect(res.status).toBe(200);
        expect(mocks.del).toHaveBeenCalledWith('omnibus_impersonate');
        expect(auditLog).toHaveBeenCalledWith('IMPERSONATE_USER_STOP', { targetUserId: 'user_2' }, 'admin_1');
    });

    it('answers 409 for a session that is not impersonating — and still clears a leftover cookie', async () => {
        mocks.getToken.mockResolvedValue({ id: 'user_2', role: 'USER' });
        const res = await stop(post('/api/impersonation/stop'));

        expect(res.status).toBe(409);
        expect(mocks.del).toHaveBeenCalledWith('omnibus_impersonate');
        expect(auditLog).not.toHaveBeenCalled();
    });

    it('answers 401 without a live session', async () => {
        mocks.getToken.mockResolvedValue(null);
        expect((await stop(post('/api/impersonation/stop'))).status).toBe(401);

        mocks.getToken.mockResolvedValue({ error: 'SessionExpired' });
        expect((await stop(post('/api/impersonation/stop'))).status).toBe(401);
        expect(auditLog).not.toHaveBeenCalled();
    });
});
