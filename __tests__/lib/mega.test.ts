import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { loggerLog } from '../helpers/setup-global';

const mocks = vi.hoisted(() => ({ fromURL: vi.fn(), storage: vi.fn(), loadAttributes: vi.fn() }));
vi.mock('megajs', () => ({ File: { fromURL: mocks.fromURL }, Storage: mocks.storage }));

const account = { id: 'mega-1', username: ' Reader@Example.com ', password: 'account-secret', updatedAt: new Date('2026-10-02') };
const url = 'https://mega.nz/file/fileid#public-decryption-key';
let resolveMega: typeof import('@/lib/hosters/mega')['resolveMega'];
let storages: { api: { sid: string; close: ReturnType<typeof vi.fn> }; ready: Promise<void>; close: ReturnType<typeof vi.fn> }[];

beforeEach(async () => {
    vi.resetModules();
    mocks.storage.mockReset();
    mocks.fromURL.mockReset();
    mocks.loadAttributes.mockReset();
    storages = [];
    mocks.storage.mockImplementation(function () {
        const storage = { api: { sid: `session-${storages.length}`, close: vi.fn() }, ready: Promise.resolve(), close: vi.fn().mockResolvedValue(undefined) };
        storages.push(storage);
        return storage;
    });
    mocks.fromURL.mockImplementation((_url, options) => {
        const node = { name: 'comic.cbz', size: 600_000, directory: false, api: options?.api || { sid: undefined } };
        return { ...node, loadAttributes: () => mocks.loadAttributes(node) };
    });
    mocks.loadAttributes.mockImplementation(async node => node);
    ({ resolveMega } = await import('@/lib/hosters/mega'));
});

afterEach(() => vi.restoreAllMocks());

describe('MEGA authenticated resolution', () => {
    it('uses the logged-in API and keeps the public file decryption URL intact', async () => {
        const result = await resolveMega(url, account);
        expect(result).toMatchObject({ success: true, isMegaStream: true, fileName: 'comic.cbz' });
        expect(mocks.storage).toHaveBeenCalledWith(expect.objectContaining({
            email: 'reader@example.com', password: 'account-secret', autoload: false, keepalive: false,
        }));
        expect(mocks.fromURL).toHaveBeenLastCalledWith(url, { api: storages[0].api });
        expect(result.megaFileNode?.api).toBe(storages[0].api);
        result.release?.();
    });

    it.each([null, { ...account, isActive: false }, { ...account, username: '', password: '', apiKey: 'old-unused-key' }])(
        'keeps downloads anonymous without usable active credentials (%j)', async credentials => {
            const result = await resolveMega(url, credentials);
            expect(result.success).toBe(true);
            expect(mocks.storage).not.toHaveBeenCalled();
            expect(result.release).toBeUndefined();
        },
    );

    it('attaches the logged-in API to the largest archive child of a shared folder', async () => {
        const selected = { name: 'large.cbr', size: 800_000, directory: false, api: { sid: undefined } };
        mocks.loadAttributes.mockImplementation(async node => ({ ...node, directory: true, children: [
            { name: 'readme.txt', size: 9_000_000, directory: false },
            { name: 'small.cbz', size: 600_000, directory: false }, selected,
            { name: 'other.zip', size: 9_000_000, directory: true },
        ] }));
        const result = await resolveMega('https://mega.nz/folder/folderid#folder-key', account);
        expect(result.megaFileNode).toBe(selected);
        expect(selected.api).toBe(storages[0].api);
        result.release?.();
    });

    it('uses the node returned for a file targeted inside a shared folder', async () => {
        const selected = { name: 'target.cbz', size: 600_000, directory: false, api: {} };
        mocks.loadAttributes.mockResolvedValue(selected);
        const result = await resolveMega('https://mega.nz/folder/folderid#folder-key/file/target', account);
        expect(result.megaFileNode).toBe(selected);
        expect(selected.api).toBe(storages[0].api);
        result.release?.();
    });

    it('shares an in-flight login across simultaneous downloads and reuses it afterward', async () => {
        let finishLogin!: () => void;
        mocks.storage.mockImplementationOnce(function () {
            const storage = { api: { sid: 'shared', close: vi.fn() }, ready: new Promise<void>(resolve => { finishLogin = resolve; }), close: vi.fn().mockResolvedValue(undefined) };
            storages.push(storage);
            return storage;
        });
        const first = resolveMega(url, account);
        const second = resolveMega(url, account);
        expect(mocks.storage).toHaveBeenCalledTimes(1);
        finishLogin();
        const results = await Promise.all([first, second, resolveMega(url, account)]);
        expect(mocks.storage).toHaveBeenCalledTimes(1);
        for (const result of results) {
            expect(result.megaFileNode?.api).toBe(storages[0].api);
            result.release?.();
        }
    });

    it('expires cached sessions and waits for the old download to release before logging it out', async () => {
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        const old = await resolveMega(url, account);
        clock.mockReturnValue(now + 60 * 60 * 1000 + 1);
        const fresh = await resolveMega(url, account);
        expect(mocks.storage).toHaveBeenCalledTimes(2);
        expect(storages[0].close).not.toHaveBeenCalled();
        old.release?.();
        old.release?.(); // Release is idempotent.
        await Promise.resolve();
        expect(storages[0].close).toHaveBeenCalledTimes(1);
        fresh.release?.();
    });

    it('invalidates a cached session when the account password changes', async () => {
        const old = await resolveMega(url, account);
        const fresh = await resolveMega(url, { ...account, password: 'new-secret' });
        expect(mocks.storage).toHaveBeenCalledTimes(2);
        expect(fresh.megaFileNode?.api).not.toBe(old.megaFileNode?.api);
        old.release?.();
        fresh.release?.();
    });

    it.each(['ENOENT (-9): password rejected', 'EMFAREQUIRED (-26): MFA required'])(
        'warns and tries anonymous access after rejected login: %s', async message => {
            mocks.storage.mockImplementationOnce(function () {
                return { api: { close: vi.fn() }, ready: Promise.reject(new Error(message)) };
            });
            const result = await resolveMega(url, account);
            expect(result.success).toBe(true);
            expect(result.invalidateMegaSession).toBeUndefined();
            expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('Trying anonymous download'), 'warn');
        },
    );

    it('does not cache a rejected login', async () => {
        mocks.storage.mockImplementationOnce(function () {
            return { api: { close: vi.fn() }, ready: Promise.reject(new Error('ENOENT (-9)')) };
        });
        expect((await resolveMega(url, account)).success).toBe(true);
        const second = await resolveMega(url, account);
        expect(mocks.storage).toHaveBeenCalledTimes(2);
        expect(second.megaFileNode?.api).toBe(storages[0].api);
        second.release?.();
    });

    it('does not retry rate-limited login or expose provider error details', async () => {
        mocks.storage.mockImplementationOnce(function () {
            return { api: { close: vi.fn() }, ready: Promise.reject(new Error('ERATELIMIT (-4) account-secret')) };
        });
        const result = await resolveMega(url, account);
        expect(result).toMatchObject({ success: false, error: expect.stringContaining('rate-limited') });
        expect(mocks.storage).toHaveBeenCalledTimes(1);
        expect(mocks.loadAttributes).not.toHaveBeenCalled();
        expect(JSON.stringify(loggerLog.mock.calls)).not.toContain('account-secret');
    });

    it('refreshes an expired session once when loading attributes', async () => {
        mocks.loadAttributes.mockRejectedValueOnce(new Error('ESID (-15)'));
        const result = await resolveMega(url, account);
        expect(result.success).toBe(true);
        expect(mocks.storage).toHaveBeenCalledTimes(2);
        expect(result.megaFileNode?.api).toBe(storages[1].api);
        result.release?.();
    });

    it('bounds expired-session recovery to one attempt', async () => {
        mocks.loadAttributes.mockRejectedValue(new Error('ESID (-15)'));
        expect(await resolveMega(url, account)).toMatchObject({ success: false, error: expect.stringContaining('expired again') });
        expect(mocks.storage).toHaveBeenCalledTimes(2);
    });

    it('rejects partial credentials and avoids logging malformed public keys', async () => {
        expect((await resolveMega(url, { ...account, password: '' })).success).toBe(false);
        mocks.fromURL.mockImplementationOnce(() => { throw new Error('Invalid argument: private-link-key'); });
        const result = await resolveMega('https://mega.nz/file/fileid#private-link-key', account);
        expect(result.success).toBe(false);
        expect(mocks.storage).not.toHaveBeenCalled();
        expect(JSON.stringify([result, loggerLog.mock.calls])).not.toContain('private-link-key');
    });

    it('only recognizes HTTP(S) links on exact MEGA domains', async () => {
        const { isMegaLink } = await import('@/lib/hosters/mega');
        expect(isMegaLink(url)).toBe(true);
        expect(isMegaLink('https://mega.co.nz/#!file!key')).toBe(true);
        for (const candidate of ['https://mega.nz.evil.test/file/a', 'https://evil.test/mega.nz', 'https://mega.nz@evil.test/a', 'file://mega.nz/a', 'invalid']) {
            expect(isMegaLink(candidate)).toBe(false);
        }
    });

    it('tests credentials independently and closes the test session', async () => {
        const { testMegaAccount } = await import('@/lib/hosters/mega-session');
        await testMegaAccount(account.username, account.password);
        expect(storages[0].close).toHaveBeenCalledTimes(1);
        mocks.storage.mockImplementationOnce(function () {
            return { api: { close: vi.fn() }, ready: Promise.reject(new Error('EMFAREQUIRED (-26)')) };
        });
        await expect(testMegaAccount(account.username, account.password)).rejects.toThrow('two-factor authentication');
    });
});
