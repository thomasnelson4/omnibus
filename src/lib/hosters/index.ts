// src/lib/hosters/index.ts
import { prisma } from '@/lib/db';
import { Logger } from '../logger';
import { decryptSecret } from '../encryption';
import { resolveMediaFire } from './mediafire';
import { resolvePixeldrain } from './pixeldrain';
import { resolveMega } from './mega';
import { resolveRootz } from './rootz';
import { resolveVikingfile } from './vikingfile';
import { resolveTerabox } from './terabox';
import { resolveAnnasArchive } from './annas-archive';
import type { File } from 'megajs';

export interface HosterResolveResult {
    success: boolean;
    directUrl?: string;
    headers?: Record<string, string>;
    isMegaStream?: boolean;
    megaFileNode?: File;
    release?: () => void;
    invalidateMegaSession?: () => void;
    fileName?: string;
    error?: string;
}

export const HosterEngine = {
    async resolveLink(url: string, hoster: string): Promise<HosterResolveResult> {
        Logger.log(`[Hoster Engine] Attempting to resolve ${hoster} link...`, 'info');

        try {
            const stored = await prisma.hosterAccount.findFirst({
                where: { hoster, isActive: true },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            });
            // Keep decrypted secrets in a local copy, inside the error boundary.
            const account = stored ? {
                ...stored,
                password: await decryptSecret(stored.password),
                apiKey: hoster === 'mega' ? null : await decryptSecret(stored.apiKey),
            } : null;
            Logger.log(`[Hoster Engine Debug] Account configuration for ${hoster}: ${account ? 'Active' : 'None (Anonymous)'}`, 'debug');
            let result: HosterResolveResult;

            switch (hoster) {
                case 'mediafire':
                    result = await resolveMediaFire(url, account);
                    break;
                case 'pixeldrain':
                    result = await resolvePixeldrain(url, account);
                    break;
                case 'mega':
                    result = await resolveMega(url, account);
                    break;
                case 'rootz':
                    result = await resolveRootz(url, account);
                    break;
                case 'vikingfile':
                    result = await resolveVikingfile(url, account);
                    break;
                case 'terabox':
                    result = await resolveTerabox(url, account);
                    break;
                case 'annas_archive':
                    result = await resolveAnnasArchive(url, account);
                    break;
                default:
                    result = { success: false, error: `No resolver found for hoster: ${hoster}` };
            }

            Logger.log(`[Hoster Engine Debug] Resolution result for ${hoster}: ${result.success ? 'Success' : 'Failed'}`, 'debug');
            return result;

        } catch (error: any) {
            if (hoster === 'mega') {
                Logger.log('[Mega] Could not read the saved account credentials.', 'error');
                return { success: false, error: 'Could not read the saved MEGA credentials. Re-enter the account in Settings.' };
            }
            Logger.log(`[Hoster Engine Debug] Uncaught exception during resolution: ${error.message}`, 'debug');
            Logger.log(`[Hoster Engine] Resolution failed for ${hoster}: ${error.message}`, 'error');
            return { success: false, error: error.message };
        }
    }
};
