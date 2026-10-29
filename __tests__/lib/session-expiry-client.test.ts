// #204: the pure pieces of the session-expiry fix.
import { describe, it, expect, beforeEach } from 'vitest';
import { isSafeReturnPath, loginUrlFor, isPublicPath, sessionLooksExpired, sessionPayloadIsGone, isGuardedApiUrl, claimExpiryOnce, __resetExpiryForTests } from '@/lib/session-expiry-client';

describe('session-expiry-client', () => {
    beforeEach(() => __resetExpiryForTests());

    it('accepts only same-origin, non-auth, non-api return paths', () => {
        expect(isSafeReturnPath('/admin/smart-match')).toBe(true);
        expect(isSafeReturnPath('/library/series?path=%2Fcomics%2FBatman')).toBe(true);
        expect(isSafeReturnPath('/')).toBe(true);
        for (const bad of [null, undefined, '', 'https://evil.example/x', '//evil.example', '/\\evil', '/login', '/login?x=1', '/setup', '/api/library']) {
            expect(isSafeReturnPath(bad as any)).toBe(false);
        }
    });

    it('builds the login URL with a return path, and a bare /login for home or an unsafe path', () => {
        expect(loginUrlFor('/admin/smart-match')).toBe('/login?callbackUrl=%2Fadmin%2Fsmart-match');
        expect(loginUrlFor('/library/series?path=%2Fcomics%2FBatman')).toBe('/login?callbackUrl=' + encodeURIComponent('/library/series?path=%2Fcomics%2FBatman'));
        expect(loginUrlFor('/')).toBe('/login');
        expect(loginUrlFor('https://evil.example/x')).toBe('/login');
        expect(isPublicPath('/login')).toBe(true);
        expect(isPublicPath('/setup/step-2')).toBe(true);
        expect(isPublicPath('/library')).toBe(false);
    });

    it('reads expiry from the flag, or from an empty session only after a user was present', () => {
        expect(sessionLooksExpired('authenticated', 'SessionExpired', false)).toBe(true); // the inactivity flag
        expect(sessionLooksExpired('unauthenticated', undefined, true)).toBe(true);        // the lapsed cookie
        expect(sessionLooksExpired('unauthenticated', undefined, false)).toBe(false);      // an anonymous visitor
        expect(sessionLooksExpired('loading', undefined, true)).toBe(false);
        expect(sessionLooksExpired('authenticated', undefined, true)).toBe(false);
    });

    it("reads the session endpoint's answer: NextAuth's empty {} or the flag = gone; a user = alive; anything odd = not proof", () => {
        expect(sessionPayloadIsGone({})).toBe(true);                                  // the cookie lapsed
        expect(sessionPayloadIsGone({ error: 'SessionExpired' })).toBe(true);         // the inactivity flag
        expect(sessionPayloadIsGone({ user: undefined, error: 'SessionExpired' })).toBe(true);
        expect(sessionPayloadIsGone({ user: { id: 'u2', role: 'USER' }, expires: 'x' })).toBe(false);
        for (const odd of [null, undefined, 'nope', 42, []]) expect(sessionPayloadIsGone(odd)).toBe(false);
    });

    it("guards our own /api routes only — never NextAuth's, never another origin", () => {
        const origin = 'http://localhost:3000';
        expect(isGuardedApiUrl('/api/library/series?path=x', origin)).toBe(true);
        expect(isGuardedApiUrl('http://localhost:3000/api/admin/unmatched', origin)).toBe(true);
        expect(isGuardedApiUrl(new URL('http://localhost:3000/api/search?q=x'), origin)).toBe(true);
        expect(isGuardedApiUrl('/api/auth/callback/credentials', origin)).toBe(false);
        expect(isGuardedApiUrl('/api/auth/session', origin)).toBe(false);
        expect(isGuardedApiUrl('https://comicvine.gamespot.com/api/volume/4050-1/', origin)).toBe(false);
        expect(isGuardedApiUrl('/library/series', origin)).toBe(false);
        expect(isGuardedApiUrl({} as any, origin)).toBe(false);
    });

    it('fires once per page life', () => {
        expect(claimExpiryOnce()).toBe(true);
        expect(claimExpiryOnce()).toBe(false);
        __resetExpiryForTests();
        expect(claimExpiryOnce()).toBe(true);
    });
});
