// @vitest-environment jsdom
//
// /reading-lists — the post-creation visibility toggle beside the Global badge. The UI contract
// under test: render the control only where the action is permitted, never move the switch
// optimistically (the server decides), and say so when the server refuses.
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err, stubFetchRouter } from '../../helpers/fetch';

const auth = vi.hoisted(() => ({ session: null as any }));
const toastMock = vi.hoisted(() => vi.fn());
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: auth.session }) }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/components/reading-list-item-match-dialog', () => ({ ReadingListItemMatchDialog: () => null }));

import ReadingListsPage from '@/app/reading-lists/page';

const list = (over: Record<string, unknown> = {}) => ({
    id: 'list_1', name: 'Dawn of X', description: '', coverUrl: null, userId: 'user_1', isGlobal: false,
    shareId: null, user: { username: 'u1' }, items: [], ...over,
});

/** GET returns `lists`; PATCH is answered by `onPatch` so each test can refuse or accept. */
const setup = (lists: any[], onPatch: (body: any) => any) => stubFetchRouter([
    ['/api/reading-lists?', () => ok(lists)],
    ['/api/reading-lists', (_url: string, init: any) => {
        if (init?.method !== 'PATCH') return ok({});
        const body = JSON.parse(init.body);
        return onPatch(body);
    }],
]);

const toggle = () => screen.queryByRole('switch', { name: 'Public' });
const patches = (fetchMock: ReturnType<typeof setup>) =>
    fetchMock.mock.calls.filter(([, init]: any) => init?.method === 'PATCH').map(([, init]: any) => JSON.parse(init.body));
const lastToast = () => toastMock.mock.calls.at(-1)?.[0];

describe('/reading-lists — post-creation visibility toggle', () => {
    beforeEach(() => {
        auth.session = { user: { id: 'user_1', role: 'USER' } };
        toastMock.mockClear();
        vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('promotes an owned list and follows the server value', async () => {
        auth.session = { user: { id: 'user_1', role: 'USER', canCreateGlobalLists: true } };
        setup([list()], ({ id, isGlobal }) => ok({ success: true, isPrivate: !isGlobal, shareRevoked: false, list: { id, isGlobal } }));
        render(<ReadingListsPage />);
        await screen.findAllByText('Dawn of X');

        fireEvent.click(toggle()!);
        await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
        // The Global badge is driven by the same value, so the header cannot disagree with itself.
        expect(await screen.findByText(/^Global \(u1\)$/)).toBeInTheDocument();
        expect(lastToast()).toMatchObject({ title: 'List is now public' });
    });

    it('hides the control entirely when the owner may not publish and the list is private', async () => {
        setup([list()], () => ok({}));
        render(<ReadingListsPage />);
        await screen.findAllByText('Dawn of X');
        // Not disabled — absent. A switch the user can never move is not information.
        expect(toggle()).toBeNull();
    });

    it('offers the control to an owner who may publish', async () => {
        auth.session = { user: { id: 'user_1', role: 'USER', canCreateGlobalLists: true } };
        setup([list()], () => ok({}));
        render(<ReadingListsPage />);
        await screen.findAllByText('Dawn of X');
        expect(toggle()).not.toBeDisabled();
    });

    it('lets an owner without the permission demote their own public list', async () => {
        auth.session = { user: { id: 'user_1', role: 'USER' } };
        setup([list({ isGlobal: true, shareId: 'ab12cd' })], ({ id, isGlobal }) =>
            ok({ success: true, isPrivate: !isGlobal, shareRevoked: true, list: { id, isGlobal, shareId: null } }));
        render(<ReadingListsPage />);
        await screen.findAllByText('Dawn of X');

        // Promotion needs the permission, demotion does not — so the control must be here.
        expect(toggle()).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(toggle()!);
        // "Private" revokes the public share link, and the UI has to say so.
        await waitFor(() => expect(lastToast()).toMatchObject({ title: 'List is now private' }));
        expect(lastToast().description).toMatch(/share link has been disabled/i);
        expect(screen.queryByText(/^Global \(/)).toBeNull();
        // And now that the list is private and this owner cannot publish, the control withdraws
        // rather than sitting there offering an action that would be refused.
        await waitFor(() => expect(toggle()).toBeNull());
    });

    it("keeps the switch put and toasts when the server refuses", async () => {
        auth.session = { user: { id: 'user_1', role: 'USER', canCreateGlobalLists: true } };
        setup([list()], () => err(403, { error: 'You do not have permission to publish a list to all users.', code: 'FORBIDDEN_GLOBAL' }));
        render(<ReadingListsPage />);
        await screen.findAllByText('Dawn of X');

        fireEvent.click(toggle()!);
        await waitFor(() => expect(lastToast()).toMatchObject({ variant: 'destructive' }));
        expect(lastToast().description).toMatch(/do not have permission/i);
        // No optimistic write: the flag never moved off the server's value.
        await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'false'));
    });

    it('hides the control from a non-owner', async () => {
        auth.session = { user: { id: 'user_9', role: 'USER', canCreateGlobalLists: true } };
        setup([list({ userId: 'user_1', isGlobal: true })], () => ok({}));
        render(<ReadingListsPage />);
        await screen.findAllByText('Dawn of X');
        expect(toggle()).toBeNull();
    });

    it('shows an ADMIN a disabled, explained control on a list with no owner', async () => {
        auth.session = { user: { id: 'admin_1', role: 'ADMIN' } };
        setup([list({ userId: null })], () => ok({}));
        render(<ReadingListsPage />);
        await screen.findAllByText('Dawn of X');

        // userId null means "visible to everyone" whatever the flag says — shown, but inert, because
        // the honest answer is "this cannot be made private", not a switch that lies.
        expect(toggle()).toBeDisabled();
        expect(screen.getByTitle(/no owner, so it stays visible to every user/i)).toBeInTheDocument();
    });

    it('hides the control on a no-owner list from a non-admin', async () => {
        setup([list({ userId: null })], () => ok({}));
        render(<ReadingListsPage />);
        await screen.findAllByText('Dawn of X');
        expect(toggle()).toBeNull();
    });

    it('warns before the switch that demoting disables the share link', async () => {
        setup([list({ isGlobal: true, shareId: 'ab12cd' })], ({ id, isGlobal }) =>
            ok({ success: true, isPrivate: !isGlobal, shareRevoked: true, list: { id, isGlobal, shareId: null } }));
        render(<ReadingListsPage />);
        await screen.findAllByText('Dawn of X');
        expect(toggle()!.closest('div')!.getAttribute('title')).toMatch(/share link will be disabled/i);
    });

    it('sends exactly one PATCH carrying the id and the requested value', async () => {
        auth.session = { user: { id: 'user_1', role: 'USER', canCreateGlobalLists: true } };
        const fetchMock = setup([list()], ({ id, isGlobal }) => ok({ success: true, list: { id, isGlobal } }));
        render(<ReadingListsPage />);
        await screen.findAllByText('Dawn of X');

        fireEvent.click(toggle()!);
        await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
        expect(patches(fetchMock)[0]).toEqual({ id: 'list_1', isGlobal: true });
    });

    it('still lets an ADMIN promote another user’s list', async () => {
        auth.session = { user: { id: 'admin_1', role: 'ADMIN' } };
        const fetchMock = setup([list({ userId: 'user_9', isGlobal: false })], ({ id, isGlobal }) =>
            ok({ success: true, list: { id, isGlobal } }));
        render(<ReadingListsPage />);
        await screen.findAllByText('Dawn of X');

        fireEvent.click(toggle()!);
        await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
        expect(patches(fetchMock)[0]).toEqual({ id: 'list_1', isGlobal: true });
    });
});