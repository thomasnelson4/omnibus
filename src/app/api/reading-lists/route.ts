// src/app/api/reading-lists/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getAccessibleLibraryIds, canAccessLibraryId, type AccessibleLibraries } from '@/lib/library-access';
import { linkAccessForList } from '@/lib/reading-list-links';
import { parseReadingListTitle } from '@/lib/utils/reading-list-match';
import { pickIssueForProviderId } from '@/lib/reading-list-links';
import { triggerReadListPushSoon, triggerReadListRemoteDelete } from '@/lib/komga/readlist-trigger';

export const dynamic = 'force-dynamic';

// `_request`: kept for the arity Next.js passes (and that the tests rely on), but the auto-link
// needs no request state. Named with the underscore so the unused-arg lint allows it.
export async function GET(_request: Request) {
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
            const linkedLists = new Set<string>();

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
                    const candidates = potentialIssues.filter(i => canAccessLibraryId(access, i.series?.libraryId));
                    // The shared rule (reading-list-links): metadata id + source, the #194 title
                    // veto, file-backed copies first. The Komga resolver uses the same helper, so a
                    // list cannot resolve to a different issue in Komga than it does on screen.
                    const validIssue = pickIssueForProviderId(candidates, Number(item.cvIssueId), source, expected);

                    if (validIssue) {
                        // Conditional write: a concurrent rematch/clear (or another GET) wins.
                        linkUpdates.push(
                            prisma.readingListItem.updateMany({
                                where: { id: item.id, issueId: null, cvIssueId: item.cvIssueId, metadataSource: item.metadataSource },
                                data: { issueId: validIssue.id }
                            })
                        );
                        linkedLists.add(list.id);
                    }
                }
            }

            if (linkUpdates.length > 0) {
                const results = await prisma.$transaction(linkUpdates);
                requiresRefresh = results.some((r: { count: number }) => r.count > 0);
                // Only a list that ACTUALLY changed is worth re-pushing, and only when it is synced.
                // Fire-and-forget: an auto-link must never slow the page load or fail on Redis.
                if (requiresRefresh) for (const listId of linkedLists) triggerReadListPushSoon(listId);
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
        // A brand new list never has komgaSync (admin opt-in), so this is normally a no-op — but it
        // costs one cached flag read and keeps every list-creation path honest if that ever changes.
        triggerReadListPushSoon(newList.id);
        return NextResponse.json({ success: true, id: newList.id, listId: newList.id, list: newList });
    } catch (error: unknown) {
        Logger.log(`[Reading Lists API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

// PATCH — the only post-creation list edit. Deliberately narrow (visibility only): every extra
// writable field is another field the ownership rule has to be re-argued for, and nothing else is
// missing. Lives here rather than in its own route so the ownership rule sits next to DELETE's copy.
export async function PATCH(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const userId = (session.user as any).id;
        const role = (session.user as any).role;
        const canMakeGlobal = role === 'ADMIN' || (session.user as any).canCreateGlobalLists === true;

        const bad = (error: string) => NextResponse.json({ error, code: 'INVALID_INPUT' }, { status: 400 });

        // Hand-validated (this repo has no zod). Strings only, because an object here would reach
        // Prisma as a filter operator ({ not: '' }) rather than as a value.
        let body: any;
        try {
            body = await request.json();
        } catch {
            return bad('Invalid JSON body.');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Invalid JSON body.');

        const { id, isGlobal } = body;
        if (typeof id !== 'string' || !id) return bad('id is required.');
        if (typeof isGlobal !== 'boolean') return bad('isGlobal must be a boolean.');

        const list = await prisma.readingList.findUnique({ where: { id } });
        if (!list) return NextResponse.json({ error: "Not found" }, { status: 404 });

        // Same edit rule as DELETE and items/route.ts: owner or ADMIN; system lists (userId null)
        // have no owner, so they are ADMIN-only.
        if (list.userId !== userId && role !== 'ADMIN') {
            return NextResponse.json({ error: "Forbidden", code: 'FORBIDDEN' }, { status: 403 });
        }

        // canCreateGlobalLists gates PUBLISHING, one way only. An ADMIN may have made this owner's
        // list global for them; gating the reverse direction too would leave a public list that its
        // owner cannot hide. So: promotion needs the permission, demotion only needs ownership.
        // Refused loudly (403) rather than coerced to false the way POST does — POST has no prior
        // state to contradict, here it would leave the caller believing it had changed something.
        if (isGlobal && !canMakeGlobal) {
            return NextResponse.json({
                error: "You do not have permission to publish a list to all users.",
                code: 'FORBIDDEN_GLOBAL'
            }, { status: 403 });
        }

        // A list with no owner is visible to every user REGARDLESS of this flag (the OR filter in
        // GET, and share/route.ts's isPublic, both test userId === null on their own). Flipping it
        // changes nothing, so the response says so instead of letting a caller read "private" off a
        // 200. The write itself is still allowed: the flag is still the list's honest metadata.
        const isSystemList = list.userId === null;

        // Demoting has to actually mean private. /reading-lists/shared/[shareId] is an
        // unauthenticated server component keyed only on shareId, so a link minted while the list
        // was public keeps reading it forever. Revoking it with the exposure is the honest reading
        // of "private" — and it is one click to re-mint. NOT done for a system list: that one never
        // becomes private, so clearing would be a pure, unrequested loss. Also only on a real
        // true -> false transition, so a redundant call cannot quietly destroy a link.
        const revokeShare = list.isGlobal === true && !isGlobal && !isSystemList;

        const updated = await prisma.readingList.update({
            where: { id },
            data: { isGlobal, ...(revokeShare ? { shareId: null } : {}) }
        });

        // Phase 4 naming rule is `{name}` for a global list and `{name} ({owner})` for a user-owned
        // one, so this flag change renames the remote read list — re-push so it can't silently drift.
        // The trigger no-ops for a list without komgaSync and never throws when Redis is down.
        if (updated.komgaSync && updated.isGlobal !== list.isGlobal) triggerReadListPushSoon(updated.id);

        return NextResponse.json({
            success: true,
            list: updated,
            shareRevoked: revokeShare,
            // What the list actually is now, independent of what the flag says.
            isPrivate: !isSystemList && updated.isGlobal === false,
            notice: isSystemList
                ? "This list has no owner, so it stays visible to every user."
                : undefined
        });
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

        // Komga BEFORE the delete: the link row cascades away with the list, so the Komga id has to
        // be read while it still exists. Awaited (not fire-and-forget) precisely because the read
        // races the delete below. The job itself re-checks the ownership marker before deleting.
        await triggerReadListRemoteDelete(id);

        // Clean up items before deleting the list
        await prisma.readingListItem.deleteMany({ where: { listId: id } });
        await prisma.readingList.delete({ where: { id } });
        
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        Logger.log(`[Reading Lists API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}