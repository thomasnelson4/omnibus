import { NextResponse } from 'next/server';
import { secretsMatch } from '@/lib/api-auth';
import { getMatchDecision } from '@/lib/smart-match/service';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    if (!secretsMatch(request.headers.get('x-internal-secret'), process.env.NEXTAUTH_SECRET)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json().catch(() => null);
    if (typeof body?.itemId !== 'string' || !body.itemId) return NextResponse.json({ error: 'Missing itemId' }, { status: 400 });
    try {
        const decision = await getMatchDecision(body.itemId, { purpose: 'sweep', maxRequests: typeof body.maxRequests === 'number' ? Math.max(0, Math.min(16, Math.floor(body.maxRequests))) : 16 });
        if (body.expectedFingerprint && body.expectedFingerprint !== decision.fingerprint) return NextResponse.json({ ...decision, autoAccept: false, safeToAccept: false, status: 'conflict', reasons: ['Source or matching policy changed during the sweep'] });
        return NextResponse.json(decision);
    }
    catch { return NextResponse.json({ error: 'Could not read matching evidence' }, { status: 422 }); }
}
