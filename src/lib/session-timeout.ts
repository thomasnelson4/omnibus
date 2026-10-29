// src/lib/session-timeout.ts
//
// Inactivity-window rules shared by the NextAuth jwt callback and the middleware.
// Edge-safe: pure constants and arithmetic only.
export const ADMIN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const USER_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * The role whose idle window applies to a token. An impersonating session is the ADMIN's (only an
 * admin can start one), even while its role is the impersonated user's — it keeps the 2h window.
 */
export function windowRole(token: { role?: unknown; isImpersonating?: unknown } | null | undefined): string | undefined {
    if (token?.isImpersonating) return 'ADMIN';
    return typeof token?.role === 'string' ? token.role : undefined;
}

export function isInactivityExpired(
    role: string | undefined | null,
    lastActive: number | undefined | null,
    now: number = Date.now()
): boolean {
    // No stamp = legacy token from before the window existed; the jwt callback stamps it next run.
    if (!lastActive) return false;
    const limit = role === 'ADMIN' ? ADMIN_TIMEOUT_MS : USER_TIMEOUT_MS;
    return now - lastActive > limit;
}
