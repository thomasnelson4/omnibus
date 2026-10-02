// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MegaAccountFields } from '@/components/mega-account-fields';

const fetchMock = vi.fn();
const account = { id: 'mega-1', username: 'reader@example.com', password: '********', isActive: true };

beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ success: true, message: 'MEGA login successful.' }) });
});

describe('Shared MEGA form for Settings and Setup', () => {
    it('edits email, password, and account enablement through the owner state', () => {
        const change = vi.fn();
        render(<MegaAccountFields account={account} onChange={change} />);
        fireEvent.change(screen.getByLabelText('MEGA Email'), { target: { value: 'updated@example.com' } });
        expect(change).toHaveBeenCalledWith({ username: 'updated@example.com' });
        fireEvent.change(screen.getByLabelText('MEGA Password'), { target: { value: 'new-password' } });
        expect(change).toHaveBeenCalledWith({ password: 'new-password' });
        fireEvent.click(screen.getByRole('switch', { name: 'Use MEGA account' }));
        expect(change).toHaveBeenCalledWith({ isActive: false });
        expect(screen.getByLabelText('MEGA Password')).toHaveAttribute('type', 'password');
    });

    it('tests masked saved credentials by account ID and displays the result', async () => {
        render(<MegaAccountFields account={account} onChange={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Test Account' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('MEGA login successful.'));
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ type: 'mega', config: {
            id: 'mega-1', username: 'reader@example.com', password: '********',
        } });
    });

    it('reports rejected authentication rather than anonymous download availability', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: false, message: 'MEGA rejected the email or password.' }) });
        render(<MegaAccountFields account={account} onChange={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Test Account' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('MEGA rejected'));
        expect(screen.getByRole('status')).toHaveClass('text-destructive');
    });

    it('does not test an incomplete account', () => {
        render(<MegaAccountFields account={{ username: 'reader@example.com' }} onChange={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Test Account' })).toBeDisabled();
    });
});
