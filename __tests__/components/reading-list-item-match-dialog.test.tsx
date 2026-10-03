// @vitest-environment jsdom
import '@testing-library/jest-dom';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { err, ok, stubFetchRouter } from '../helpers/fetch';
import { openTab } from '../helpers/radix';
import {
    ReadingListItemMatchDialog, type MatchDialogItem, type ReadingListItemMatchDialogProps,
} from '@/components/reading-list-item-match-dialog';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const baseItem: MatchDialogItem = {
    id: 'item_1', title: 'Uncanny X-Men (1963) #141', cvIssueId: null, metadataSource: 'COMICVINE', issueId: null, issue: null,
};
const linkedItem = (issue: Partial<NonNullable<MatchDialogItem['issue']>> = {}, over: Partial<MatchDialogItem> = {}): MatchDialogItem => ({
    ...baseItem,
    title: 'X-Men #1',
    issueId: 'old_issue',
    issue: { number: '1', filePath: '/c/x1.cbz', metadataSource: 'COMICVINE', metadataId: '999', series: { name: 'X-Men', year: 1991 }, ...issue },
    ...over,
});

const summary = (over: Record<string, unknown> = {}) => ({
    provider: 'COMICVINE', issueId: 20288, seriesId: 2133, seriesName: 'Uncanny X-Men', seriesStartYear: null, publisher: null,
    issueNumber: '141', issueTitle: 'Days of Future Past', coverDate: '1981-01-01', storeDate: null,
    image: '/api/library/cover?path=https%3A%2F%2Fcv%2F141.jpg',
    siteUrl: 'https://comicvine.gamespot.com/uncanny-x-men-141/4000-20288/', displayTitle: 'Uncanny X-Men #141',
    ...over,
});
const lookupBody = (over: Record<string, unknown> = {}, match: Record<string, unknown> = {}) => ({
    match: summary(match), local: null, mislabeled: null, accessScope: 'self', keepable: false, ...over,
});
// itemId is optional: the current-match header line calls GET /match without it.
const matchUrl = (provider: string, issueId: string | number, itemId?: string) => {
    const p = new URLSearchParams({ listId: 'list_1' });
    if (itemId !== undefined) p.set('itemId', itemId);
    p.set('provider', provider);
    p.set('issueId', String(issueId));
    return `/api/reading-lists/match?${p}`;
};

type Props = ReadingListItemMatchDialogProps;
let onMatched = vi.fn<Props['onMatched']>();

function Harness(p: Partial<Props>) {
    const [open, setOpen] = useState(true);
    const item = p.item ?? baseItem;
    return (
        <>
            <button onClick={() => setOpen(true)}>Open fix match</button>
            <ReadingListItemMatchDialog open={open} onOpenChange={setOpen} listId="list_1" item={item}
                listItems={p.listItems ?? [item]} onMatched={p.onMatched ?? onMatched} onStale={p.onStale}
                slowNoticeMs={p.slowNoticeMs} resyncWarning={p.resyncWarning} />
        </>
    );
}

interface Routes {
    providers?: () => any;
    match?: (url: string) => any;
    search?: (url: string) => any;
    issues?: (url: string) => any;
    items?: (url: string, init: any) => any;
}
const setup = (r: Routes = {}) => stubFetchRouter([
    ['/api/reading-lists/match/providers', () => (r.providers ? r.providers() : ok({ providers: { COMICVINE: true, METRON: true }, primary: 'COMICVINE' }))],
    ['/api/reading-lists/match?', url => (r.match ? r.match(url) : ok(lookupBody()))],
    ['/api/search?', url => (r.search ? r.search(url) : ok({ results: [], hasMore: false }))],
    ['/api/series-issues?', url => (r.issues ? r.issues(url) : ok({ results: [] }))],
    ['/api/reading-lists/items', (url, init) => (r.items ? r.items(url, init) : ok({ success: true, item: { id: 'item_1' }, link: 'none', linked: false, hasFile: false, match: summary() }))],
]);

const patchBodies = (fetchMock: ReturnType<typeof setup>) =>
    fetchMock.mock.calls.filter(([url]) => url === '/api/reading-lists/items').map(([, init]) => JSON.parse(init.body));
const lookupCalls = (fetchMock: ReturnType<typeof setup>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/reading-lists/match?'));

const enterId = async (value: string) => {
    openTab(/Enter ID/);
    fireEvent.change(screen.getByLabelText(/issue ID/), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
};
const chooseProvider = async (name: RegExp | string) => {
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name }));
};
const saveButton = () => screen.getByRole('button', { name: 'Save match' });

const seriesResult = { id: 2133, name: 'Uncanny X-Men', year: 1963, publisher: 'Marvel', count: 544, image: null, metadataSource: 'COMICVINE' };
const issue = (n: string, id: number) => ({ id, volumeId: 2133, name: `Uncanny X-Men #${n}`, issueNumber: n, issue_number: n, year: '1981', image: null, metadataSource: 'COMICVINE' });

describe('ReadingListItemMatchDialog', () => {
    beforeEach(() => {
        onMatched = vi.fn();
        window.HTMLElement.prototype.scrollIntoView = vi.fn();
        window.HTMLElement.prototype.hasPointerCapture = vi.fn();
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('1. looks up a pasted ComicVine id, previews it, and saves', async () => {
        const updated = { id: 'item_1', title: 'Uncanny X-Men #141', cvIssueId: 20288, metadataSource: 'COMICVINE', issueId: null, issue: null };
        const fetchMock = setup({ items: () => ok({ success: true, item: updated, link: 'none', linked: false, hasFile: false, match: summary() }) });
        render(<Harness />);
        expect(saveButton()).toBeDisabled();
        await enterId(' 4000-20288 ');
        expect(await screen.findByText('Uncanny X-Men #141')).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith('/api/reading-lists/match?listId=list_1&itemId=item_1&provider=COMICVINE&issueId=20288');
        expect(screen.getByText(/Not in the library/)).toBeInTheDocument();

        fireEvent.click(saveButton());
        await waitFor(() => expect(onMatched).toHaveBeenCalledOnce());
        expect(patchBodies(fetchMock)).toEqual([{ listId: 'list_1', itemId: 'item_1', action: 'rematch', provider: 'COMICVINE', providerIssueId: 20288 }]);
        expect(onMatched).toHaveBeenCalledWith(updated, { linked: false, cleared: false });
        expect(toast).toHaveBeenCalledWith({ title: 'Match updated', description: 'Uncanny X-Men #141 — not in the library yet. Use Request to get it.' });
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('2. looks up Metron ids after switching provider', async () => {
        const fetchMock = setup({ match: () => ok(lookupBody({}, { provider: 'METRON', issueId: 4521, displayTitle: 'Saga #1', siteUrl: 'https://metron.cloud/issue/4521/' })) });
        render(<Harness />);
        await chooseProvider('Metron');
        await enterId('https://metron.cloud/issue/4521/');
        expect(await screen.findByText('Saga #1')).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith(matchUrl('METRON', 4521, 'item_1'));
        expect(screen.getByLabelText('Metron issue ID')).toBeInTheDocument();
    });

    it.each(['4050-1', '0', 'abc'])('3. rejects ComicVine id %j without a lookup', async value => {
        const fetchMock = setup();
        render(<Harness />);
        await enterId(value);
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(lookupCalls(fetchMock)).toHaveLength(0);
    });

    it('3. rejects a slugged Metron link without a lookup', async () => {
        const fetchMock = setup();
        render(<Harness />);
        await chooseProvider('Metron');
        await enterId('https://metron.cloud/issue/saga-1/');
        expect(screen.getByRole('alert').textContent).toMatch(/name slug/);
        expect(lookupCalls(fetchMock)).toHaveLength(0);
    });

    it('4. offers a one-click provider switch for a cross-provider paste', async () => {
        const fetchMock = setup({ match: () => ok(lookupBody({}, { provider: 'METRON', issueId: 4521, displayTitle: 'Saga #1' })) });
        render(<Harness />);
        await enterId('https://metron.cloud/issue/4521/');
        expect(screen.getByRole('alert').textContent).toMatch(/Metron link/);
        expect(lookupCalls(fetchMock)).toHaveLength(0);
        fireEvent.click(screen.getByRole('button', { name: 'Switch to Metron' }));
        expect(await screen.findByText('Saga #1')).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith(matchUrl('METRON', 4521, 'item_1'));
        expect(screen.getByRole('combobox')).toHaveTextContent('Metron');
    });

    it('5. shows a lookup failure and keeps Save disabled', async () => {
        setup({ match: () => err(404, { error: 'No ComicVine issue has ID 1.', code: 'ISSUE_NOT_FOUND' }) });
        render(<Harness />);
        await enterId('1');
        expect((await screen.findByRole('alert')).textContent).toBe('No ComicVine issue has ID 1.');
        expect(saveButton()).toBeDisabled();
    });

    it('6. searches a series, auto-selects the one matching issue, and saves it', async () => {
        const fetchMock = setup({
            search: () => ok({ results: [seriesResult], hasMore: false }),
            issues: () => ok({ results: [issue('142', 20289), issue('141', 20288), issue('140', 20287)] }),
        });
        render(<Harness />);
        expect(screen.getByLabelText('Series')).toHaveValue('Uncanny X-Men (1963)');
        expect(screen.getByLabelText('Issue #')).toHaveValue('141');
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Choose series Uncanny X-Men (1963)' }));
        expect(fetchMock).toHaveBeenCalledWith('/api/search?q=Uncanny+X-Men+%281963%29&provider=COMICVINE&page=1');
        expect(fetchMock).toHaveBeenCalledWith('/api/series-issues?volumeId=2133&provider=COMICVINE');
        await waitFor(() => expect(screen.getByRole('button', { name: 'Choose issue #141' })).toHaveAttribute('aria-pressed', 'true'));
        // The preview (not just the issue row, whose name is also "Uncanny X-Men #141").
        expect(await screen.findByText(/Not in the library/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /View on ComicVine/ })).toHaveAttribute('href', 'https://comicvine.gamespot.com/uncanny-x-men-141/4000-20288/');
        expect(fetchMock).toHaveBeenCalledWith(matchUrl('COMICVINE', 20288, 'item_1'));
        fireEvent.click(saveButton());
        await waitFor(() => expect(onMatched).toHaveBeenCalled());
        expect(patchBodies(fetchMock)[0]).toMatchObject({ provider: 'COMICVINE', providerIssueId: 20288 });
    });

    it('7. loads more series and drops duplicates', async () => {
        setup({
            search: url => (url.includes('page=1')
                ? ok({ results: [seriesResult, { ...seriesResult, id: 1, name: 'X-Men' }], hasMore: true })
                : ok({ results: [{ ...seriesResult, id: 1, name: 'X-Men' }, { ...seriesResult, id: 3, name: 'X-Factor' }], hasMore: false })),
        });
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
        await screen.findByRole('button', { name: 'Choose series X-Factor (1963)' });
        expect(screen.getAllByRole('button', { name: /^Choose series/ })).toHaveLength(3);
        expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    });

    it('8. explains an empty series search', async () => {
        setup();
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        expect(await screen.findByText(/No series found on ComicVine/)).toBeInTheDocument();
    });

    it('9. falls back to every issue when the number is missing from the series', async () => {
        setup({ search: () => ok({ results: [seriesResult] }), issues: () => ok({ results: [issue('142', 2), issue('140', 1)] }) });
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        fireEvent.click(await screen.findByRole('button', { name: /Choose series/ }));
        expect(await screen.findByText('No #141 in this series — pick another issue or series.')).toBeInTheDocument();
        const rows = screen.getAllByRole('button', { name: /Choose issue/ });
        expect(rows.map(r => r.getAttribute('aria-label'))).toEqual(['Choose issue #140', 'Choose issue #142']);
    });

    it('9. narrows to the exact number with a Show all toggle', async () => {
        setup({ search: () => ok({ results: [seriesResult] }), issues: () => ok({ results: [issue('141', 20288), issue('140', 1), issue('142', 2)] }) });
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        fireEvent.click(await screen.findByRole('button', { name: /Choose series/ }));
        await screen.findByRole('button', { name: 'Choose issue #141' });
        expect(screen.getAllByRole('button', { name: /Choose issue/ })).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: 'Show all 3 issues' }));
        expect(screen.getAllByRole('button', { name: /Choose issue/ })).toHaveLength(3);
        fireEvent.click(screen.getByRole('button', { name: 'Show only #141' }));
        expect(screen.getAllByRole('button', { name: /Choose issue/ })).toHaveLength(1);
    });

    it('10. uses neutral copy for an empty issue list, and Retry refetches', async () => {
        const fetchMock = setup({ search: () => ok({ results: [seriesResult] }) });
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        fireEvent.click(await screen.findByRole('button', { name: /Choose series/ }));
        expect(await screen.findByText(/No issues came back from ComicVine. It may be busy or rate-limiting/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/series-issues?'))).toHaveLength(2));
    });

    it('10. goes back to the series list', async () => {
        setup({ search: () => ok({ results: [seriesResult] }), issues: () => new Promise(() => {}) });
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        fireEvent.click(await screen.findByRole('button', { name: /Choose series/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'All series' }));
        expect(screen.getByRole('button', { name: /Choose series/ })).toBeInTheDocument();
        expect(screen.queryByText(/Loading issues/)).toBeNull();
    });

    it('11. shows the slow-provider notice while a request hangs', async () => {
        setup({ search: () => new Promise(() => {}) });
        render(<Harness slowNoticeMs={1} />);
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        expect(await screen.findByText(/taking a while/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    });

    it('12. a provider change clears the selection and preview but keeps the inputs', async () => {
        setup();
        render(<Harness />);
        await enterId('20288');
        expect(await screen.findByText('Uncanny X-Men #141')).toBeInTheDocument();
        await chooseProvider('Metron');
        expect(screen.queryByText('Uncanny X-Men #141')).toBeNull();
        expect(saveButton()).toBeDisabled();
        expect(screen.getByLabelText('Metron issue ID')).toHaveValue('20288');
        openTab(/Search/);
        expect(screen.getByLabelText('Series')).toHaveValue('Uncanny X-Men (1963)');
    });

    it('13. disables an unconfigured provider', async () => {
        setup({ providers: () => ok({ providers: { COMICVINE: true, METRON: false }, primary: 'COMICVINE' }) });
        render(<Harness />);
        await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('ComicVine'));
        fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
        const metron = await screen.findByRole('option', { name: /Metron/ });
        expect(metron).toHaveAttribute('aria-disabled', 'true');
        expect(metron).toHaveTextContent('(not configured)');
    });

    it('13. switches to the configured provider when the default is not', async () => {
        const fetchMock = setup({ providers: () => ok({ providers: { COMICVINE: false, METRON: true }, primary: 'COMICVINE' }) });
        render(<Harness />);
        await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('Metron'));
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/search?q=Uncanny+X-Men+%281963%29&provider=METRON&page=1'));
    });

    it('13. explains when no provider is configured and disables search', async () => {
        setup({ providers: () => ok({ providers: { COMICVINE: false, METRON: false }, primary: 'COMICVINE' }) });
        render(<Harness />);
        expect(await screen.findByText(/No metadata provider is configured on this server/)).toHaveAttribute('role', 'status');
        expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    });

    it('13. assumes both providers work when the providers call fails', async () => {
        setup({ providers: () => err(500, {}) });
        render(<Harness />);
        fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
        expect(await screen.findByRole('option', { name: 'Metron' })).not.toHaveAttribute('aria-disabled', 'true');
    });

    it('14. warns about a number mismatch and a duplicate entry', async () => {
        const other = { ...baseItem, id: 'item_2', title: 'Uncanny X-Men #142', cvIssueId: 20289 };
        setup({ match: () => ok(lookupBody({}, { issueId: 20289, issueNumber: '142', displayTitle: 'Uncanny X-Men #142' })) });
        render(<Harness listItems={[baseItem, other]} />);
        await enterId('20289');
        expect(await screen.findByText(/This entry says #141; the selected issue is #142\./)).toBeInTheDocument();
        expect(screen.getByText(/Already in this list at position 2\./)).toBeInTheDocument();
        expect(saveButton()).toBeEnabled();
    });

    it('14. warns when an annual entry is pointed at a main-run issue', async () => {
        const annual = linkedItem({ isAnnual: true, number: '1', metadataId: '7777' });
        setup({ match: () => ok(lookupBody({}, { seriesName: 'X-Men', issueNumber: '1', displayTitle: 'X-Men #1' })) });
        render(<Harness item={annual} />);
        expect(screen.getByLabelText('Series')).toHaveValue('X-Men Annual');
        await enterId('20288');
        expect(await screen.findByText(/This entry is an annual; the selected issue is from “X-Men”\./)).toBeInTheDocument();
    });

    it('15. explains a wanted local copy', async () => {
        setup({ match: () => ok(lookupBody({ local: { issueId: 'iss_1', seriesId: 's', seriesName: 'Uncanny X-Men', number: '141', hasFile: false } })) });
        render(<Harness />);
        await enterId('20288');
        expect(await screen.findByText(/In the library as a wanted issue \(not downloaded yet\)/)).toBeInTheDocument();
    });

    it('15. confirms an owned local copy', async () => {
        setup({ match: () => ok(lookupBody({ local: { issueId: 'iss_1', seriesId: 's', seriesName: 'Uncanny X-Men', number: '141', hasFile: true } })) });
        render(<Harness />);
        await enterId('20288');
        expect(await screen.findByText('In the library — this entry will link to Uncanny X-Men #141.')).toBeInTheDocument();
    });

    it('15. warns that saving unlinks a contradicted copy', async () => {
        // keepable: true so the client's own `libraryCannotContradict` check is what hides the
        // switch — the server said keep, the library contradicts, so the save will unlink.
        setup({ match: () => ok(lookupBody({ keepable: true })) });
        render(<Harness item={linkedItem()} />);
        await enterId('20288');
        expect(await screen.findByText(/Saving unlinks this entry from “X-Men #1”\. Your library has that copy matched to a different ComicVine issue\./)).toBeInTheDocument();
        expect(screen.queryByRole('switch')).toBeNull();
    });

    it('15. explains a mislabeled copy and the owner scope', async () => {
        setup({ match: () => ok(lookupBody({ mislabeled: { seriesName: 'X-Men', number: '142' }, accessScope: 'owner' })) });
        render(<Harness />);
        await enterId('20288');
        expect(await screen.findByText(/Your library has “X-Men #142” tagged with this ID/)).toBeInTheDocument();
        expect(screen.getByText("Checked against the list owner's libraries.")).toBeInTheDocument();
    });

    it('16. keeps the preview on a save error and reports a stale list', async () => {
        const onStale = vi.fn();
        setup({ items: () => err(403, { error: 'Forbidden', code: 'FORBIDDEN' }) });
        render(<Harness onStale={onStale} />);
        await enterId('20288');
        await screen.findByText('Uncanny X-Men #141');
        fireEvent.click(saveButton());
        expect((await screen.findByRole('alert')).textContent).toBe('Forbidden');
        expect(screen.getByText('Uncanny X-Men #141')).toBeInTheDocument();
        expect(onStale).toHaveBeenCalledOnce();
        expect(onMatched).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('16. does not call onStale for provider errors', async () => {
        const onStale = vi.fn();
        setup({ items: () => err(429, { error: 'ComicVine is rate-limiting requests — try again in a few minutes.', code: 'RATE_LIMITED' }) });
        render(<Harness onStale={onStale} />);
        await enterId('20288');
        await screen.findByText('Uncanny X-Men #141');
        fireEvent.click(saveButton());
        expect((await screen.findByRole('alert')).textContent).toMatch(/rate-limiting/);
        expect(onStale).not.toHaveBeenCalled();
    });

    it('17. drops a lookup that resolves after close and reopen', async () => {
        let resolve!: (v: unknown) => void;
        setup({ match: () => new Promise(r => { resolve = r; }) });
        render(<Harness />);
        await enterId('20288');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Open fix match' }));
        resolve(await ok(lookupBody()));
        openTab(/Enter ID/);
        await waitFor(() => expect(screen.getByLabelText(/issue ID/)).toHaveValue(''));
        expect(screen.queryByText('Uncanny X-Men #141')).toBeNull();
        expect(saveButton()).toBeDisabled();
    });

    it('18. offers to keep a link the library cannot contradict', async () => {
        const item = linkedItem({ metadataSource: 'LOCAL', metadataId: 'unmatched_1', number: '141', series: { name: 'Uncanny X-Men', year: 1963 } });
        const fetchMock = setup({ match: () => ok(lookupBody({ keepable: true })) });
        render(<Harness item={item} />);
        await enterId('20288');
        const keep = await screen.findByRole('switch');
        expect(keep).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByText(/Keep linking this entry to your library file “Uncanny X-Men #141”/)).toBeInTheDocument();
        expect(screen.getByText(/This file is still unmatched in your library/)).toBeInTheDocument();
        expect(screen.getByText('This entry stays linked to “Uncanny X-Men #141”.')).toBeInTheDocument();
        fireEvent.click(saveButton());
        await waitFor(() => expect(patchBodies(fetchMock)).toHaveLength(1));
        expect(patchBodies(fetchMock)[0]).toEqual({
            listId: 'list_1', itemId: 'item_1', action: 'rematch', provider: 'COMICVINE', providerIssueId: 20288, keepLocalLink: true,
        });
    });

    it('18. defaults the keep switch off when the numbers disagree, and sends false', async () => {
        const item = linkedItem({ metadataSource: 'METRON', metadataId: '77', number: '9' });
        const fetchMock = setup({ match: () => ok(lookupBody({ keepable: true })) });
        render(<Harness item={item} />);
        await enterId('20288');
        expect(await screen.findByRole('switch')).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByText(/Saving unlinks this entry from “X-Men #9”\.$/)).toBeInTheDocument();
        fireEvent.click(saveButton());
        await waitFor(() => expect(patchBodies(fetchMock)).toHaveLength(1));
        expect(patchBodies(fetchMock)[0].keepLocalLink).toBe(false);
    });

    // Regression: an ADMIN editing a restricted owner's entry. The owner's libraries decide the link,
    // so the server reports keepable:false and the save drops it — the preview must say so too,
    // instead of promising "stays linked" and then unlinking.
    it('18. believes the server, not the local heuristic, when the link cannot be kept', async () => {
        const item = linkedItem({ metadataSource: 'LOCAL', metadataId: 'unmatched_1', number: '141', series: { name: 'Uncanny X-Men', year: 1963 } });
        const fetchMock = setup({ match: () => ok(lookupBody({ keepable: false, accessScope: 'owner' })) });
        render(<Harness item={item} />);
        await enterId('20288');
        expect(await screen.findByText("Checked against the list owner's libraries.")).toBeInTheDocument();
        expect(screen.queryByRole('switch')).toBeNull();
        expect(screen.queryByText(/This entry stays linked/)).toBeNull();
        expect(screen.getByText(/Saving unlinks this entry from “Uncanny X-Men #141”\.$/)).toBeInTheDocument();
        fireEvent.click(saveButton());
        await waitFor(() => expect(patchBodies(fetchMock)).toHaveLength(1));
        // Not even `keepLocalLink: false` — there is nothing to keep.
        expect(patchBodies(fetchMock)[0]).not.toHaveProperty('keepLocalLink');
    });

    it('19. moves focus to Keep when the clear confirmation opens', async () => {
        const item = linkedItem({}, { cvIssueId: 900 });
        setup();
        render(<Harness item={item} />);
        fireEvent.click(screen.getByRole('button', { name: 'Clear match' }));
        const keep = await screen.findByRole('button', { name: 'Keep' });
        await waitFor(() => expect(keep).toHaveFocus());
        expect(screen.getByRole('button', { name: 'Unlink' })).not.toHaveFocus();
    });

    it('19. confirms before clearing a linked entry', async () => {
        const item = linkedItem({}, { cvIssueId: 900 });
        const updated = { ...item, cvIssueId: null, issueId: null, issue: null };
        const fetchMock = setup({ items: () => ok({ success: true, item: updated }) });
        render(<Harness item={item} />);
        fireEvent.click(screen.getByRole('button', { name: 'Clear match' }));
        expect(screen.getByText(/Unlink this entry from “X-Men #1”\? It can only be relinked here/)).toBeInTheDocument();
        expect(patchBodies(fetchMock)).toHaveLength(0);
        fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
        expect(screen.queryByText(/Unlink this entry/)).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Clear match' }));
        fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
        await waitFor(() => expect(onMatched).toHaveBeenCalledWith(updated, { linked: false, cleared: true }));
        expect(patchBodies(fetchMock)).toEqual([{ listId: 'list_1', itemId: 'item_1', action: 'clear' }]);
        expect(toast).toHaveBeenCalledWith({ title: 'Match cleared', description: 'Was linked to “X-Men #1” (ComicVine #900).' });
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('19. clears an id-only entry immediately', async () => {
        const item = { ...baseItem, title: 'Part One', cvIssueId: 900 };
        const fetchMock = setup();
        render(<Harness item={item} />);
        fireEvent.click(screen.getByRole('button', { name: 'Clear match' }));
        await waitFor(() => expect(patchBodies(fetchMock)).toEqual([{ listId: 'list_1', itemId: 'item_1', action: 'clear' }]));
        expect(toast).toHaveBeenCalledWith({ title: 'Match cleared', description: 'Was ComicVine #900.' });
    });

    it('19. hides Clear match when there is nothing to clear', () => {
        setup();
        render(<Harness />);
        expect(screen.queryByRole('button', { name: 'Clear match' })).toBeNull();
    });

    it('20. resolves the current match on open and prefills the search from it', async () => {
        const item = { ...baseItem, title: 'Part One', cvIssueId: 900 };
        const fetchMock = setup({
            match: () => ok(lookupBody({}, { issueId: 900, seriesName: 'X-Men', issueNumber: '154', displayTitle: 'X-Men #154', coverDate: '1982-02-01' })),
        });
        render(<Harness item={item} />);
        await waitFor(() => expect(screen.getByLabelText('Series')).toHaveValue('X-Men'));
        expect(screen.getByLabelText('Issue #')).toHaveValue('154');
        expect(fetchMock).toHaveBeenCalledWith(matchUrl('COMICVINE', 900));
        expect(screen.getByText(/— X-Men #154 \(1982-02\)/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'ComicVine #900' })).toHaveAttribute('href', 'https://comicvine.gamespot.com/issue/4000-900/');
    });

    it('20. does not overwrite what the user typed with the current match', async () => {
        let resolve!: (v: unknown) => void;
        const item = { ...baseItem, title: 'Part One', cvIssueId: 900 };
        setup({ match: () => new Promise(r => { resolve = r; }) });
        render(<Harness item={item} />);
        fireEvent.change(screen.getByLabelText('Series'), { target: { value: 'Excalibur' } });
        resolve(await ok(lookupBody({}, { issueId: 900, seriesName: 'X-Men', issueNumber: '154' })));
        await screen.findByText(/— Uncanny X-Men #141/);
        expect(screen.getByLabelText('Series')).toHaveValue('Excalibur');
    });

    it('describes the current link and shows the re-sync warning', () => {
        setup();
        render(<Harness item={linkedItem({ filePath: null })} resyncWarning="Re-syncing this list from AniList/MyAnimeList rebuilds it and discards manual match fixes." />);
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByText(/not downloaded/)).toBeInTheDocument();
        expect(within(dialog).getByText('X-Men #1')).toBeInTheDocument();
        expect(within(dialog).getByText(/discards manual match fixes/)).toBeInTheDocument();
    });

    it('defaults to the provider the entry is already matched to', async () => {
        setup();
        render(<Harness item={{ ...baseItem, cvIssueId: 4521, metadataSource: 'METRON' }} />);
        await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('Metron'));
    });
});
