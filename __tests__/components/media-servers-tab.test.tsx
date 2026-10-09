// @vitest-environment jsdom
// __tests__/components/media-servers-tab.test.tsx
//
// Komga integration Phase 1: the "Media Servers" settings tab. Every field writes through the
// shared bag's setConfig (so it rides the normal Save), the path-mapping editor stores its rows
// as a JSON string in config.komga_path_mappings, "Test Connection" goes through the page's
// handleTest('komga'), and "Detect Libraries" posts the UNSAVED values to
// /api/admin/komga/libraries and renders the mapping table with its warnings.
import '@testing-library/jest-dom';
import React, { useState } from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    MediaServersTab, parseMappingRows, serializeMappingRows, isStrongWarning, isVersionBelow,
} from '@/app/admin/settings/tabs/media-servers-tab';
import type { SettingsBag } from '@/app/admin/settings/tabs/shared';

global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn()
}));

const DEFAULT_KOMGA_CONFIG = {
    komga_enabled: 'false', komga_url: '', komga_api_key: '', komga_path_mappings: '[]',
    komga_scan_on_change: 'true', komga_readlists_enabled: 'false',
};

const mkBag = (overrides: Record<string, any> = {}): SettingsBag => ({
    config: { ...DEFAULT_KOMGA_CONFIG },
    setConfig: vi.fn(),
    handleTest: vi.fn(),
    testing: null,
    testResults: {},
    setTestResults: vi.fn(),
    toast: vi.fn(),
    configuredLibraries: [], configuredIndexers: [], configuredClients: [], configuredWebhooks: [],
    configuredHosters: [], customHeaders: [], customAcronyms: [], scoringRules: [],
    hosterPriority: [], searchSourcePriority: [], availableIndexers: [], users: [], apiKeys: [],
    ...overrides,
});

// Holds config in real state (like page.tsx) so successive edits build on each other; `seen`
// records every config object the tab writes.
function Harness({ initial, seen }: { initial: Record<string, any>; seen: (c: Record<string, any>) => void }) {
    const [config, setConfigState] = useState<Record<string, any>>(initial);
    const setConfig = (c: Record<string, any>) => { seen(c); setConfigState(c); };
    return <MediaServersTab s={mkBag({ config, setConfig })} />;
}

const jsonResponse = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

const LIBRARIES_BODY = {
    version: '1.28.1',
    warnings: ['Omnibus library "Manga" (/data/manga) is not covered by any Komga library.'],
    libraries: [
        {
            id: 'k1', name: 'Comics', root: '/comics', translatedRoot: '/data/comics',
            omnibusLibrary: { id: 'o1', name: 'Main Comics', path: '/data/comics' },
            warnings: [],
        },
        {
            id: 'k2', name: 'Imports', root: '/imports', translatedRoot: null, omnibusLibrary: null,
            warnings: [
                'Strongly discouraged: "Convert to CBZ" is on, so Komga rewrites files Omnibus manages.',
                'File hashing is off, so Komga cannot follow moved files.',
            ],
        },
    ],
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Component: MediaServersTab (Komga)', () => {
    it('renders the Komga card with every field and the empty mapping state', () => {
        render(<MediaServersTab s={mkBag()} />);

        expect(screen.getByText('Komga')).toBeInTheDocument();
        expect(screen.getByLabelText(/Enable Komga Integration/i)).toHaveAttribute('role', 'switch');
        expect(screen.getByLabelText(/Komga URL/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/API Key/i)).toHaveAttribute('type', 'password');
        expect(screen.getByLabelText(/Scan Komga When Files Change/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/Push Reading Lists to Komga/i)).toBeInTheDocument();
        // The read-list switch spells out both preconditions.
        expect(screen.getByText(/1\.23\.3 or newer/)).toBeInTheDocument();
        expect(screen.getByText(/opted in from its own page/i)).toBeInTheDocument();
        // Empty mappings mean identity.
        expect(screen.getByText(/same paths as Omnibus/i)).toBeInTheDocument();
        // The server-generated instance id is never shown.
        expect(screen.queryByText(/instance/i)).not.toBeInTheDocument();
    });

    it('reflects the stored flags, with scan-on-change on when the key is missing', () => {
        const { unmount } = render(<MediaServersTab s={mkBag({ config: { komga_enabled: 'true', komga_readlists_enabled: 'true' } })} />);
        expect(screen.getByLabelText(/Enable Komga Integration/i)).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByLabelText(/Scan Komga When Files Change/i)).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByLabelText(/Push Reading Lists to Komga/i)).toHaveAttribute('aria-checked', 'true');
        unmount();

        render(<MediaServersTab s={mkBag({ config: { ...DEFAULT_KOMGA_CONFIG, komga_scan_on_change: 'false' } })} />);
        expect(screen.getByLabelText(/Enable Komga Integration/i)).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByLabelText(/Scan Komga When Files Change/i)).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByLabelText(/Push Reading Lists to Komga/i)).toHaveAttribute('aria-checked', 'false');
    });

    it('writes each switch through setConfig as a "true"/"false" string', () => {
        const bag = mkBag();
        render(<MediaServersTab s={bag} />);

        fireEvent.click(screen.getByLabelText(/Enable Komga Integration/i));
        expect(bag.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ komga_enabled: 'true' }));

        fireEvent.click(screen.getByLabelText(/Scan Komga When Files Change/i));
        expect(bag.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ komga_scan_on_change: 'false' }));

        fireEvent.click(screen.getByLabelText(/Push Reading Lists to Komga/i));
        expect(bag.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ komga_readlists_enabled: 'true' }));
    });

    it('writes URL and API key through setConfig and keeps a saved key masked', () => {
        const bag = mkBag({
            config: { ...DEFAULT_KOMGA_CONFIG, komga_url: 'http://komga:25600', komga_api_key: '********' },
            testResults: { komga: { success: true, text: 'Connected to Komga 1.28.1' } },
        });
        render(<MediaServersTab s={bag} />);

        const key = screen.getByLabelText(/API Key/i) as HTMLInputElement;
        expect(key.type).toBe('password');
        expect(key.value).toBe('********');

        fireEvent.change(screen.getByLabelText(/Komga URL/i), { target: { value: 'http://host/komga' } });
        expect(bag.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ komga_url: 'http://host/komga', komga_api_key: '********' }));
        // A result for the old URL is cleared.
        expect(bag.setTestResults).toHaveBeenCalledTimes(1);
        const updater = (bag.setTestResults as any).mock.calls[0][0];
        expect(updater({ komga: { success: true, text: 'x' }, prowlarr: null })).toEqual({ komga: null, prowlarr: null });

        fireEvent.change(key, { target: { value: 'new-key' } });
        expect(bag.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ komga_api_key: 'new-key' }));
    });

    it('edits path mappings as a JSON string: add, edit both sides, remove', () => {
        const seen = vi.fn();
        render(<Harness initial={{ ...DEFAULT_KOMGA_CONFIG }} seen={seen} />);
        const last = () => seen.mock.calls[seen.mock.calls.length - 1][0].komga_path_mappings;

        fireEvent.click(screen.getByRole('button', { name: /Add Mapping/i }));
        expect(last()).toBe('[{"omnibus":"","komga":""}]');

        fireEvent.change(screen.getByLabelText('Omnibus path 1'), { target: { value: '/data/comics' } });
        fireEvent.change(screen.getByLabelText('Komga path 1'), { target: { value: '/comics' } });
        expect(JSON.parse(last())).toEqual([{ omnibus: '/data/comics', komga: '/comics' }]);

        fireEvent.click(screen.getByRole('button', { name: /Add Mapping/i }));
        fireEvent.change(screen.getByLabelText('Omnibus path 2'), { target: { value: '/data/manga' } });
        fireEvent.change(screen.getByLabelText('Komga path 2'), { target: { value: '/manga' } });
        expect(JSON.parse(last())).toEqual([
            { omnibus: '/data/comics', komga: '/comics' },
            { omnibus: '/data/manga', komga: '/manga' },
        ]);

        fireEvent.click(screen.getByRole('button', { name: 'Remove mapping 1' }));
        expect(JSON.parse(last())).toEqual([{ omnibus: '/data/manga', komga: '/manga' }]);
        expect((screen.getByLabelText('Omnibus path 1') as HTMLInputElement).value).toBe('/data/manga');

        fireEvent.click(screen.getByRole('button', { name: 'Remove mapping 1' }));
        expect(last()).toBe('[]');
        expect(screen.getByText(/same paths as Omnibus/i)).toBeInTheDocument();
    });

    it('renders stored mapping rows and survives a corrupt stored value', () => {
        const { unmount } = render(<MediaServersTab s={mkBag({ config: { ...DEFAULT_KOMGA_CONFIG, komga_path_mappings: '[{"omnibus":"/a","komga":"/b"}]' } })} />);
        expect((screen.getByLabelText('Omnibus path 1') as HTMLInputElement).value).toBe('/a');
        expect((screen.getByLabelText('Komga path 1') as HTMLInputElement).value).toBe('/b');
        unmount();

        render(<MediaServersTab s={mkBag({ config: { ...DEFAULT_KOMGA_CONFIG, komga_path_mappings: '{not json' } })} />);
        expect(screen.getByText(/same paths as Omnibus/i)).toBeInTheDocument();
    });

    it('Test Connection calls handleTest("komga") once a URL and key are present, and shows the result', () => {
        const noCreds = mkBag();
        const { unmount } = render(<MediaServersTab s={noCreds} />);
        expect(screen.getByRole('button', { name: /Test Connection/i })).toBeDisabled();
        unmount();

        const bag = mkBag({
            config: { ...DEFAULT_KOMGA_CONFIG, komga_url: 'http://komga:25600', komga_api_key: '********' },
            testResults: { komga: { success: false, text: 'Invalid API key, or Komga is older than 1.20.0' } },
        });
        render(<MediaServersTab s={bag} />);
        fireEvent.click(screen.getByRole('button', { name: /Test Connection/i }));
        expect(bag.handleTest).toHaveBeenCalledWith('komga');
        expect(screen.getByText(/Invalid API key/)).toBeInTheDocument();
    });

    it('disables Test Connection while any test is running', () => {
        render(<MediaServersTab s={mkBag({
            config: { ...DEFAULT_KOMGA_CONFIG, komga_url: 'http://komga:25600', komga_api_key: 'k' },
            testing: 'komga',
        })} />);
        expect(screen.getByRole('button', { name: /Test Connection/i })).toBeDisabled();
    });

    it('Detect Libraries posts the unsaved values and renders the table, warnings, and version', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, LIBRARIES_BODY));
        vi.stubGlobal('fetch', fetchMock);
        const mappings = '[{"omnibus":"/data/comics","komga":"/comics"}]';
        render(<MediaServersTab s={mkBag({
            config: { ...DEFAULT_KOMGA_CONFIG, komga_url: 'http://komga:25600', komga_api_key: '********', komga_path_mappings: mappings },
        })} />);

        fireEvent.click(screen.getByRole('button', { name: /Detect Libraries/i }));
        const table = await screen.findByRole('table');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/admin/komga/libraries');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ url: 'http://komga:25600', apiKey: '********', pathMappings: mappings });

        expect(screen.getByText('Komga 1.28.1')).toBeInTheDocument();
        expect(screen.getByText('2 libraries detected')).toBeInTheDocument();
        expect(screen.getByText(/not covered by any Komga library/)).toBeInTheDocument();

        // One body per library: its row, plus a full-width warnings row when it has warnings.
        const [mapped, unmapped] = Array.from(table.querySelectorAll('tbody[data-library-id]')) as HTMLElement[];
        expect(table.querySelectorAll('tbody[data-library-id]')).toHaveLength(2);

        expect(mapped).toHaveAttribute('data-library-id', 'k1');
        expect(within(mapped).getAllByRole('row')).toHaveLength(1);
        expect(within(mapped).getByText('Comics')).toBeInTheDocument();
        expect(within(mapped).getByText('/comics')).toBeInTheDocument();
        expect(within(mapped).getAllByText('/data/comics')).toHaveLength(2); // translated root + library path
        // Phone layout repeats both paths inside the Library cell (CSS hides one copy per width).
        expect(within(mapped).getByText('Komga: /comics')).toBeInTheDocument();
        expect(within(mapped).getByText('Omnibus: /data/comics')).toBeInTheDocument();
        expect(within(mapped).getByText('Main Comics')).toBeInTheDocument();
        expect(within(mapped).getByText(/No warnings/)).toBeInTheDocument();

        expect(unmapped).toHaveAttribute('data-library-id', 'k2');
        expect(within(unmapped).getAllByRole('row')).toHaveLength(2);
        expect(within(unmapped).getByText('Imports')).toBeInTheDocument();
        expect(within(unmapped).getByText('Not mapped')).toBeInTheDocument();
        expect(within(unmapped).getByText(/Outside every mapping/)).toBeInTheDocument();
        expect(within(unmapped).getByText('Omnibus: no mapping covers it')).toBeInTheDocument();
        const strong = within(unmapped).getByText(/Strongly discouraged/).closest('li')!;
        const normal = within(unmapped).getByText(/File hashing is off/).closest('li')!;
        expect(strong).toHaveAttribute('data-severity', 'strong');
        expect(normal).toHaveAttribute('data-severity', 'warning');
        expect(strong.className).not.toBe(normal.className);
    });

    it('shows the route error when detection fails, and a reachability error when fetch throws', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(502, { error: 'Komga is unreachable at http://komga:25600' })));
        const bag = mkBag({ config: { ...DEFAULT_KOMGA_CONFIG, komga_url: 'http://komga:25600', komga_api_key: 'k' } });
        const { unmount } = render(<MediaServersTab s={bag} />);
        fireEvent.click(screen.getByRole('button', { name: /Detect Libraries/i }));
        expect(await screen.findByText(/Komga is unreachable/)).toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        unmount();

        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
        const second = render(<MediaServersTab s={bag} />);
        fireEvent.click(screen.getByRole('button', { name: /Detect Libraries/i }));
        expect(await screen.findByText(/could not reach Omnibus/i)).toBeInTheDocument();
        second.unmount();

        // The 60 s client-side abort reports a timeout rather than a generic failure.
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        render(<MediaServersTab s={bag} />);
        fireEvent.click(screen.getByRole('button', { name: /Detect Libraries/i }));
        expect(await screen.findByText(/no answer after 60 seconds/i)).toBeInTheDocument();
    });

    it('keeps Detect Libraries disabled until a URL and key are entered', () => {
        render(<MediaServersTab s={mkBag({ config: { ...DEFAULT_KOMGA_CONFIG, komga_url: 'http://komga:25600' } })} />);
        expect(screen.getByRole('button', { name: /Detect Libraries/i })).toBeDisabled();
        expect(screen.getByText(/Enter a Komga URL and API key/)).toBeInTheDocument();
    });

    it('handles an empty library list', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { libraries: [], warnings: [], version: null }));
        vi.stubGlobal('fetch', fetchMock);
        // A corrupt stored mapping value shows as "no mappings" and is previewed as exactly that.
        render(<MediaServersTab s={mkBag({ config: { ...DEFAULT_KOMGA_CONFIG, komga_url: 'http://k', komga_api_key: 'k', komga_path_mappings: '{oops' } })} />);
        fireEvent.click(screen.getByRole('button', { name: /Detect Libraries/i }));
        expect(await screen.findByText(/Komga reported no libraries/)).toBeInTheDocument();
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).pathMappings).toBe('[]');
        expect(screen.getByText('Komga version unknown')).toBeInTheDocument();
    });

    it('drops a detection preview once the URL or mappings change', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, LIBRARIES_BODY)));
        render(<Harness initial={{ ...DEFAULT_KOMGA_CONFIG, komga_url: 'http://komga:25600', komga_api_key: 'k' }} seen={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: /Detect Libraries/i }));
        await screen.findByRole('table');
        fireEvent.click(screen.getByRole('button', { name: /Add Mapping/i }));
        expect(screen.queryByRole('table')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Detect Libraries/i }));
        await screen.findByRole('table');
        fireEvent.change(screen.getByLabelText(/Komga URL/i), { target: { value: 'http://other:25600' } });
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('warns when read lists are on but the detected Komga is older than 1.23.3', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { ...LIBRARIES_BODY, version: '1.22.0' })));
        render(<MediaServersTab s={mkBag({
            config: { ...DEFAULT_KOMGA_CONFIG, komga_url: 'http://k', komga_api_key: 'k', komga_readlists_enabled: 'true' },
        })} />);
        expect(screen.queryByText(/is older than 1\.23\.3/)).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Detect Libraries/i }));
        await waitFor(() => expect(screen.getByText(/\(1\.22\.0\) is older than 1\.23\.3/)).toBeInTheDocument());
    });
});

describe('media-servers-tab helpers', () => {
    it('parseMappingRows is tolerant and keeps half-typed rows', () => {
        expect(parseMappingRows(undefined)).toEqual([]);
        expect(parseMappingRows('')).toEqual([]);
        expect(parseMappingRows('nope')).toEqual([]);
        expect(parseMappingRows('{"omnibus":"/a"}')).toEqual([]);
        expect(parseMappingRows('[null, 3, {"omnibus":"/a","komga":7}, {"omnibus":"/x","komga":"/y","extra":1}]'))
            .toEqual([{ omnibus: '/a', komga: '' }, { omnibus: '/x', komga: '/y' }]);
    });

    it('serializeMappingRows writes exactly {omnibus, komga} rows', () => {
        expect(serializeMappingRows([])).toBe('[]');
        expect(serializeMappingRows([{ omnibus: '/a', komga: '/b', extra: 1 } as any])).toBe('[{"omnibus":"/a","komga":"/b"}]');
        const rows = [{ omnibus: '/data/comics', komga: '/comics' }];
        expect(parseMappingRows(serializeMappingRows(rows))).toEqual(rows);
    });

    it('isStrongWarning matches the "Strongly discouraged:" prefix only', () => {
        expect(isStrongWarning('Strongly discouraged: convertToCbz is on')).toBe(true);
        expect(isStrongWarning('  strongly discouraged: repairExtensions')).toBe(true);
        expect(isStrongWarning('hashFiles is off (strongly discouraged)')).toBe(false);
    });

    it('isVersionBelow compares the leading x.y.z and ignores build suffixes', () => {
        expect(isVersionBelow('1.22.0', '1.23.3')).toBe(true);
        expect(isVersionBelow('1.23.2', '1.23.3')).toBe(true);
        expect(isVersionBelow('1.23.3', '1.23.3')).toBe(false);
        expect(isVersionBelow('1.28.1-SNAPSHOT', '1.23.3')).toBe(false);
        expect(isVersionBelow('2.0', '1.23.3')).toBe(false);
        expect(isVersionBelow('v1.9.10', '1.10.0')).toBe(true);
        expect(isVersionBelow(null, '1.23.3')).toBe(false);
        expect(isVersionBelow('unknown', '1.23.3')).toBe(false);
    });
});
