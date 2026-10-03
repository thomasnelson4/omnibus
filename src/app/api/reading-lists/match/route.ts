// src/app/api/reading-lists/match/route.ts
//
// Fix match preview: GET ?listId=&provider=COMICVINE|METRON&issueId=<raw id or URL>
// Resolves the provider issue and the local copy the save WOULD link — same owner-access rule and
// #194 identity guard as PATCH /api/reading-lists/items, so the preview and the save agree.
// Requires edit rights on the list (owner or ADMIN; system lists are ADMIN-only).
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { IssueMatchError, lookupProviderIssue } from '@/lib/metadata/issue-match';
import { canAccessLibraryId } from '@/lib/library-access';
import { findLocalIssueForMatch, linkAccessForList } from '@/lib/reading-list-links';
import {
    isMatchProvider, libraryCannotContradict, parseProviderIssueId, type MatchLookupResponse,
} from '@/lib/utils/reading-list-match';

export const dynamic = 'force-dynamic';

const bad = (error: string) => NextResponse.json({ error, code: 'INVALID_INPUT' }, { status: 400 });

export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;
        if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const role = (session?.user as any)?.role;

        const { searchParams } = new URL(request.url);
        const listId = searchParams.get('listId');
        const itemId = searchParams.get('itemId');
        const provider = searchParams.get('provider');
        if (!listId) return bad('listId is required.');
        if (!isMatchProvider(provider)) return bad('provider must be COMICVINE or METRON.');
        const parsed = parseProviderIssueId(provider, searchParams.get('issueId') ?? '');
        if (!parsed.ok) return bad(parsed.error);

        const list = await prisma.readingList.findUnique({ where: { id: listId } });
        if (!list || (list.userId !== userId && role !== 'ADMIN')) {
            return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 });
        }

        const match = await lookupProviderIssue(provider, parsed.id);
        const access = await linkAccessForList(list, { id: userId, role });
        const { local, mislabeled } = await findLocalIssueForMatch(provider, parsed.id, match, access);

        // The entry being edited (optional). Read scoped by listId, so a foreign itemId is a miss.
        let current = null;
        if (itemId) {
            current = await prisma.readingListItem.findFirst({
                where: { id: itemId, listId },
                select: { issueId: true, issue: { select: { metadataSource: true, metadataId: true, series: { select: { libraryId: true } } } } },
            });
        }
        // EXACTLY the keep predicate PATCH applies, so the preview can't promise a link the save
        // drops (an ADMIN editing a restricted owner's entry: the owner, not the admin, decides).
        const keepable = !!current && !!current.issueId && !!current.issue
            && libraryCannotContradict(current.issue, provider)
            && canAccessLibraryId(access, current.issue.series?.libraryId);

        const body: MatchLookupResponse = {
            match,
            local,
            mislabeled,
            accessScope: list.userId && list.userId !== userId ? 'owner' : 'self',
            keepable,
        };
        return NextResponse.json(body);
    } catch (error: unknown) {
        if (error instanceof IssueMatchError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
        }
        Logger.log(`[Reading List Match API] Lookup Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
