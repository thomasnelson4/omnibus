// @vitest-environment jsdom
// #215: a collected edition you own reads like any issue. The Collected Editions shelf only let you
// select a card (the reader was reachable through the sidebar's Read Selected, off-screen), so owned
// books get the same Read/Resume button and read/progress badge as the downloaded issues. The
// button must not leak its click to the card behind it (the card selects the book).
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// A plain anchor stands in for next/link: no router in jsdom, and the click behaviour under test
// (stopPropagation) belongs to the button, not the link.
vi.mock('next/link', () => ({
    default: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a>,
}));

import { CollectedReadButton, CollectedProgressBadge } from '@/components/collected-read-button';

const book = (over: Partial<{ fullPath: string; isRead: boolean; readProgress: number }> = {}) => ({
    fullPath: '/comics/Image/Spawn (1992)/Spawn Compendium Vol. 01.cbz',
    isRead: false,
    readProgress: 0,
    ...over,
});

describe('CollectedReadButton', () => {
    it('opens the book in the reader with the series as context', () => {
        render(<CollectedReadButton book={book()} seriesFolder="/comics/Image/Spawn (1992)" />);
        const link = screen.getByRole('link', { name: 'Read' });
        const href = new URL(link.getAttribute('href')!, 'http://omnibus.local');
        expect(href.pathname).toBe('/reader');
        expect(href.searchParams.get('path')).toBe('/comics/Image/Spawn (1992)/Spawn Compendium Vol. 01.cbz');
        expect(href.searchParams.get('series')).toBe('/comics/Image/Spawn (1992)');
    });

    it('says Resume part-way through, and Read when unread or finished', () => {
        const { rerender } = render(<CollectedReadButton book={book({ readProgress: 42 })} seriesFolder="/s" />);
        expect(screen.getByRole('link').textContent).toBe('Resume');

        rerender(<CollectedReadButton book={book({ readProgress: 100 })} seriesFolder="/s" />);
        expect(screen.getByRole('link').textContent).toBe('Read');

        rerender(<CollectedReadButton book={book({ readProgress: 60, isRead: true })} seriesFolder="/s" />);
        expect(screen.getByRole('link').textContent).toBe('Read');
    });

    it('does not select the card behind it when clicked', () => {
        const selectCard = vi.fn();
        render(
            <div onClick={selectCard}>
                <CollectedReadButton book={book()} seriesFolder="/s" />
            </div>
        );
        fireEvent.click(screen.getByRole('link'));
        expect(selectCard).not.toHaveBeenCalled();
    });
});

describe('CollectedProgressBadge', () => {
    it('shows a read check, a percentage part-way through, and nothing when unread', () => {
        const { container, rerender } = render(<CollectedProgressBadge book={book({ isRead: true })} />);
        expect(screen.getByLabelText('Read')).toBeTruthy();

        rerender(<CollectedProgressBadge book={book({ readProgress: 42.4 })} />);
        expect(screen.getByText('42%')).toBeTruthy();

        rerender(<CollectedProgressBadge book={book()} />);
        expect(container.textContent).toBe('');
        expect(screen.queryByLabelText('Read')).toBeNull();
    });
});
