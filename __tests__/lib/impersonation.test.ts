// The impersonation cookie (found in the v1.4.7 permission sweep). It was `target|admin|hmac` and
// nothing tied it to a sign-in: it outlived sign-out (NextAuth clears only its own cookies), so
// signing back in as the admin resumed the impersonation. It now carries when it was issued, and
// counts only for the sign-in it was issued in, and only for its hour.
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { IMPERSONATION_MAX_AGE_S, readImpersonationCookie, signImpersonationCookie } from '@/lib/impersonation';

const SECRET = 'super_secure_test_secret_key_1234567890';
const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 9, 12, 18, 0, 0);

describe('impersonation cookie', () => {
    it('round-trips: a cookie issued during this sign-in names its target', () => {
        const raw = signImpersonationCookie('user_2', 'admin_1', NOW - 5 * MIN, SECRET);
        expect(raw.split('|')).toHaveLength(4);
        expect(readImpersonationCookie(raw, { secret: SECRET, adminId: 'admin_1', signedInAt: NOW - 10 * MIN, now: NOW })).toBe('user_2');
    });

    it('refuses a cookie issued before this sign-in — sign out, sign back in, and it no longer counts', () => {
        const raw = signImpersonationCookie('user_2', 'admin_1', NOW - 10 * MIN, SECRET);
        expect(readImpersonationCookie(raw, { secret: SECRET, adminId: 'admin_1', signedInAt: NOW - 1 * MIN, now: NOW })).toBeNull();
    });

    it('accepts any in-date cookie for a session signed in before this stamp existed (no signedInAt)', () => {
        const raw = signImpersonationCookie('user_2', 'admin_1', NOW - 5 * MIN, SECRET);
        expect(readImpersonationCookie(raw, { secret: SECRET, adminId: 'admin_1', signedInAt: undefined, now: NOW })).toBe('user_2');
    });

    it('refuses a cookie past its hour even if a browser still sends it', () => {
        const raw = signImpersonationCookie('user_2', 'admin_1', NOW - IMPERSONATION_MAX_AGE_S * 1000 - 1, SECRET);
        expect(readImpersonationCookie(raw, { secret: SECRET, adminId: 'admin_1', signedInAt: 0, now: NOW })).toBeNull();
    });

    it('refuses a cookie another admin started', () => {
        const raw = signImpersonationCookie('user_2', 'admin_9', NOW - 5 * MIN, SECRET);
        expect(readImpersonationCookie(raw, { secret: SECRET, adminId: 'admin_1', signedInAt: 0, now: NOW })).toBeNull();
    });

    it('refuses a tampered cookie (target, admin or time changed after signing)', () => {
        const raw = signImpersonationCookie('user_2', 'admin_1', NOW - 5 * MIN, SECRET);
        const [, admin, issuedAt, sig] = raw.split('|');
        const opts = { secret: SECRET, adminId: 'admin_1', signedInAt: 0, now: NOW };
        expect(readImpersonationCookie(`user_3|${admin}|${issuedAt}|${sig}`, opts)).toBeNull();
        expect(readImpersonationCookie(`user_2|${admin}|${NOW}|${sig}`, opts)).toBeNull();
        expect(readImpersonationCookie(raw, { ...opts, secret: 'another_secret_entirely_0987654321' })).toBeNull();
    });

    it('refuses the old three-part cookie, so an impersonation running at upgrade simply ends', () => {
        const payload = 'user_2|admin_1';
        const legacy = `${payload}|${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;
        expect(readImpersonationCookie(legacy, { secret: SECRET, adminId: 'admin_1', signedInAt: 0, now: NOW })).toBeNull();
    });

    it.each([undefined, '', 'garbage', 'a|b|c|d|e', 'user_2|admin_1|not-a-time|abc'])('refuses %j', (raw) => {
        expect(readImpersonationCookie(raw, { secret: SECRET, adminId: 'admin_1', signedInAt: 0, now: NOW })).toBeNull();
    });

    it('refuses everything without a secret or an admin to match', () => {
        const raw = signImpersonationCookie('user_2', 'admin_1', NOW - 5 * MIN, SECRET);
        expect(readImpersonationCookie(raw, { secret: '', adminId: 'admin_1', signedInAt: 0, now: NOW })).toBeNull();
        expect(readImpersonationCookie(raw, { secret: SECRET, adminId: undefined, signedInAt: 0, now: NOW })).toBeNull();
    });
});
