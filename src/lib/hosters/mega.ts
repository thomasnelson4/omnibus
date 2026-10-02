import { File } from 'megajs';
import { Logger } from '../logger';
import { acquireMegaSession, isMegaSessionError, MegaLoginError, type MegaAccount } from './mega-session';
import type { HosterResolveResult } from './index';

export function isMegaLink(url: string): boolean {
    try {
        const parsed = new URL(url);
        return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
            && (parsed.hostname === 'mega.nz' || parsed.hostname === 'mega.co.nz');
    } catch {
        return false;
    }
}

export async function resolveMega(url: string, account?: MegaAccount | null): Promise<HosterResolveResult> {
    let lease: Awaited<ReturnType<typeof acquireMegaSession>> | undefined;
    try {
        // Validate before logging in. File.fromURL's errors may include the URL's key.
        File.fromURL(url);
        const email = account?.isActive !== false ? account?.username?.trim() : '';
        const password = account?.isActive !== false ? account?.password : '';
        if (!!email !== !!password) {
            return { success: false, error: 'Enter both a MEGA email and password, or clear both for anonymous downloads.' };
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            if (email && password && account) {
                try {
                    lease = await acquireMegaSession(account);
                } catch (error) {
                    if (!(error instanceof MegaLoginError) || !error.allowAnonymous) throw error;
                    Logger.log(`[Mega] ${error.message} Trying anonymous download.`, 'warn');
                }
            }
            try {
                Logger.log(`[Mega] Loading shared link (${lease ? 'authenticated' : 'anonymous'}).`, 'info');
                const root = File.fromURL(url, lease ? { api: lease.api } : undefined);
                const node = await root.loadAttributes();
                let target: File | undefined = node;
                if (node.directory) {
                    target = (node.children || [])
                        .filter(child => !child.directory && /\.(cbz|cbr|zip|rar)$/i.test(child.name || ''))
                        .sort((a, b) => (b.size || 0) - (a.size || 0))[0];
                }
                if (!target) throw new Error('No comic archives found');
                // megajs 1.3.10 creates folder children with the anonymous global API.
                target.api = root.api;
                return {
                    success: true,
                    isMegaStream: true,
                    megaFileNode: target,
                    fileName: target.name || undefined,
                    release: lease?.release,
                    invalidateMegaSession: lease?.invalidate,
                };
            } catch (error) {
                lease?.release();
                if (!lease || !isMegaSessionError(error)) throw error;
                lease.invalidate();
                lease = undefined;
                if (attempt === 1) throw error;
                Logger.log('[Mega] Session expired; logging in again.', 'warn');
            }
        }
        throw new Error('MEGA resolution failed');
    } catch (error) {
        lease?.release();
        const message = error instanceof MegaLoginError ? error.message
            : isMegaSessionError(error) ? 'MEGA session expired again. Try the download later.'
            : error instanceof Error && error.message === 'No comic archives found' ? 'No comic files (.cbz, .cbr, .zip, .rar) found inside the MEGA folder.'
            : 'Could not load the MEGA file or folder. Check the link and its decryption key, or try again later.';
        Logger.log(`[Mega] ${message}`, 'warn');
        return { success: false, error: message };
    }
}
