// @vitest-environment jsdom
// The "Viewing as … · Stop impersonating" bar (found in the v1.4.7 permission sweep: nothing read
// session.user.isImpersonating, so once an admin started impersonating there was no visible sign of
// it and no way back short of the cookie's hour running out).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ok, err, stubFetchRouter } from '../helpers/fetch';
import { nav } from '@/lib/session-expiry-client';

const toast = vi.fn();
const state = vi.hoisted(() => ({ session: null as any, update: null as any }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: state.session, update: state.update, status: state.session ? 'authenticated' : 'unauthenticated' }) }));

import { ImpersonationBanner } from '@/components/impersonation-banner';

describe('ImpersonationBanner', () => {
    let go: ReturnType<typeof vi.spyOn>;
    let fetchMock: ReturnType<typeof stubFetchRouter>;
    let stopAnswer: () => any;

    beforeEach(() => {
        toast.mockClear();
        state.update = vi.fn(async () => ({ user: { name: 'adam', role: 'ADMIN' } }));
        state.session = { user: { id: 'user_2', name: 'reader', role: 'USER', isImpersonating: true } };
        go = vi.spyOn(nav, 'go').mockImplementation(() => {});
        stopAnswer = () => ok({ success: true });
        fetchMock = stubFetchRouter([['/api/impersonation/stop', () => stopAnswer()]]);
    });

    it('renders nothing for a session that is not impersonating', () => {
        state.session = { user: { id: 'admin_1', name: 'adam', role: 'ADMIN' } };
        const { container } = render(<ImpersonationBanner />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when signed out', () => {
        state.session = null;
        const { container } = render(<ImpersonationBanner />);
        expect(container).toBeEmptyDOMElement();
    });

    it('says whose view this is and offers the way back', () => {
        render(<ImpersonationBanner />);
        expect(screen.getByRole('status')).toHaveTextContent('Viewing Omnibus as reader');
        screen.getByRole('button', { name: 'Stop impersonating' });
    });

    it('Stop: ends it on the server, refreshes the session, then lands on Users', async () => {
        render(<ImpersonationBanner />);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop impersonating' })); });

        expect(fetchMock).toHaveBeenCalledWith('/api/impersonation/stop', expect.objectContaining({ method: 'POST' }));
        expect(state.update).toHaveBeenCalled();
        expect(go).toHaveBeenCalledWith('/admin/users');
        // The session refresh (where the jwt callback reverts to the admin) lands before the navigation.
        expect(state.update.mock.invocationCallOrder[0]).toBeLessThan(go.mock.invocationCallOrder[0]);
    });

    it('Stop: a 409 (the impersonation already ended) still refreshes and goes back', async () => {
        stopAnswer = () => err(409, { error: 'Not impersonating anyone.' });
        render(<ImpersonationBanner />);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop impersonating' })); });

        expect(state.update).toHaveBeenCalled();
        expect(go).toHaveBeenCalledWith('/admin/users');
        expect(toast).not.toHaveBeenCalled();
    });

    it('Stop: any other failure is shown, and nothing navigates', async () => {
        stopAnswer = () => err(500, { error: 'Something broke' });
        render(<ImpersonationBanner />);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop impersonating' })); });

        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive', description: 'Something broke' }));
        expect(state.update).not.toHaveBeenCalled();
        expect(go).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Stop impersonating' })).toBeEnabled();
    });
});
