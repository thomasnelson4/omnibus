import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getMatchDecision } from '@/lib/smart-match/service';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    const session = await getServerSession(await getAuthOptions());
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    const body = await request.json().catch(() => null);
    if (typeof body?.itemId !== 'string' || !body.itemId) return NextResponse.json({ error: 'Missing itemId' }, { status: 400 });
    try {
        return NextResponse.json(await getMatchDecision(body.itemId, { provider: body.provider === 'METRON' ? 'METRON' : 'COMICVINE', refresh: body.refresh === true }));
    } catch { return NextResponse.json({ error: 'Could not read matching evidence for this item' }, { status: 422 }); }
}
