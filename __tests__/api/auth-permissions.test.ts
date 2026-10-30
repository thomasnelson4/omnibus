// This file tests the REAL module — undo setup-global's suite-wide mock.
vi.unmock('@/app/api/auth/[...nextauth]/options');
// __tests__/api/auth-permissions.test.ts
//
// 2026-10-12 (Adam, live server): users set to "Hero" — request, auto-approve, download, global
// lists — got the red "Requests not enabled. Ask an admin to grant you the Request permission."
// toast on every request button. The request gate in the browser reads session.user.canRequest,
// and since the tiers landed (v1.1.0-beta.055) the password sign-in never put canRequest on the
// session — only the SSO path did. Separately, the session only ever learned a user's permissions
// at sign-in: applying a tier to a signed-in user changed the database and nothing else, and the
// activity ping kept postponing the 5-minute sweep that could have refreshed them.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PERMISSION_TIERS, tierFlags, tierFromUser, type TierFlags } from '@/lib/permission-tiers';
import { signImpersonationCookie } from '@/lib/impersonation';

const mocks = vi.hoisted(() => {
    process.env.NEXTAUTH_SECRET = 'super_secure_test_secret_key_1234567890';
    return {
        systemSettingFindMany: vi.fn(),
        userFindUnique: vi.fn(),
        queryRaw: vi.fn(),
        impersonateCookie: undefined as string | undefined,
    };
});

import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findMany: mocks.systemSettingFindMany },
        user: { findUnique: mocks.userFindUnique },
        $queryRaw: mocks.queryRaw,
    }
}));
vi.mock('bcryptjs', () => ({ default: { compare: vi.fn(async () => true) } }));
vi.mock('@/lib/encryption', () => ({ decrypt2FA: vi.fn() }));
vi.mock('next/headers', () => ({
    cookies: vi.fn(async () => ({
        get: (name: string) => (name === 'omnibus_impersonate' && mocks.impersonateCookie ? { value: mocks.impersonateCookie } : undefined),
    })),
}));

const MIN = 60 * 1000;

const options = async () => {
    mocks.systemSettingFindMany.mockResolvedValue([]);
    return getAuthOptions();
};
const callbacks = async () => {
    const o = await options();
    return { jwt: o.callbacks!.jwt as any, session: o.callbacks!.session as any };
};

/** The User row the password sign-in reads with raw SQL. */
const userRow = (flags: TierFlags, overrides: Record<string, any> = {}) => ({
    id: 'user_1', username: 'reader', email: 'reader@example.com', role: 'USER', password: '$2a$10$hash',
    isApproved: true, twoFactorEnabled: false, twoFactorSecret: null, avatar: null, sessionVersion: 0,
    ...flags, ...overrides,
});

/** A signed-in USER token whose 5-minute sweep is due. */
const dueToken = (overrides: Record<string, any> = {}) => ({
    id: 'user_1', role: 'USER', sessionVersion: 0,
    ...tierFlags('Sidekick'),
    lastActive: Date.now() - MIN,
    lastSessionCheck: Date.now() - 6 * MIN,
    ...overrides,
});

const sessionUserOf = async (token: any) => {
    const { session } = await callbacks();
    return (await session({ session: { user: { name: 'reader' }, expires: '' }, token })).user;
};

beforeEach(() => {
    mocks.impersonateCookie = undefined;
    mocks.userFindUnique.mockReset();
    mocks.queryRaw.mockReset();
});

describe('Permissions: a password sign-in carries every tier flag onto the session', () => {
    it.each(PERMISSION_TIERS.map(t => [t.name, t.flags] as const))('%s', async (name, flags) => {
        mocks.queryRaw.mockResolvedValue([userRow(flags)]);
        const o = await options();
        const credentials = o.providers.find((p: any) => p.id === 'credentials') as any;

        const user = await credentials.options.authorize({ username: 'reader', password: 'pw' }, {});
        const { jwt } = await callbacks();
        const token = await jwt({ token: {}, user, trigger: 'signIn', session: undefined });
        const sessionUser = await sessionUserOf(token);

        expect(sessionUser).toMatchObject(flags);
        // The header's tier badge reads the same session — a Hero was showing as "Custom".
        expect(tierFromUser(sessionUser)).toBe(name);
    });
});

describe('Permissions: a signed-in session follows the database at the 5-minute sweep', () => {
    it('an admin applies Hero to a signed-in Sidekick: the session becomes Hero without signing out', async () => {
        const { jwt } = await callbacks();
        mocks.userFindUnique.mockResolvedValue({ sessionVersion: 0, role: 'USER', ...tierFlags('Hero') });

        const result = await jwt({ token: dueToken(), user: undefined, trigger: undefined, session: undefined });

        expect(result.error).toBeUndefined();
        expect(tierFromUser(result)).toBe('Hero');
        expect(tierFromUser(await sessionUserOf(result))).toBe('Hero');
    });

    it("heals a password session from before this fix (no canRequest on it at all)", async () => {
        const { jwt } = await callbacks();
        const { canRequest: _missing, ...withoutCanRequest } = dueToken({ ...tierFlags('Hero') });
        mocks.userFindUnique.mockResolvedValue({ sessionVersion: 0, role: 'USER', ...tierFlags('Hero') });

        const result = await jwt({ token: withoutCanRequest, user: undefined, trigger: undefined, session: undefined });

        expect(result.canRequest).toBe(true);
    });

    it('takes permissions away just the same (Hero → Civilian, and an admin demoted to USER)', async () => {
        const { jwt } = await callbacks();
        mocks.userFindUnique.mockResolvedValue({ sessionVersion: 0, role: 'USER', ...tierFlags('Civilian') });
        const downgraded = await jwt({ token: dueToken({ ...tierFlags('Hero') }), user: undefined, trigger: undefined, session: undefined });
        expect(tierFromUser(downgraded)).toBe('Civilian');

        mocks.userFindUnique.mockResolvedValue({ sessionVersion: 0, role: 'USER', ...tierFlags('Hero') });
        const demoted = await jwt({ token: dueToken({ id: 'admin_2', role: 'ADMIN', originalAdminId: 'admin_2' }), user: undefined, trigger: undefined, session: undefined });
        expect(demoted.role).toBe('USER');
    });

    it("the activity ping no longer postpones the sweep — an active user still picks up a change", async () => {
        const { jwt } = await callbacks();
        mocks.userFindUnique.mockResolvedValue({ sessionVersion: 0, role: 'USER', ...tierFlags('Hero') });
        const before = Date.now() - MIN;

        const result = await jwt({ token: dueToken({ lastActive: before }), user: undefined, trigger: 'update', session: undefined });

        expect(mocks.userFindUnique).toHaveBeenCalledTimes(1);
        expect(tierFromUser(result)).toBe('Hero');
        expect(result.lastActive).toBeGreaterThan(before);       // the ping still slides the window
    });

    it('keeps the 5-minute cadence: a ping inside the window does not read the database', async () => {
        const { jwt } = await callbacks();

        const result = await jwt({ token: dueToken({ lastSessionCheck: Date.now() - MIN }), user: undefined, trigger: 'update', session: undefined });

        expect(result.error).toBeUndefined();
        expect(mocks.userFindUnique).not.toHaveBeenCalled();
    });
});

describe("Permissions: impersonation is judged on the admin's own session", () => {
    const impersonating = (overrides: Record<string, any> = {}) => dueToken({
        id: 'user_2', role: 'USER', sessionVersion: 0, isImpersonating: true, originalAdminId: 'admin_1', ...overrides,
    });
    // Issued a minute ago, i.e. during this sign-in (the cookie carries its issue time since v1.4.9).
    const signCookie = (target: string, admin: string) =>
        signImpersonationCookie(target, admin, Date.now() - 60_000, process.env.NEXTAUTH_SECRET!);
    const rows: Record<string, any> = {
        admin_1: { sessionVersion: 0, role: 'ADMIN', ...tierFlags('Hero') },
        user_2: { sessionVersion: 3, role: 'USER', ...tierFlags('Sidekick') },  // the target's own version differs
    };

    it("a target whose sessionVersion differs from the admin's no longer signs the admin out", async () => {
        const { jwt } = await callbacks();
        mocks.impersonateCookie = signCookie('user_2', 'admin_1');
        mocks.userFindUnique.mockImplementation(async ({ where }: any) => rows[where.id] ?? null);

        const result = await jwt({ token: impersonating(), user: undefined, trigger: undefined, session: undefined });

        expect(result.error).toBeUndefined();
        expect(result.id).toBe('user_2');
        expect(result.isImpersonating).toBe(true);
        expect(result.role).toBe('USER');                         // the admin's own flags are not copied in
        expect(tierFromUser(result)).toBe('Sidekick');
    });

    it("revoking the admin's sessions still ends the impersonation", async () => {
        const { jwt } = await callbacks();
        mocks.impersonateCookie = signCookie('user_2', 'admin_1');
        mocks.userFindUnique.mockImplementation(async ({ where }: any) =>
            where.id === 'admin_1' ? { ...rows.admin_1, sessionVersion: 1 } : rows[where.id] ?? null);

        const result = await jwt({ token: impersonating(), user: undefined, trigger: undefined, session: undefined });

        expect(result).toEqual({ error: 'SessionExpired' });
    });
});
