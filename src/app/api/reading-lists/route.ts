// src/app/api/reading-lists/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getAccessibleLibraryIds, canAccessLibraryId, type AccessibleLibraries } from '@/lib/library-access';
import { linkAccessForList } from '@/lib/reading-list-links';
import { parseReadingListTitle, pickPreferredIssue } from '@/lib/utils/reading-list-match';
import { isSameIssue } from '@/lib/utils/issue-parser';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;

        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Per-library access: hide list items whose linked issue is in a library the user can't access.
        // Metadata-only items (no linked issue yet) are kept — they're reading-order placeholders, not content.
        const accessibleLibs = await getAccessibleLibraryIds(userId, (session?.user as any)?.role);
        const itemAccessWhere = accessibleLibs === 'ALL'
            ? {}
            : { OR: [{ issueId: null }, { issue: { series: { libraryId: { in: accessibleLibs } } } }] };

        let lists = await prisma.readingList.findMany({
            where: { OR: [ { userId: userId }, { isGlobal: true }, { userId: null } ] },
            include: {
                user: { select: { username: true } }, // Important for the UI to display the creator of Global lists
                items: {
                    where: itemAccessWhere,
                    orderBy: { order: 'asc' },
                    include: { issue: { include: { series: true } } }
                }
            },
            orderBy: { updatedAt: 'desc' }
        });

        let requiresRefresh = false;
        const missingItemsMeta: { id: string, source: string }[] = [];

        // Auto-link logic: Find items that were imported from a CSV or Auto-builder that have a Metadata ID but no local database linkage yet
        for (const list of lists) {
            for (const item of list.items) {
                if (!item.issueId && item.cvIssueId) {
                    missingItemsMeta.push({ id: item.cvIssueId.toString(), source: item.metadataSource || 'COMICVINE' });
                }
            }
        }

        if (missingItemsMeta.length > 0) {
            // Links follow the list OWNER's library access (system lists: any library), whoever's
            // GET triggers them — otherwise an admin's or another viewer's page load could link a
            // restricted owner's entry into a library the owner can't see, hiding it from them.
            const viewer = { id: userId, role: (session?.user as any)?.role };
            const accessCache = new Map<string, Promise<AccessibleLibraries>>();
            const potentialIssues = await prisma.issue.findMany({
                where: {
                    OR: missingItemsMeta.map(m => ({ metadataId: m.id, metadataSource: m.source }))
                },
                select: {
                    id: true, metadataId: true, metadataSource: true, number: true, filePath: true, attachedVolumeId: true,
                    series: { select: { libraryId: true } }
                },
                orderBy: { createdAt: 'asc' }
            });

            const linkUpdates = [];

            for (const list of lists) {
                const unlinked = list.items.filter(i => !i.issueId && i.cvIssueId);
                if (unlinked.length === 0) continue;
                const access = await linkAccessForList(list, viewer, accessCache);
                for (const item of unlinked) {
                    const source = item.metadataSource || 'COMICVINE';
                    // #194: a row holding the id but a different number than the title's "#N" is a
                    // mislabeled copy (sync race) — linking it would undo a Fix match on reload.
                    // Attached-lane numbers are user curation, so those rows are id-anchored only.
                    const expected = parseReadingListTitle(item.title).number;
                    const candidates = potentialIssues.filter(i =>
                        i.metadataId === String(item.cvIssueId) && i.metadataSource === source
                        && canAccessLibraryId(access, i.series?.libraryId)
                        && (!expected || !!i.attachedVolumeId || isSameIssue(i.number, expected)));
                    const validIssue = pickPreferredIssue(candidates);

                    if (validIssue) {
                        // Conditional write: a concurrent rematch/clear (or another GET) wins.
                        linkUpdates.push(
                            prisma.readingListItem.updateMany({
                                where: { id: item.id, issueId: null, cvIssueId: item.cvIssueId, metadataSource: item.metadataSource },
                                data: { issueId: validIssue.id }
                            })
                        );
                    }
                }
            }

            if (linkUpdates.length > 0) {
                const results = await prisma.$transaction(linkUpdates);
                requiresRefresh = results.some((r: { count: number }) => r.count > 0);
            }
        }

        if (requiresRefresh) {
            lists = await prisma.readingList.findMany({
                where: { OR: [{ userId: userId }, { isGlobal: true }, { userId: null }] },
                include: {
                    user: { select: { username: true } },
                    items: {
                        where: itemAccessWhere,
                        orderBy: { order: 'asc' },
                        include: { issue: { include: { series: true } } }
                    }
                },
                orderBy: { updatedAt: 'desc' }
            });
        }

        return NextResponse.json(lists);
    } catch (error: unknown) {
        Logger.log(`[Reading Lists API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        
        const userId = (session.user as any).id;
        const { name, description, isGlobal, coverUrl } = await request.json();

        if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

        // Ensure only admins can set the global flag
        const isAdmin = (session.user as any).role === 'ADMIN';

        const canMakeGlobal = (session.user as any).role === 'ADMIN' || (session.user as any).canCreateGlobalLists === true;

        const newList = await prisma.readingList.create({
            data: {
                name,
                description,
                coverUrl,
                isGlobal: isGlobal === true && canMakeGlobal,
                userId: userId // Always preserve the creator's ID
            }
        });

        // Provide both id and listId for unified compatibility with the Library page creation flow
        return NextResponse.json({ success: true, id: newList.id, listId: newList.id, list: newList });
    } catch (error: unknown) {
        Logger.log(`[Reading Lists API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');

        if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

        const list = await prisma.readingList.findUnique({ where: { id } });
        if (!list) return NextResponse.json({ error: "Not found" }, { status: 404 });

        if (list.userId !== (session.user as any).id && (session.user as any).role !== 'ADMIN') {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        // Clean up items before deleting the list
        await prisma.readingListItem.deleteMany({ where: { listId: id } });
        await prisma.readingList.delete({ where: { id } });
        
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        Logger.log(`[Reading Lists API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}