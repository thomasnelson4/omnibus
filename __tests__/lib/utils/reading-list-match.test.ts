// __tests__/lib/utils/reading-list-match.test.ts
import { describe, it, expect } from 'vitest';
import {
    buildReadingListItemTitle, isDownloaded, isMatchProvider, isUsableSecret, libraryCannotContradict,
    linkedIssueRequest, matchSearchPrefill, normalizeIssueNo, parseProviderIssueId, parseReadingListTitle,
    pickPreferredIssue, providerIssueUrl, providerLabel, providerShortLabel, readingListItemLabel,
    MAX_PROVIDER_ISSUE_ID,
} from '@/lib/utils/reading-list-match';

describe('parseProviderIssueId — ComicVine', () => {
    it.each([
        ['12345', 12345],
        [' 4000-12345 ', 12345],
        ['https://comicvine.gamespot.com/uncanny-x-men-141-days-of-future-past/4000-20288/', 20288],
        ['https://comicvine.gamespot.com/issue/4000-20288/', 20288],
        ['CVDB20288', 20288],
        ['cvdb20288', 20288],
        [20288, 20288],
        [String(MAX_PROVIDER_ISSUE_ID), MAX_PROVIDER_ISSUE_ID],
    ])('accepts %j', (raw, id) => {
        expect(parseProviderIssueId('COMICVINE', raw)).toEqual({ ok: true, id });
    });

    it('names a volume id instead of looking it up', () => {
        const r = parseProviderIssueId('COMICVINE', '4050-12345');
        expect(r).toEqual({ ok: false, error: expect.stringContaining('volume ID (4050-') });
        expect(parseProviderIssueId('COMICVINE', 'https://comicvine.gamespot.com/uncanny-x-men/4050-2133/'))
            .toMatchObject({ ok: false, error: expect.stringContaining('volume ID') });
    });

    it('rejects a ComicVine link without an issue id', () => {
        expect(parseProviderIssueId('COMICVINE', 'https://comicvine.gamespot.com/x/'))
            .toEqual({ ok: false, error: "Couldn't find a ComicVine issue ID (4000-…) in that link." });
    });

    it('suggests Metron for a metron.cloud link', () => {
        expect(parseProviderIssueId('COMICVINE', 'https://metron.cloud/issue/4521/'))
            .toEqual({ ok: false, error: expect.stringContaining('Metron link'), suggestProvider: 'METRON' });
    });

    it.each(['0', '-5', '1.5', 'abc', '2147483648', '14000-123', '9007199254740993', -5, 1.5, 0, Number.NaN])(
        'rejects %j as a non-positive / non-numeric id',
        raw => {
            expect(parseProviderIssueId('COMICVINE', raw))
                .toEqual({ ok: false, error: 'Enter a positive numeric issue ID from the selected provider.' });
        },
    );

    it.each(['', '   ', null, undefined, { not: '' }, ['1']])('asks for an id when given %j', raw => {
        expect(parseProviderIssueId('COMICVINE', raw)).toEqual({ ok: false, error: 'Enter an issue ID.' });
    });
});

describe('parseProviderIssueId — Metron', () => {
    it.each([
        ['4521', 4521],
        ['https://metron.cloud/issue/4521/', 4521],
        ['https://metron.cloud/issue/4521', 4521],
        ['https://metron.cloud/api/issue/4521/?format=json', 4521],
        [4521, 4521],
    ])('accepts %j', (raw, id) => {
        expect(parseProviderIssueId('METRON', raw)).toEqual({ ok: true, id });
    });

    it('explains that slugged Metron links cannot be resolved', () => {
        expect(parseProviderIssueId('METRON', 'https://metron.cloud/issue/saga-2012-1/'))
            .toEqual({ ok: false, error: expect.stringContaining('name slug') });
    });

    it('suggests ComicVine for CV ids and links', () => {
        expect(parseProviderIssueId('METRON', '4000-20288'))
            .toEqual({ ok: false, error: expect.stringContaining('ComicVine ID'), suggestProvider: 'COMICVINE' });
        expect(parseProviderIssueId('METRON', 'https://comicvine.gamespot.com/x/4000-20288/'))
            .toMatchObject({ ok: false, suggestProvider: 'COMICVINE' });
    });

    it('rejects other links and non-numeric input', () => {
        expect(parseProviderIssueId('METRON', 'https://example.com/issue/1/'))
            .toEqual({ ok: false, error: "That doesn't look like a Metron issue link." });
        expect(parseProviderIssueId('METRON', 'CVDB1')).toMatchObject({ ok: false, error: expect.stringContaining('positive numeric') });
        expect(parseProviderIssueId('METRON', '0')).toMatchObject({ ok: false });
    });
});

describe('normalizeIssueNo', () => {
    it.each([
        ['001', '1'], ['0', '0'], ['00', '0'], ['-001', '-1'], ['½', '0.5'], ['13½', '13.5'],
        ['0.5', '0.5'], [' 12 ', '12'], [null, ''], [undefined, ''], [7, '7'], ['012AU', '12AU'],
    ])('%j → %j', (input, out) => {
        expect(normalizeIssueNo(input as any)).toBe(out);
    });
});

describe('parseReadingListTitle', () => {
    it.each([
        ['Uncanny X-Men (1963) #141', { series: 'Uncanny X-Men', number: '141', year: 1963 }],
        ['Batman #½', { series: 'Batman', number: '0.5', year: null }],
        ['Saga #13½', { series: 'Saga', number: '13.5', year: null }],
        ['X-Men #154: Lifedeath', { series: 'X-Men', number: '154', year: null }],
        ['Kaiju No. 8 #3', { series: 'Kaiju No. 8', number: '3', year: null }],
        ['Batman #001', { series: 'Batman', number: '1', year: null }],
        ['Batman #1 (2016)', { series: 'Batman', number: '1', year: 2016 }],
        ['Part One', { series: 'Part One', number: '', year: null }],
        ['', { series: '', number: '', year: null }],
        ['Batman [2016] #-1', { series: 'Batman', number: '-1', year: 2016 }],
        ['Spider-Man 2099 #1', { series: 'Spider-Man 2099', number: '1', year: null }],
    ])('%j', (title, expected) => {
        expect(parseReadingListTitle(title)).toEqual(expected);
    });

    it('takes the LAST #N as the issue', () => {
        expect(parseReadingListTitle('Batman #1 #2')).toMatchObject({ series: 'Batman #1', number: '2' });
    });

    it('tolerates null', () => {
        expect(parseReadingListTitle(null)).toEqual({ series: '', number: '', year: null });
    });
});

describe('buildReadingListItemTitle', () => {
    it.each([
        [['X-Men', '154'], 'X-Men #154'],
        [['Saga', '13½'], 'Saga #13.5'],
        [[null, '3'], 'Issue #3'],
        [['Saga', ''], 'Saga'],
        [['  Saga  ', '001'], 'Saga #1'],
        [[null, ''], 'Unknown issue'],
    ])('%j → %j', ([s, n], out) => {
        expect(buildReadingListItemTitle(s as any, n as any)).toBe(out);
    });
});

describe('matchSearchPrefill', () => {
    it('uses the linked issue with a parenthesized year', () => {
        expect(matchSearchPrefill({ title: '', issue: { number: '141', series: { name: 'X-Men', year: 1991 } } }))
            .toEqual({ query: 'X-Men (1991)', number: '141', annual: false });
    });

    it('omits a 0 / missing year', () => {
        expect(matchSearchPrefill({ title: '', issue: { number: '2', series: { name: 'Saga', year: 0 } } }))
            .toEqual({ query: 'Saga', number: '2', annual: false });
    });

    it('prefills annuals as "Series Annual"', () => {
        expect(matchSearchPrefill({ title: '', issue: { number: '1', isAnnual: true, series: { name: 'X-Men', year: 1991 } } }))
            .toEqual({ query: 'X-Men Annual', number: '1', annual: true });
    });

    it('parses unlinked titles', () => {
        expect(matchSearchPrefill({ title: 'Uncanny X-Men (1963) #141', issue: null }))
            .toEqual({ query: 'Uncanny X-Men (1963)', number: '141', annual: false });
        expect(matchSearchPrefill({ title: 'Part One', issue: null })).toEqual({ query: 'Part One', number: '', annual: false });
    });
});

describe('libraryCannotContradict', () => {
    it.each([
        [{ metadataSource: 'LOCAL', metadataId: 'unmatched_x' }, 'COMICVINE', true],
        [{ metadataSource: 'COMICVINE', metadataId: 'unmatched_x' }, 'COMICVINE', true],
        [{ metadataSource: 'COMICVINE', metadataId: '999' }, 'COMICVINE', false],
        [{ metadataSource: 'METRON', metadataId: '5' }, 'COMICVINE', true],
        [{ metadataSource: 'METRON', metadataId: '5' }, 'METRON', false],
        [{ metadataSource: 'COMICVINE', metadataId: null }, 'COMICVINE', true],
    ])('%j vs %s → %s', (issue, provider, out) => {
        expect(libraryCannotContradict(issue, provider as any)).toBe(out);
    });
});

describe('linkedIssueRequest', () => {
    const now = new Date('2026-05-01T00:00:00Z');
    const series = { name: 'X-Men', year: 1991, publisher: 'Marvel', metadataId: '4511', metadataSource: 'COMICVINE' };

    it('files against the series volume with the shared request name', () => {
        expect(linkedIssueRequest({ issue: { number: '142', name: 'Lifedeath', series } }, now)).toEqual({
            cvId: '4511', name: 'X-Men #142: Lifedeath', issueNumber: '142', year: '1991', publisher: 'Marvel',
            metadataSource: 'COMICVINE', releaseDate: null,
        });
    });

    it('marks annuals and normalizes fractions', () => {
        expect(linkedIssueRequest({ issue: { number: '1', isAnnual: true, series } }, now)).toMatchObject({ name: 'X-Men Annual #1', issueNumber: '1' });
        expect(linkedIssueRequest({ issue: { number: '13½', series } }, now)).toMatchObject({ issueNumber: '13.5', name: 'X-Men #13.5' });
    });

    it('passes the release date through and defaults year/publisher', () => {
        expect(linkedIssueRequest({ issue: { number: '2', releaseDate: '2027-01-01', series: { ...series, year: 0, publisher: null } } }, now))
            .toMatchObject({ releaseDate: '2027-01-01', year: '2026', publisher: 'Unknown' });
    });

    it('returns null for unmatched / LOCAL series and unlinked entries', () => {
        expect(linkedIssueRequest({ issue: { number: '1', series: { ...series, metadataId: 'unmatched_9' } } }, now)).toBeNull();
        expect(linkedIssueRequest({ issue: { number: '1', series: { ...series, metadataSource: 'LOCAL' } } }, now)).toBeNull();
        expect(linkedIssueRequest({ title: 'X-Men #1', issue: null }, now)).toBeNull();
        expect(linkedIssueRequest({ issue: { number: '1', series: null } }, now)).toBeNull();
    });
});

describe('small helpers', () => {
    it('pickPreferredIssue prefers a file-backed row, else the first', () => {
        const a = { id: 'a', filePath: null }, b = { id: 'b', filePath: '  ' }, c = { id: 'c', filePath: '/x.cbz' };
        expect(pickPreferredIssue([a, b, c])).toBe(c);
        expect(pickPreferredIssue([a, b])).toBe(a);
        expect(pickPreferredIssue([])).toBeNull();
    });

    it('isDownloaded treats blank paths as not downloaded', () => {
        expect(isDownloaded({ issue: { filePath: '/c/x.cbz' } })).toBe(true);
        expect(isDownloaded({ issue: { filePath: '   ' } })).toBe(false);
        expect(isDownloaded({ issue: { filePath: null } })).toBe(false);
        expect(isDownloaded({ issue: null })).toBe(false);
    });

    it('providerIssueUrl / labels', () => {
        expect(providerIssueUrl('COMICVINE', 20288)).toBe('https://comicvine.gamespot.com/issue/4000-20288/');
        expect(providerIssueUrl('METRON', 4521)).toBe('https://metron.cloud/issue/4521/');
        expect(providerLabel('METRON')).toBe('Metron');
        expect(providerLabel('COMICVINE')).toBe('ComicVine');
        expect(providerLabel(undefined)).toBe('ComicVine');
        expect(providerShortLabel('COMICVINE')).toBe('CV');
        expect(providerShortLabel('METRON')).toBe('Metron');
    });

    it('readingListItemLabel', () => {
        expect(readingListItemLabel({ issue: { number: '1', isAnnual: true, series: { name: 'X-Men' } } })).toBe('X-Men Annual #1');
        expect(readingListItemLabel({ issue: { number: '141', series: { name: 'X-Men' } } })).toBe('X-Men #141');
        expect(readingListItemLabel({ title: 'Part One' })).toBe('Part One');
        expect(readingListItemLabel({ title: '' })).toBe('this entry');
    });

    it('isMatchProvider / isUsableSecret', () => {
        expect(isMatchProvider('COMICVINE')).toBe(true);
        expect(isMatchProvider('METRON')).toBe(true);
        expect(isMatchProvider('ANILIST')).toBe(false);
        expect(isMatchProvider(undefined)).toBe(false);
        expect(isUsableSecret('key')).toBe(true);
        expect(isUsableSecret('********')).toBe(false);
        expect(isUsableSecret('enc:v2:abc')).toBe(false);
        expect(isUsableSecret('')).toBe(false);
        expect(isUsableSecret(null)).toBe(false);
    });
});
