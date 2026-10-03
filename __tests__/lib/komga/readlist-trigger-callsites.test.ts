// __tests__/lib/komga/readlist-trigger-callsites.test.ts
//
// The push/delete triggers are spread over a dozen route files, and a missed one is silent: the
// list simply stops updating in Komga. This test derives the inventory from the CODE (every module
// that writes a ReadingList or ReadingListItem) instead of trusting a hand-written list, so a new
// mutation route that forgets the trigger fails here rather than in production.
//
// The expected exemptions are deliberate and each is commented with why.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');
const ROUTES = path.join(SRC, 'app', 'api');

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
}

const all = walk(ROUTES);
const reads = (file: string) => fs.readFileSync(file, 'utf8');

/** A route that MUTATES reading lists or their items. */
const isMutator = (file: string) => /prisma\.readingList(Item)?\.(create|createMany|update|updateMany|delete|deleteMany|upsert)/.test(reads(file));

/**
 * A route that mutates them by CASCADE rather than directly. prisma.user.delete takes the user's
 * ReadingLists (and, through them, KomgaReadListLink) with it, so it is a delete path too.
 */
const isCascadeMutator = (file: string) => /prisma\.user\.delete\(/.test(reads(file));

const mutators = all.filter(f => isMutator(f) || isCascadeMutator(f));

/**
 * Routes that write reading lists but must NOT push. Each is a real case, not a shrug:
 *  - share: updates only shareId; the book's membership is untouched.
 *  - lookup-volume / manual-fallback / match: read-only previews and provider requests.
 *  - match/providers: reads only.
 */
const NO_PUSH_NEEDED = new Set([
    'src/app/api/reading-lists/share/route.ts',
]);

describe('the Komga read-list trigger call sites', () => {
    it('finds the mutating routes at all (a broken glob would silently pass everything)', () => {
        expect(mutators.length).toBeGreaterThanOrEqual(10);
        const names = mutators.map(f => path.relative(process.cwd(), f));
        // The ones PLAN names explicitly must all be present.
        for (const expected of [
            'src/app/api/reading-lists/route.ts',
            'src/app/api/reading-lists/items/route.ts',
            'src/app/api/reading-lists/import-cbl/route.ts',
            'src/app/api/reading-lists/import-csv/route.ts',
            'src/app/api/reading-lists/import-mal/route.ts',
            'src/app/api/reading-lists/import-anilist/route.ts',
            'src/app/api/reading-lists/auto-build/route.ts',
            'src/app/api/library/route.ts',
            'src/app/api/admin/users/route.ts',
        ]) {
            expect(names).toContain(expected);
        }
    });

    it('every mutating route reaches the trigger, directly or through a lazy import', () => {
        const missing = mutators
            .map(f => path.relative(process.cwd(), f))
            .filter(f => !NO_PUSH_NEEDED.has(f))
            .filter(f => !/readlist-trigger/.test(reads(path.join(process.cwd(), f))));
        expect(missing).toEqual([]);
    });

    it('the trigger is imported STATICALLY by the hot route modules (not lazily per call)', () => {
        // The lazy import is for the QUEUE, inside the trigger. A route importing the trigger
        // dynamically would defeat the point: the module itself is cheap, the queue is not.
        for (const rel of [
            'src/app/api/reading-lists/route.ts',
            'src/app/api/reading-lists/items/route.ts',
            'src/app/api/library/route.ts',
        ]) {
            const src = reads(path.join(process.cwd(), rel));
            expect(/^import .*from '@\/lib\/komga\/readlist-trigger';$/m.test(src)).toBe(true);
        }
    });

    it('readlist-trigger.ts imports the queue ONLY lazily', () => {
        const src = reads(path.join(SRC, 'lib', 'komga', 'readlist-trigger.ts'));
        // A static queue import would pull bullmq + ioredis into every reading-list request bundle.
        expect(/^import .*from '\.\/queue';$/m.test(src)).toBe(false);
        expect(src).toContain("await import('./queue')");
    });

    it('the delete paths capture the Komga id before deleting', () => {
        // The link row cascades away with the list, so the Komga id has to be read while it exists.
        // reading-lists DELETE awaits the lookup (it has nothing else to capture it from).
        // reading-lists DELETE: the Komga id must be captured before the list (and its link) is gone.
        const listRoute = reads(path.join(process.cwd(), 'src/app/api/reading-lists/route.ts'));
        expect(listRoute.indexOf('await triggerReadListRemoteDelete(id)')).toBeGreaterThan(-1);
        expect(listRoute.indexOf('prisma.readingList.delete({')).toBeGreaterThan(
            listRoute.indexOf('await triggerReadListRemoteDelete(id)'),
        );
        // MAL re-import
        const mal = reads(path.join(process.cwd(), 'src/app/api/reading-lists/import-mal/route.ts'));
        expect(mal.indexOf('prisma.readingList.deleteMany(')).toBeGreaterThan(
            mal.indexOf('replacedLinks'),
        );
        expect(mal).toContain('enqueueKomgaReadListDeleteNow(old.komgaReadListId, old.readingListId)');
        // AniList re-import
        const anilist = reads(path.join(process.cwd(), 'src/app/api/reading-lists/import-anilist/route.ts'));
        expect(anilist.indexOf('prisma.readingList.deleteMany(')).toBeGreaterThan(
            anilist.indexOf('replacedLinks'),
        );
        expect(anilist).toContain('enqueueKomgaReadListDeleteNow(old.komgaReadListId, old.readingListId)');
        // user deletion cascade
        const users = reads(path.join(process.cwd(), 'src/app/api/admin/users/route.ts'));
        expect(users.indexOf('prisma.user.delete(')).toBeGreaterThan(users.indexOf('ownedLinks'));
        expect(users).toContain('enqueueKomgaReadListDeleteNow(link.komgaReadListId, link.readingListId)');
    });

    it('the cascade paths capture the Komga id BEFORE the rows disappear', () => {
        // enqueueKomgaReadListDeleteNow takes an id, so it can be called after the cascade; but the
        // id itself has to be read before. These three must select komgaReadListId up front.
        for (const rel of [
            'src/app/api/reading-lists/import-mal/route.ts',
            'src/app/api/reading-lists/import-anilist/route.ts',
            'src/app/api/admin/users/route.ts',
        ]) {
            const src = reads(path.join(process.cwd(), rel));
            expect(src, rel).toMatch(/select: \{[^}]*komgaReadListId: true[^}]*\}/);
        }
    });

    it('the re-import routes carry komgaSync onto the recreated list', () => {
        for (const rel of ['src/app/api/reading-lists/import-mal/route.ts', 'src/app/api/reading-lists/import-anilist/route.ts']) {
            const src = reads(path.join(process.cwd(), rel));
            expect(src, rel).toMatch(/komgaSync: replacedLinks\.length > 0 \? true : undefined/);
        }
    });

    it('no route enqueues a read-list job without going through the trigger', () => {
        // Direct queue access from a route would bypass the komgaSync check entirely.
        const offenders = all
            .map(f => path.relative(process.cwd(), f))
            .filter(f => /enqueueKomgaReadList(Push|Delete)\(/.test(reads(path.join(process.cwd(), f))));
        expect(offenders).toEqual([]);
    });
});