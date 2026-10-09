// Real isolated SQLite + a temporary schema; every provider call is mocked.
//
// The unit suites mock prisma entirely, which cannot tell whether a query SHAPE is legal. This one
// runs the new Fix match queries against a real engine, so it catches what a mock can never see:
//   - the nested library filter (`series: { libraryId: { in: [...] } }`) on Issue.findMany;
//   - `updateMany({ where: { id, listId } })` scoping and the columns the update does NOT write
//     (`order` / `listId`) — asserted by reading the row back, not by inspecting the argument;
//   - the auto-link's conditional `updateMany({ id, issueId: null, cvIssueId, metadataSource })`,
//     including that a row already linked is NOT overwritten;
//   - the whole-file transaction that links several entries at once.
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

const mocks = vi.hoisted(() => ({
    prisma: null as any,
    session: null as any,
    cachedCvGet: vi.fn(),
    getIssueSummary: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth/next', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: mocks.cachedCvGet }));
vi.mock('@/lib/metadata/providers/metron', () => ({ MetronProvider: class { getIssueSummary = mocks.getIssueSummary; } }));

import { PATCH } from '@/app/api/reading-lists/items/route';
import { GET as getMatch } from '@/app/api/reading-lists/match/route';
import { GET as getLists } from '@/app/api/reading-lists/route';

let root: string;
const asUser = () => ({ user: { id: 'owner', role: 'USER' } });
const asAdmin = () => ({ user: { id: 'admin', role: 'ADMIN' } });

const patchReq = (body: unknown) => new Request('http://fixture/api/reading-lists/items', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const previewReq = (params: Record<string, string>) =>
    new Request(`http://fixture/api/reading-lists/match?${new URLSearchParams(params)}`);
const listsReq = () => new Request('http://fixture/api/reading-lists');

const CV_ISSUE = {
    id: 20288, name: 'Days of Future Past', issue_number: '141', cover_date: '1981-01-01',
    image: {}, volume: { id: 2133, name: 'Uncanny X-Men' },
};

beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnibus-rl-rematch-'));
    const url = `file:${path.join(root, 'fixture.db')}`;
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
    });
    mocks.prisma = new PrismaClient({ datasources: { db: { url } } });
    vi.stubEnv('CV_API_KEY', '');
}, 70_000);

afterAll(async () => { await mocks.prisma?.$disconnect(); await fs.rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

beforeEach(async () => {
    const p = mocks.prisma;
    await p.readingListItem.deleteMany();
    await p.readingList.deleteMany();
    await p.userLibraryAccess.deleteMany();
    await p.issue.deleteMany();
    await p.series.deleteMany();
    await p.library.deleteMany();
    await p.user.deleteMany();
    await p.systemSetting.deleteMany();
    await p.systemSetting.create({ data: { key: 'cv_api_key', value: 'fixture-key' } });

    await p.user.create({ data: { id: 'owner', username: 'owner', email: 'owner@x', password: 'x' } });
    await p.user.create({ data: { id: 'admin', username: 'admin', email: 'admin@x', password: 'x', role: 'ADMIN' } });
    await p.user.create({ data: { id: 'stranger', username: 'stranger', email: 's@x', password: 'x' } });
    await p.library.create({ data: { id: 'lib_ok', name: 'Visible', path: path.join(root, 'visible') } });
    await p.library.create({ data: { id: 'lib_secret', name: 'Secret', path: path.join(root, 'secret') } });
    await p.userLibraryAccess.create({ data: { userId: 'owner', libraryId: 'lib_ok' } });
    await p.series.create({ data: { id: 'ser_ok', name: 'Uncanny X-Men', year: 1963, folderPath: '/v/x', libraryId: 'lib_ok', metadataId: '2133', metadataSource: 'COMICVINE' } });
    // A second copy of the same provider issue in the invisible library. Its SERIES is Metron, so it
    // carries no ComicVine parent evidence and PASSES the identity guard — the ONLY thing that can
    // keep it out of an owner's link is the library filter, which is what this fixture is for.
    // (Series @@unique([metadataSource, metadataId]) means it cannot share the CV volume id.)
    await p.series.create({ data: { id: 'ser_secret', name: 'Uncanny X-Men', year: 1963, folderPath: '/s/x', libraryId: 'lib_secret', metadataId: '9999', metadataSource: 'METRON' } });
    await p.issue.create({ data: { id: 'iss_ok', seriesId: 'ser_ok', number: '141', metadataId: '20288', metadataSource: 'COMICVINE', filePath: '/v/x141.cbz' } });
    await p.issue.create({ data: { id: 'iss_secret', seriesId: 'ser_secret', number: '141', metadataId: '20288', metadataSource: 'COMICVINE', filePath: '/s/x141.cbz' } });
    await p.issue.create({ data: { id: 'iss_unmatched', seriesId: 'ser_secret', number: '1', metadataId: 'unmatched_1', metadataSource: 'LOCAL', filePath: '/s/x1.cbz' } });
    // isGlobal so an ADMIN actually loads this list in the auto-link tests — a non-global list is not
// in GET /api/reading-lists for anyone but its owner, which would make those tests vacuous.
await p.readingList.create({ data: { id: 'list_owner', name: 'L', userId: 'owner', isGlobal: true } });
    await p.readingListItem.create({
        data: { id: 'item_unlinked', listId: 'list_owner', title: 'Uncanny X-Men (1963) #141', cvIssueId: 20288, metadataSource: 'COMICVINE', issueId: null, order: 7 },
    });
    await p.readingListItem.create({
        data: { id: 'item_linked', listId: 'list_owner', title: 'X-Men #1', cvIssueId: null, metadataSource: 'COMICVINE', issueId: 'iss_unmatched', order: 8 },
    });

    mocks.session = asUser();
    mocks.cachedCvGet.mockResolvedValue({ data: { status_code: 1, results: CV_ISSUE }, cached: false });
    mocks.getIssueSummary.mockReset();
});

const row = (id: string) => mocks.prisma.readingListItem.findUniqueOrThrow({ where: { id } });

describe('Fix match against a real database', () => {
    it('links the owner\'s copy, leaves order/listId untouched, and writes no extra columns', async () => {
        mocks.cachedCvGet.mockResolvedValue({ data: { status_code: 1, results: CV_ISSUE }, cached: false });
        const res = await PATCH(patchReq({ listId: 'list_owner', itemId: 'item_unlinked', action: 'rematch', provider: 'COMICVINE', providerIssueId: 20288 }));
        expect(res.status).toBe(200);

        const after = await row('item_unlinked');
        expect(after).toMatchObject({ issueId: 'iss_ok', cvIssueId: 20288, metadataSource: 'COMICVINE', title: 'Uncanny X-Men #141' });
        // The two columns the contract says the update never touches.
        expect(after.order).toBe(7);
        expect(after.listId).toBe('list_owner');
    });

    it('never links across the library boundary, in either direction', async () => {
        // The copy in the invisible library must not be picked for an owner's save...
        await PATCH(patchReq({ listId: 'list_owner', itemId: 'item_unlinked', action: 'rematch', provider: 'COMICVINE', providerIssueId: 20288 }));
        expect((await row('item_unlinked')).issueId).toBe('iss_ok');

        // ...and an ADMIN editing the restricted owner's list must not reach it either.
        mocks.session = asAdmin();
        await PATCH(patchReq({ listId: 'list_owner', itemId: 'item_linked', action: 'rematch', provider: 'COMICVINE', providerIssueId: 20288 }));
        expect((await row('item_linked')).issueId).toBe('iss_ok');
    });

    it('links NOTHING when the only copy sits in the library the owner cannot see', async () => {
        // Removes the tie between the two copies, so this fails outright if the access filter is
        // ever bypassed rather than merely out-picking the wrong row.
        await mocks.prisma.issue.delete({ where: { id: 'iss_ok' } });
        const body = await (await getMatch(previewReq({ listId: 'list_owner', provider: 'COMICVINE', issueId: '20288' }))).json();
        expect(body.local).toBeNull();

        const res = await PATCH(patchReq({ listId: 'list_owner', itemId: 'item_unlinked', action: 'rematch', provider: 'COMICVINE', providerIssueId: 20288 }));
        expect(await res.json()).toMatchObject({ link: 'none', linked: false });
        expect((await row('item_unlinked')).issueId).toBeNull();

        // Same for the ADMIN, who may see the list but not decide the owner's links.
        mocks.session = asAdmin();
        const adminBody = await (await getMatch(previewReq({ listId: 'list_owner', provider: 'COMICVINE', issueId: '20288' }))).json();
        expect(adminBody.accessScope).toBe('owner');
        expect(adminBody.local).toBeNull();
    });

    it('the ADMIN preview and the ADMIN save agree about the invisible link', async () => {
        mocks.session = asAdmin();
        const body = await (await getMatch(previewReq({ listId: 'list_owner', itemId: 'item_linked', provider: 'COMICVINE', issueId: '20288' }))).json();
        // The current link is a file in the library the owner cannot see.
        expect(body.accessScope).toBe('owner');
        expect(body.keepable).toBe(false);

        const res = await PATCH(patchReq({ listId: 'list_owner', itemId: 'item_linked', action: 'rematch', provider: 'COMICVINE', providerIssueId: 20288, keepLocalLink: true }));
        expect(await res.json()).toMatchObject({ link: 'matched', linked: true });
        // link:'matched' (an accessible copy exists) — the point is that keepable never lied about
        // the keep path: had it said true, the save would still have overwritten the link.
        expect((await row('item_linked')).issueId).toBe('iss_ok');
    });

    it('scopes the item lookup to the list (an item id from another list is not found)', async () => {
        await mocks.prisma.readingList.create({ data: { id: 'list_other', name: 'Other', userId: 'stranger' } });
        await mocks.prisma.readingListItem.create({ data: { id: 'item_foreign', listId: 'list_other', title: 'Secret #1', cvIssueId: 1, order: 0 } });
        const res = await PATCH(patchReq({ listId: 'list_owner', itemId: 'item_foreign', action: 'clear' }));
        expect(res.status).toBe(404);
        expect((await row('item_foreign')).cvIssueId).toBe(1);
    });

    it('clear drops the identity and the link but keeps a meaningful title', async () => {
        const res = await PATCH(patchReq({ listId: 'list_owner', itemId: 'item_linked', action: 'clear' }));
        expect(res.status).toBe(200);
        expect(await row('item_linked')).toMatchObject({ cvIssueId: null, issueId: null, title: 'X-Men #1', order: 8 });
    });

    it('clear rebuilds a title for a single-issue add that stored an empty one', async () => {
        await mocks.prisma.readingListItem.create({
            data: { id: 'item_blank', listId: 'list_owner', title: '', cvIssueId: 20288, issueId: 'iss_ok', order: 9 },
        });
        await PATCH(patchReq({ listId: 'list_owner', itemId: 'item_blank', action: 'clear' }));
        expect((await row('item_blank')).title).toBe('Uncanny X-Men #141');
    });

    describe('the GET auto-link, in the database', () => {
        it('links the owner\'s copy on load and does NOT touch the already-linked row', async () => {
            const before = await row('item_linked');
            const body = await (await getLists(listsReq())).json();
            expect(body).toHaveLength(1);
            expect(body[0].items.find((i: any) => i.id === 'item_unlinked').issueId).toBe('iss_ok');
            // The linked row kept its link — the conditional update cannot re-point it.
            expect(await row('item_linked')).toMatchObject({ issueId: before.issueId });
        });

        it('is a no-op the second time (idempotent, and the re-read is skipped)', async () => {
            await (await getLists(listsReq())).json();
            expect((await row('item_unlinked')).issueId).toBe('iss_ok');
            const second = await (await getLists(listsReq())).json();
            expect(second[0].items.find((i: any) => i.id === 'item_unlinked').issueId).toBe('iss_ok');
        });

        it('an ADMIN viewing the list does not link the owner into the invisible library', async () => {
            await mocks.prisma.userLibraryAccess.deleteMany({ where: { userId: 'owner' } });
            await mocks.prisma.issue.delete({ where: { id: 'iss_ok' } });
            mocks.session = asAdmin();
            const lists = await (await getLists(listsReq())).json();
            // The list is global, so the ADMIN really does load it — the entry stays unlinked.
            expect(lists[0].items.map((i: any) => i.id)).toContain('item_unlinked');
            expect((await row('item_unlinked')).issueId).toBeNull();
        });

        it('a title whose "#N" contradicts the row vetoes the link', async () => {
            await mocks.prisma.readingListItem.update({ where: { id: 'item_unlinked' }, data: { title: 'Uncanny X-Men #142' } });
            await (await getLists(listsReq())).json();
            expect((await row('item_unlinked')).issueId).toBeNull();
        });

        it('links several entries in one transaction', async () => {
            await mocks.prisma.readingListItem.createMany({
                data: [
                    { id: 'item_b', listId: 'list_owner', title: 'Uncanny X-Men #141', cvIssueId: 20288, metadataSource: 'COMICVINE', order: 10 },
                    { id: 'item_c', listId: 'list_owner', title: 'Uncanny X-Men #141', cvIssueId: 20288, metadataSource: 'COMICVINE', order: 11 },
                ],
            });
            await (await getLists(listsReq())).json();
            for (const id of ['item_unlinked', 'item_b', 'item_c']) {
                expect((await row(id)).issueId).toBe('iss_ok');
            }
        });
    });
});