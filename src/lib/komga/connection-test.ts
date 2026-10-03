// src/lib/komga/connection-test.ts
//
// Reusable Komga connection test (PLAN §6 P1), shared by the admin "Test connection" button
// (/api/admin/test), the detected-libraries table (/api/admin/komga/libraries) and the save-time
// enable gate (settings-hooks.ts). Modelled on annas-test.ts: it never throws, and every failure is a
// {success:false, message} the admin can act on. The steps run in order and the first failing one
// decides the message:
//   1. health()        — is anything Komga-shaped answering at this URL?
//   2. getMe()         — valid key, ADMIN role, no content restrictions (they filter admins too)
//   3. getInfo()       — version gate (< 1.20.0 fails, < 1.23.5 warns)
//   4. listLibraries() — mapping status + per-library and global warnings
// Omnibus never changes Komga library settings; it only reports them.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import type { KomgaClient } from './client';
import { isKomgaError, type KomgaLibraryDto, type KomgaUserDto } from './types';
import { KOMGA_MIN_VERSION, KOMGA_RECOMMENDED_VERSION, KOMGA_READLIST_MIN_VERSION, KOMGA_HTTP_TIMEOUT_MS } from './constants';
import type { KomgaPathMapping } from './path-map';
import { createKomgaClientFor } from './factory';
import {
    resolveKomgaLibraries,
    komgaLibrariesForOmnibusLibrary,
    computeLibraryWarnings,
    computeGlobalWarnings,
    countCb7InLibraries,
    persistKomgaLibraries,
    type OmnibusLibraryRef,
} from './libraries';

export interface KomgaDetectedLibrary {
    id: string;
    name: string;
    root: string;
    translatedRoot: string | null;
    omnibusLibrary: { id: string; name: string; path: string } | null;
    warnings: string[];
}

export interface KomgaTestResult {
    success: boolean;
    message: string;
    version: string | null;
    /**
     * Version + global warnings. With includeLibraries=false the per-library warnings are folded
     * in as `Komga library "<name>": …`; with includeLibraries=true (the default) they live only on
     * libraries[i].warnings, so a caller showing both never lists a warning twice.
     */
    warnings: string[];
    user?: { email: string; roles: string[]; sharedAllLibraries: boolean };
    libraries?: KomgaDetectedLibrary[];
}

export interface KomgaTestOptions {
    pathMappings?: KomgaPathMapping[];
    includeLibraries?: boolean;
    /** Write the KomgaLibrary cache after a successful listLibraries (only for the SAVED url/mappings). */
    persist?: boolean;
    /** Test seam; defaults to a client for url/apiKey with the saved custom headers. */
    client?: KomgaClient;
}

/** Numeric compare of the x.y.z core; pre-release/build suffixes ("1.28.1-SNAPSHOT") are ignored. */
export function compareKomgaVersions(a: string, b: string): number {
    const parse = (v: string) => String(v ?? '').trim().replace(/^v/i, '').split(/[-+\s]/)[0]
        .split('.').map(n => { const x = parseInt(n, 10); return Number.isFinite(x) ? x : 0; });
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d < 0 ? -1 : 1;
    }
    return 0;
}

function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

function contentRestrictions(me: KomgaUserDto): string[] {
    const out: string[] = [];
    // UserDto is @JsonInclude(NON_NULL): an unrestricted user has NO ageRestriction field at all.
    if (me.ageRestriction != null) {
        const r = me.ageRestriction;
        out.push(`age restriction (${r.restriction === 'EXCLUDE' ? 'exclude' : 'allow only'} ${r.age}+)`);
    }
    if (Array.isArray(me.labelsAllow) && me.labelsAllow.length > 0) out.push(`allowed labels: ${me.labelsAllow.join(', ')}`);
    if (Array.isArray(me.labelsExclude) && me.labelsExclude.length > 0) out.push(`excluded labels: ${me.labelsExclude.join(', ')}`);
    return out;
}

export async function testKomgaConnection(url: string, apiKey: string, opts: KomgaTestOptions = {}): Promise<KomgaTestResult> {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    // Defense in depth for "the API key never reaches the browser": whatever text a lower layer
    // produced, scrub the key out of it before it becomes a message.
    const scrub = (text: string): string => (key.length >= 4 ? text.split(key).join('***') : text);
    const errText = (e: unknown): string => scrub(e instanceof Error ? e.message : String(e));
    let version: string | null = null;
    let user: KomgaTestResult['user'];
    const warnings: string[] = [];
    const fail = (message: string): KomgaTestResult => ({
        success: false, message: scrub(message), version, warnings: warnings.map(scrub), ...(user ? { user } : {}),
    });

    try {
        const baseUrl = typeof url === 'string' ? url.trim() : '';
        if (!baseUrl) return fail('Enter the Komga URL (for example http://192.168.1.10:25600).');
        if (!/^https?:\/\/[^/\s]+/i.test(baseUrl)) return fail('The Komga URL must start with http:// or https://.');
        if (!key) return fail('Enter a Komga API key (Komga → Account settings → API keys).');
        if (key.startsWith('enc:')) return fail('The saved Komga API key could not be decrypted. Re-enter it and save again.');

        const client = opts.client ?? await createKomgaClientFor(baseUrl, key);

        // 1. Reachability (anonymous endpoint).
        try {
            const health = await client.health();
            const status = typeof health?.status === 'string' ? health.status.toUpperCase() : '';
            if (!status || status === 'UNKNOWN') return fail('The server at this URL answered, but it does not look like Komga (no health status). Check the URL and any sub-path.');
            if (status !== 'UP') return fail(`Komga is reachable but reports its status as ${status}.`);
        } catch (e) {
            if (isKomgaError(e)) {
                if (e.kind === 'timeout') return fail(`Komga did not answer within ${Math.round(KOMGA_HTTP_TIMEOUT_MS / 1000)} s. Check the URL and that Komga is running.`);
                if (e.kind === 'unreachable') return fail(`Cannot reach Komga at this URL: ${errText(e)}`);
                if (e.kind === 'notFound') return fail('No Komga server found at this URL (the health endpoint returned 404). Check the URL, including any sub-path such as /komga.');
                if (e.kind === 'unauthorized' || e.kind === 'forbidden') return fail(`Something in front of Komga rejected the request (HTTP ${e.status}). If a reverse proxy requires authentication, add its header under Settings → Access & Security → Custom Request Headers.`);
            }
            return fail(`Komga health check failed: ${errText(e)}`);
        }

        // 2. Who does the key belong to?
        let me: KomgaUserDto;
        try {
            me = await client.getMe();
        } catch (e) {
            if (isKomgaError(e) && e.kind === 'unauthorized') return fail('Invalid API key, or Komga is older than 1.20.0 (no API-key support)');
            if (isKomgaError(e) && e.kind === 'forbidden') return fail('Komga refused the API key (403 Forbidden).');
            return fail(`Could not read the Komga user for this API key: ${errText(e)}`);
        }
        const roles = Array.isArray(me?.roles) ? me.roles.map(String) : [];
        user = { email: String(me?.email ?? ''), roles, sharedAllLibraries: me?.sharedAllLibraries === true };
        if (!roles.includes('ADMIN')) {
            return fail(`The API key belongs to ${user.email || 'a Komga user'}, which is not a Komga admin. Omnibus needs an API key of an ADMIN user.`);
        }
        const restrictions = contentRestrictions(me);
        if (restrictions.length > 0) {
            return fail(`The Komga user ${user.email} has content restrictions (${restrictions.join('; ')}). Restrictions hide books even from admins, so Omnibus needs an admin user without them.`);
        }

        // 3. Version. An API key that authenticated already proves >= 1.20.0, so an unreadable version
        // only warns.
        try {
            const info = await client.getInfo();
            version = typeof info?.version === 'string' && info.version.trim() ? info.version.trim() : null;
        } catch (e) {
            if (isKomgaError(e) && (e.kind === 'unauthorized' || e.kind === 'forbidden')) {
                return fail(`Komga refused /actuator/info (HTTP ${e.status}); the API key's user must be an admin.`);
            }
            return fail(`Could not read the Komga version: ${errText(e)}`);
        }
        if (version === null) {
            warnings.push(`Could not determine the Komga version. ${KOMGA_RECOMMENDED_VERSION} or newer is recommended.`);
        } else if (compareKomgaVersions(version, KOMGA_MIN_VERSION) < 0) {
            return fail(`Komga ${version} is not supported. Omnibus needs Komga ${KOMGA_MIN_VERSION} or newer (${KOMGA_RECOMMENDED_VERSION}+ recommended).`);
        } else if (compareKomgaVersions(version, KOMGA_RECOMMENDED_VERSION) < 0) {
            const readLists = compareKomgaVersions(version, KOMGA_READLIST_MIN_VERSION) < 0
                ? ` Reading-list sync needs ${KOMGA_READLIST_MIN_VERSION} or newer.`
                : '';
            warnings.push(`Komga ${version} is older than the recommended ${KOMGA_RECOMMENDED_VERSION}: before 1.23.5 API-key requests can return empty results.${readLists} Upgrading is recommended.`);
        }

        // 4. Libraries and their mapping status.
        let dtos: KomgaLibraryDto[];
        try {
            dtos = await client.listLibraries();
        } catch (e) {
            return fail(`Could not list the Komga libraries: ${errText(e)}`);
        }
        const mappings = opts.pathMappings ?? [];
        let omnibusLibraries: OmnibusLibraryRef[] = [];
        try {
            omnibusLibraries = await prisma.library.findMany({ select: { id: true, name: true, path: true } });
        } catch (e) {
            warnings.push('Could not read the Omnibus libraries, so mapping status is incomplete.');
            Logger.log(`[Komga] Connection test could not read Omnibus libraries: ${errText(e)}`, 'warn');
        }
        const resolved = resolveKomgaLibraries(dtos, mappings, omnibusLibraries);

        if (opts.persist) {
            try {
                await persistKomgaLibraries(resolved);
            } catch (e) {
                Logger.log(`[Komga] Could not update the Komga library cache: ${errText(e)}`, 'warn');
            }
        }

        // .cb7 only matters where Komga actually serves the Omnibus library.
        const servedPaths = omnibusLibraries.filter(l => komgaLibrariesForOmnibusLibrary(l, resolved).length > 0).map(l => l.path);
        let cb7Count = 0;
        if (servedPaths.length > 0) {
            try {
                cb7Count = await countCb7InLibraries(servedPaths);
            } catch (e) {
                Logger.log(`[Komga] Connection test could not count .cb7 files: ${errText(e)}`, 'debug');
            }
        }
        warnings.push(...computeGlobalWarnings(resolved, omnibusLibraries, cb7Count));

        const mappedOmnibusPaths = omnibusLibraries.map(l => l.path);
        const byId = new Map(omnibusLibraries.map(l => [l.id, l]));
        const includeLibraries = opts.includeLibraries !== false;
        const libraries: KomgaDetectedLibrary[] = resolved.map(lib => {
            const omnibus = lib.omnibusLibraryId ? byId.get(lib.omnibusLibraryId) : undefined;
            const libWarnings = computeLibraryWarnings(lib, { mappedOmnibusPaths, mappings }).map(scrub);
            if (!includeLibraries) warnings.push(...libWarnings.map(w => `Komga library "${lib.name}": ${w}`));
            return {
                id: lib.komgaLibraryId,
                name: lib.name,
                root: lib.root,
                translatedRoot: lib.translatedRoot,
                omnibusLibrary: omnibus ? { id: omnibus.id, name: omnibus.name, path: omnibus.path } : null,
                warnings: libWarnings,
            };
        });

        const mappedCount = resolved.filter(l => l.omnibusLibraryId).length;
        const message = `Connected to Komga${version ? ` ${version}` : ''} as ${user.email}: ${plural(resolved.length, 'library', 'libraries')}, ${mappedCount} mapped to Omnibus.`;
        return {
            success: true,
            message: scrub(message),
            version,
            warnings: warnings.map(scrub),
            user,
            ...(includeLibraries ? { libraries } : {}),
        };
    } catch (e) {
        Logger.log(`[Komga] Connection test failed unexpectedly: ${errText(e)}`, 'warn');
        return fail(`Komga connection test failed: ${errText(e)}`);
    }
}
