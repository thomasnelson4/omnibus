import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HosterEngine } from '@/lib/hosters';
import axios from 'axios';
import { loggerLog } from '../helpers/setup-global';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findFirstHoster: vi.fn(),
    log: vi.fn(),
    findMirrorSettings: vi.fn().mockResolvedValue([]),
}));

// 2. Mock Axios and Database
vi.mock('axios');
vi.mock('@/lib/db', () => ({
    prisma: {
        hosterAccount: { findFirst: mocks.findFirstHoster },
        systemSetting: { findMany: mocks.findMirrorSettings },
    }
}));

describe('Download Pipeline: Hoster Engine', () => {

    it('should resolve Pixeldrain links, attach Premium API headers, and trace debug logs', async () => {
        mocks.findFirstHoster.mockResolvedValueOnce({ apiKey: 'premium_key_123', isActive: true });
        vi.mocked(axios.head).mockResolvedValueOnce({ status: 200 } as any);

        const result = await HosterEngine.resolveLink('https://pixeldrain.com/u/FILE123', 'pixeldrain');

        expect(result.success).toBe(true);
        expect(result.directUrl).toBe('https://pixeldrain.com/api/file/FILE123');
        expect(result.headers?.Authorization).toContain('Basic ');

        // NEW: Assert our new debug logs traced the execution
        expect(loggerLog).toHaveBeenCalledWith(
            expect.stringContaining('[Hoster Engine] Attempting to resolve pixeldrain link...'),
            'info'
        );
        expect(loggerLog).toHaveBeenCalledWith(
            expect.stringContaining('[Pixeldrain Debug] Performing HEAD request to verify file availability'),
            'debug'
        );
    });

    it('should block Annas Archive automated downloads if no API key is present', async () => {
        mocks.findFirstHoster.mockResolvedValueOnce(null); // No premium account configured

        const result = await HosterEngine.resolveLink('https://annas-archive.org/md5/12345', 'annas_archive');

        // Omnibus should block it and return an error so the user has to solve the captcha manually
        expect(result.success).toBe(false);
        expect(result.error).toContain('requires a Premium API Key');
        expect(axios.get).not.toHaveBeenCalled();
    });

    it('should successfully download from Annas Archive if an API key is present', async () => {
        mocks.findFirstHoster.mockResolvedValueOnce({ apiKey: 'anna_key_123', isActive: true });
        
        vi.mocked(axios.get).mockResolvedValueOnce({
            status: 200,
            data: { download_url: 'https://fast.annas-archive.org/file.cbz' }
        } as any);

        const result = await HosterEngine.resolveLink('https://annas-archive.org/md5/12345', 'annas_archive');

        expect(result.success).toBe(true);
        expect(result.directUrl).toBe('https://fast.annas-archive.org/file.cbz');
    });

    it('loads saved fallback mirrors when resolving an unavailable Anna\'s Archive link', async () => {
        mocks.findFirstHoster.mockResolvedValueOnce({ apiKey: 'test-key', isActive: true });
        mocks.findMirrorSettings.mockResolvedValueOnce([
            { key: 'annas_archive_base_url', value: 'https://old.example' },
            { key: 'annas_archive_mirrors', value: 'https://fallback.example' },
        ]);
        vi.mocked(axios.get).mockRejectedValueOnce(new Error('ENOTFOUND'))
            .mockResolvedValueOnce({ status: 200, data: { download_url: 'https://files.example/book.cbz' } } as any);
        const result = await HosterEngine.resolveLink('https://old.example/md5/0123456789abcdef0123456789abcdef', 'annas_archive');
        expect(result).toEqual({ success: true, directUrl: 'https://files.example/book.cbz' });
        expect(axios.get).toHaveBeenNthCalledWith(2, 'https://fallback.example/dyn/api/fast_download.json', expect.any(Object));
    });
});
