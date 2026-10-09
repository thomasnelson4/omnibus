import axios from 'axios';
import { annasMirrorCandidates } from './annas-mirrors';
import { Logger } from './logger';

export interface AnnasMirrorConfig {
    baseUrl?: string | null;
    mirrors?: string | null;
    preferredUrl?: string;
}

// Retry unavailable mirrors, but return an authoritative API response immediately. An invalid key
// or exhausted quota is shared across mirrors; retrying it can waste fast-download allowance.
export async function requestAnnasArchiveApi(key: string, md5: string, config: AnnasMirrorConfig = {}, timeout = 15000) {
    for (const mirror of annasMirrorCandidates(config.baseUrl, config.mirrors, config.preferredUrl)) {
        try {
            const res = await axios.get(`${mirror}/dyn/api/fast_download.json`, {
                headers: { 'User-Agent': 'Omnibus/1.0' },
                params: { key, md5 },
                timeout,
                validateStatus: () => true,
            });
            const data = res.data;
            const isApiResponse = data && typeof data === 'object' && !Array.isArray(data) &&
                ((typeof data.download_url === 'string' && data.download_url.trim()) ||
                    typeof data.account_fast_download_info?.downloads_left === 'number' ||
                    (typeof data.error === 'string' && data.error.length > 0));
            if (res.status !== 404 && res.status !== 429 && !(res.status >= 500) && isApiResponse) {
                return { data, mirror };
            }
            Logger.log(`[Anna's Archive] Mirror ${mirror} returned HTTP ${res.status} or an unusable API response; trying the next mirror.`, 'warn');
        } catch {
            // Avoid logging Axios errors: their request config can contain the API key.
            Logger.log(`[Anna's Archive] Mirror ${mirror} could not be reached; trying the next mirror.`, 'warn');
        }
    }
    throw new Error("Could not reach a usable Anna's Archive API on any configured or built-in mirror.");
}
