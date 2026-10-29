// src/lib/impersonation.ts
//
// The impersonation cookie: `target|admin|issuedAt|hmac`, signed with NEXTAUTH_SECRET. The jwt
// callback swaps the session to `target` only while the cookie is genuine, was started by this
// session's admin, was issued during THIS sign-in, and is inside its hour. Before v1.4.8 it was
// `target|admin|hmac` and tied to nothing: NextAuth's sign-out clears only its own cookies, so signing
// back in as the admin resumed the impersonation (found in the v1.4.7 permission sweep).
import crypto from 'crypto';

export const IMPERSONATION_COOKIE = 'omnibus_impersonate';
export const IMPERSONATION_MAX_AGE_S = 60 * 60;

const sign = (payload: string, secret: string) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

export function signImpersonationCookie(targetId: string, adminId: string, issuedAt: number, secret: string): string {
    const payload = `${targetId}|${adminId}|${issuedAt}`;
    return `${payload}|${sign(payload, secret)}`;
}

/**
 * The impersonated user's id, or null when the cookie must be ignored. `signedInAt` is the session's
 * sign-in time (absent on sessions signed in before it was stamped — those accept any in-date cookie).
 */
export function readImpersonationCookie(
    raw: string | null | undefined,
    opts: { secret: string | undefined; adminId: unknown; signedInAt?: unknown; now?: number },
): string | null {
    if (!raw || !opts.secret || typeof opts.adminId !== 'string' || !opts.adminId) return null;
    const parts = raw.split('|');
    if (parts.length !== 4) return null;
    const [targetId, cookieAdminId, issuedAtText, signature] = parts;
    if (!targetId || cookieAdminId !== opts.adminId || !/^\d+$/.test(issuedAtText)) return null;

    const expected = Buffer.from(sign(`${targetId}|${cookieAdminId}|${issuedAtText}`, opts.secret));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

    const issuedAt = Number(issuedAtText);
    const now = opts.now ?? Date.now();
    if (now - issuedAt > IMPERSONATION_MAX_AGE_S * 1000) return null;
    const signedInAt = typeof opts.signedInAt === 'number' ? opts.signedInAt : 0;
    if (issuedAt < signedInAt) return null;
    return targetId;
}
