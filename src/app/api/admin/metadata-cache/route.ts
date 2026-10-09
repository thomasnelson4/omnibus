// src/app/api/admin/metadata-cache/route.ts
//
// Stats + manual clear for the shared CV/Metron response cache (Settings → Metadata). GET returns
// entry count / total bytes / oldest entry; DELETE truncates the table for a guaranteed-fresh next
// sync (turning the toggle off does NOT delete rows — they age out via CACHE_CLEANUP instead, so a
// quick off-and-on doesn't cost the warm cache).
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { prisma } from '@/lib/db';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { Logger } from '@/lib/logger';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Defense-in-depth behind the middleware /api/admin/* gate.
    const session = await getServerSession(await getAuthOptions());
    if ((session?.user as any)?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

    const [entries, sized, oldest] = await Promise.all([
      prisma.metadataCache.count(),
      prisma.$queryRawUnsafe(`SELECT COALESCE(SUM(LENGTH(value)), 0) AS total FROM "MetadataCache"`) as Promise<any[]>,
      prisma.metadataCache.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
    ]);

    return NextResponse.json({
      entries,
      bytes: Number(sized?.[0]?.total || 0),
      oldest: oldest?.createdAt || null
    });
  } catch (error: unknown) {
    Logger.log(`[Metadata Cache API] Stats Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = await getServerSession(await getAuthOptions());
    if ((session?.user as any)?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    const userId = (session?.user as any)?.id;

    const deleted = await prisma.metadataCache.deleteMany({});
    // Matching decisions and formatted provider responses are derived from these same bodies.
    // A generation fences already-open pages; their server-owned decision tokens become stale.
    await prisma.systemSetting.upsert({ where: { key: 'smart_match_cache_epoch' },
      update: { value: crypto.randomUUID() }, create: { key: 'smart_match_cache_epoch', value: crypto.randomUUID() } });
    await prisma.systemSetting.deleteMany({ where: { OR: [
      { key: { startsWith: 'search_v3_' } }, { key: { startsWith: 'meta_details_' } },
      { key: { startsWith: 'cv_details_cache_' } }, { key: { startsWith: 'smart_match_v1_' } },
    ] } });
    if (userId) await AuditLogger.log('CLEARED_METADATA_CACHE', { count: deleted.count }, userId);
    Logger.log(`[Metadata Cache API] Admin cleared ${deleted.count} cached provider responses.`, 'info');

    return NextResponse.json({ success: true, count: deleted.count });
  } catch (error: unknown) {
    Logger.log(`[Metadata Cache API] Clear Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
