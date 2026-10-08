// src/app/api/opds/cover/issue/[id]/route.ts — an issue cover for OPDS clients, authenticated with
// the OPDS key. The issue's own cover (provider art or a cached local file), else its archive's
// first page rendered by the cover route — never the series folder art, so a freshly imported run
// doesn't show volume one's cover on every issue. See lib/opds-covers.ts.
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
        const issue = await prisma.issue.findUnique({
            where: { id },
            select: { id: true, coverUrl: true, series: { select: { libraryId: true } } },
        });
        if (!issue) return new Response('Not Found', { status: 404 });

        const accessibleLibs = await getAccessibleLibraryIds(auth.user.id, auth.user.role);
        if (!canAccessLibraryId(accessibleLibs, issue.series?.libraryId)) return new Response('Forbidden', { status: 403 });

        return delegateCover(req, coverQueryFor(issue.coverUrl) ?? { issueId: issue.id }, opdsCoverWidth(req));
    } catch (error: unknown) {
        Logger.log(`[OPDS Cover API] Issue cover error: ${getErrorMessage(error)}`, 'error');
        return new Response('Internal Server Error', { status: 500 });
    }
}
