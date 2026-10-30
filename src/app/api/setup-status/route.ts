// src/app/api/setup-status/route.ts
//
// The first-run checklist's facts (components/setup-checklist.tsx), computed live: System Health's
// cache can be a quarter of an hour old, and a checklist still saying "No library folder" right after
// one was added is worse than none. Admins get the steps; anyone else only learns whether their
// library is empty and whether they may request, so the page can say what to do next.
import fs from 'fs';
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { prisma } from '@/lib/db';
import { getAccessibleLibraryIds, seriesAccessWhere } from '@/lib/library-access';
import { serverPathProblem } from '@/lib/utils/paths';
import { hasMetronCredentials } from '@/lib/metron/credentials';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export type SetupStepId = 'library' | 'metadata' | 'comics' | 'match' | 'discover' | 'sources';
export interface SetupStep { id: SetupStepId; required: boolean; done: boolean; detail?: string; count?: number }

const SETTING_KEYS = ['cv_api_key', 'metron_api_token', 'metron_user', 'metron_pass', 'last_popular_sync', 'hide_first_steps_banner', 'first_run_completed'];
const filled = (v: string | undefined) => typeof v === 'string' && v.trim() !== '';

/** Why the libraries can't be used yet, or null when every one is a folder Omnibus can write to. */
async function libraryProblem(libraries: { name: string; path: string }[]): Promise<string | null> {
    if (libraries.length === 0) return 'No library folder is set up yet.';
    for (const lib of libraries) {
        const pathProblem = serverPathProblem(lib.path);
        if (pathProblem) return `Library "${lib.name}": ${pathProblem}`;
        try {
            await fs.promises.access(lib.path, fs.constants.F_OK);
        } catch {
            return `Library "${lib.name}": ${lib.path} doesn't exist on the server.`;
        }
        try {
            await fs.promises.access(lib.path, fs.constants.W_OK);
        } catch {
            return `Library "${lib.name}": Omnibus can't write to ${lib.path}.`;
        }
    }
    return null;
}

export async function GET() {
    try {
        const session = await getServerSession(await getAuthOptions());
        const user = session?.user as { id?: string; role?: string } | undefined;
        if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const libs = await getAccessibleLibraryIds(user.id, user.role);
        const seriesCount = await prisma.series.count({ where: seriesAccessWhere(libs) });

        if (user.role !== 'ADMIN') {
            const row = await prisma.user.findUnique({ where: { id: user.id }, select: { canRequest: true } });
            return NextResponse.json({ role: 'USER', libraryEmpty: seriesCount === 0, canRequest: !!row?.canRequest });
        }

        const [rows, libraries, unmatched, indexers, clients] = await Promise.all([
            prisma.systemSetting.findMany({ where: { key: { in: SETTING_KEYS } } }),
            prisma.library.findMany({ select: { name: true, path: true } }),
            prisma.series.count({ where: { matchState: 'UNMATCHED' } }),
            prisma.indexer.count(),
            prisma.downloadClient.count(),
        ]);
        const settings: Record<string, string> = Object.fromEntries(rows.map(r => [r.key, r.value]));
        const libProblem = await libraryProblem(libraries);

        const steps: SetupStep[] = [
            { id: 'library', required: true, done: !libProblem, ...(libProblem ? { detail: libProblem } : {}) },
            { id: 'metadata', required: true, done: filled(settings.cv_api_key) || hasMetronCredentials(settings) },
            { id: 'comics', required: true, done: seriesCount > 0, count: seriesCount },
            { id: 'match', required: false, done: unmatched === 0, count: unmatched },
            { id: 'discover', required: true, done: filled(settings.last_popular_sync) },
            { id: 'sources', required: false, done: indexers + clients > 0 },
        ];

        // Once every required step has been done, the checklist is finished for good: something that
        // breaks later is System Health's to report, not a first-run banner's.
        const remembered = settings.first_run_completed === 'true';
        const complete = steps.every(s => !s.required || s.done);
        if (complete && !remembered) {
            await prisma.systemSetting.upsert({
                where: { key: 'first_run_completed' },
                update: { value: 'true' },
                create: { key: 'first_run_completed', value: 'true' },
            });
        }

        return NextResponse.json({
            role: 'ADMIN',
            dismissed: settings.hide_first_steps_banner === 'true',
            completed: remembered || complete,
            libraryEmpty: seriesCount === 0,
            steps,
        });
    } catch (error) {
        Logger.log(`[Setup Status] ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
