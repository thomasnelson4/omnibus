// src/app/api/reading-lists/match/providers/route.ts
//
// Which metadata providers can serve a Fix match lookup: { providers: { COMICVINE, METRON }, primary }.
// Non-admin list owners can't read /api/admin/*, and an unconfigured Metron search silently returns
// [] (which /api/search then caches for 12 h), so the dialog disables what can't work. Booleans
// only — never a setting value.
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getConfiguredProviders } from '@/lib/metadata/issue-match';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;
        if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const { providers, primary } = await getConfiguredProviders();
        return NextResponse.json({
            providers: { COMICVINE: providers.COMICVINE === true, METRON: providers.METRON === true },
            primary,
        });
    } catch (error: unknown) {
        Logger.log(`[Reading List Match API] Providers Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
