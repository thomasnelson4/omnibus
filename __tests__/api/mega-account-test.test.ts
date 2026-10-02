import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/admin/test/route';
import { MegaLoginError } from '@/lib/hosters/mega-session';
import { makePostJson } from '../helpers/request';

const mocks = vi.hoisted(() => ({ session: vi.fn(), setting: vi.fn(), account: vi.fn(), decrypt: vi.fn(), test: vi.fn() }));
vi.mock('next-auth/next', () => ({ getServerSession: mocks.session }));
vi.mock('@/lib/db', () => ({ prisma: {
    systemSetting: { findUnique: mocks.setting }, hosterAccount: { findFirst: mocks.account },
} }));
vi.mock('@/lib/encryption', () => ({ decryptSecret: mocks.decrypt }));
vi.mock('@/lib/hosters/mega-session', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/hosters/mega-session')>(), testMegaAccount: mocks.test,
}));

const request = makePostJson('http://localhost/api/admin/test');
const testRequest = (config = { id: 'mega-1', username: 'reader@example.com', password: 'new-password' }) =>
    POST(request({ type: 'mega', config }));

beforeEach(() => {
    mocks.session.mockResolvedValue({ user: { role: 'ADMIN' } });
    mocks.setting.mockResolvedValue({ value: 'true' });
    mocks.account.mockResolvedValue({ password: 'enc:v2:saved-password' });
    mocks.decrypt.mockResolvedValue('saved-password');
    mocks.test.mockReset().mockResolvedValue(undefined);
});

describe('MEGA account test endpoint', () => {
    it('tests unsaved credentials without looking up or saving an account', async () => {
        const response = await testRequest();
        expect(await response.json()).toMatchObject({ success: true });
        expect(mocks.test).toHaveBeenCalledWith('reader@example.com', 'new-password');
        expect(mocks.account).not.toHaveBeenCalled();
    });

    it('decrypts a masked password using the saved account ID and MEGA hoster', async () => {
        await testRequest({ id: 'mega-1', username: 'changed@example.com', password: '********' });
        expect(mocks.account).toHaveBeenCalledWith({ where: { id: 'mega-1', hoster: 'mega' } });
        expect(mocks.decrypt).toHaveBeenCalledWith('enc:v2:saved-password');
        expect(mocks.test).toHaveBeenCalledWith('changed@example.com', 'saved-password');
    });

    it('rejects a masked password that does not belong to a saved MEGA account', async () => {
        mocks.account.mockResolvedValue(null);
        const response = await testRequest({ id: 'pixeldrain-1', username: 'reader@example.com', password: '********' });
        expect(response.status).toBe(400);
        expect(mocks.test).not.toHaveBeenCalled();
    });

    it.each([null, { user: { role: 'USER' } }])('rejects non-admin sessions (%j)', async session => {
        mocks.session.mockResolvedValue(session);
        expect((await testRequest()).status).toBe(401);
        expect(mocks.test).not.toHaveBeenCalled();
        expect(mocks.account).not.toHaveBeenCalled();
    });

    it('allows testing during initial setup, matching existing account-test behavior', async () => {
        mocks.setting.mockResolvedValue({ value: 'false' });
        mocks.session.mockResolvedValue(null);
        expect(await (await testRequest()).json()).toMatchObject({ success: true });
    });

    it('reports an MFA requirement as failed authentication', async () => {
        mocks.test.mockRejectedValue(new MegaLoginError('This MEGA account requires two-factor authentication.', true));
        expect(await (await testRequest()).json()).toEqual({ success: false, message: 'This MEGA account requires two-factor authentication.' });
    });

    it('never exposes unreadable secrets or unexpected upstream errors', async () => {
        mocks.decrypt.mockRejectedValue(new Error('saved-password: account-secret'));
        const response = await testRequest({ id: 'mega-1', username: 'reader@example.com', password: '********' });
        const body = await response.json();
        expect(body.success).toBe(false);
        expect(JSON.stringify(body)).not.toContain('account-secret');
        expect(mocks.test).not.toHaveBeenCalled();
    });

    it('validates the credential shape before testing', async () => {
        const response = await POST(request({ type: 'mega', config: { username: 42 } }));
        expect(response.status).toBe(400);
        expect(mocks.test).not.toHaveBeenCalled();
    });
});
