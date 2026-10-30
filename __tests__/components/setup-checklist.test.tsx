// @vitest-environment jsdom
// __tests__/components/setup-checklist.test.tsx
//
// The first-run checklist (replaces the static "Welcome to Omnibus!" banner): live steps from
// /api/setup-status, each done or not with the action that does it. On Home it shows until setup is
// complete or dismissed; on an empty Library it explains what to do whatever the banner's state.
// Users who aren't admins get a one-line hint instead of the steps.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SetupChecklist } from '@/components/setup-checklist';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const fetchMock = vi.fn();
global.fetch = fetchMock as unknown as typeof fetch;

type Step = { id: string; required: boolean; done: boolean; detail?: string; count?: number };
const adminStatus = (over: Partial<{ dismissed: boolean; completed: boolean; libraryEmpty: boolean; steps: Step[] }> = {}) => ({
    role: 'ADMIN',
    dismissed: false,
    completed: false,
    libraryEmpty: true,
    steps: [
        { id: 'library', required: true, done: false, detail: 'No library folder is set up yet.' },
        { id: 'metadata', required: true, done: true },
        { id: 'comics', required: true, done: false, count: 0 },
        { id: 'match', required: false, done: true, count: 0 },
        { id: 'discover', required: true, done: false },
        { id: 'sources', required: false, done: false },
    ],
    ...over,
});

const answer = (status: unknown) => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/setup-status') return { ok: true, json: async () => status };
        if (url === '/api/admin/jobs/trigger' && init?.method === 'POST') return { ok: true, json: async () => ({ success: true }) };
        return { ok: true, json: async () => ({}) };
    });
};
const posted = (url: string) => fetchMock.mock.calls
    .filter(([u, init]) => u === url && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init.body)));

beforeEach(() => {
    fetchMock.mockReset();
    toast.mockReset();
});

describe('SetupChecklist (admin)', () => {
    it('lists the steps with what is done, the reason a step is not, and the progress', async () => {
        answer(adminStatus());
        render(<SetupChecklist variant="home" />);

        expect(await screen.findByText(/Set up Omnibus/i)).toBeInTheDocument();
        expect(screen.getByText('1 of 4 required steps done')).toBeInTheDocument();
        expect(screen.getByText('No library folder is set up yet.')).toBeInTheDocument();
        const step = (id: string) => document.querySelector(`[data-step="${id}"]`);
        expect(step('library')).toHaveAttribute('data-done', 'false');
        expect(step('metadata')).toHaveAttribute('data-done', 'true');
        // Nothing to match: the Smart Matcher step stays out of the way.
        expect(step('match')).toBeNull();
        expect(screen.getByRole('link', { name: /Library & Files/i })).toHaveAttribute('href', '/admin/settings?tab=library');
    });

    it('shows the Smart Matcher step when series are waiting there', async () => {
        const status = adminStatus();
        status.steps[3] = { id: 'match', required: false, done: false, count: 3 };
        answer(status);
        render(<SetupChecklist variant="home" />);

        expect(await screen.findByText(/Match 3 unidentified series/i)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Smart Matcher/i })).toHaveAttribute('href', '/admin/smart-match');
    });

    it('queues a library scan and a Discover sync from their steps', async () => {
        answer(adminStatus());
        render(<SetupChecklist variant="home" />);

        fireEvent.click(await screen.findByRole('button', { name: /Scan library/i }));
        await waitFor(() => expect(posted('/api/admin/jobs/trigger')).toContainEqual({ job: 'library' }));

        fireEvent.click(screen.getByRole('button', { name: /Run Discover sync/i }));
        await waitFor(() => expect(posted('/api/admin/jobs/trigger')).toContainEqual({ job: 'popular' }));
        expect(toast).toHaveBeenCalledTimes(2);
    });

    it('can be dismissed, and remembers it', async () => {
        answer(adminStatus());
        render(<SetupChecklist variant="home" />);

        fireEvent.click(await screen.findByRole('button', { name: /Dismiss/i }));

        await waitFor(() => expect(screen.queryByText(/Set up Omnibus/i)).not.toBeInTheDocument());
        expect(posted('/api/admin/config')).toEqual([{ settings: { hide_first_steps_banner: 'true' } }]);
    });

    it('shows nothing on Home once setup is complete or the checklist was dismissed', async () => {
        answer(adminStatus({ completed: true }));
        const { container, unmount } = render(<SetupChecklist variant="home" />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
        unmount();

        answer(adminStatus({ dismissed: true }));
        const second = render(<SetupChecklist variant="home" />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(second.container).toBeEmptyDOMElement();
    });

    it('explains an empty Library even after the Home checklist was dismissed', async () => {
        answer(adminStatus({ dismissed: true, completed: true }));
        render(<SetupChecklist variant="library" />);

        expect(await screen.findByText(/Set up Omnibus/i)).toBeInTheDocument();
        // The Library page has no dismiss: it is the empty state, not a banner.
        expect(screen.queryByRole('button', { name: /Dismiss/i })).not.toBeInTheDocument();
    });

    it('shows nothing on the Library page once it has comics', async () => {
        answer(adminStatus({ libraryEmpty: false }));
        const { container } = render(<SetupChecklist variant="library" />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });

    it('renders its fallback when it has nothing to say (a filter that matches nothing)', async () => {
        answer(adminStatus({ libraryEmpty: false }));
        render(<SetupChecklist variant="library" fallback={<p>No comics found matching your criteria.</p>} />);

        expect(await screen.findByText('No comics found matching your criteria.')).toBeInTheDocument();
    });
});

describe('SetupChecklist (not an admin)', () => {
    it('tells a user with an empty library how to get comics when they may request', async () => {
        answer({ role: 'USER', libraryEmpty: true, canRequest: true });
        render(<SetupChecklist variant="home" />);

        expect(await screen.findByText(/Your library is empty/i)).toBeInTheDocument();
        expect(screen.getByText(/request/i, { selector: 'p' })).toBeInTheDocument();
        expect(screen.queryByText(/Set up Omnibus/i)).not.toBeInTheDocument();
    });

    it('sends them to the admin when they may not request', async () => {
        answer({ role: 'USER', libraryEmpty: true, canRequest: false });
        render(<SetupChecklist variant="library" />);

        expect(await screen.findByText(/Ask your admin/i)).toBeInTheDocument();
    });

    it('shows a user nothing once their library has comics', async () => {
        answer({ role: 'USER', libraryEmpty: false, canRequest: true });
        const { container } = render(<SetupChecklist variant="home" />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });
});
