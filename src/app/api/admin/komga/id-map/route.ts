// src/app/api/admin/komga/id-map/route.ts
//
// The "ID map file" of PLAN §3: a downloadable snapshot of the identity map, so an operator can
// diff Omnibus ids against Komga ids without a database shell.
//
// The map itself is a pure DB read, so the export still works when Komga is down — which is exactly
// when an operator needs it. The only remote call is the best-effort version string, and a failure
// there degrades `komga.version` to null instead of failing the request.
//
// The API key is never read, never logged and never returned. `komga.url` identifies the instance,
// and it is the only server-side value safe to publish.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getKomgaSettings } from '@/lib/komga/settings';
import { getKomgaClient } from '@/lib/komga/factory';
import { komgaLibraryRowToResolved } from '@/lib/komga/libraries';
import { normalizeKomgaPath } from '@/lib/komga/path-map';

// One row per linked issue, so this is small in practice — but an unbounded read is still a lever
// against the server, so it is capped and the cap is reported in `truncated`.
const MAX_ROWS = 50_000;

export async function GET() {
    try {
        // --- SECURITY ENFORCEMENT ---
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const settings = await getKomgaSettings();
        const [bookLinks, seriesLinks, libraryRows, libraryNames] = await Promise.all([
            prisma.komgaBookLink.findMany({
                orderBy: { issueId: 'asc' },
                take: MAX_ROWS,
                select: {
                    issueId: true, komgaBookId: true, komgaLibraryId: true, omnibusPath: true,
                    komgaPath: true, matchedBy: true, verifiedAt: true,
                },
            }),
            prisma.komgaSeriesLink.findMany({
                orderBy: { seriesId: 'asc' },
                take: MAX_ROWS,
                select: { seriesId: true, komgaSeriesId: true },
            }),
            prisma.komgaLibrary.findMany({ orderBy: { name: 'asc' } }),
            prisma.library.findMany({ select: { id: true, name: true } }),
        ]);

        const nameById = new Map(libraryNames.map(l => [l.id, l.name]));
        const perLibrary = new Map<string, number>();
        for (const b of bookLinks) perLibrary.set(b.komgaLibraryId, (perLibrary.get(b.komgaLibraryId) ?? 0) + 1);

        const libraries = libraryRows.map(row => {
            const lib = komgaLibraryRowToResolved(row);
            return {
                komgaLibraryId: lib.komgaLibraryId,
                name: lib.name,
                root: lib.root,
                translatedRoot: lib.translatedRoot,
                omnibusLibraryId: lib.omnibusLibraryId,
                omnibusLibraryName: lib.omnibusLibraryId ? (nameById.get(lib.omnibusLibraryId) ?? null) : null,
                unavailable: lib.unavailable,
                linkedBooks: perLibrary.get(lib.komgaLibraryId) ?? 0,
            };
        });

        // Best effort only: an unreachable server must not cost the operator their export.
        let version: string | null = null;
        try {
            const client = await getKomgaClient(settings);
            version = client ? (await client.getInfo()).version : null;
        } catch (e) {
            Logger.log(`[Komga] ID map export: could not read the Komga version: ${getErrorMessage(e)}`, 'debug');
        }

        return NextResponse.json({
            generatedAt: new Date().toISOString(),
            komga: { url: settings.url ?? null, version },
            libraries,
            series: seriesLinks.map(s => ({ seriesId: s.seriesId, komgaSeriesId: s.komgaSeriesId })),
            books: bookLinks.map(b => ({
                issueId: b.issueId,
                komgaBookId: b.komgaBookId,
                komgaPath: normalizeKomgaPath(b.komgaPath) ?? b.komgaPath,
                omnibusPath: normalizeKomgaPath(b.omnibusPath) ?? b.omnibusPath,
                matchedBy: b.matchedBy,
                verifiedAt: b.verifiedAt,
            })),
            truncated: bookLinks.length >= MAX_ROWS || seriesLinks.length >= MAX_ROWS,
        });
    } catch (error: unknown) {
        const msg = getErrorMessage(error);
        Logger.log(`[Komga] ID map export failed: ${msg}`, 'error');
        return NextResponse.json({ error: `Failed to build the Komga ID map: ${msg}` }, { status: 500 });
    }
}