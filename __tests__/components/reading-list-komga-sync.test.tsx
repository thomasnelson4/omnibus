// @vitest-environment jsdom
// __tests__/components/reading-list-komga-sync.test.tsx
//
// The admin panel's status line. The formatting is pure and lives in the component so it can be
// asserted without a DOM; this file also renders the panel to prove the one-way warning and the
// error line actually reach the screen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    fetch: vi.fn(),
}));

vi.stubGlobal('fetch', mocks.fetch);

import { render, screen, waitFor, cleanup } from '@testing-library/react';
import ReadingListKomgaSync, { formatPushedAt, formatStatusLine } from '@/components/reading-list-komga-sync';

const link = (over: Record<string, any> = {}) => ({
    komgaReadListId: 'KL1', status: 'synced', lastPushedName: 'My List',
    lastPushedAt: '2026-01-01T00:00:00Z', pushedCount: 38, skippedCount: 14,
    skipped: { placeholder: 0, notDownloaded: 9, unsupportedFormat: 0, libraryUnmapped: 0, awaitingScan: 5, duplicate: 0 },
    lastError: null, ...over,
});

describe('formatPushedAt', () => {
    const now = new Date('2026-01-01T12:00:00Z').getTime();
    it('renders "never" for no timestamp', () => {
        expect(formatPushedAt(null, now)).toBe('never');
        expect(formatPushedAt(undefined, now)).toBe('never');
        expect(formatPushedAt('not-a-date', now)).toBe('never');
    });

    it('renders seconds, minutes, hours and days', () => {
        expect(formatPushedAt('2026-01-01T11:59:55Z', now)).toBe('5 s ago');
        expect(formatPushedAt('2026-01-01T11:55:00Z', now)).toBe('5 m ago');
        expect(formatPushedAt('2026-01-01T09:00:00Z', now)).toBe('3 h ago');
        expect(formatPushedAt('2025-12-30T12:00:00Z', now)).toBe('2 d ago');
    });
});

describe('formatStatusLine', () => {
    const now = new Date('2026-01-01T12:00:00Z').getTime();

    it('says so plainly when the list was never pushed', () => {
        expect(formatStatusLine({ total: 52, link: null, now })).toBe('Not pushed to Komga yet · 52 issues in this list');
    });

    it('renders the count, the age and the skip breakdown', () => {
        const line = formatStatusLine({
            total: 52, link: link({ lastPushedAt: '2026-01-01T11:55:00Z' }) as never, now,
        });
        expect(line).toContain('38 of 52 issues in Komga');
        expect(line).toContain('pushed 5 m ago');
        expect(line).toContain('14 skipped (9 not downloaded, 5 awaiting scan)');
    });

    it('lists every non-zero bucket in a stable order', () => {
        const line = formatStatusLine({
            total: 9,
            link: link({
                pushedCount: 1,
                skipped: { placeholder: 1, notDownloaded: 2, unsupportedFormat: 3, libraryUnmapped: 4, awaitingScan: 5, duplicate: 6 },
            }) as never,
            now,
        });
        expect(line).toContain(
            '21 skipped (2 not downloaded, 5 awaiting scan, 1 placeholder, 3 unsupported format, 4 library not mapped to Komga, 6 duplicate)',
        );
    });

    it('omits the skip clause entirely when nothing was skipped', () => {
        const line = formatStatusLine({
            total: 3,
            link: link({
                pushedCount: 3, lastPushedAt: null, skippedCount: 0,
                skipped: { placeholder: 0, notDownloaded: 0, unsupportedFormat: 0, libraryUnmapped: 0, awaitingScan: 0, duplicate: 0 },
            }) as never,
            now,
        });
        expect(line).toBe('3 of 3 issues in Komga · pushed never');
        expect(line).not.toContain('skipped');
    });

    it('explains a waiting link', () => {
        const line = formatStatusLine({ total: 4, link: link({ status: 'waiting', pushedCount: 0 }) as never, now });
        expect(line).toContain('waiting for issues to be indexed');
    });

    it('uses the singular for a one-issue list', () => {
        expect(formatStatusLine({ total: 1, link: link({ pushedCount: 1 }) as never, now })).toContain('1 of 1 issue in Komga');
    });
});

describe('<ReadingListKomgaSync />', () => {
    afterEach(() => {
        cleanup();
    });

    beforeEach(() => {
        mocks.fetch.mockReset();
        mocks.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ listId: 'L1', komgaSync: true, link: link() }),
        });
    });

    it('renders the status and the one-way warning', async () => {
        render(<ReadingListKomgaSync listId="L1" totalItems={52} />);
        await waitFor(() => expect(screen.getByText(/38 of 52 issues in Komga/)).toBeTruthy());
        // The one-way contract is stated, not implied.
        expect(screen.getByText(/edits made in Komga are overwritten/i)).toBeTruthy();
    });

    it('shows lastError when the last push failed', async () => {
        mocks.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ listId: 'L1', komgaSync: true, link: link({ status: 'error', lastError: 'Komga already has a read list named "X"' }) }),
        });
        render(<ReadingListKomgaSync listId="L1" totalItems={3} />);
        await waitFor(() => expect(screen.getByText(/Komga already has a read list/)).toBeTruthy());
    });

    it('renders nothing until the status has loaded', async () => {
        let resolve: (v: unknown) => void = () => {};
        mocks.fetch.mockReturnValue(new Promise(r => { resolve = r; }));
        const { container } = render(<ReadingListKomgaSync listId="L1" totalItems={3} />);
        expect(container.innerHTML).toBe('');
        resolve({ ok: true, json: async () => ({ listId: 'L1', komgaSync: true, link: link() }) });
        await waitFor(() => expect(screen.getByText(/Sync to Komga/)).toBeTruthy());
    });
});