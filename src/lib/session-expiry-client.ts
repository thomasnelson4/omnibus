// src/lib/session-expiry-client.ts
//
// #204 (de6oliveira-droid): the Smart Matcher, left open for a day or two, greeted the next click
// with a black dialog reading "Unauthorized Access". Two different expiries exist and the client
// handled only one: the admin INACTIVITY window flags the token {error:"SessionExpired"} and the
// header signed the user out on it — but the session COOKIE itself lives six hours, and once it is
// gone the periodic refetch returns an EMPTY session with no flag. Nothing redirected, the page
// stayed up, and the next /api call came back as the middleware's 401, rendered as dialog text.
//
// These are the pure pieces of the fix (the guard in AuthProvider.tsx wires them up):
//   - a session that turns empty AFTER the user was signed in is treated exactly like the flag;
//   - a 401 from our own /api (not NextAuth's) while a user was signed in is the same event — once
//     the server's session endpoint confirms it. A 401 alone is only a hint: a route that refused a
//     signed-in non-admin with 401 (the Library page's admin-settings read) signed every regular
//     user out on the spot and bounced them again after each sign-in (2026-10-12);
//   - the user lands on /login with a return path, so "pick up where you left off" is one click.
// Pure and test-facing; `nav` is the one side effect, seamed so tests can watch it.

export const SESSION_EXPIRED_TOAST = {
    title: "Session expired",
    description: "You were signed out after a period of inactivity. Sign in again to pick up where you left off.",
} as const;

/** Pages that are reachable without a session — never bounce these (with or without a query). */
const PUBLIC_PATH = /^\/(login|setup)(?=[/?#]|$)/;

/** A return path we are willing to send someone back to: same-origin, absolute path, not an auth or API page. */
export function isSafeReturnPath(p: string | null | undefined): p is string {
    if (!p || !p.startsWith('/') || p.startsWith('//') || p.startsWith('/\\')) return false;
    if (PUBLIC_PATH.test(p) || p.startsWith('/api/')) return false;
    return true;
}

/** The login URL that brings the user back to `pathAndSearch` afterwards ("/" needs no return). */
export function loginUrlFor(pathAndSearch: string): string {
    return isSafeReturnPath(pathAndSearch) && pathAndSearch !== '/'
        ? `/login?callbackUrl=${encodeURIComponent(pathAndSearch)}`
        : '/login';
}

/** True on a page where an expired session must not trigger a bounce. */
export function isPublicPath(pathname: string | null | undefined): boolean {
    return !!pathname && PUBLIC_PATH.test(pathname);
}

/**
 * Whether the session state means "expired", given whether a user was ever seen on this page.
 * The inactivity flag counts on its own; an EMPTY session counts only after a user was present —
 * an anonymous visitor on a public page is not an expiry.
 */
export function sessionLooksExpired(status: string, error: unknown, hadUser: boolean): boolean {
    if (error === 'SessionExpired') return true;
    return status === 'unauthenticated' && hadUser;
}

/**
 * Whether /api/auth/session's answer means the session is over: NextAuth answers an empty `{}` once
 * the cookie is gone and `{ error: "SessionExpired" }` for the inactivity flag. Anything that is not
 * a session object at all is no proof either way — and only proof signs a user out.
 */
export function sessionPayloadIsGone(body: unknown): boolean {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const session = body as { user?: unknown; error?: unknown };
    return session.error === 'SessionExpired' || !session.user;
}

/**
 * Whether a fetch target is one of OUR api routes whose 401 may mean the session is gone. NextAuth's
 * own endpoints 401 for their own reasons (a wrong password, for one) and are left alone.
 */
export function isGuardedApiUrl(input: RequestInfo | URL, origin: string = typeof window !== 'undefined' ? window.location.origin : ''): boolean {
    let raw: string;
    if (typeof input === 'string') raw = input;
    else if (input instanceof URL) raw = input.toString();
    else if (input && typeof (input as Request).url === 'string') raw = (input as Request).url;
    else return false;
    let path: string;
    try {
        const u = new URL(raw, origin || 'http://localhost');
        if (origin && u.origin !== origin) return false;
        path = u.pathname;
    } catch {
        return false;
    }
    return path.startsWith('/api/') && !path.startsWith('/api/auth/');
}

/** The one side effect, seamed for tests: a full navigation clears every stale client state. */
export const nav = {
    go(url: string) { window.location.href = url; },
};

let firing = false;
/** Once per page life: the guard may observe the expiry several ways at once (refetch + a 401). */
export function claimExpiryOnce(): boolean {
    if (firing) return false;
    firing = true;
    return true;
}
/** Test hook. */
export function __resetExpiryForTests() { firing = false; }
