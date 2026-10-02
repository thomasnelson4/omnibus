// @vitest-environment jsdom
// Search Match (#199 round 2, concept by CapitanoNemo78): the Smart Matcher's manual match is
// search-first — type a series name, pick from the provider's results — with the classic
// exact-ID lookup demoted to an "advanced" disclosure, not removed. These tests drive the REAL
// page in jsdom and pin the new wiring end to end: dialog copy, /api/search call shape, result
// rows, pick → volume resolution → Issue Mapping auto-fill (exact issue id from the file's
// number), Load more pagination, and the fallback ID path routing through the same resolver.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { err, ok, stubFetchRouter } from '../../helpers/fetch';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { id: 'admin_1', role: 'ADMIN' } }, status: 'authenticated' }),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
// The metadata dialog and page manager have their own test files — stub them inert here, but keep
// every named export the page imports (the partial-mock trap: missing exports fail at import time).
vi.mock('@/components/smart-match-metadata-dialog', () => ({
    default: () => null,
    buildFolderPreview: () => '',
    shouldEmbedIssueCover: () => undefined,
    COMIC_INFO_DEFAULT_KEYS: [],
}));
vi.mock('@/components/page-manager-modal', () => ({ default: () => null }));

import SmartMatchPage from '@/app/admin/smart-match/page';

const RAW_ITEM = {
    id: 'raw_Q29uYW4', name: 'Conan & Dragonero 001',
    folderPath: '/unmatched/Conan & Dragonero 001.cbz', isRawFile: true,
};

const SEARCH_RESULT = {
    id: 16180, name: 'Conan & Dragonero', year: 2026, publisher: 'Sergio Bonelli Editore',
    count: 5, image: null, description: 'crossover', metadataSource: 'METRON',
};

const VOLUME_DETAILS = {
    id: 16180, name: 'Conan & Dragonero', volumeName: 'Conan & Dragonero', volumeId: 16180,
    publisher: 'Sergio Bonelli Editore', image: null, year: '2026', description: 'crossover',
    count: 5,
    issues: [
        { id: '171893', issue_number: '1', name: 'Conan & Dragonero (2026) #1' },
        { id: '171894', issue_number: '2', name: 'Conan & Dragonero (2026) #2' },
    ],
};

let searchCalls: string[] = [];
let detailCalls: string[] = [];

// Collapse only the scan's pacing delay; Testing Library's timeout must stay real.
const stubScanDelays = () => {
    const original = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', (callback: () => void, delay: number, ...args: unknown[]) =>
        original(callback, delay === 1500 ? 0 : delay, ...args));
};

const openSearchMatchDialog = async () => {
    render(<SmartMatchPage />);
    await screen.findByText('Conan & Dragonero 001');
    fireEvent.click(screen.getByRole('button', { name: /Search Match/ }));
    await screen.findByPlaceholderText('e.g. The Amazing Spider-Man');
};

type BulkPayload = { oldFolderPath: string; [key: string]: unknown };
type UnmatchedItem = typeof RAW_ITEM & { isIgnored?: boolean };

const rawItems = (count: number): UnmatchedItem[] => Array.from({ length: count }, (_, idx) => ({
    id: `raw_${idx + 1}`, name: `Conan & Dragonero ${String(idx + 1).padStart(3, '0')}`,
    folderPath: `/unmatched/Conan & Dragonero ${idx + 1}.cbz`, isRawFile: true,
}));

const stubBulkFetch = (
    items: UnmatchedItem[],
    apply = (batch: BulkPayload[], _call: number) => ok({ results: batch.map(() => ({ ok: true })) }),
    prefillFor: (path: string) => unknown = () => null,
) => {
    const batches: BulkPayload[][] = [];
    stubFetchRouter([
        ['/api/admin/unmatched', () => ok(items)],
        ['/api/admin/config', () => ok({ settings: [{ key: 'primary_metadata_source', value: 'METRON' }] })],
        ['/api/admin/match-prefill', u => {
            const prefill = prefillFor(new URL(u, 'http://localhost').searchParams.get('path') || '');
            return ok({ hasContent: !!prefill, prefill });
        }],
        ['/api/search', u => { searchCalls.push(u); return ok({ results: [SEARCH_RESULT] }); }],
        ['/api/issue-details/covers', () => ok({ covers: {} })],
        ['/api/issue-details', u => { detailCalls.push(u); return ok(VOLUME_DETAILS); }],
        ['/api/library/match-series/bulk', (_u, init) => {
            const batch = JSON.parse(init.body).items;
            batches.push(batch);
            return apply(batch, batches.length);
        }],
    ]);
    return batches;
};

const openBulkAssignment = async (items: UnmatchedItem[]) => {
    render(<SmartMatchPage />);
    await screen.findByText(items[0].name);
    for (const item of items) fireEvent.click(screen.getByRole('checkbox', { name: `Select ${item.name}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Assign to Series' }));
    const dialog = screen.getByRole('dialog', { name: 'Assign to Series' });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Search$/ }));
    fireEvent.click(await within(dialog).findByText(SEARCH_RESULT.name));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /Assign Selected/ }).hasAttribute('disabled')).toBe(false));
    return dialog;
};

describe('Smart Matcher — Search Match dialog', () => {
    beforeEach(() => {
        searchCalls = [];
        detailCalls = [];
        toast.mockClear();
        localStorage.clear();
        sessionStorage.clear();
        stubFetchRouter([
            ['/api/admin/unmatched', () => ok([RAW_ITEM])],
            ['/api/admin/config', () => ok({
                settings: [
                    { key: 'metron_user', value: 'u' }, { key: 'metron_pass', value: 'p' },
                    { key: 'primary_metadata_source', value: 'METRON' },
                    { key: 'folder_naming_pattern', value: '{Publisher}/{Series} ({Year})' },
                    { key: 'metadata_write_comicinfo', value: 'true' },
                ],
            })],
            ['/api/admin/sweep', () => ok({})],
            ['/api/search', (u) => {
                searchCalls.push(u);
                const page = new URL(u, 'http://localhost').searchParams.get('page');
                return page === '1'
                    ? ok({ results: [SEARCH_RESULT], hasMore: true })
                    : ok({ results: [{ ...SEARCH_RESULT, id: 999, name: 'Dragonero Adventures' }], hasMore: false });
            }],
            ['/api/issue-details', (u) => { detailCalls.push(u); return ok(VOLUME_DETAILS); }],
        ]);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('searches by name, picks a result, and auto-fills the exact issue id from the file number', async () => {
        await openSearchMatchDialog();

        fireEvent.change(screen.getByPlaceholderText('e.g. The Amazing Spider-Man'), { target: { value: 'Conan & Dragonero' } });
        fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));

        // The search hits /api/search with the query, page 1, and the page's provider…
        const row = await screen.findByText('Conan & Dragonero');
        expect(searchCalls[0]).toContain('q=Conan%20%26%20Dragonero');
        expect(searchCalls[0]).toContain('page=1');
        expect(searchCalls[0]).toContain('provider=METRON');
        expect(screen.getByText(/Sergio Bonelli Editore • 2026 • 5 issues/)).toBeTruthy();

        // …and picking the row resolves the volume under the RESULT'S OWN provider and auto-maps
        // "001" → issue #1's exact provider id.
        fireEvent.click(row);
        await waitFor(() => expect(detailCalls).toHaveLength(1));
        expect(detailCalls[0]).toContain('id=16180');
        expect(detailCalls[0]).toContain('type=volume');
        expect(detailCalls[0]).toContain('provider=METRON');
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Series Selected' })));
        await waitFor(() => expect(screen.getByDisplayValue('171893')).toBeTruthy());
        expect(await screen.findByRole('button', { name: /Apply Match/ })).toBeTruthy();
    });

    it('pages further results through Load more', async () => {
        await openSearchMatchDialog();
        fireEvent.change(screen.getByPlaceholderText('e.g. The Amazing Spider-Man'), { target: { value: 'Dragonero' } });
        fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));

        fireEvent.click(await screen.findByRole('button', { name: /Load more/ }));
        await screen.findByText('Dragonero Adventures');

        expect(searchCalls).toHaveLength(2);
        expect(searchCalls[1]).toContain('page=2');
        // hasMore=false on page 2 removes the button; page 1's row is still listed above it.
        expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull();
        expect(screen.getByText('Conan & Dragonero')).toBeTruthy();
    });

    it('keeps the exact-ID lookup behind the advanced disclosure, routed through the same resolver', async () => {
        await openSearchMatchDialog();

        // Hidden until disclosed…
        expect(screen.queryByPlaceholderText('e.g. 4050-12345 or 12746')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Match by exact provider ID/ }));

        // …then the classic flow: pasted CV-prefixed id is sanitized before the volume fetch.
        fireEvent.change(await screen.findByPlaceholderText('e.g. 4050-12345 or 12746'), { target: { value: '4050-16180' } });
        fireEvent.click(screen.getByRole('button', { name: /Look Up/ }));

        await waitFor(() => expect(detailCalls).toHaveLength(1));
        expect(detailCalls[0]).toContain('id=16180');
        expect(detailCalls[0]).not.toContain('4050-');
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Series Selected' })));
    });

    it('re-resolves the exact issue id from a corrected number using the picked volume\'s own list', async () => {
        await openSearchMatchDialog();
        fireEvent.change(screen.getByPlaceholderText('e.g. The Amazing Spider-Man'), { target: { value: 'Conan & Dragonero' } });
        fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
        fireEvent.click(await screen.findByText('Conan & Dragonero'));
        await waitFor(() => expect(screen.getByDisplayValue('171893')).toBeTruthy());

        // Right series, wrong issue: the admin corrects "1" → "2" and refreshes. The rawIssues list
        // is authoritative, so no second /api/issue-details call is made.
        fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '2' } });
        fireEvent.click(screen.getByRole('button', { name: /Refresh from number/ }));

        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Issue ID updated' })));
        expect(screen.getByDisplayValue('171894')).toBeTruthy();
        expect(detailCalls).toHaveLength(1);
    });

    it('falls back to one volume fetch when the match carries no issue list', async () => {
        let detailHits = 0;
        stubFetchRouter([
            ['/api/admin/unmatched', () => ok([RAW_ITEM])],
            ['/api/admin/config', () => ok({ settings: [{ key: 'primary_metadata_source', value: 'METRON' }] })],
            ['/api/admin/sweep', () => ok({})],
            ['/api/search', () => ok({ results: [SEARCH_RESULT], hasMore: false })],
            // First call (the pick) returns a volume WITHOUT issues — the auto-scan-shaped case;
            // the refresh's fallback fetch then returns the real list.
            ['/api/issue-details', () => { detailHits++; return ok(detailHits === 1 ? { ...VOLUME_DETAILS, issues: [] } : VOLUME_DETAILS); }],
        ]);
        await openSearchMatchDialog();
        fireEvent.change(screen.getByPlaceholderText('e.g. The Amazing Spider-Man'), { target: { value: 'Conan & Dragonero' } });
        fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
        fireEvent.click(await screen.findByText('Conan & Dragonero'));
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Series Selected' })));

        fireEvent.change(screen.getByPlaceholderText('e.g. 1'), { target: { value: '2' } });
        fireEvent.click(screen.getByRole('button', { name: /Refresh from number/ }));

        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Issue ID updated' })));
        expect(detailHits).toBe(2);
        expect(screen.getByDisplayValue('171894')).toBeTruthy();
    });

    it('reports an empty search honestly and suggests the ID fallback', async () => {
        stubFetchRouter([
            ['/api/admin/unmatched', () => ok([RAW_ITEM])],
            ['/api/admin/config', () => ok({ settings: [{ key: 'primary_metadata_source', value: 'METRON' }] })],
            ['/api/search', () => ok({ results: [], hasMore: false })],
        ]);
        await openSearchMatchDialog();
        fireEvent.change(screen.getByPlaceholderText('e.g. The Amazing Spider-Man'), { target: { value: 'Zzz Nothing' } });
        fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));

        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'No results' })));
    });

    it('retries a failed auto-search instead of caching a 500 as NOT_FOUND', async () => {
        stubScanDelays();
        let attempts = 0;
        stubFetchRouter([
            ['/api/admin/unmatched', () => ok([RAW_ITEM])],
            ['/api/admin/config', () => ok({ settings: [{ key: 'primary_metadata_source', value: 'METRON' }] })],
            ['/api/search', () => ++attempts === 1 ? err(500, { error: 'temporary' }) : ok({ results: [SEARCH_RESULT] })],
        ]);
        render(<SmartMatchPage />);
        await screen.findByText(RAW_ITEM.name);
        fireEvent.click(screen.getByRole('button', { name: /Start Auto-Scan/ }));
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Scan Complete' })));
        toast.mockClear();
        fireEvent.click(screen.getByRole('button', { name: /Start Auto-Scan/ }));
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Scan Complete', description: 'Found suggestions for 1 series.',
        })));
        expect(attempts).toBe(2);
    });

    it('does not repeat cached NOT_FOUND searches on every auto-scan', async () => {
        stubScanDelays();
        let attempts = 0;
        stubFetchRouter([
            ['/api/admin/unmatched', () => ok([RAW_ITEM])],
            ['/api/admin/config', () => ok({ settings: [{ key: 'primary_metadata_source', value: 'METRON' }] })],
            ['/api/search', () => { attempts++; return ok({ results: [] }); }],
        ]);
        render(<SmartMatchPage />);
        await screen.findByText(RAW_ITEM.name);
        for (let run = 0; run < 2; run++) {
            toast.mockClear();
            fireEvent.click(screen.getByRole('button', { name: /Start Auto-Scan/ }));
            await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Scan Complete' })));
        }
        expect(attempts).toBe(1);
    });

    it('assigns selected files with one search and distinct, editable issue mappings', async () => {
        const items = rawItems(3);
        const batches = stubBulkFetch(items);
        const dialog = await openBulkAssignment(items.slice(0, 2));
        expect(within(dialog).getByLabelText(`Issue ID for ${items[0].name}`).getAttribute('value')).toBe('171893');
        expect(within(dialog).getByLabelText(`Issue ID for ${items[1].name}`).getAttribute('value')).toBe('171894');
        fireEvent.change(within(dialog).getByLabelText(`Issue number for ${items[0].name}`), { target: { value: '7' } });
        fireEvent.change(within(dialog).getByLabelText(`Issue ID for ${items[0].name}`), { target: { value: 'corrected-id' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Assign Selected (2)' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(batches).toHaveLength(1);
        expect(batches[0]).toEqual([
            expect.objectContaining({ oldFolderPath: items[0].folderPath, metadataId: 16180, metadataSource: 'METRON', name: SEARCH_RESULT.name, exactIssueNumber: '7', exactIssueId: 'corrected-id' }),
            expect.objectContaining({ oldFolderPath: items[1].folderPath, metadataId: 16180, metadataSource: 'METRON', name: SEARCH_RESULT.name, exactIssueNumber: '2', exactIssueId: '171894' }),
        ]);
        expect(searchCalls).toHaveLength(1);
        expect(detailCalls).toHaveLength(1);
        expect(screen.queryByText(items[0].name)).toBeNull();
        expect(screen.queryByText(items[1].name)).toBeNull();
        expect(screen.getByText(items[2].name)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Select Entries' })).toBeTruthy();
    });

    it('assigns large selections in chunks without repeating the search or volume lookup', async () => {
        const items = rawItems(12);
        const batches = stubBulkFetch(items);
        const dialog = await openBulkAssignment(items);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Assign Selected (12)' }));

        await screen.findByText('All Caught Up!');
        expect(batches.map(batch => batch.length)).toEqual([5, 5, 2]);
        expect(batches.flat().map(item => item.oldFolderPath)).toEqual(items.map(item => item.folderPath));
        expect(batches.flat().every(item => item.metadataId === 16180 && item.metadataSource === 'METRON')).toBe(true);
        expect(searchCalls).toHaveLength(1);
        expect(detailCalls).toHaveLength(1);
    });

    it('keeps failed entries selected and retries only those with the chosen series', async () => {
        const items = rawItems(2);
        const batches = stubBulkFetch(items, (batch, call) => ok({ results: call === 1
            ? [{ ok: true }, { ok: false, error: 'Folder collision' }]
            : batch.map(() => ({ ok: true })),
        }));
        const dialog = await openBulkAssignment(items);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Assign Selected (2)' }));

        const retry = await within(dialog).findByRole('button', { name: 'Assign Selected (1)' });
        await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(false));
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Assignment finished with errors', description: expect.stringContaining('Folder collision') }));
        expect(within(dialog).queryByLabelText(`Issue ID for ${items[0].name}`)).toBeNull();
        expect(within(dialog).getByLabelText(`Issue ID for ${items[1].name}`).getAttribute('value')).toBe('171894');
        fireEvent.click(retry);

        await screen.findByText('All Caught Up!');
        expect(batches.map(batch => batch.map(item => item.oldFolderPath))).toEqual([
            items.map(item => item.folderPath), [items[1].folderPath],
        ]);
        expect(searchCalls).toHaveLength(1);
    });

    it.each(['HTTP error', 'network error', 'missing results'])('retains the selection after a bulk %s', async failure => {
        const items = rawItems(2);
        const batches = stubBulkFetch(items, (batch, call) => {
            if (call > 1) return ok({ results: batch.map(() => ({ ok: true })) });
            if (failure === 'HTTP error') return err(500, { error: 'Provider unavailable' });
            if (failure === 'network error') return Promise.reject(new Error('Network error'));
            return ok({ results: [] });
        });
        const dialog = await openBulkAssignment(items);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Assign Selected (2)' }));
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Assignment finished with errors' })));
        const retry = within(dialog).getByRole('button', { name: 'Assign Selected (2)' });
        expect(retry.hasAttribute('disabled')).toBe(false);
        fireEvent.click(retry);
        await screen.findByText('All Caught Up!');
        expect(batches.map(batch => batch.length)).toEqual([2, 2]);
    });

    it('selects and deselects all available entries while excluding ignored series', async () => {
        const items = [...rawItems(2), { id: 'ignored', name: 'Ignored series', folderPath: '/library/ignored', isRawFile: false, isIgnored: true }];
        const batches = stubBulkFetch(items);
        render(<SmartMatchPage />);
        await screen.findByText(items[0].name);
        fireEvent.click(screen.getByRole('button', { name: 'Show ignored (1)' }));
        expect(screen.getByRole('checkbox', { name: 'Select Ignored series' }).hasAttribute('disabled')).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Select Entries' }));
        expect(screen.getByRole('button', { name: 'Assign to Series' }).hasAttribute('disabled')).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
        expect(screen.getByRole('status').textContent).toBe('2 Selected');
        fireEvent.click(screen.getByRole('button', { name: 'Deselect All' }));
        expect(screen.getByRole('status').textContent).toBe('0 Selected');
        fireEvent.click(screen.getByRole('checkbox', { name: `Select ${items[0].name}` }));
        fireEvent.click(screen.getByRole('button', { name: 'Cancel Selection' }));
        expect(screen.getByRole('checkbox', { name: `Select ${items[0].name}` }).getAttribute('aria-checked')).toBe('false');
        expect(batches).toHaveLength(0);
    });

    it('confirms combining folders before assigning them to one series', async () => {
        const folders = rawItems(2).map(item => ({ ...item, folderPath: `/library/${item.id}`, isRawFile: false }));
        const batches = stubBulkFetch(folders);
        const dialog = await openBulkAssignment(folders);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Assign Selected (2)' }));
        expect(batches).toHaveLength(0);
        const confirmation = screen.getByRole('dialog', { name: 'Merge these folders into one series?' });
        fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
        expect(batches).toHaveLength(0);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Assign Selected (2)' }));
        fireEvent.click(screen.getByRole('button', { name: 'Assign and Merge' }));
        await screen.findByText('All Caught Up!');
        expect(batches[0].map(item => item.oldFolderPath)).toEqual(folders.map(item => item.folderPath));
    });

    it('preserves file metadata when shared naming is supplied', async () => {
        const items = rawItems(2);
        const batches = stubBulkFetch(items, undefined, path => ({
            fields: { description: { value: `Curated ${path}`, source: 'comicinfo' }, writer: { value: 'Local Writer', source: 'comicinfo' } },
            issue: { title: `Title ${path}` },
        }));
        const dialog = await openBulkAssignment(items);
        fireEvent.change(within(dialog).getByPlaceholderText('e.g. X-Men'), { target: { value: 'Crossover' } });
        fireEvent.change(within(dialog).getByPlaceholderText('e.g. Earth-616'), { target: { value: 'Shared Universe' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Assign Selected (2)' }));
        await screen.findByText('All Caught Up!');
        expect(batches[0]).toEqual(items.map(item => expect.objectContaining({
            oldFolderPath: item.folderPath, name: SEARCH_RESULT.name, description: `Curated ${item.folderPath}`, writer: 'Local Writer',
            issueTitle: `Title ${item.folderPath}`, dataMode: 'keep', seriesGroup: 'Crossover', universe: 'Shared Universe', lockMetadata: true,
        })));
    });

    it('locks assignment controls until the bulk request finishes', async () => {
        const items = rawItems(2);
        let finish!: (value: Awaited<ReturnType<typeof ok>>) => void;
        const pending = new Promise<Awaited<ReturnType<typeof ok>>>(resolve => { finish = resolve; });
        const batches = stubBulkFetch(items, () => pending);
        const dialog = await openBulkAssignment(items);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Assign Selected (2)' }));
        await waitFor(() => expect(batches).toHaveLength(1));
        expect(within(dialog).getByRole('button', { name: /Assigning 0\/2/ }).hasAttribute('disabled')).toBe(true);
        expect(within(dialog).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
        expect(within(dialog).getByPlaceholderText('e.g. The Amazing Spider-Man').closest('fieldset')?.disabled).toBe(true);
        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(screen.getByRole('dialog', { name: 'Assign to Series' })).toBeTruthy();
        finish(await ok({ results: [{ ok: true }, { ok: true }] }));
        await screen.findByText('All Caught Up!');
    });
});
