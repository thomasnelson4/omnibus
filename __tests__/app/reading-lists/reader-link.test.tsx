// @vitest-environment jsdom
//
// A ReadingListItem only links to the reader when its Issue has a file. A wanted-but-not-downloaded
// issue (Issue.filePath === null — exactly what status WANTED means) must render NO reader link:
// the literal `null` and the `|| ''` degradation are both dead links to /reader.
//
// Two pages are covered:
//   - the owner's /reading-lists list (both the Grouped and Flat views), where the Read link is
//     gated by isDownloaded() and the "Not downloaded" + Request affordances must survive;
//   - the public share page, which previously rendered `issue.filePath || ''` unconditionally.
import '@testing-library/jest-dom';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, stubFetchRouter } from '../../helpers/fetch';

const auth = vi.hoisted(() => ({ session: null as any }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: auth.session }) }));
vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: vi.fn() }),
    notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/db', () => ({ prisma: { readingList: { findFirst: mocks.shareFindFirst } } }));

const mocks = vi.hoisted(() => ({ shareFindFirst: vi.fn() }));

import ReadingListsPage from '@/app/reading-lists/page';
import SharedReadingListPage from '@/app/reading-lists/shared/[shareId]/page';

const series = { id: 'ser_x', name: 'X-Men', year: 1991, publisher: 'Marvel', folderPath: '/c/X-Men', metadataId: '4511', metadataSource: 'COMICVINE' };
const downloaded = {
    id: 'item_1', order: 0, title: 'X-Men #141', cvIssueId: null, metadataSource: 'COMICVINE', issueId: 'iss_141',
    issue: { id: 'iss_141', number: '141', name: 'Mind Out of Time', filePath: '/c/x141.cbz', metadataSource: 'COMICVINE', metadataId: '9141', isAnnual: false, series },
};
/** status WANTED => library/issues/route.ts sets filePath = null. */
const wanted = {
    id: 'item_2', order: 1, title: 'X-Men #142', cvIssueId: null, metadataSource: 'COMICVINE', issueId: 'iss_142',
    issue: { id: 'iss_142', number: '142', name: null, filePath: null, releaseDate: '2001-01-01', metadataSource: 'COMICVINE', metadataId: '9142', isAnnual: false, series },
};
const list = (over: Record<string, unknown> = {}) => ({
    id: 'list_1', name: 'Dawn of X', description: '', coverUrl: null, userId: 'user_1', isGlobal: false,
    user: { username: 'u1' }, items: [downloaded, wanted], ...over,
});

/** Every /reader href on the page, decoded so a bare `null`/`''` is visible. */
const readerHrefs = () =>
    Array.from(document.querySelectorAll('a[href^="/reader"]')).map(a => decodeURIComponent(a.getAttribute('href') || ''));

const expandAll = async () => {
    await screen.findAllByText('Dawn of X');
    for (const header of screen.getAllByText(/^(X-Men|Missing\/Unlinked Issue)$/).map(el => el.closest('[role="button"]') as HTMLElement)) {
        fireEvent.click(header);
    }
};

describe('Reader links are only rendered for issues that have a file', () => {
    beforeEach(() => {
        auth.session = { user: { id: 'user_1', role: 'USER' } };
        vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
        mocks.shareFindFirst.mockResolvedValue(null);
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    describe("the owner's /reading-lists list", () => {
        beforeEach(() => {
            stubFetchRouter([['/api/reading-lists?', () => ok([list()])]]);
        });

        it('Grouped view links the downloaded issue and never emits path=null', async () => {
            render(<ReadingListsPage />);
            await expandAll();

            expect(screen.getByText('Not downloaded')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Request X-Men #142' })).toBeInTheDocument();

            const hrefs = readerHrefs();
            expect(hrefs).toHaveLength(1);
            expect(hrefs[0]).toContain('/c/x141.cbz');
            expect(hrefs.some(h => h.includes('path=null') || h.includes('path=&'))).toBe(false);
        });

        it('Flat view links the downloaded issue and never emits path=null', async () => {
            render(<ReadingListsPage />);
            await screen.findAllByText('Dawn of X');
            fireEvent.click(screen.getByRole('button', { name: /Flat \(Reorder\)/ }));

            expect(await screen.findByText('Not downloaded')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Request X-Men #142' })).toBeInTheDocument();

            const hrefs = readerHrefs();
            expect(hrefs).toHaveLength(1);
            expect(hrefs[0]).toContain('/c/x141.cbz');
            expect(hrefs.some(h => h.includes('path=null') || h.includes('path=&'))).toBe(false);
        });
    });

    describe('the public share page', () => {
        const renderShare = async () => {
            const ui = await SharedReadingListPage({ params: Promise.resolve({ shareId: 'share_1' }) });
            render(ui);
        };

        it('renders no reader link at all for a file-less issue, and a working one for a downloaded issue', async () => {
            mocks.shareFindFirst.mockResolvedValue(list());
            await renderShare();

            expect(screen.getAllByText('X-Men')).toHaveLength(2);

            const hrefs = readerHrefs();
            expect(hrefs).toHaveLength(1);
            expect(hrefs[0]).toContain('/c/x141.cbz');
            expect(hrefs[0]).toContain('series=/c/X-Men');

            // The regression: the wanted issue used to render `/reader?path=&series=…`.
            expect(hrefs.some(h => h.includes('path=null') || h.includes('path=&'))).toBe(false);
            expect(screen.getByRole('link', { name: /Read/ })).toHaveAttribute('href', expect.stringContaining(encodeURIComponent('/c/x141.cbz')));
        });

        it('explains the missing link rather than leaving an unexplained gap', async () => {
            mocks.shareFindFirst.mockResolvedValue(list());
            await renderShare();
            expect(screen.getByText('Not downloaded')).toBeInTheDocument();
        });

        it('still renders the read link when every issue is downloaded', async () => {
            mocks.shareFindFirst.mockResolvedValue(list({ items: [downloaded] }));
            await renderShare();
            expect(screen.queryByText('Not downloaded')).toBeNull();
            expect(readerHrefs()).toHaveLength(1);
        });
    });
});