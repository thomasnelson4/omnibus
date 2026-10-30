// @vitest-environment jsdom
// __tests__/components/site-footer.test.tsx
// The data credits every page carries (2026-10-14). Metron's data is licensed CC BY-SA 4.0, which
// asks for a credit, a link to the source and the license, and a note that the data may have been
// changed - one line in a footer is enough. ComicVine's API terms ask apps to link back to it on any
// page that uses its data. Cover images belong to their publishers: neither data license covers them.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SiteFooter } from '@/components/site-footer';

describe('SiteFooter: the data credits', () => {
    it('credits ComicVine and Metron, with links back to both', () => {
        render(<SiteFooter />);

        expect(screen.getByRole('link', { name: 'ComicVine' })).toHaveAttribute('href', 'https://comicvine.gamespot.com/');
        expect(screen.getByRole('link', { name: 'Metron' })).toHaveAttribute('href', 'https://metron.cloud/');
    });

    it('names Metron\'s license, links to it, and says the data may be edited', () => {
        render(<SiteFooter />);

        expect(screen.getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by-sa/4.0/');
        expect(screen.getByTestId('data-credits')).toHaveTextContent(/may be edited/i);
    });

    it('says the covers belong to their publishers', () => {
        render(<SiteFooter />);

        expect(screen.getByTestId('data-credits')).toHaveTextContent(/covers .*publishers/i);
    });

    it('opens the credit links in a new tab, without handing over the page', () => {
        render(<SiteFooter />);

        for (const name of ['ComicVine', 'Metron', 'CC BY-SA 4.0']) {
            const link = screen.getByRole('link', { name });
            expect(link).toHaveAttribute('target', '_blank');
            expect(link.getAttribute('rel')).toContain('noreferrer');
        }
    });
});
