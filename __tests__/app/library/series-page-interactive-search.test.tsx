// @vitest-environment jsdom
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, stubFetchRouter } from '../../helpers/fetch';

const auth = vi.hoisted(() => ({ session: null as any }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: auth.session }) }));
const nav = vi.hoisted(() => ({
    params: new URLSearchParams({ path: '/comics/Batman' }),
    push: vi.fn(),
}));
vi.mock('next/navigation', () => ({
    useSearchParams: () => nav.params,
    useRouter: () => ({ push: nav.push }),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/metadata-editor-modal', () => ({ default: () => null }));
vi.mock('@/components/page-manager-modal', () => ({ default: () => null }));
vi.mock('@/components/attached-volumes-manager', () => ({ AttachedVolumesManager: () => null }));

import SeriesPage from '@/app/library/series/page';

const series = {
    id: 'series-1', seriesName: 'Batman', metadataId: '42821', cvId: 123,
    metadataSource: 'COMICVINE', year: 2016, publisher: 'DC Comics',
    coverUrl: '/series-cover.jpg', isManga: false,
    downloadedIssues: [{
        id: 'issue-1', number: '1', parsedNum: 1, name: 'An issue subtitle',
        fullPath: '/comics/Batman/1.cbz', coverUrl: '/issue-cover.jpg',
        readProgress: 0, isRead: false,
    }],
    missingIssues: [],
};
const release = {
    title: 'Batman 2016 Complete', guid: 'release-1', protocol: 'torrent',
    indexer: 'Test Indexer', downloadUrl: 'https://indexer.example/release-1',
};

describe('/library/series — interactive search', () => {
    let requests: any[];

    beforeEach(() => {
        auth.session = { user: { id: 'u1', role: 'USER', canRequest: true } };
        requests = [];
        vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    const setup = (overrides = {}) => stubFetchRouter([
        ['/api/library/series?', () => ok({ ...series, ...overrides })],
        ['/api/search/interactive?', () => ok({ prowlarr: [release], getcomics: [] })],
        ['/api/request/manual', (_url, init) => {
            requests.push(JSON.parse(init.body));
            return ok({ success: true });
        }],
    ]);

    it('searches the series even when a downloaded issue is selected, then requests the chosen release', async () => {
        const fetchMock = setup();
        render(<SeriesPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Interactive Search' }));

        const dialog = await screen.findByRole('dialog', { name: 'Interactive Search' });
        expect(within(dialog).getByRole('textbox')).toHaveValue('Batman 2016');
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/search/interactive?q=Batman+2016&year=2016'));
        expect(requests).toHaveLength(0);

        fireEvent.click((await within(dialog).findAllByRole('button', { name: 'Download' }))[0]);
        fireEvent.click(await screen.findByRole('button', { name: 'No, Just Download This File' }));

        await waitFor(() => expect(requests).toHaveLength(1));
        expect(requests[0]).toEqual({
            cvId: '42821', name: 'Batman', year: '2016', publisher: 'DC Comics',
            image: '/series-cover.jpg', type: 'volume', metadataSource: 'COMICVINE',
            isManga: false, searchResult: release, source: 'prowlarr', monitored: false,
        });
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Interactive Search' })).not.toBeInTheDocument());
    });

    it('lets users edit the query and starts fresh when reopened', async () => {
        const fetchMock = setup();
        render(<SeriesPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Interactive Search' }));
        const dialog = await screen.findByRole('dialog', { name: 'Interactive Search' });
        const input = within(dialog).getByRole('textbox');
        fireEvent.change(input, { target: { value: 'Batman collection' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/search/interactive?q=Batman+collection&year=2016'));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Interactive Search' }));
        expect(within(await screen.findByRole('dialog', { name: 'Interactive Search' })).getByRole('textbox')).toHaveValue('Batman 2016');
        expect(requests).toHaveLength(0);
    });

    it('preserves a string metadata ID and manga context when there are no issues', async () => {
        const fetchMock = setup({
            seriesName: 'One Piece', metadataId: '30013', metadataSource: 'ANILIST',
            isManga: true, downloadedIssues: [],
        });
        render(<SeriesPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Interactive Search' }));
        const dialog = await screen.findByRole('dialog', { name: 'Interactive Search' });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/search/interactive?q=One+Piece+2016&year=2016&isManga=true'));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Flag for Admin' }));
        await waitFor(() => expect(requests).toHaveLength(1));
        expect(requests[0]).toMatchObject({ cvId: '30013', metadataSource: 'ANILIST', isManga: true, name: 'One Piece' });
    });

    it('supports a legacy series ID with missing optional metadata', async () => {
        setup({ metadataId: null, year: null, publisher: null, coverUrl: null, downloadedIssues: [] });
        render(<SeriesPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Interactive Search' }));
        const dialog = await screen.findByRole('dialog', { name: 'Interactive Search' });
        expect(within(dialog).getByRole('textbox')).toHaveValue('Batman');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Flag for Admin' }));
        await waitFor(() => expect(requests).toHaveLength(1));
        expect(requests[0]).toMatchObject({ cvId: 123, year: '', publisher: 'Unknown', image: '' });
    });

    it('hides interactive search for users without request permission', async () => {
        auth.session = { user: { role: 'USER', canRequest: false, canDownload: true } };
        setup();
        render(<SeriesPage />);
        await screen.findByRole('heading', { name: 'Batman' });
        expect(screen.queryByRole('button', { name: 'Interactive Search' })).not.toBeInTheDocument();
    });

    it('allows admins to search without a separate request permission', async () => {
        auth.session = { user: { role: 'ADMIN', canRequest: false } };
        setup();
        render(<SeriesPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Interactive Search' }));
        expect(await screen.findByRole('dialog', { name: 'Interactive Search' })).toBeInTheDocument();
    });
});
