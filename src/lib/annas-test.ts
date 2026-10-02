// src/lib/annas-test.ts
//
// Shared Anna's Archive API-key validation, used by both the admin "Test API Key" button
// (/api/admin/test) and the save-time automation gate (/api/admin/config). Anna's Archive exposes no
// quota-free key-check endpoint, so we probe fast_download.json with a placeholder md5: a valid key
// returns a download_url and/or account_fast_download_info (quota); an invalid key returns an error.
// (Placeholder md5 — Phase 3 may switch to a known-present md5 for a stricter check.)
import { requestAnnasArchiveApi } from './annas-api';

export interface AnnasTestResult {
    success: boolean;
    message: string;
    downloadsLeft?: number;
}

export async function testAnnasArchiveKey(key: string | null | undefined, baseUrl?: string, mirrors?: string): Promise<AnnasTestResult> {
    if (!key) {
        return { success: false, message: "No Anna's Archive API key configured. Add one under Hoster Accounts — interactive search still works without it." };
    }
    try {
        const { data } = await requestAnnasArchiveApi(key, '00000000000000000000000000000000', { baseUrl, mirrors }, 10000);
        const left = data.account_fast_download_info?.downloads_left;
        if (data.download_url || typeof left === 'number') {
            return {
                success: true,
                downloadsLeft: typeof left === 'number' ? left : undefined,
                message: typeof left === 'number'
                    ? `Anna's Archive API key valid (${left} download(s) left today).`
                    : "Anna's Archive API key valid.",
            };
        }
        return {
            success: false,
            message: data.error
                ? `Anna's Archive: ${data.error}`
                : "API key rejected or no response. Check the key and your membership status.",
        };
    } catch (e: any) {
        return { success: false, message: `Anna's Archive: ${e?.message || 'connection failed'}` };
    }
}
