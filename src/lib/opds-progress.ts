// src/lib/opds-progress.ts
//
// The caller's own reading progress for a set of issues, keyed by issue id — what `pse:lastRead` is
// built from. Shared by the series feed, the root sections and the search feed, which all render
// issue entries; one query per feed (a section is 20 entries, a search page 50).
import { prisma } from '@/lib/db';
import type { IssueProgress } from '@/lib/opds-feed';

export async function progressByIssueId(
    userId: string,
    issueIds: readonly string[],
): Promise<Map<string, IssueProgress>> {
    if (issueIds.length === 0) return new Map();
    const rows = await prisma.readProgress.findMany({
        where: { userId, issueId: { in: [...issueIds] } },
        select: { issueId: true, currentPage: true, isCompleted: true, updatedAt: true },
    });
    return new Map(rows.map((p) => [p.issueId, p]));
}
