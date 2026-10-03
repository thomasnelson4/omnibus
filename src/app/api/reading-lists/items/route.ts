// src/app/api/reading-lists/items/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getAccessibleLibraryIds, canAccessLibraryId, nestedSeriesAccessWhere } from '@/lib/library-access';
import { AuditLogger } from '@/lib/audit-logger';
import { IssueMatchError, lookupProviderIssue } from '@/lib/metadata/issue-match';
import { linkAccessForList, findLocalIssueForMatch } from '@/lib/reading-list-links';
import {
  isMatchProvider, parseProviderIssueId, buildReadingListItemTitle, libraryCannotContradict, type MatchProvider,
} from '@/lib/utils/reading-list-match';

export async function POST(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { listId, issueId, seriesId, seriesIds, itemId, action } = await request.json();

    if (!listId || (!issueId && !seriesId && !itemId && (!seriesIds || seriesIds.length === 0))) {
        return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
    }

    // Verify ownership of the list
    const list = await prisma.readingList.findUnique({ where: { id: listId } });
    if (!list || (list.userId !== userId && session?.user?.role !== 'ADMIN')) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Per-library access: a non-admin may only add content from libraries they've been granted.
    const accessibleLibs = await getAccessibleLibraryIds(userId, (session?.user as any)?.role);

    if (action === 'add') {
      const lastItem = await prisma.readingListItem.findFirst({
        where: { listId },
        orderBy: { order: 'desc' }
      });
      let nextOrder = lastItem ? lastItem.order + 1 : 0;

      if (issueId) {
          const target = await prisma.issue.findUnique({ where: { id: issueId }, include: { series: { select: { libraryId: true } } } });
          if (!canAccessLibraryId(accessibleLibs, target?.series?.libraryId)) {
              return NextResponse.json({ error: "You don't have access to this library." }, { status: 403 });
          }
          await prisma.readingListItem.create({
              data: { listId, issueId, order: nextOrder, title: "" }
          });
          return NextResponse.json({ success: true, message: `Added issue to reading list.` });
      } else {
          // Add all issues from one or more series (filtered to libraries the user can access)
          const idsToProcess = seriesIds || [seriesId];
          const issues = await prisma.issue.findMany({
              where: { seriesId: { in: idsToProcess }, ...nestedSeriesAccessWhere(accessibleLibs) },
              include: { series: true }
          });

          issues.sort((a, b) => {
              if (a.seriesId !== b.seriesId) return a.series.name.localeCompare(b.series.name);
              // Added '-' to regex to preserve negative values during sort
              return parseFloat(a.number.replace(/[^0-9.-]/g, '')) - parseFloat(b.number.replace(/[^0-9.-]/g, ''));
          });

          const itemsData = issues.map(issue => ({
              listId,
              issueId: issue.id,
              title: `${issue.series.name} #${issue.number}`,
              order: nextOrder++
          }));

          if (itemsData.length > 0) {
              await prisma.readingListItem.createMany({ data: itemsData });
          }

          return NextResponse.json({ success: true, message: `Added ${itemsData.length} issues to reading list.` });
      }

    } else if (action === 'remove') {
      if (itemId) {
          // Remove a single list entry by its own id — works for owned AND "missing" items (which
          // have no issueId), and removes exactly that entry even if the issue appears more than once.
          await prisma.readingListItem.deleteMany({
            where: { id: itemId, listId }
          });
      } else if (issueId) {
          await prisma.readingListItem.deleteMany({
            where: { listId, issueId }
          });
      } else {
          // Remove all issues that belong to one or more series
          const idsToProcess = seriesIds || [seriesId];
          const issues = await prisma.issue.findMany({ where: { seriesId: { in: idsToProcess } }, select: { id: true } });
          const issueIds = issues.map(i => i.id);
          await prisma.readingListItem.deleteMany({
            where: { listId, issueId: { in: issueIds } }
          });
      }
      return NextResponse.json({ success: true, message: 'Removed from reading list' });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

  } catch (error: unknown) {
    Logger.log(`[List Items API] Add/Remove Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;
  
        if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  
        const { listId, items } = await request.json(); // Expects array of { id, order }
  
        // Verify ownership
        const list = await prisma.readingList.findUnique({ where: { id: listId } });
        if (!list || (list.userId !== userId && session?.user?.role !== 'ADMIN')) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
  
        // Update all orders in one transaction, scoping each update to the verified listId so a caller can't
        // reorder items in another user's list by submitting foreign item ids (the id is a global cuid).
        await prisma.$transaction(
            items.map((item: any) =>
                prisma.readingListItem.updateMany({
                    where: { id: item.id, listId },
                    data: { order: item.order }
                })
            )
        );
  
        return NextResponse.json({ success: true, message: 'List reordered successfully' });
  
    } catch (error: unknown) {
        Logger.log(`[List Items API] Update Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

const itemGone =() => NextResponse.json({ error: 'This entry is no longer in the list.', code: 'ITEM_NOT_FOUND' }, { status: 404 });

// Fix match: re-point ONE entry at a provider issue (action "rematch") or drop its identity
// ("clear"). The server is authoritative — the provider issue is re-fetched here and the client
// never sends a title or series data (titles are shown to every viewer of the list and feed the
// downloader's search name). A local copy is linked only inside the list OWNER's libraries and
// only past the #194 identity guard; otherwise a stale link is cleared, because the page renders
// the linked Issue instead of the title and would keep showing (and reading) the old comic.
export async function PATCH(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;
        if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const role = (session?.user as any)?.role;

        const bad = (error: string) => NextResponse.json({ error, code: 'INVALID_INPUT' }, { status: 400 });
        let body: any;
        try {
            body = await request.json();
        } catch {
            return bad('Invalid JSON body.');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Invalid JSON body.');

        // Strings only: an object here would reach Prisma as a filter operator ({ not: '' }).
        const { listId, itemId, action } = body;
        if (typeof listId !== 'string' || !listId || typeof itemId !== 'string' || !itemId) {
            return bad('listId and itemId are required.');
        }
        if (action !== 'rematch' && action !== 'clear') return bad('action must be "rematch" or "clear".');

        let provider: MatchProvider = 'COMICVINE';
        let providerIssueId = 0;
        if (action === 'rematch') {
            if (!isMatchProvider(body.provider)) return bad('provider must be COMICVINE or METRON.');
            const parsed = parseProviderIssueId(body.provider, body.providerIssueId);
            if (!parsed.ok) return bad(parsed.error);
            provider = body.provider;
            providerIssueId = parsed.id;
        }

        // Same edit rule as POST/PUT: owner or ADMIN; system lists (userId null) are ADMIN-only.
        const list = await prisma.readingList.findUnique({ where: { id: listId } });
        if (!list || (list.userId !== userId && session?.user?.role !== 'ADMIN')) {
            return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 });
        }

        // Never address an item by its id alone — ids are global cuids.
        const itemQuery = { where: { id: itemId, listId }, include: { issue: { include: { series: true } } } };
        const item = await prisma.readingListItem.findFirst(itemQuery);
        if (!item) return itemGone();
        const previous = { cvIssueId: item.cvIssueId, metadataSource: item.metadataSource, issueId: item.issueId, title: item.title };

        if (action === 'rematch') {
            // Provider errors (typed IssueMatchError) exit here, before any further DB work.
            const match = await lookupProviderIssue(provider, providerIssueId);
            const linkAccess = await linkAccessForList(list, { id: userId, role });
            const { local } = await findLocalIssueForMatch(provider, providerIssueId, match, linkAccess);

            let issueId: string | null = local?.issueId ?? null;
            let link: 'matched' | 'kept' | 'none' = local ? 'matched' : 'none';
            // Opt-in keep: only for a current link the library can't contradict (other provider, or
            // no provider id at all — LOCAL / unmatched_*), and still only inside the owner's access.
            if (!local && body.keepLocalLink === true && item.issueId && item.issue
                && libraryCannotContradict(item.issue, provider)
                && canAccessLibraryId(linkAccess, item.issue.series?.libraryId)) {
                issueId = item.issueId;
                link = 'kept';
            }

            const data = { cvIssueId: providerIssueId, metadataSource: provider, title: match.displayTitle, issueId };
            const { count } = await prisma.readingListItem.updateMany({ where: { id: itemId, listId }, data });
            if (count === 0) return itemGone();
            const updated = await prisma.readingListItem.findFirst(itemQuery);

            await AuditLogger.log('REMATCH_READING_LIST_ITEM', {
                listId, itemId, provider, providerIssueId, link, linkedIssueId: issueId, previous,
            }, userId);
            return NextResponse.json({
                success: true, item: updated, link, linked: !!updated?.issueId, hasFile: !!updated?.issue?.filePath?.trim(), match,
            });
        }

        // Clear: keep a meaningful title — a single-issue manual add stores "" and leans on the link.
        const title = item.title?.trim()
            ? item.title
            : (item.issue ? buildReadingListItemTitle(item.issue.series?.name ?? null, item.issue.number) : item.title);
        const data = { cvIssueId: null, metadataSource: 'COMICVINE' /* column default */, issueId: null, title };
        const { count } = await prisma.readingListItem.updateMany({ where: { id: itemId, listId }, data });
        if (count === 0) return itemGone();
        const updated = await prisma.readingListItem.findFirst(itemQuery);

        await AuditLogger.log('CLEAR_READING_LIST_ITEM_MATCH', { listId, itemId, previous }, userId);
        return NextResponse.json({ success: true, item: updated });

    } catch (error: unknown) {
        if (error instanceof IssueMatchError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
        }
        Logger.log(`[List Items API] Rematch Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
