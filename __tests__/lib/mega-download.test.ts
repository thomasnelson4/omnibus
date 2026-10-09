import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Readable } from 'stream';
import { DownloadService } from '@/lib/download-clients';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), update: vi.fn(), setting: vi.fn(), engine: vi.fn() }));
vi.mock('@/lib/hosters', () => ({ HosterEngine: { resolveLink: mocks.resolve } }));
vi.mock('@/lib/db', () => ({ prisma: {
    systemSetting: { findUnique: mocks.setting }, request: { update: mocks.update, findUnique: vi.fn().mockResolvedValue(null) },
} }));
vi.mock('@/lib/importer', () => ({ Importer: {} }));
vi.mock('@/lib/engine', () => ({ ENGINE_URL: 'http://engine', engineHeaders: () => ({}), engineFetchLong: mocks.engine }));

const url = 'https://mega.nz/file/handle#public-key';
const payload = Buffer.alloc(600_000, 'x');
let directory: string;
const result = (stream = () => Readable.from([payload])) => ({
    success: true, isMegaStream: true, fileName: 'comic.cbz',
    megaFileNode: { size: payload.length, download: vi.fn(stream) },
    release: vi.fn(), invalidateMegaSession: vi.fn(),
});
const failedStream = (message: string) => new Readable({ read() { this.destroy(new Error(message)); } });

beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'omnibus-mega-test-'));
    mocks.resolve.mockReset();
    mocks.setting.mockReset().mockResolvedValue(null);
    mocks.update.mockResolvedValue({});
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('MEGA download streaming and retry routing', () => {
    it('infers MEGA for retry calls and saves SDK bytes without using the HTTP engine', async () => {
        const resolved = result();
        mocks.resolve.mockResolvedValue(resolved);
        expect(await DownloadService.downloadDirectFile(url, 'comic', directory, 'request-1')).toBe(true);
        expect(mocks.resolve).toHaveBeenCalledWith(url, 'mega');
        expect(resolved.megaFileNode.download).toHaveBeenCalledWith({ forceHttps: true });
        expect(readFileSync(path.join(directory, 'GetComics/comic.cbz'))).toEqual(payload);
        expect(resolved.release).toHaveBeenCalledTimes(1);
        expect(mocks.engine).not.toHaveBeenCalled();
    });

    it('refreshes an expired SDK session once and restarts the partial file', async () => {
        const stale = result(() => failedStream('ESID (-15)'));
        const fresh = result();
        mocks.resolve.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
        expect(await DownloadService.downloadDirectFile(url, 'comic', directory, 'request-1', 'mega')).toBe(true);
        expect(mocks.resolve).toHaveBeenCalledTimes(2);
        expect(stale.invalidateMegaSession).toHaveBeenCalledTimes(1);
        expect(stale.release).toHaveBeenCalledTimes(1);
        expect(fresh.release).toHaveBeenCalledTimes(1);
        expect(readFileSync(path.join(directory, 'GetComics/comic.cbz'))).toEqual(payload);
        expect(existsSync(path.join(directory, 'GetComics/comic.cbz.part'))).toBe(false);
    });

    it('does not loop on repeatedly expired sessions and cleans up', async () => {
        const first = result(() => failedStream('ESID (-15)'));
        const second = result(() => failedStream('ESID (-15)'));
        mocks.resolve.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        await expect(DownloadService.downloadDirectFile(url, 'comic', directory, 'request-1')).rejects.toThrow('expired again');
        expect(mocks.resolve).toHaveBeenCalledTimes(2);
        expect(second.invalidateMegaSession).toHaveBeenCalledTimes(1);
        expect(second.release).toHaveBeenCalledTimes(1);
        expect(existsSync(path.join(directory, 'GetComics/comic.cbz.part'))).toBe(false);
        expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'STALLED', progress: 0 } }));
    });

    it('does not repeatedly log in when the transfer allowance is exhausted', async () => {
        const resolved = result(() => failedStream('Bandwidth limit reached: 3600 seconds until it resets'));
        mocks.resolve.mockResolvedValue(resolved);
        await expect(DownloadService.downloadDirectFile(url, 'comic', directory, 'request-1')).rejects.toThrow('transfer allowance exhausted');
        expect(mocks.resolve).toHaveBeenCalledTimes(1);
        expect(resolved.invalidateMegaSession).not.toHaveBeenCalled();
        expect(resolved.release).toHaveBeenCalledTimes(1);
        expect(existsSync(path.join(directory, 'GetComics/comic.cbz.part'))).toBe(false);
    });

    it('respects disabled MEGA hoster preferences on retry', async () => {
        mocks.setting.mockImplementation(async ({ where }) => where.key === 'hoster_priority'
            ? { value: JSON.stringify([{ hoster: 'mega', enabled: false }]) } : null);
        await expect(DownloadService.downloadDirectFile(url, 'comic', directory, 'request-1')).rejects.toThrow('disabled');
        expect(mocks.resolve).not.toHaveBeenCalled();
        expect(mocks.engine).not.toHaveBeenCalled();
    });

    it('keeps ordinary HTTP files on the existing engine path', async () => {
        mocks.engine.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        expect(await DownloadService.downloadDirectFile('https://cdn.example.test/comic.cbz', 'comic', directory, 'request-1')).toBe(true);
        expect(mocks.resolve).not.toHaveBeenCalled();
        expect(mocks.engine).toHaveBeenCalledTimes(1);
    });
});
