import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { deleteUsenetSource } from '@/lib/utils/usenet-cleanup';

const mocks = vi.hoisted(() => ({ libraries: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { library: { findMany: mocks.libraries } } }));
vi.mock('@/lib/utils/path-resolver', () => ({ resolveRemotePath: vi.fn(async (p: string) => p) }));

describe('Usenet cleanup on disk', () => {
    let fixtureRoot: string;
    beforeEach(async () => {
        fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'omnibus-usenet-cleanup-'));
        mocks.libraries.mockResolvedValue([{ path: path.join(fixtureRoot, 'library') }]);
    });
    afterEach(async () => { await fs.remove(fixtureRoot); });

    it('removes the entire reported job directory including extraction subfolders and sidecars, preserving its category and other jobs', async () => {
        const category = path.join(fixtureRoot, 'downloads', 'comics');
        const job = path.join(category, 'SAB renamed this folder');
        const sibling = path.join(category, 'Another job', 'other.cbz');
        await fs.outputFile(path.join(job, 'extracted', 'Batman.cbz'), 'imported archive');
        await fs.outputFile(path.join(job, 'release.nfo'), 'sidecar');
        await fs.outputFile(sibling, 'keep');

        expect(await deleteUsenetSource({ clientType: 'sab', clientRoot: category, sourcePath: job, reason: 'imported' })).toBe(true);
        expect(await fs.pathExists(job)).toBe(false);
        expect(await fs.pathExists(category)).toBe(true);
        expect(await fs.readFile(sibling, 'utf8')).toBe('keep');
    });

    it('removes only the archive in a flat layout without treating the shared parent as a job', async () => {
        const category = path.join(fixtureRoot, 'downloads', 'comics');
        const source = path.join(category, 'Batman.cbz');
        await fs.outputFile(source, 'imported archive');
        expect(await deleteUsenetSource({ clientType: 'sab', clientRoot: category, sourcePath: source, reason: 'imported' })).toBe(true);
        expect(await fs.pathExists(source)).toBe(false);
        expect(await fs.pathExists(category)).toBe(true);
    });
});
