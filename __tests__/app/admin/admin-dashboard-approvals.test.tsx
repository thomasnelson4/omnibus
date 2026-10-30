// @vitest-environment jsdom
// Admin dashboard → Requests Awaiting Approval (found in the v1.4.7 permission sweep). Bulk
// approve/deny awaited the PATCHes and announced "Successfully processed N requests" whatever the
// server said, and the single Approve/Deny buttons said nothing at all on a refusal. A failure now
// says how many and why, and the failed requests stay selected so the admin can try them again.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ok, err, stubFetchRouter } from '../../helpers/fetch';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { id: 'admin_1', role: 'ADMIN' } }, status: 'authenticated' }),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/admin',
}));

import AdminPage from '@/app/admin/page';

const approval = (id: string, name: string) => ({
    id, status: 'PENDING_APPROVAL', seriesName: name, activeDownloadName: name, userName: 'reader',
    createdAt: '2026-10-12T12:00:00.000Z', imageUrl: null, progress: 0,
});

const stalled = (id: string, name: string) => ({ ...approval(id, name), status: 'STALLED' });

describe('Admin dashboard: request approvals report what the server did', () => {
    let fetchMock: ReturnType<typeof stubFetchRouter>;
    let rows: any[];
    let patchAnswer: (id: string, status: string) => any;
    let retryAnswer: (id: string) => any;
    let bulkDeleteAnswer: () => any;

    beforeEach(() => {
        toast.mockClear();
        rows = [approval('r1', 'Batman #1'), approval('r2', 'Batman #2')];
        patchAnswer = () => ok({ success: true });
        retryAnswer = () => ok({ success: true });
        bulkDeleteAnswer = () => ok({ success: true });
        fetchMock = stubFetchRouter([
            ['/api/admin/requests', (_u, init) => init?.method === 'DELETE' ? bulkDeleteAnswer() : ok(rows)],
            ['/api/request/retry', (_u, init) => retryAnswer(JSON.parse(init.body).id)],
            ['/api/admin/stats', () => ok({ success: true, totalRequests: 2, completed30d: 0, failed30d: 0, totalUsers: 2 })],
            ['/api/admin/active-downloads', () => ok({ success: true, activeDownloads: [] })],
            ['/api/admin/health', () => ok({ checks: [] })],
            ['/api/request', (_u, init) => {
                const { id, status } = JSON.parse(init.body);
                return patchAnswer(id, status);
            }],
        ]);
    });

    afterEach(() => vi.useRealTimers());

    const patches = () => fetchMock.mock.calls
        .filter(([u, init]) => String(u) === '/api/request' && (init as any)?.method === 'PATCH')
        .map(([, init]) => JSON.parse((init as any).body));

    const selectAllAnd = async (action: RegExp) => {
        await act(async () => { render(<AdminPage />); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Select All' })); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: action })); });
    };

    it('bulk approve: all accepted → success, selection cleared', async () => {
        await selectAllAnd(/approve \(2\)/i);

        expect(patches()).toEqual([{ id: 'r1', status: 'PENDING' }, { id: 'r2', status: 'PENDING' }]);
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Bulk Approval Complete', description: 'Approved 2 requests.' }));
        expect(screen.queryByRole('button', { name: /approve \(\d\)/i })).toBeNull();
    });

    it('bulk approve: a refused PATCH is reported with its reason and stays selected', async () => {
        patchAnswer = (id) => id === 'r2' ? err(500, { error: 'database is locked' }) : ok({ success: true });
        await selectAllAnd(/approve \(2\)/i);

        expect(toast).toHaveBeenCalledWith(expect.objectContaining({
            variant: 'destructive', title: '1 of 2 approvals failed', description: 'database is locked',
        }));
        expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Bulk Approval Complete' }));
        // Only the failed one is still selected, ready for a retry.
        screen.getByRole('button', { name: /approve \(1\)/i });
    });

    it('bulk deny: every PATCH refused → nothing claimed as done', async () => {
        patchAnswer = () => err(403, { error: 'Forbidden' });
        await selectAllAnd(/deny \(2\)/i);

        expect(patches()).toEqual([{ id: 'r1', status: 'CANCELLED' }, { id: 'r2', status: 'CANCELLED' }]);
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({
            variant: 'destructive', title: '2 of 2 denials failed', description: 'Forbidden',
        }));
        screen.getByRole('button', { name: /deny \(2\)/i });
    });

    it('single Approve: a refusal is shown instead of silence', async () => {
        patchAnswer = () => err(404, { error: 'Request not found' });
        await act(async () => { render(<AdminPage />); });
        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /^approve$/i })[0]); });

        expect(toast).toHaveBeenCalledWith(expect.objectContaining({
            variant: 'destructive', title: 'Approval Failed', description: 'Request not found',
        }));
    });

    const selectQueueAnd = async (action: RegExp) => {
        rows = [stalled('r3', 'Superman #1'), stalled('r4', 'Superman #2')];
        await act(async () => { render(<AdminPage />); });
        await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Select All' })); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: action })); });
    };

    it('bulk retry: a refused retry is reported and stays selected', async () => {
        retryAnswer = (id) => id === 'r4' ? err(500, { error: 'Search failed' }) : ok({ success: true });
        await selectQueueAnd(/retry \(2\)/i);

        expect(toast).toHaveBeenCalledWith(expect.objectContaining({
            variant: 'destructive', title: '1 of 2 retries failed', description: 'Search failed',
        }));
        expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Bulk Retry Complete' }));
        screen.getByRole('button', { name: /retry \(1\)/i });
    });

    it('bulk retry: all accepted → complete, selection cleared', async () => {
        await selectQueueAnd(/retry \(2\)/i);

        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Bulk Retry Complete', description: 'Retried 2 requests.' }));
        expect(screen.queryByRole('button', { name: /retry \(\d\)/i })).toBeNull();
    });

    it('bulk delete from the queue: a refusal is shown instead of silence', async () => {
        bulkDeleteAnswer = () => err(500, { error: 'Failed to delete requests' });
        await selectQueueAnd(/^delete$/i);

        expect(toast).toHaveBeenCalledWith(expect.objectContaining({
            variant: 'destructive', title: 'Delete Failed', description: 'Failed to delete requests',
        }));
    });
});
