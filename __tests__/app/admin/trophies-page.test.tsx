// @vitest-environment jsdom
// Admin → Trophies (found in the v1.4.7 permission sweep). Since the src/ move the page asked
// /api/admin/trophies, a route that never existed — every load 404'd into an empty list and every
// save/delete did nothing, without a word. The handlers live at /api/trophies (admin-only).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ok, err, stubFetchRouter } from '../../helpers/fetch';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

import AdminTrophies from '@/app/admin/trophies/page';

const BRONZE = { id: 't1', name: 'Bronze Reader', description: 'Read 10 comics.', actionType: 'READ_COUNT', targetValue: 10, iconUrl: null };

const calls = (fetchMock: ReturnType<typeof stubFetchRouter>) =>
    fetchMock.mock.calls.map(([url, init]) => `${(init as any)?.method || 'GET'} ${String(url)}`);

describe('Admin Trophies page', () => {
    let fetchMock: ReturnType<typeof stubFetchRouter>;
    let saveResponse: () => any;
    let deleteResponse: () => any;
    let listResponse: () => any;

    beforeEach(() => {
        toast.mockClear();
        listResponse = () => ok([BRONZE]);
        saveResponse = () => ok({ id: 't2' });
        deleteResponse = () => ok({ success: true });
        fetchMock = stubFetchRouter([
            ['/api/trophies', (_u, init) => {
                const method = init?.method || 'GET';
                if (method === 'POST') return saveResponse();
                if (method === 'DELETE') return deleteResponse();
                return listResponse();
            }],
        ]);
    });

    it('lists trophies from /api/trophies', async () => {
        await act(async () => { render(<AdminTrophies />); });

        expect(calls(fetchMock)).toEqual(['GET /api/trophies']);
        screen.getByText('Bronze Reader');
    });

    it('survives an error body instead of crashing on .map, and says so', async () => {
        listResponse = () => err(500, { error: 'Failed to fetch trophies.' });
        await act(async () => { render(<AdminTrophies />); });

        screen.getByText(/trophy management/i);
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    });

    const openNewTrophy = async () => {
        await act(async () => { render(<AdminTrophies />); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /create trophy/i })); });
        fireEvent.change(screen.getByLabelText('Trophy Name'), { target: { value: 'Silver Reader' } });
        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Read 50 comics.' } });
    };

    it('saves a new trophy to /api/trophies and reloads the list', async () => {
        await openNewTrophy();
        fireEvent.change(screen.getByLabelText('Target Milestone'), { target: { value: '50' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save trophy/i })); });

        expect(calls(fetchMock)).toEqual(['GET /api/trophies', 'POST /api/trophies', 'GET /api/trophies']);
        const body = JSON.parse((fetchMock.mock.calls[1][1] as any).body);
        expect(body).toEqual(expect.objectContaining({ name: 'Silver Reader', targetValue: '50', actionType: 'READ_COUNT' }));
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Trophy Saved' }));
    });

    it('does not send a trophy without a whole-number target', async () => {
        await openNewTrophy();
        fireEvent.change(screen.getByLabelText('Target Milestone'), { target: { value: '' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save trophy/i })); });

        expect(calls(fetchMock)).toEqual(['GET /api/trophies']);
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    });

    it('shows the server refusal when a save fails, and keeps the form open', async () => {
        saveResponse = () => err(400, { error: 'Icon must be a PNG, JPEG, WebP or GIF image.' });
        await openNewTrophy();
        fireEvent.change(screen.getByLabelText('Target Milestone'), { target: { value: '50' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save trophy/i })); });

        expect(toast).toHaveBeenCalledWith(expect.objectContaining({
            variant: 'destructive', description: 'Icon must be a PNG, JPEG, WebP or GIF image.',
        }));
        screen.getByLabelText('Trophy Name');
    });

    it('deletes through /api/trophies?id=…', async () => {
        await act(async () => { render(<AdminTrophies />); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete trophy Bronze Reader' })); });

        expect(calls(fetchMock)).toEqual(['GET /api/trophies', 'DELETE /api/trophies?id=t1', 'GET /api/trophies']);
    });

    it('says so when a delete fails', async () => {
        deleteResponse = () => err(500, { error: 'Failed to delete trophy.' });
        await act(async () => { render(<AdminTrophies />); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete trophy Bronze Reader' })); });

        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive', description: 'Failed to delete trophy.' }));
    });
});
