// @vitest-environment jsdom
// The API Guide's live tester (found in the v1.4.7 permission sweep). It used to read the key from
// the admin settings, which only ever return a stored secret as `********` — so it sent the mask and
// got a 401 every time (and before v1.4.7 that 401 signed the admin out). Keys made under Settings →
// Access & Security are stored hashed and can't be read back by anything, so the tester takes a
// pasted key instead: the same request Homepage will make, with the key the admin will give it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ok, err, stubFetchRouter } from '../../helpers/fetch';

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import ApiGuidePage from '@/app/admin/api-guide/page';

const GOOD_KEY = 'omni_live_key_123';

describe('API Guide live tester', () => {
    let fetchMock: ReturnType<typeof stubFetchRouter>;

    beforeEach(() => {
        fetchMock = stubFetchRouter([
            ['/api/v1/stats', (_u, init) => init?.headers?.['x-api-key'] === GOOD_KEY
                ? ok({ success: true, data: { systemHealth: 'Healthy', totalSeries: 7 } }).then(r => ({ ...r, status: 200 }))
                : err(401, { error: 'Invalid API Key.' })],
        ]);
    });

    it('never reads the admin settings — a stored key only ever comes back masked', async () => {
        await act(async () => { render(<ApiGuidePage />); });

        expect(fetchMock.mock.calls.map(c => String(c[0]))).not.toContain('/api/admin/config');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps Test Endpoint disabled until a key is pasted', async () => {
        await act(async () => { render(<ApiGuidePage />); });
        const button = screen.getByRole('button', { name: /test endpoint/i });
        expect(button).toBeDisabled();

        fireEvent.change(screen.getByLabelText(/api key to test/i), { target: { value: '   ' } });
        expect(button).toBeDisabled();

        fireEvent.change(screen.getByLabelText(/api key to test/i), { target: { value: GOOD_KEY } });
        expect(button).toBeEnabled();
    });

    it('sends the pasted key as x-api-key to /api/v1/stats and shows the payload', async () => {
        await act(async () => { render(<ApiGuidePage />); });
        fireEvent.change(screen.getByLabelText(/api key to test/i), { target: { value: `  ${GOOD_KEY}  ` } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /test endpoint/i })); });

        const [url, init] = fetchMock.mock.calls.at(-1)!;
        expect(String(url)).toBe('/api/v1/stats');
        expect((init as any).headers['x-api-key']).toBe(GOOD_KEY);
        expect(screen.getByText(/"totalSeries": 7/)).toBeTruthy();
        expect(screen.getByText(/HTTP 200/)).toBeTruthy();
    });

    it('shows the refusal and its status when the key is wrong', async () => {
        await act(async () => { render(<ApiGuidePage />); });
        fireEvent.change(screen.getByLabelText(/api key to test/i), { target: { value: 'not-a-key' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /test endpoint/i })); });

        expect(screen.getByText(/Invalid API Key\./)).toBeTruthy();
        expect(screen.getByText(/HTTP 401/)).toBeTruthy();
    });
});
