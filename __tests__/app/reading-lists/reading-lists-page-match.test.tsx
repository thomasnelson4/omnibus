// @vitest-environment jsdom
//
// /reading-lists — Fix match entry point, in-place patch after a save, the downloaded state
// ("Not downloaded" + Request for file-less links, Missing (N)), per-row Request in Grouped view,
// and keyboard-operable group headers. The dialog itself is stubbed (it has its own suite).
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, stubFetchRouter } from '../../helpers/fetch';

const auth = vi.hoisted(() => ({ session: null as any }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: auth.session }) }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/reading-list-item-match-dialog', () => ({
    ReadingListItemMatchDialog: (p: any) => (p.open ? (
        <div role="dialog" aria-label="Fix match">
            {p.item?.title}
            <span data-testid="stub-list-items">{p.listItems?.length}</span>
            <span data-testid="stub-resync">{p.resyncWarning ?? ''}</span>
            <button onClick={() => {
                p.onMatched({ ...p.item, title: 'Uncanny X-Men #141', cvIssueId: 20288, metadataSource: 'COMICVINE', issueId: null, issue: null }, { linked: false, cleared: false });
                p.onOpenChange(false);
            }}>stub-save</button>
            <button onClick={() => p.onStale?.()}>stub-stale</button>
        </div>
    ) : null),
}));

import ReadingListsPage from '@/app/reading-lists/page';

const xmen = { id: 'ser_x', name: 'X-Men', year: 1991, publisher: 'Marvel', folderPath: '/c/X-Men', metadataId: '4511', metadataSource: 'COMICVINE' };
const item1 = {
    id: 'item_1', order: 0, title: 'X-Men #141', cvIssueId: null, metadataSource: 'COMICVINE', issueId: 'iss_141',
    issue: { id: 'iss_141', number: '141', name: 'Mind Out of Time', filePath: '/c/x141.cbz', metadataSource: 'COMICVINE', metadataId: '9141', isAnnual: false, series: xmen },
};
const item2 = { id: 'item_2', order: 1, title: 'Uncanny X-Men (1963) #141', cvIssueId: null, metadataSource: 'COMICVINE', issueId: null, issue: null };
const item3 = {
    id: 'item_3', order: 2, title: 'X-Men #142', cvIssueId: null, metadataSource: 'COMICVINE', issueId: 'iss_142',
    issue: { id: 'iss_142', number: '142', name: null, filePath: null, releaseDate: '2001-01-01', metadataSource: 'COMICVINE', metadataId: '9142', isAnnual: false, series: xmen },
};
const list = (over: Record<string, unknown> = {}) => ({
    id: 'list_1', name: 'Dawn of X', description: '', coverUrl: null, userId: 'user_1', isGlobal: false,
    user: { username: 'u1' }, items: [item1, item2, item3], ...over,
});

let requests: any[];
const setup = (lists: any[]) => stubFetchRouter([
    ['/api/reading-lists?', () => ok(lists)],
    ['/api/request', (_url, init) => { requests.push(JSON.parse(init.body)); return ok({ success: true }); }],
]);
const listFetches = (fetchMock: ReturnType<typeof setup>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/reading-lists?')).length;

const groupHeaders = () => screen.getAllByText(/^(X-Men|Missing\/Unlinked Issue)$/).map(el => el.closest('[role="button"]') as HTMLElement);
const expandAll = async () => {
    await screen.findAllByText('Dawn of X');
    for (const header of groupHeaders()) fireEvent.click(header);
};
const fixButtons = () => screen.queryAllByRole('button', { name: /^Fix match for / });

describe('/reading-lists — Fix match and downloaded state', () => {
    let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        auth.session = { user: { id: 'user_1', role: 'USER' } };
        requests = [];
        storage = { getItem: vi.fn(() => '["item_2"]'), setItem: vi.fn() };
        vi.stubGlobal('localStorage', storage);
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('1. gives the owner a Fix match button on every row', async () => {
        setup([list()]);
        render(<ReadingListsPage />);
        await expandAll();
        expect(fixButtons().map(b => b.getAttribute('aria-label'))).toEqual([
            'Fix match for X-Men #141', 'Fix match for Uncanny X-Men (1963) #141', 'Fix match for X-Men #142',
        ]);
        expect(fixButtons().map(b => b.getAttribute('data-match-trigger'))).toEqual(['item_1', 'item_2', 'item_3']);
        expect(fixButtons().every(b => !b.className.includes('hidden'))).toBe(true);
    });

    it("2. shows no Fix match to a USER viewing another user's global list", async () => {
        setup([list({ userId: 'user_9', isGlobal: true })]);
        render(<ReadingListsPage />);
        await expandAll();
        // The rows are rendered (and still requestable) — just not editable.
        expect(screen.getByRole('button', { name: 'Requested' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Request X-Men #142' })).toBeInTheDocument();
        expect(fixButtons()).toHaveLength(0);
        expect(document.querySelectorAll('[data-match-trigger]')).toHaveLength(0);
    });

    it('3. shows Fix match to an ADMIN on a system list', async () => {
        auth.session = { user: { id: 'admin_1', role: 'ADMIN' } };
        setup([list({ userId: null })]);
        render(<ReadingListsPage />);
        await expandAll();
        expect(fixButtons()).toHaveLength(3);
    });

    it('4. patches the saved row in place: new title + provider badge, no refetch, group kept open, Requested reset', async () => {
        const fetchMock = setup([list()]);
        render(<ReadingListsPage />);
        await expandAll();
        expect(screen.getByRole('button', { name: 'Requested' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Fix match for Uncanny X-Men (1963) #141' }));
        const dialog = screen.getByRole('dialog', { name: 'Fix match' });
        expect(within(dialog).getByText('Uncanny X-Men (1963) #141')).toBeInTheDocument();
        expect(within(dialog).getByTestId('stub-list-items')).toHaveTextContent('3');
        fireEvent.click(within(dialog).getByRole('button', { name: 'stub-save' }));

        expect(await screen.findByText('Uncanny X-Men #141 (Missing File)')).toBeInTheDocument();
        const badge = screen.getByRole('link', { name: 'CV #20288' });
        expect(badge).toHaveAttribute('href', 'https://comicvine.gamespot.com/issue/4000-20288/');
        expect(badge).toHaveAttribute('target', '_blank');
        expect(listFetches(fetchMock)).toBe(1);
        // Still expanded: the row's own buttons are still rendered.
        expect(screen.getByRole('button', { name: 'Fix match for Uncanny X-Men #141' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Fix match for X-Men #141' })).toBeInTheDocument();
        expect(storage.setItem).toHaveBeenCalledWith('omnibus_requested_issues', '[]');
        expect(screen.getByRole('button', { name: 'Request Uncanny X-Men #141' })).toBeInTheDocument();
        expect(screen.queryByRole('dialog')).toBeNull();
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fix match for Uncanny X-Men #141' })));
    });

    it('4. refetches the lists when the dialog reports a stale list', async () => {
        const fetchMock = setup([list()]);
        render(<ReadingListsPage />);
        await expandAll();
        fireEvent.click(screen.getByRole('button', { name: 'Fix match for X-Men #142' }));
        fireEvent.click(screen.getByRole('button', { name: 'stub-stale' }));
        await waitFor(() => expect(listFetches(fetchMock)).toBe(2));
    });

    it('5. treats file-less links as Not downloaded with Request, and counts them in Missing', async () => {
        storage.getItem.mockReturnValue(null);
        setup([list()]);
        render(<ReadingListsPage />);
        await expandAll();

        expect(screen.getByRole('button', { name: /Missing \(2\)/ })).toBeInTheDocument();
        expect(screen.getAllByText('Not downloaded')).toHaveLength(1);
        const readLinks = screen.getAllByRole('link', { name: /Read/ });
        expect(readLinks).toHaveLength(1);
        expect(readLinks[0]).toHaveAttribute('href', expect.stringContaining(encodeURIComponent('/c/x141.cbz')));
        expect(screen.getByRole('button', { name: 'Request Uncanny X-Men (1963) #141' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Request X-Men #142' }));
        await waitFor(() => expect(requests).toHaveLength(1));
        expect(requests[0]).toEqual(expect.objectContaining({
            type: 'issue', cvId: '4511', name: 'X-Men #142', issueNumber: '142', year: '1991', publisher: 'Marvel',
            metadataSource: 'COMICVINE', releaseDate: '2001-01-01',
        }));
        expect(await screen.findByRole('button', { name: 'Requested' })).toBeInTheDocument();
    });

    it('5. keeps the existing unlinked Request path (title-derived number)', async () => {
        storage.getItem.mockReturnValue(null);
        setup([list()]);
        render(<ReadingListsPage />);
        await expandAll();
        fireEvent.click(screen.getByRole('button', { name: 'Request Uncanny X-Men (1963) #141' }));
        await waitFor(() => expect(requests).toHaveLength(1));
        expect(requests[0]).toMatchObject({ type: 'issue', cvId: 0, name: 'Uncanny X-Men (1963) #141', issueNumber: '141' });
    });

    it('5. never sends an empty request name for an untitled manual add', async () => {
        storage.getItem.mockReturnValue(null);
        const untitled = { ...item3, id: 'item_4', title: '', issue: { ...item3.issue, series: { ...xmen, metadataId: 'unmatched_1' } } };
        setup([list({ items: [untitled] })]);
        render(<ReadingListsPage />);
        await expandAll();
        fireEvent.click(screen.getByRole('button', { name: 'Request X-Men #142' }));
        await waitFor(() => expect(requests).toHaveLength(1));
        expect(requests[0].name).toBe('X-Men #142');
    });

    it('expands a group from the keyboard', async () => {
        setup([list()]);
        render(<ReadingListsPage />);
        await screen.findAllByText('Dawn of X');
        const header = screen.getByText('Missing/Unlinked Issue').closest('[role="button"]') as HTMLElement;
        expect(header).toHaveAttribute('tabindex', '0');
        expect(header).toHaveAttribute('aria-expanded', 'false');
        fireEvent.keyDown(header, { key: 'Enter' });
        expect(header).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('button', { name: 'Fix match for Uncanny X-Men (1963) #141' })).toBeInTheDocument();
        fireEvent.keyDown(header, { key: ' ' });
        expect(header).toHaveAttribute('aria-expanded', 'false');
    });

    it('passes the AniList/MAL re-sync warning to the dialog', async () => {
        setup([list({ description: 'Imported from AniList user: hanks_cafe' })]);
        render(<ReadingListsPage />);
        await expandAll();
        fireEvent.click(screen.getByRole('button', { name: 'Fix match for X-Men #141' }));
        expect(screen.getByTestId('stub-resync')).toHaveTextContent(/discards manual match fixes/);
    });

    it('6. offers Fix match in the Flat view too', async () => {
        storage.getItem.mockReturnValue(null);
        setup([list()]);
        render(<ReadingListsPage />);
        await screen.findAllByText('Dawn of X');
        fireEvent.click(screen.getByRole('button', { name: /Flat \(Reorder\)/ }));
        expect(await screen.findByRole('button', { name: 'Fix match for Uncanny X-Men (1963) #141' })).toBeInTheDocument();
        expect(fixButtons()).toHaveLength(3);
        expect(screen.getByText('Not downloaded')).toBeInTheDocument();
        expect(screen.getAllByRole('link', { name: /Read/ })).toHaveLength(1);
        expect(screen.getByRole('button', { name: 'Request X-Men #142' })).toBeInTheDocument();
    });
});
