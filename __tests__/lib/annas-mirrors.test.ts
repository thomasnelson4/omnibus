import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { annasMirrorCandidates, parseAnnasMirrors } from '@/lib/annas-mirrors';
import { requestAnnasArchiveApi } from '@/lib/annas-api';
import { testAnnasArchiveKey } from '@/lib/annas-test';
import { resolveAnnasArchive } from '@/lib/hosters/annas-archive';

vi.mock('axios');

const primary = 'https://primary.example';
const fallback = 'https://fallback.example';
const md5 = '0123456789abcdef0123456789abcdef';

describe("Anna's Archive configured mirrors", () => {
    beforeEach(() => { vi.mocked(axios.get).mockReset(); });

    it('keeps user order ahead of built-ins, normalizes addresses, and removes duplicates', () => {
        expect(annasMirrorCandidates(`${primary}/`, ` ${fallback}/\r\nhttps://second.example,${fallback}\nhttps://annas-archive.gl`).slice(0, 4))
            .toEqual([primary, fallback, 'https://second.example', 'https://annas-archive.gl']);
        expect(annasMirrorCandidates('', '').slice(0, 1)).toEqual(['https://annas-archive.gl']);
        expect(annasMirrorCandidates(primary, fallback, `${fallback}/md5/${md5}`).slice(0, 2))
            .toEqual([fallback, primary]);
    });

    it.each(['not-a-url', 'ftp://bad.example', 'https://user:pass@bad.example', 'https://bad.example/md5/1', 'https://bad.example?key=x'])
        ('rejects invalid mirror address %s', address => {
            expect(() => parseAnnasMirrors(address)).toThrow('Invalid Anna\'s Archive mirror URL');
        });

    it.each([
        { status: 503, data: { error: 'unavailable' } },
        { status: 429, data: 'rate limited' },
        { status: 404, data: 'not found' },
        { status: 403, data: '<!doctype html><title>Just a moment...</title>' },
        { status: 200, data: '<html>challenge</html>' },
        { status: 200, data: {} },
        { status: 200, data: { account_fast_download_info: {} } },
    ])('uses the configured fallback after an unusable response ($status)', async response => {
        vi.mocked(axios.get).mockResolvedValueOnce(response as any)
            .mockResolvedValueOnce({ status: 200, data: { download_url: 'https://files.example/book.cbz' } } as any);
        const result = await requestAnnasArchiveApi('test-key', md5, { baseUrl: primary, mirrors: fallback });
        expect(result.mirror).toBe(fallback);
        expect(axios.get).toHaveBeenNthCalledWith(2, `${fallback}/dyn/api/fast_download.json`, expect.objectContaining({ params: { key: 'test-key', md5 } }));
        expect(axios.get).toHaveBeenCalledTimes(2);
    });

    it('the API-key test uses a fallback when the primary cannot connect', async () => {
        vi.mocked(axios.get).mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockResolvedValueOnce({ status: 200, data: { account_fast_download_info: { downloads_left: 7 } } } as any);
        expect(await testAnnasArchiveKey('test-key', primary, fallback)).toMatchObject({ success: true, downloadsLeft: 7 });
        expect(axios.get).toHaveBeenNthCalledWith(2, `${fallback}/dyn/api/fast_download.json`, expect.any(Object));
    });

    it('resolves an old queued link through the configured mirrors when its origin is down', async () => {
        vi.mocked(axios.get).mockRejectedValueOnce(new Error('ENOTFOUND'))
            .mockResolvedValueOnce({ status: 503, data: 'unavailable' } as any)
            .mockResolvedValueOnce({ status: 200, data: { download_url: 'https://files.example/book.cbz' } } as any);
        const result = await resolveAnnasArchive(`https://old.example/md5/${md5}`, { apiKey: 'test-key' }, { baseUrl: primary, mirrors: fallback });
        expect(result).toEqual({ success: true, directUrl: 'https://files.example/book.cbz' });
        expect(vi.mocked(axios.get).mock.calls.map(call => call[0])).toEqual([
            'https://old.example/dyn/api/fast_download.json',
            `${primary}/dyn/api/fast_download.json`,
            `${fallback}/dyn/api/fast_download.json`,
        ]);
    });

    it.each(['Invalid API key', 'Daily download quota exhausted'])('does not retry the authoritative API error: %s', async error => {
        vi.mocked(axios.get).mockResolvedValueOnce({ status: 403, data: { error } } as any);
        const result = await resolveAnnasArchive(`${primary}/md5/${md5}`, { apiKey: 'test-key' }, { baseUrl: primary, mirrors: fallback });
        expect(result.success).toBe(false);
        expect(result.error).toContain(error);
        expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('reports a failure when every mirror is unreachable', async () => {
        vi.mocked(axios.get).mockRejectedValue(new Error('ENOTFOUND'));
        const result = await testAnnasArchiveKey('test-key', primary, fallback);
        expect(result.success).toBe(false);
        expect(result.message).toContain('any configured or built-in mirror');
        expect(axios.get).toHaveBeenCalledTimes(6);
    });
});
