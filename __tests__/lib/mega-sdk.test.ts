import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv } from 'crypto';
import type { Transform } from 'stream';
import { API, encrypt } from 'megajs';
import { resolveMega } from '@/lib/hosters/mega';

// Exercise real MEGAJS parsing, requests, decryption and integrity verification. Only
// account login and the remote HTTP service are faked; no provider credentials are used.
const mocks = vi.hoisted(() => ({ storage: vi.fn(), fetch: vi.fn() }));
vi.mock('megajs', async importOriginal => ({
    ...await importOriginal<typeof import('megajs')>(), Storage: mocks.storage,
}));

const payload = Buffer.from('comic-content\n'.repeat(100));
let encrypted: Buffer;
let fileKey: Buffer;
const folderKey = Buffer.alloc(16, 3);
let api: API;

function attributes(name: string, key: Buffer): string {
    const aesKey = Buffer.from(key.subarray(0, 16));
    if (key.length === 32) {
        for (let i = 0; i < 16; i++) aesKey[i] ^= key[i + 16];
    }
    const data = Buffer.from(`MEGA${JSON.stringify({ n: name })}`);
    const padded = Buffer.alloc(Math.ceil(data.length / 16) * 16);
    data.copy(padded);
    const cipher = createCipheriv('aes-128-cbc', aesKey, Buffer.alloc(16));
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64url');
}

function wrappedKey(key: Buffer): string {
    const cipher = createCipheriv('aes-128-ecb', folderKey, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(key), cipher.final()]).toString('base64url');
}

beforeEach(async () => {
    const cipher = encrypt(Buffer.alloc(24, 2)) as Transform & { key: Buffer };
    const bytes = (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of cipher) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
    })();
    // MEGAJS encrypts input chunks in place; keep the expected plaintext intact.
    cipher.end(Buffer.from(payload));
    encrypted = await bytes;
    fileKey = cipher.key;
    api = new API(false, { fetch: mocks.fetch });
    // sid is set by Storage.login in the real SDK.
    Object.assign(api, { sid: 'authenticated-session' });
    mocks.storage.mockReset().mockImplementation(function () {
        return { api, ready: Promise.resolve(), close: vi.fn().mockResolvedValue(undefined) };
    });
    mocks.fetch.mockReset().mockImplementation(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.hostname === 'download.example.test') {
            const [start, end] = url.pathname.split('/').pop()!.split('-').map(Number);
            return new Response(new Uint8Array(encrypted.subarray(start, end + 1)));
        }
        expect(url.searchParams.get('sid')).toBe('authenticated-session');
        const command = JSON.parse(init?.body as string)[0];
        if (command.a === 'f') {
            return Response.json([{ f: [
                { h: 'folderid', t: 1, k: `folderid:${wrappedKey(folderKey)}`, a: attributes('Comics', folderKey) },
                { h: 'comicid', p: 'folderid', t: 0, s: payload.length, k: `folderid:${wrappedKey(fileKey)}`, a: attributes('comic.cbz', fileKey) },
            ] }]);
        }
        expect(command.a).toBe('g');
        return Response.json([{ at: attributes('comic.cbz', fileKey), s: payload.length, g: 'https://download.example.test/content' }]);
    });
});

describe('MEGAJS authenticated public downloads', () => {
    it.each(['file', 'folder', 'folder-file'])('sends the account SID and decrypts a public %s download', async kind => {
        const fileUrl = `https://mega.nz/file/comicid#${fileKey.toString('base64url')}`;
        const folderUrl = `https://mega.nz/folder/folderid#${folderKey.toString('base64url')}`;
        const url = kind === 'file' ? fileUrl : kind === 'folder-file' ? `${folderUrl}/file/comicid` : folderUrl;
        const result = await resolveMega(url, { id: `sdk-${kind}`, username: 'reader@example.com', password: 'test-secret' });
        expect(result.success).toBe(true);
        expect(result.fileName).toBe('comic.cbz');
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of result.megaFileNode!.download({ maxConnections: 1, forceHttps: true })) {
                chunks.push(Buffer.from(chunk));
            }
            expect(Buffer.concat(chunks).equals(payload)).toBe(true);
            const calls = mocks.fetch.mock.calls.filter(([input]) => new URL(input as string).hostname !== 'download.example.test');
            const downloadCall = calls.find(([, init]) => JSON.parse(init.body)[0].g === 1)!;
            expect(new URL(downloadCall[0]).searchParams.get('sid')).toBe('authenticated-session');
            if (kind !== 'file') {
                expect(new URL(downloadCall[0]).searchParams.get('n')).toBe('folderid');
                expect(JSON.parse(downloadCall[1].body)[0].n).toBe('comicid');
            }
        } finally {
            result.release?.();
        }
    });
});
