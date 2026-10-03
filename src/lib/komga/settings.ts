// src/lib/komga/settings.ts
//
// Komga settings reads. HOT-PATH SAFE: recordLibraryChange and the reading-list trigger import this
// from inside Omnibus file operations, so it may only import db, logger, ./constants and ./path-map
// (never the client, the queue or anything that opens a socket).
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { KOMGA_KEYS, KOMGA_SETTING_KEYS, KOMGA_SETTINGS_CACHE_TTL_MS } from './constants';
import { parsePathMappings, type KomgaPathMapping } from './path-map';

export interface KomgaSettings {
    enabled: boolean;
    url: string | null;
    apiKey: string | null;
    pathMappings: KomgaPathMapping[];
    pathMappingsRaw: string;
    scanOnChange: boolean;
    readListsEnabled: boolean;
    instanceId: string | null;
}

export interface KomgaHotFlags {
    enabled: boolean;
    scanOnChange: boolean;
    readListsEnabled: boolean;
}

const ALL_OFF: KomgaHotFlags = { enabled: false, scanOnChange: false, readListsEnabled: false };

function nonEmpty(v: string | undefined): string | null {
    const t = (v ?? '').trim();
    return t ? t : null;
}

/** Pure parse of SystemSetting rows. Defaults per PLAN §5: everything off except scan-on-change. */
export function parseKomgaSettings(rows: { key: string; value: string }[]): KomgaSettings {
    const map = new Map<string, string>();
    for (const r of rows) {
        if (r && typeof r.key === 'string') map.set(r.key, typeof r.value === 'string' ? r.value : String(r.value ?? ''));
    }
    const scanRaw = nonEmpty(map.get(KOMGA_KEYS.scanOnChange));
    const pathMappingsRaw = nonEmpty(map.get(KOMGA_KEYS.pathMappings)) ?? '[]';
    return {
        enabled: map.get(KOMGA_KEYS.enabled)?.trim() === 'true',
        url: nonEmpty(map.get(KOMGA_KEYS.url)),
        apiKey: nonEmpty(map.get(KOMGA_KEYS.apiKey)),
        pathMappings: parsePathMappings(pathMappingsRaw),
        pathMappingsRaw,
        // An absent/blank row means "never saved", which defaults to on; only an explicit value turns it off.
        scanOnChange: scanRaw === null ? true : scanRaw === 'true',
        readListsEnabled: map.get(KOMGA_KEYS.readListsEnabled)?.trim() === 'true',
        instanceId: nonEmpty(map.get(KOMGA_KEYS.instanceId)),
    };
}

/** Fresh (uncached) read of every Komga key. komga_api_key comes back decrypted via the db.ts extension. Throws on DB errors. */
export async function getKomgaSettings(): Promise<KomgaSettings> {
    const rows = await prisma.systemSetting.findMany({ where: { key: { in: [...KOMGA_SETTING_KEYS] } } });
    return parseKomgaSettings(rows);
}

// Route bundles and the instrumentation bundle each get their own copy of this module, so the cache
// lives on globalThis; `generation` stops an in-flight read that straddles an invalidate from
// re-populating the cache with pre-save values.
const g = globalThis as unknown as {
    __komgaHotFlags?: { value: KomgaHotFlags; expiresAt: number };
    __komgaHotFlagsInflight?: Promise<KomgaHotFlags>;
    __komgaHotFlagsGeneration?: number;
};

/**
 * Cheap gate for hot paths. The flags are EFFECTIVE values: scanOnChange/readListsEnabled are only
 * true when Komga itself is enabled. Never throws — a DB error yields all-false (cached for the TTL
 * so a failing DB is not hammered once per file operation).
 */
export async function getKomgaHotFlags(): Promise<KomgaHotFlags> {
    const cached = g.__komgaHotFlags;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (g.__komgaHotFlagsInflight) return g.__komgaHotFlagsInflight;

    const generation = g.__komgaHotFlagsGeneration ?? 0;
    const read = (async (): Promise<KomgaHotFlags> => {
        let value: KomgaHotFlags;
        try {
            const rows = await prisma.systemSetting.findMany({
                where: { key: { in: [KOMGA_KEYS.enabled, KOMGA_KEYS.scanOnChange, KOMGA_KEYS.readListsEnabled] } },
                select: { key: true, value: true },
            });
            const s = parseKomgaSettings(rows);
            value = { enabled: s.enabled, scanOnChange: s.enabled && s.scanOnChange, readListsEnabled: s.enabled && s.readListsEnabled };
        } catch (e) {
            Logger.log(`[Komga] Settings flag read failed; treating Komga as disabled: ${e instanceof Error ? e.message : String(e)}`, 'debug');
            value = { ...ALL_OFF };
        }
        if ((g.__komgaHotFlagsGeneration ?? 0) === generation) {
            g.__komgaHotFlags = { value, expiresAt: Date.now() + KOMGA_SETTINGS_CACHE_TTL_MS };
        }
        return value;
    })();
    g.__komgaHotFlagsInflight = read;
    try {
        return await read;
    } finally {
        if (g.__komgaHotFlagsInflight === read) g.__komgaHotFlagsInflight = undefined;
    }
}

/** Drop the hot-flag cache (called after a settings save). Only affects this process. */
export function invalidateKomgaSettingsCache(): void {
    g.__komgaHotFlags = undefined;
    g.__komgaHotFlagsInflight = undefined;
    g.__komgaHotFlagsGeneration = (g.__komgaHotFlagsGeneration ?? 0) + 1;
}

/** Global custom request headers (Settings → Access & Security), applied to Komga requests the same way Prowlarr gets them. */
export async function getKomgaCustomHeaders(): Promise<Record<string, string>> {
    try {
        const rows = await prisma.customHeader.findMany();
        const headers: Record<string, string> = {};
        for (const h of rows) {
            const key = typeof h.key === 'string' ? h.key.trim() : '';
            const value = typeof h.value === 'string' ? h.value.trim() : '';
            if (key && value) headers[key] = value;
        }
        return headers;
    } catch (e) {
        Logger.log(`[Komga] Custom header read failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
        return {};
    }
}
