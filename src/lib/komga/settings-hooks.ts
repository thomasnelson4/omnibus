// src/lib/komga/settings-hooks.ts
//
// Komga's two hooks into the admin config save (/api/admin/config POST):
//   - runKomgaEnableGate: BEFORE the secret-encryption loop. Mirrors the Anna's Archive gate: only
//     the komga_enabled false→true transition runs a connection test, and a failing test saves the
//     flag as 'false' with a warning instead of failing the save.
//   - applyKomgaSettingsChange: AFTER the save committed, fire-and-forget. Cache invalidation, an
//     identity reset when the server changed, the instance id, and the reconcile enqueue.
// Neither may fail or stall an Omnibus save, and neither ever logs or echoes the API key.
import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { AuditLogger } from '@/lib/audit-logger';
import { KOMGA_KEYS, KOMGA_READLIST_MIN_VERSION } from './constants';
import { parsePathMappings, serializePathMappings } from './path-map';
import { invalidateKomgaSettingsCache } from './settings';
import { testKomgaConnection, compareKomgaVersions } from './connection-test';
import { createKomgaClientFor } from './factory';

const MASK = '********';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function isTrue(v: unknown): boolean {
    return v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}

function asSettingString(v: unknown): string {
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// Scheme + host + port + path: a trailing slash, host case or an embedded proxy credential is not
// a different Komga server, and treating it as one would needlessly wipe the identity map.
function serverIdentity(url: string | undefined): string {
    const t = (url ?? '').trim();
    if (!t) return '';
    try {
        const u = new URL(t);
        return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
        return t.replace(/\/+$/, '');
    }
}

function mappingsIdentity(raw: string | undefined): string {
    return serializePathMappings(parsePathMappings(raw ?? '[]'));
}

/**
 * Save-time gate. Mutates `incoming` (the settings bag about to be saved):
 *   - komga_instance_id is server-managed (the read-list ownership marker), so it is always removed.
 *   - komga_enabled false→true runs testKomgaConnection with the effective URL/key/mappings
 *     ('********' or an absent key resolves to the stored, decrypted key). Failure → 'false' + a
 *     warning "Komga was not enabled: <message>".
 *   - komga_readlists_enabled on with a known Komga version below 1.23.3 → 'false' + a warning
 *     (PLAN §5). An unknown version is allowed; the push path re-checks eligibility.
 * Never throws: an unexpected error while enabling fails closed.
 */
export async function runKomgaEnableGate(
    incoming: Record<string, unknown>,
    prior: Record<string, string | undefined>,
    warnings: string[],
): Promise<void> {
    if (!incoming || typeof incoming !== 'object') return;
    delete incoming[KOMGA_KEYS.instanceId];
    const before = prior ?? {};

    const pick = (key: string): unknown => (incoming[key] !== undefined ? incoming[key] : before[key]);
    const enabling = isTrue(incoming[KOMGA_KEYS.enabled]) && before[KOMGA_KEYS.enabled] !== 'true';
    const readListsOn = isTrue(pick(KOMGA_KEYS.readListsEnabled));
    const readListsTurningOn = readListsOn && before[KOMGA_KEYS.readListsEnabled] !== 'true';
    const staysEnabled = !enabling && isTrue(pick(KOMGA_KEYS.enabled));
    if (!enabling && !(readListsTurningOn && staysEnabled)) return;

    const refuseReadLists = (version: string) => {
        incoming[KOMGA_KEYS.readListsEnabled] = 'false';
        warnings.push(`Komga reading-list sync was not enabled: it needs Komga ${KOMGA_READLIST_MIN_VERSION} or newer (this server runs ${version}).`);
        Logger.log(`[Komga] Reading-list sync refused at save: Komga ${version} < ${KOMGA_READLIST_MIN_VERSION}`, 'warn');
    };

    try {
        const url = asSettingString(pick(KOMGA_KEYS.url)).trim();
        const apiKey = await resolveApiKey(incoming, before);
        const pathMappings = parsePathMappings(pick(KOMGA_KEYS.pathMappings));

        if (enabling) {
            const test = await testKomgaConnection(url, apiKey, { pathMappings, includeLibraries: false });
            if (!test.success) {
                incoming[KOMGA_KEYS.enabled] = 'false';
                warnings.push(`Komga was not enabled: ${test.message}`);
                Logger.log(`[Komga] Enable gate failed: ${test.message}`, 'warn');
                return;
            }
            Logger.log(`[Komga] Enable gate passed: ${test.message}`, 'info');
            if (readListsOn && test.version && compareKomgaVersions(test.version, KOMGA_READLIST_MIN_VERSION) < 0) {
                refuseReadLists(test.version);
            }
            return;
        }

        // Komga already on; only the reading-list switch flipped. A failed version read allows it.
        try {
            const client = await createKomgaClientFor(url, apiKey);
            const { version } = await client.getInfo();
            if (version && compareKomgaVersions(version, KOMGA_READLIST_MIN_VERSION) < 0) refuseReadLists(version);
        } catch (e) {
            Logger.log(`[Komga] Could not check the Komga version for reading-list sync: ${errText(e)}`, 'debug');
        }
    } catch (e) {
        if (enabling) {
            incoming[KOMGA_KEYS.enabled] = 'false';
            warnings.push('Komga was not enabled: the connection test could not be run. Check the server logs, then try again.');
        }
        Logger.log(`[Komga] Enable gate error: ${errText(e)}`, 'warn');
    }
}

async function resolveApiKey(incoming: Record<string, unknown>, prior: Record<string, string | undefined>): Promise<string> {
    const raw = incoming[KOMGA_KEYS.apiKey];
    if (raw !== undefined && raw !== null && raw !== MASK) return asSettingString(raw).trim();
    if (prior[KOMGA_KEYS.apiKey] !== undefined) return (prior[KOMGA_KEYS.apiKey] ?? '').trim();
    // Prior map without the key (caller read a subset): the db.ts extension decrypts on read.
    const row = await prisma.systemSetting.findUnique({ where: { key: KOMGA_KEYS.apiKey } });
    return (row?.value ?? '').trim();
}

/**
 * Post-save hook. `prior` / `next` are the komga_* values before and after the save (plaintext;
 * '********' or an absent key in `next` means unchanged). Never throws; each step is isolated so a
 * failure in one (DB, Redis) does not skip the others.
 */
export async function applyKomgaSettingsChange(
    prior: Record<string, string | undefined>,
    next: Record<string, string | undefined>,
    actor?: { id?: string; username?: string },
): Promise<void> {
    try {
        invalidateKomgaSettingsCache();
        const before = prior ?? {};
        const after = next ?? {};
        const eff = (key: string): string | undefined => {
            const v = after[key];
            return v === undefined || v === MASK ? before[key] : v;
        };

        const wasEnabled = (before[KOMGA_KEYS.enabled] ?? '').trim() === 'true';
        const isEnabled = (eff(KOMGA_KEYS.enabled) ?? '').trim() === 'true';
        const urlChanged = serverIdentity(before[KOMGA_KEYS.url]) !== serverIdentity(eff(KOMGA_KEYS.url));
        const changed: string[] = [];
        if (urlChanged) changed.push('url');
        if ((before[KOMGA_KEYS.apiKey] ?? '').trim() !== (eff(KOMGA_KEYS.apiKey) ?? '').trim()) changed.push('apiKey');
        if (mappingsIdentity(before[KOMGA_KEYS.pathMappings]) !== mappingsIdentity(eff(KOMGA_KEYS.pathMappings))) changed.push('pathMappings');

        // Book/series/library ids belong to one Komga server; after a server change they are
        // meaningless. Read-list links survive (minus the remote id): the push adopts the old lists
        // back by their ownership marker if this turns out to be the same server.
        if (urlChanged) {
            try {
                await prisma.$transaction([
                    prisma.komgaBookLink.deleteMany({}),
                    prisma.komgaSeriesLink.deleteMany({}),
                    prisma.komgaLibrary.deleteMany({}),
                    prisma.komgaReadListLink.updateMany({ where: { komgaReadListId: { not: null } }, data: { komgaReadListId: null, status: 'pending' } }),
                ]);
                Logger.log('[Komga] Server URL changed: cleared the Komga identity map and library cache.', 'info');
            } catch (e) {
                Logger.log(`[Komga] Could not clear the Komga identity map after a URL change: ${errText(e)}`, 'warn');
            }
        }

        if (isEnabled) {
            try {
                await ensureInstanceId(eff(KOMGA_KEYS.instanceId));
            } catch (e) {
                Logger.log(`[Komga] Could not create the Komga instance id: ${errText(e)}`, 'warn');
            }
        }

        // A fixed URL / API key / path mapping is the usual answer to "Komga stopped syncing".
        // Without this the backoff keeps every library parked behind nextEligibleAt for up to
        // 30 minutes after the operator has already fixed the thing, which reads as "still broken".
        if (isEnabled && changed.length > 0) {
            try {
                const { count } = await prisma.komgaSyncState.updateMany({
                    where: { nextEligibleAt: { not: null }, OR: [{ consecutiveFailures: { gt: 0 } }, { lastError: { not: null } }] },
                    data: { consecutiveFailures: 0, nextEligibleAt: null, lastError: null },
                });
                if (count > 0) {
                    Logger.log(`[Komga] Reset scan backoff for ${count} librar${count === 1 ? 'y' : 'ies'} after ${changed.join(', ')} changed.`, 'info');
                }
            } catch (e) {
                Logger.log(`[Komga] Could not reset scan backoff after a settings change: ${errText(e)}`, 'warn');
            }
        }

        let reason: string | null = null;
        if (isEnabled && !wasEnabled) reason = 'enabled';
        else if (isEnabled && changed.length > 0) reason = `settings changed (${changed.join(', ')})`;
        if (reason) {
            try {
                const { enqueueKomgaReconcile } = await import('./queue');
                await enqueueKomgaReconcile(reason);
                Logger.log(`[Komga] Reconcile queued: ${reason}.`, 'info');
            } catch (e) {
                Logger.log(`[Komga] Could not queue a reconcile (${reason}); the daily reconcile will catch up: ${errText(e)}`, 'warn');
            }
        }

        const toggles: string[] = [];
        if ((before[KOMGA_KEYS.scanOnChange] ?? '') !== (eff(KOMGA_KEYS.scanOnChange) ?? '')) toggles.push('scanOnChange');
        if ((before[KOMGA_KEYS.readListsEnabled] ?? '') !== (eff(KOMGA_KEYS.readListsEnabled) ?? '')) toggles.push('readListsEnabled');
        if (wasEnabled !== isEnabled || changed.length > 0 || toggles.length > 0) {
            // Field names only — never values (the key is a full Komga admin credential).
            try {
                await AuditLogger.log('KOMGA_SETTINGS_CHANGED', {
                    enabled: isEnabled,
                    ...(wasEnabled !== isEnabled ? { enabledChanged: true } : {}),
                    changed: [...changed, ...toggles],
                    ...(actor?.username ? { by: actor.username } : {}),
                }, actor?.id ?? 'System');
            } catch { /* AuditLogger already logs its own failures */ }
        }
    } catch (e) {
        Logger.log(`[Komga] Settings change hook failed: ${errText(e)}`, 'warn');
    }
}

async function ensureInstanceId(known: string | undefined): Promise<void> {
    if (known && known.trim()) return;
    // Re-read: the caller's snapshot may predate a concurrent save that already generated one.
    const row = await prisma.systemSetting.findUnique({ where: { key: KOMGA_KEYS.instanceId } });
    if (row?.value && row.value.trim()) return;
    const id = crypto.randomUUID();
    await prisma.systemSetting.upsert({
        where: { key: KOMGA_KEYS.instanceId },
        update: { value: id },
        create: { key: KOMGA_KEYS.instanceId, value: id },
    });
    Logger.log(`[Komga] Generated Komga instance id ${id}.`, 'info');
}
