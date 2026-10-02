import { createHash } from 'crypto';
import { Storage } from 'megajs';

export interface MegaAccount {
    id: string;
    username?: string | null;
    password?: string | null;
    updatedAt?: Date | string;
    isActive?: boolean;
}

const SESSION_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CACHED_SESSIONS = 32;

interface SessionEntry {
    version: string;
    expiresAt: number;
    users: number;
    retired: boolean;
    ready: Promise<Storage>;
}

const sessions = new Map<string, SessionEntry>();

export class MegaLoginError extends Error {
    constructor(message: string, readonly allowAnonymous = false) {
        super(message);
    }
}

export function isMegaSessionError(error: unknown): boolean {
    return error instanceof Error && /ESID|\(-15\)/i.test(error.message);
}

function loginError(error: unknown): MegaLoginError {
    const message = error instanceof Error ? error.message : '';
    if (/EMFAREQUIRED|\(-26\)/i.test(message)) {
        return new MegaLoginError('This MEGA account requires two-factor authentication, which unattended account login does not currently support.', true);
    }
    if (/ENOENT|\(-9\)|invalid credentials/i.test(message)) {
        return new MegaLoginError('MEGA rejected the email or password.', true);
    }
    if (/ERATELIMIT|\(-4\)/i.test(message)) {
        return new MegaLoginError('MEGA temporarily rate-limited account login. Try again later.');
    }
    // SDK errors can contain request details. Never expose those with credentials.
    return new MegaLoginError('Could not log into MEGA. Check the account or try again later.');
}

async function login(email: string, password: string): Promise<Storage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let storage: Storage | undefined;
    try {
        storage = new Storage({
            email,
            password,
            autoload: false,
            keepalive: false,
            fetch: (input, init) => globalThis.fetch(input, {
                ...init,
                signal: AbortSignal.any([
                    controller.signal,
                    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                    ...(init?.signal ? [init.signal] : []),
                ]),
            }),
        });
        await storage.ready;
        return storage;
    } catch (error) {
        storage?.api.close();
        throw loginError(error);
    } finally {
        clearTimeout(timer);
    }
}

function closeWhenIdle(entry: SessionEntry) {
    // Logging out a shared API while another file is downloading would break that stream.
    void entry.ready.then(storage => storage.close().catch(() => {}), () => {});
}

function retire(entry: SessionEntry) {
    if (entry.retired) return;
    entry.retired = true;
    if (entry.users === 0) closeWhenIdle(entry);
}

export async function acquireMegaSession(account: MegaAccount) {
    const email = account.username!.trim().toLowerCase();
    const password = account.password!;
    const version = createHash('sha256')
        .update(JSON.stringify([email, password, account.updatedAt]))
        .digest('hex');
    for (const [id, entry] of sessions) {
        if (entry.expiresAt <= Date.now() || (id === account.id && entry.version !== version)) {
            sessions.delete(id);
            retire(entry);
        }
    }
    let entry = sessions.get(account.id);
    if (!entry) {
        if (sessions.size >= MAX_CACHED_SESSIONS) {
            const [id, oldest] = sessions.entries().next().value!;
            sessions.delete(id);
            retire(oldest);
        }
        entry = {
            version,
            expiresAt: Date.now() + SESSION_TTL_MS,
            users: 0,
            retired: false,
            ready: login(email, password),
        };
        sessions.set(account.id, entry);
    }
    const current = entry;
    current.users++;
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        current.users--;
        if (current.retired && current.users === 0) closeWhenIdle(current);
    };
    const invalidate = () => {
        if (sessions.get(account.id) === current) sessions.delete(account.id);
        retire(current);
    };
    try {
        const storage = await current.ready;
        return { api: storage.api, release, invalidate };
    } catch (error) {
        invalidate();
        release();
        throw error;
    }
}

/** Tests authentication itself; anonymous access must never make this test pass. */
export async function testMegaAccount(email: string, password: string): Promise<void> {
    if (!email.trim() || !password || password === '********') {
        throw new MegaLoginError('Enter both a MEGA email and password.');
    }
    const storage = await login(email.trim().toLowerCase(), password);
    await storage.close().catch(() => {});
}
