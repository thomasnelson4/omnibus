// src/app/api/admin/komga/libraries/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { testKomgaConnection } from '@/lib/komga/connection-test';
import { getKomgaSettings } from '@/lib/komga/settings';
import { parsePathMappings, serializePathMappings } from '@/lib/komga/path-map';

const MASKED = '********';

// Never let a Komga API key reach the browser or the log, even if an upstream message echoed it.
const redactSecret = (text: string, secret: string): string =>
    secret.length >= 6 ? text.split(secret).join(MASKED) : text;

const trimTrailingSlashes = (url: string): string => url.replace(/\/+$/, '');

// Detected-libraries table for Settings → Media Servers. Takes the UNSAVED url/key/mappings so the
// admin can preview before saving; '********' means "the stored key". Unlike the Prowlarr indexers
// route there is no setup-time exemption: the setup wizard never configures Komga, and the stored
// key is a full Komga ADMIN credential that must not be aimed at an arbitrary URL anonymously.
export async function POST(request: Request) {
    let secret = '';
    try {
        // --- SECURITY ENFORCEMENT ---
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        let body: { url?: unknown; apiKey?: unknown; pathMappings?: unknown } | null;
        try {
            body = await request.json();
        } catch {
            return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
        }

        const url = typeof body?.url === 'string' ? body.url.trim() : '';
        if (!url) {
            return NextResponse.json({ error: "Komga URL is required." }, { status: 400 });
        }
        if (!/^https?:\/\/[^/\s]+/i.test(url)) {
            return NextResponse.json({ error: "The Komga URL must start with http:// or https://." }, { status: 400 });
        }

        // pathMappings arrives as the stored JSON string (config.komga_path_mappings) or an array.
        // Absent/blank means identity; anything that is not a list is a 400, not a silent identity.
        const rawInput = body?.pathMappings;
        let mappingRows: unknown = rawInput ?? [];
        if (typeof rawInput === 'string') {
            try { mappingRows = rawInput.trim() === '' ? [] : JSON.parse(rawInput); } catch { mappingRows = undefined; }
        }
        if (!Array.isArray(mappingRows)) {
            return NextResponse.json({ error: 'Path mappings must be a JSON list of {"omnibus", "komga"} rows.' }, { status: 400 });
        }
        const pathMappings = parsePathMappings(mappingRows);

        const saved = await getKomgaSettings();
        const providedKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
        const apiKey = providedKey === MASKED ? (saved.apiKey ?? '').trim() : providedKey;
        if (!apiKey) {
            return NextResponse.json({ error: "Komga API key is required." }, { status: 400 });
        }
        secret = apiKey;

        // Only a preview of the SAVED server + mappings may refresh the KomgaLibrary cache that sync
        // and reconcile read; a preview with unsaved values must not overwrite it.
        const persist = !!saved.url
            && trimTrailingSlashes(saved.url) === trimTrailingSlashes(url)
            && serializePathMappings(saved.pathMappings) === serializePathMappings(pathMappings);

        const result = await testKomgaConnection(url, apiKey, { pathMappings, includeLibraries: true, persist });
        if (!result.success) {
            // Komga (or the network to it) refused: an upstream failure, not a bad request to us —
            // and never 401, which the page would read as its own session expiring.
            return NextResponse.json({ error: redactSecret(result.message, apiKey) }, { status: 502 });
        }

        // Explicit field picks: the response carries exactly the documented shape and nothing else.
        const libraries = (result.libraries ?? []).map(lib => ({
            id: lib.id,
            name: lib.name,
            root: lib.root,
            translatedRoot: lib.translatedRoot,
            omnibusLibrary: lib.omnibusLibrary
                ? { id: lib.omnibusLibrary.id, name: lib.omnibusLibrary.name, path: lib.omnibusLibrary.path }
                : null,
            warnings: (lib.warnings ?? []).map(w => redactSecret(w, apiKey)),
        }));

        return NextResponse.json({
            libraries,
            warnings: (result.warnings ?? []).map(w => redactSecret(w, apiKey)),
            version: result.version,
        });
    } catch (error: unknown) {
        const msg = redactSecret(getErrorMessage(error), secret);
        Logger.log(`[Komga] Library discovery failed: ${msg}`, 'error');
        return NextResponse.json({ error: `Failed to load Komga libraries: ${msg}` }, { status: 500 });
    }
}
