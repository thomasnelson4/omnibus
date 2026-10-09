// @vitest-environment jsdom
// __tests__/components/site-header-admin-upload-link.test.tsx
//
// The header advertises Manual Upload and Smart Matcher shortcuts beside the notification bell.
// `/admin/upload` and `/admin/smart-match` are already blocked server-side by middleware
// (non-admins redirect to "/"), but the header must not show a link the signed-in user cannot
// use — so both icons are gated on the same session?.user?.role === "ADMIN" check the
// "Admin Dashboard" entries use. Smart Matcher uses Sparkles, matching the Admin Dashboard card.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SiteHeader } from '@/components/site-header';

const mocks = vi.hoisted(() => ({
    useSession: vi.fn(),
    pathname: '/',
}));

vi.mock('next-auth/react', () => ({
    useSession: mocks.useSession,
    signOut: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }));

vi.mock('next-themes', () => ({
    useTheme: () => ({ theme: 'light', setTheme: vi.fn(), resolvedTheme: 'light' }),
}));

// NotificationBell polls /api/notifications on mount; keep it silent.
const sessionWithRole = (role: string) => ({
    user: { id: 'u1', name: 'Test', email: 't@example.com', role },
    expires: '2099-01-01',
});

const renderHeader = () => render(<SiteHeader />);

const uploadLink = () => screen.queryByRole('link', { name: /manual upload/i });
const smartMatchLink = () => screen.queryByRole('link', { name: /smart matcher/i });

describe('Component: SiteHeader — admin Manual Upload / Smart Matcher links', () => {
    beforeEach(() => {
        global.ResizeObserver = vi.fn().mockImplementation(() => ({
            observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn(),
        }));
        window.matchMedia = vi.fn().mockImplementation(() => ({
            matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
        })) as any;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true, headers: { get: () => 'application/json' }, json: async () => [],
        }));
        mocks.useSession.mockReturnValue({ data: sessionWithRole('ADMIN'), status: 'authenticated' });
    });

    it('renders the upload link for an ADMIN session', () => {
        renderHeader();
        expect(uploadLink()).toBeInTheDocument();
    });

    it('points at /admin/upload', () => {
        renderHeader();
        expect(uploadLink()).toHaveAttribute('href', '/admin/upload');
    });

    it('does not render for a USER session', () => {
        mocks.useSession.mockReturnValue({ data: sessionWithRole('USER'), status: 'authenticated' });
        renderHeader();
        expect(uploadLink()).not.toBeInTheDocument();
    });

    it('does not render without a session', () => {
        mocks.useSession.mockReturnValue({ data: null, status: 'unauthenticated' });
        renderHeader();
        expect(uploadLink()).not.toBeInTheDocument();
    });

    it('sits beside the notification bell in the same icon cluster', () => {
        const { container } = renderHeader();
        const bellButton = container.querySelector('button .lucide-bell')!.closest('button')!;
        // Radix renders the trigger and the `asChild` Button directly in the cluster, so the
        // upload link is the bell's immediate next sibling.
        expect(uploadLink()!.previousElementSibling).toBe(bellButton);
    });

    it('renders the Smart Matcher link for an ADMIN session', () => {
        renderHeader();
        expect(smartMatchLink()).toBeInTheDocument();
    });

    it('points the Smart Matcher link at /admin/smart-match', () => {
        renderHeader();
        expect(smartMatchLink()).toHaveAttribute('href', '/admin/smart-match');
    });

    it('uses Sparkles for Smart Matcher, matching the Admin Dashboard card', () => {
        renderHeader();
        // Asserted on the link itself: Sparkles also appears in the bell's dropdown, so a
        // repo-wide count would pass regardless of which icon this link used.
        expect(smartMatchLink()!.querySelector('.lucide-sparkles')).toBeInTheDocument();
    });

    it('does not render the Smart Matcher link for a USER session', () => {
        mocks.useSession.mockReturnValue({ data: sessionWithRole('USER'), status: 'authenticated' });
        renderHeader();
        expect(smartMatchLink()).not.toBeInTheDocument();
    });

    it('does not render the Smart Matcher link without a session', () => {
        mocks.useSession.mockReturnValue({ data: null, status: 'unauthenticated' });
        renderHeader();
        expect(smartMatchLink()).not.toBeInTheDocument();
    });
});