// src/app/api/opds/cover/series/[id]/route.ts — a series cover for OPDS clients, authenticated with
// the OPDS key. The series' stored cover (a local file or provider art), else its folder (the cover
// route picks cover.jpg & friends there). See lib/opds-covers.ts.
import { prisma } from '@/lib/db';
import { validateApiKey } from '@/lib/api-auth';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getAccessibleLibraryIds, canAccessLibraryId } from '@/lib/library-access';
import { coverQueryFor, delegateCover } from '@/lib/komga/cover';
import { opdsCoverWidth } from '@/lib/opds-covers';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const auth = await validateApiKey(req);
        if (!auth.valid || !auth.user) {
            return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Omnibus OPDS"' } });
        }

        const { id } = await params;
        const series = await prisma.series.findUnique({
            where: { id },
            select: { id: true, libraryId: true, folderPath: true, coverUrl: true },
        });
        if (!series) return new Response('Not Found', { status: 404 });

        const accessibleLibs = await getAccessibleLibraryIds(auth.user.id, auth.user.role);
        if (!canAccessLibraryId(accessibleLibs, series.libraryId)) return new Response('Forbidden', { status: 403 });

        const query = coverQueryFor(series.coverUrl) ?? (series.folderPath ? { path: series.folderPath } : null);
        if (!query) return new Response('Not Found', { status: 404 });

        return delegateCover(req, query, opdsCoverWidth(req));
    } catch (error: unknown) {
        Logger.log(`[OPDS Cover API] Series cover error: ${getErrorMessage(error)}`, 'error');
        return new Response('Internal Server Error', { status: 500 });
    }
}
