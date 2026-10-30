// src/app/komga/api/v1/books/[id]/pages/[n]/route.ts — #206 Komga facade: one page image.
// Komga numbers pages from 1; the OPDS-PSE streamer indexes from 0 and already does everything
// else (key validation, library grants, engine offload with local fallback, RAR/7z via the engine,
// immutable caching) — so page n is handed to it in-process as index n-1, headers and all.
// `?convert=png` (sent for non-image page types) is accepted and ignored: pages come back as WebP.
import { GET as streamOpdsPage } from '@/app/api/opds/page/[issueId]/[pageIndex]/route';
import { Logger } from '@/lib/logger';
import { authenticateKomga, komgaGuard, komgaError } from '@/lib/komga/auth';
import { bookLabel, findAccessibleIssue } from '@/lib/komga/data';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
    return komgaGuard('books/{id}/pages/{n}', async () => {
        const { id, n } = await params;
        const page = /^\d+$/.test(n) ? parseInt(n, 10) : NaN;
        if (!Number.isInteger(page) || page < 1) return komgaError(404);
        const res = await streamOpdsPage(
            new Request(req.url, { headers: req.headers }),
            { params: Promise.resolve({ issueId: id, pageIndex: String(page - 1) }) },
        );
        // The streamer's own refusals are plain text (it serves OPDS readers); the facade answers
        // every error the Komga way (#206 round 4).
        if (!res.ok) return komgaError(res.status);
        // Paperback reports only finished chapters, so whether the pages it loads could stand in
        // for reading progress depends on how it loads them (ahead of the reader? all at once for an
        // offline download?). At debug level every page served is logged to measure that; at the
        // default info level this costs nothing.
        if (Logger.getLevel() === 'debug') await logPageServed(req, id, page);
        return res;
    });
}

async function logPageServed(req: Request, id: string, page: number): Promise<void> {
    try {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return;
        const found = await findAccessibleIssue(id, auth.libs);
        if (!found.ok) return;
        const app = req.headers.get('user-agent') || 'no user agent';
        Logger.log(
            `[Komga] Page ${page}/${found.issue.pageCount || '?'} of "${bookLabel(found.issue)}" (book ${id}) served to ${auth.user.username} · ${app}`,
            'debug',
        );
    } catch { /* a debug log never fails a page */ }
}
