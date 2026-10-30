// __tests__/api/komga-v2.test.ts
//
// #206 follow-up (Discord, 2026-10-19): Paperback 0.9's "Komga" source checks the account when its
// Server Settings are saved - GET /api/v2/users/me with HTTP Basic. A 2xx saves the settings, a 401
// shows "Invalid credentials", and ANY other status is read as Komga's validation error
// (`error.violations.map(...)`). The facade had no /api/v2/users/me and no v2 catch-all, so the
// source got the web app's HTML not-found page and crashed with
// "undefined is not an object (evaluating 'e.violations.map')".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as getMe } from '@/app/komga/api/v2/users/me/route';
import { GET as v2Get, POST as v2Post, PUT as v2Put, PATCH as v2Patch, DELETE as v2Delete } from '@/app/komga/api/v2/[...rest]/route';

const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    getAccessibleLibraryIds: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('@/lib/library-access', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/library-access')>()),
    getAccessibleLibraryIds: mocks.getAccessibleLibraryIds,
}));

const req = (path: string, init: RequestInit = {}) => new Request(`http://localhost/komga/api/v2${path}`, {
    ...init,
    headers: { authorization: 'Basic YWRhbTpvbW5pLWtleQ==', ...(init.headers ?? {}) },
});

describe('Komga facade v2: GET /users/me (the 0.9 source saving its Server Settings)', () => {
    beforeEach(() => {
        mocks.getAccessibleLibraryIds.mockResolvedValue('ALL');
    });

    it('answers an admin with Komga\'s UserDto, so the source saves the settings', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'user_1', username: 'adam', role: 'ADMIN' }, keyType: 'ADMIN_KEY' });

        const res = await getMe(req('/users/me'));

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(JSON.parse(await res.text())).toEqual({
            id: 'user_1',
            email: 'adam',
            roles: ['ADMIN', 'PAGE_STREAMING'],
            sharedAllLibraries: true,
            sharedLibrariesIds: [],
            labelsAllow: [],
            labelsExclude: [],
        });
    });

    it('answers a regular user with only the libraries they were granted, and no ADMIN role', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'user_2', username: 'reader', role: 'USER' }, keyType: 'USER_KEY' });
        mocks.getAccessibleLibraryIds.mockResolvedValue(['lib_1', 'lib_3']);

        const body = JSON.parse(await (await getMe(req('/users/me'))).text());

        expect(body).toEqual(expect.objectContaining({
            id: 'user_2',
            email: 'reader',
            roles: ['PAGE_STREAMING'],
            sharedAllLibraries: false,
            sharedLibrariesIds: ['lib_1', 'lib_3'],
        }));
        expect(mocks.getAccessibleLibraryIds).toHaveBeenCalledWith('user_2', 'USER');
    });

    it('answers a wrong key with 401 and the Basic challenge - the source shows "Invalid credentials"', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: false, user: null });

        const res = await getMe(req('/users/me'));

        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toContain('Basic realm="Omnibus Komga"');
        expect(JSON.parse(await res.text())).toEqual(expect.objectContaining({ status: 401, error: 'Unauthorized' }));
    });

    it('refuses a key that names no user (the legacy admin key) - progress has to belong to somebody', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: null, keyType: 'LEGACY_ADMIN' });

        expect((await getMe(req('/users/me'))).status).toBe(401);
    });
});

describe('Komga facade v2: a path no route answers', () => {
    it('is a Komga-style JSON 404 for every method, never the web app\'s HTML page', async () => {
        for (const [handler, method] of [[v2Get, 'GET'], [v2Post, 'POST'], [v2Put, 'PUT'], [v2Patch, 'PATCH'], [v2Delete, 'DELETE']] as const) {
            const res = await handler(req('/users/me/api-keys', { method }));
            expect(res.status).toBe(404);
            expect(res.headers.get('content-type')).toContain('application/json');
            expect(JSON.parse(await res.text())).toEqual(expect.objectContaining({
                status: 404, error: 'Not Found', path: '/api/v2/users/me/api-keys',
            }));
        }
    });
});
