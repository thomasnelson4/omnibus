// This file tests the REAL module — undo setup-global's suite-wide mock.
vi.unmock('@/app/api/auth/[...nextauth]/options');
// Impersonation in the jwt callback (found in the v1.4.7 permission sweep):
//   - the cookie outlived sign-out, so signing back in as the admin resumed the impersonation;
//   - the swap never changed the name, so the header showed the admin's name with the user's role;
//   - the idle window followed the swapped role: the admin's session got a user's 6 hours, not 2.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signImpersonationCookie } from '@/lib/impersonation';

const SECRET = vi.hoisted(() => {
    process.env.NEXTAUTH_SECRET = 'super_secure_test_secret_key_1234567890';
    return process.env.NEXTAUTH_SECRET;
});
const mocks = vi.hoisted(() => ({
    systemSettingFindMany: vi.fn(),
    userFindUnique: vi.fn(),
    jar: {} as Record<string, string>,
}));

import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

vi.mock('@/lib/db', () => ({
    prisma: { systemSetting: { findMany: mocks.systemSettingFindMany }, user: { findUnique: mocks.userFindUnique } },
}));
vi.mock('@/lib/encryption', () => ({ decrypt2FA: vi.fn() }));
vi.mock('next/headers', () => ({
    cookies: vi.fn(async () => ({ get: (name: string) => (name in mocks.jar ? { value: mocks.jar[name] } : undefined) })),
}));

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const USERS: Record<string, any> = {
    admin_1: { id: 'admin_1', username: 'adam', email: 'adam@example.test', role: 'ADMIN', sessionVersion: 0, autoApproveRequests: true, canRequest: true, canDownload: true, canCreateGlobalLists: true, avatar: null },
    user_2: { id: 'user_2', username: 'reader', email: 'reader@example.test', role: 'USER', sessionVersion: 3, autoApproveRequests: false, canRequest: true, canDownload: false, canCreateGlobalLists: false, avatar: '/avatars/reader.png' },
};

// The admin's own token, signed in 10 minutes ago, sweep not due.
const adminToken = (overrides: Record<string, any> = {}) => ({
    id: 'admin_1', role: 'ADMIN', name: 'adam', email: 'adam@example.test', sessionVersion: 0,
    originalAdminId: 'admin_1', signedInAt: Date.now() - 10 * MIN,
    lastActive: Date.now() - 1 * MIN, lastSessionCheck: Date.now(),
    ...overrides,
});
// The same session after the swap to user_2.
const impersonatingToken = (overrides: Record<string, any> = {}) => adminToken({
    id: 'user_2', role: 'USER', name: 'reader', email: 'reader@example.test', isImpersonating: true,
    originalAdminName: 'adam', originalAdminEmail: 'adam@example.test',
    ...overrides,
});

const cookieFor = (target: string, admin: string, issuedAt: number) => {
    mocks.jar.omnibus_impersonate = signImpersonationCookie(target, admin, issuedAt, SECRET!);
};

const jwtCallback = async () => {
    mocks.systemSettingFindMany.mockResolvedValue([]);
    return (await getAuthOptions()).callbacks!.jwt as any;
};
const run = async (token: any, extra: Record<string, any> = {}) =>
    (await jwtCallback())({ token, user: undefined, trigger: undefined, session: undefined, ...extra });

describe('jwt callback: impersonation', () => {
    beforeEach(() => {
        for (const k of Object.keys(mocks.jar)) delete mocks.jar[k];
        mocks.userFindUnique.mockImplementation(async ({ where }: any) => USERS[where.id] ?? null);
    });

    it('stamps signedInAt at sign-in', async () => {
        const start = Date.now();
        const result = await run({}, { user: { id: 'admin_1', role: 'ADMIN', name: 'adam', image: null, sessionVersion: 0 }, trigger: 'signIn' });
        expect(result.signedInAt).toBeGreaterThanOrEqual(start);
    });

    it('a cookie issued during this sign-in swaps to the target — role, permissions AND name', async () => {
        cookieFor('user_2', 'admin_1', Date.now() - 5 * MIN);
        const result = await run(adminToken());

        expect(result).toEqual(expect.objectContaining({
            id: 'user_2', role: 'USER', name: 'reader', email: 'reader@example.test', canDownload: false,
            picture: '/avatars/reader.png', isImpersonating: true, originalAdminId: 'admin_1',
        }));
    });

    it('a cookie from before this sign-in is ignored — sign out, sign back in, and you are yourself', async () => {
        cookieFor('user_2', 'admin_1', Date.now() - 30 * MIN);
        const result = await run(adminToken({ signedInAt: Date.now() - 1 * MIN }));

        expect(result.id).toBe('admin_1');
        expect(result.role).toBe('ADMIN');
        expect(result.isImpersonating).toBeFalsy();
    });

    it('the old three-part cookie is refused', async () => {
        const crypto = await import('crypto');
        const payload = 'user_2|admin_1';
        mocks.jar.omnibus_impersonate = `${payload}|${crypto.createHmac('sha256', SECRET!).update(payload).digest('hex')}`;
        const result = await run(adminToken());

        expect(result.id).toBe('admin_1');
        expect(result.isImpersonating).toBeFalsy();
    });

    it('stopping (no cookie) reverts to the admin — role, permissions AND the admin\'s own name', async () => {
        const result = await run(impersonatingToken());

        expect(result).toEqual(expect.objectContaining({
            id: 'admin_1', role: 'ADMIN', name: 'adam', email: 'adam@example.test', canDownload: true, isImpersonating: false,
        }));
        expect(result.originalAdminName).toBeUndefined();
        expect(result.originalAdminEmail).toBeUndefined();
    });

    // (The 5-minute sessionVersion sweep judging an impersonating session on the ADMIN's row shipped
    // in v1.4.8 — see auth-permissions.test.ts, "impersonation is judged on the admin's own session".)

    it('an admin impersonating a user keeps the admin\'s 2-hour idle window', async () => {
        cookieFor('user_2', 'admin_1', Date.now() - 5 * MIN);
        const result = await run(impersonatingToken({ lastActive: Date.now() - 3 * HOUR }));

        expect(result).toEqual({ error: 'SessionExpired' });
    });
});
