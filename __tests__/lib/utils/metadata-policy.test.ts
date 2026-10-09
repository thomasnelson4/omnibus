import { describe, expect, it } from 'vitest';
import { guessBookTypeFromCvVolume, isCvRateLimited, isRealGenre, resolveSyncedReleaseDate } from '@/lib/utils/metadata-policy';

describe('metadata provider policies', () => {
    it('treats both ComicVine rate-limit statuses as fatal to a batch', () => {
        expect(isCvRateLimited(420)).toBe(true);
        expect(isCvRateLimited(429)).toBe(true);
        expect(isCvRateLimited(500)).toBe(false);
    });
    it('filters concept noise without losing real genres', () => {
        expect(isRealGenre(' Superhero ')).toBe(true);
        expect(isRealGenre('Science Fiction')).toBe(true);
        expect(isRealGenre('Homage Covers')).toBe(false);
        expect(isRealGenre('Variant Cover: Action Figure')).toBe(false);
    });
    it('does not label a new or undated one-issue series as a one-shot', () => {
        expect(guessBookTypeFromCvVolume({count_of_issues: 1, start_year: 2026}, 2026)).toBeNull();
        expect(guessBookTypeFromCvVolume({count_of_issues: 1}, 2026)).toBeNull();
        expect(guessBookTypeFromCvVolume({count_of_issues: 1, start_year: '2006'}, 2026)).toBe('OneShot');
        expect(guessBookTypeFromCvVolume({name: 'Batman Hardcover', count_of_issues: 1}, 2026)).toBe('TPB');
    });
    it('preserves file dates but keeps upcoming schedule dates current', () => {
        expect(resolveSyncedReleaseDate('2017-06-30', '2017-04-19', false, true, true)).toBe('2017-06-30');
        expect(resolveSyncedReleaseDate('2026-10-01', '2026-11-01', false, true, false)).toBe('2026-11-01');
        expect(resolveSyncedReleaseDate(null, '2026-11-01', false, true, true)).toBe('2026-11-01');
        expect(resolveSyncedReleaseDate('2026-10-01', '2026-11-01', true, true, false)).toBe('2026-10-01');
    });
});
