// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { err, ok, stubFetchRouter } from '../helpers/fetch';
import { AddByIdDialog } from '@/components/add-by-id-dialog';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const details = { id: 12345, name: 'Collected Edition', year: '2024', publisher: 'DC', count: 1, image: 'https://example.test/cover.jpg' };
let onAdded = vi.fn<() => void>();

const openDialog = () => {
    render(<AddByIdDialog onAdded={onAdded} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add by ID' }));
};
const lookup = async (id = '12345') => {
    fireEvent.change(screen.getByLabelText(/Volume ID|Series ID/), { target: { value: id } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up ID' }));
    await screen.findByText(details.name);
};

describe('AddByIdDialog', () => {
    beforeEach(() => {
        onAdded = vi.fn();
        window.HTMLElement.prototype.scrollIntoView = vi.fn();
        window.HTMLElement.prototype.hasPointerCapture = vi.fn();
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('looks up a ComicVine volume ID and adds it without requesting existing issues', async () => {
        const fetchMock = stubFetchRouter([
            ['/api/issue-details', () => ok(details)],
            ['/api/request', () => ok({ success: true })],
        ]);
        openDialog();
        expect((screen.getByRole('button', { name: 'Add to Library' }) as HTMLButtonElement).disabled).toBe(true);
        await lookup(' 4050-12345 ');
        expect(fetchMock).toHaveBeenCalledWith('/api/issue-details?id=12345&type=volume&provider=COMICVINE');
        fireEvent.click(screen.getByRole('button', { name: 'Add to Library' }));
        await waitFor(() => expect(onAdded).toHaveBeenCalledOnce());
        const body = JSON.parse(fetchMock.mock.calls.find(([url]) => url === '/api/request')![1].body);
        expect(body).toMatchObject({ cvId: 12345, metadataSource: 'COMICVINE', type: 'volume', name: details.name, monitored: true, monitorOnly: true });
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('uses Metron IDs and can request existing issues', async () => {
        const fetchMock = stubFetchRouter([
            ['/api/issue-details', () => ok(details)],
            ['/api/request', () => ok({ success: true, message: 'Queued 1 issue.' })],
        ]);
        openDialog();
        fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
        fireEvent.click(await screen.findByRole('option', { name: 'Metron' }));
        await lookup();
        expect(fetchMock).toHaveBeenCalledWith('/api/issue-details?id=12345&type=volume&provider=METRON');
        fireEvent.click(screen.getByRole('switch', { name: 'Also request existing issues' }));
        fireEvent.click(screen.getByRole('button', { name: 'Add to Library' }));
        await waitFor(() => expect(onAdded).toHaveBeenCalledOnce());
        const body = JSON.parse(fetchMock.mock.calls.find(([url]) => url === '/api/request')![1].body);
        expect(body).toMatchObject({ cvId: 12345, metadataSource: 'METRON', monitorOnly: false });
        expect(toast).toHaveBeenCalledWith({ title: 'Added to Library', description: 'Queued 1 issue.' });
    });

    it.each(['0', '-123', '4000-12345', 'not-an-id', '1.5', '9007199254740992'])('rejects invalid volume ID %s before fetching', id => {
        const fetchMock = stubFetchRouter([]);
        openDialog();
        fireEvent.change(screen.getByLabelText('Volume ID'), { target: { value: id } });
        fireEvent.click(screen.getByRole('button', { name: 'Look up ID' }));
        expect(screen.getByRole('alert').textContent).toContain('positive numeric series ID');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('shows lookup failures and does not enable adding', async () => {
        stubFetchRouter([['/api/issue-details', () => err(404, { error: 'Not Found' })]]);
        openDialog();
        fireEvent.change(screen.getByLabelText('Volume ID'), { target: { value: '12345' } });
        fireEvent.click(screen.getByRole('button', { name: 'Look up ID' }));
        expect((await screen.findByRole('alert')).textContent).toBe('Not Found');
        expect((screen.getByRole('button', { name: 'Add to Library' }) as HTMLButtonElement).disabled).toBe(true);
        expect(onAdded).not.toHaveBeenCalled();
    });

    it('clears the preview when the ID changes so an old result cannot be added', async () => {
        stubFetchRouter([['/api/issue-details', () => ok(details)]]);
        openDialog();
        await lookup();
        fireEvent.change(screen.getByLabelText('Volume ID'), { target: { value: '54321' } });
        expect(screen.queryByText(details.name)).toBeNull();
        expect((screen.getByRole('button', { name: 'Add to Library' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('keeps the preview on permission failure so the user can retry', async () => {
        stubFetchRouter([
            ['/api/issue-details', () => ok(details)],
            ['/api/request', () => err(403, { error: 'Requests disabled' })],
        ]);
        openDialog();
        await lookup();
        fireEvent.click(screen.getByRole('button', { name: 'Add to Library' }));
        expect((await screen.findByRole('alert')).textContent).toBe('Requests disabled');
        expect(screen.getByText(details.name)).toBeTruthy();
        expect(onAdded).not.toHaveBeenCalled();
    });

    it('ignores a lookup response that arrives after closing and reopening', async () => {
        let resolve!: (value: unknown) => void;
        stubFetchRouter([['/api/issue-details', () => new Promise(r => { resolve = r; })]]);
        openDialog();
        fireEvent.change(screen.getByLabelText('Volume ID'), { target: { value: '12345' } });
        fireEvent.click(screen.getByRole('button', { name: 'Look up ID' }));
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        fireEvent.click(screen.getByRole('button', { name: 'Add by ID' }));
        resolve(await ok(details));
        await waitFor(() => expect((screen.getByLabelText('Volume ID') as HTMLInputElement).value).toBe(''));
        expect(screen.queryByText(details.name)).toBeNull();
    });
});
