// src/lib/utils/naming.ts
//
// Naming: the one place a series folder or an issue's file name is built from a naming pattern.
//
// EXACT TWIN of the engine's omnibus-engine/src/naming.rs. Both sides must turn the same inputs
// into byte-identical names - a file lands under the same name whichever door it came through
// (an import, the Smart Matcher, a manual link, the watched folder, Standardize). Pinned by
// omnibus-engine/tests/fixtures/naming_parity.json, which both test suites read.
//
// The rules, in short:
//   - one pass over the pattern: every {Token} (any case) is looked up once and its value is
//     inserted literally - a value is never expanded again, and "$&" in metadata stays "$&";
//   - an unknown token stays as written;
//   - {Issue} is padded by the issue_number_padding setting (#244), default 3 digits;
//   - a year that isn't 1900-2100 is no year: it leaves no "(0000)" and no empty "()";
//   - a folder is plain path segments (never "..", ".", a dots-only run or a drive prefix); a file
//     name is sanitized whole, so nothing in it can become a path.
//
// No imports on purpose: the settings preview and the Smart Matcher dialog run this in the browser.

/** The `issue_number_padding` setting: how many digits an issue number's whole part gets (#244). */
export type IssuePadding = 'none' | '2' | '3';

/** "none", "2" or "3"; missing, blank or anything else is the default, 3 digits - the width
 *  Standardize always used, so a standardized library is never renamed by it. */
export function issuePaddingFromSetting(value: unknown): IssuePadding {
    const v = typeof value === 'string' ? value.trim() : '';
    return v === 'none' || v === '2' ? v : '3';
}

const PADDING_WIDTH: Record<IssuePadding, number> = { none: 1, '2': 2, '3': 3 };

// Issue #200: ComicVine numbers half-issues with Unicode vulgar fractions ("½", X-Men (1991)'s
// "Thrall"), which no digit-based rule can see. Rewrite them as decimals - merged with a glued
// preceding integer, so Wizard-era "1½" reads 1.5 - before any parse or comparison. Conservative
// set on purpose: these three are the fractions comic numbering actually uses.
// Engine twin: metadata.rs normalize_fraction_numbers.
const VULGAR_FRACTIONS: Record<string, string> = { '½': '.5', '¼': '.25', '¾': '.75' };

export function normalizeFractionNumbers(s: string): string {
    return s.replace(/(\d+)?([½¼¾])/g, (_, int, frac) => (int || '0') + VULGAR_FRACTIONS[frac]);
}

/** An issue number as a file name shows it: the leading whole number loses its stored zeros and
 *  is padded to the setting's width; everything after it stays as it is ("1.5" → "001.5",
 *  "1A" → "001A", "-1" → "-001"). A fraction is a decimal first ("½" → "000.5"). A number that
 *  doesn't start with digits ("Annual 1") is left alone. */
export function padIssue(number: string | number | null | undefined, padding: IssuePadding): string {
    const normalized = normalizeFractionNumbers(String(number ?? '').trim());
    const sign = normalized.startsWith('-') ? '-' : '';
    const rest = normalized.slice(sign.length);
    const digits = rest.match(/^\d*/)![0];
    const tail = rest.slice(digits.length);
    if (!digits && tail && !tail.startsWith('.')) return normalized;
    return sign + digits.replace(/^0+/, '').padStart(PADDING_WIDTH[padding], '0') + tail;
}

/** A year a name may show: 1900-2100. Anything else - 0 for unknown, a ComicVine id in <Year>,
 *  a placeholder date - is no year. */
function plausibleYear(value: unknown): number | null {
    const year = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null;
}

function yearText(value: unknown): string {
    const year = plausibleYear(value);
    return year === null ? '' : String(year);
}

/** {IssueYear} (#243): the issue's own release year, else the file's ComicInfo <Year>, else the
 *  series year, else nothing. */
export function issueYear(releaseDate: string | null | undefined, comicInfoYear: unknown, seriesYear: unknown): string {
    const fromDate = /^\d{4}/.exec(String(releaseDate ?? '').trim());
    const year = (fromDate ? plausibleYear(fromDate[0]) : null) ?? plausibleYear(comicInfoYear) ?? plausibleYear(seriesYear);
    return year === null ? '' : String(year);
}

/** What a name is built from. Each caller fills what it knows; blanks are fine. */
export interface NamingInput {
    publisher?: string | null;
    /** The {Series} value (a LOCAL collected edition's own name, for its books). */
    series?: string | null;
    /** The series' start year; 0 / blank = unknown. */
    seriesYear?: number | string | null;
    issueNumber?: string | number | null;
    releaseDate?: string | null;
    comicInfoYear?: number | string | null;
    issueTitle?: string | null;
    universe?: string | null;
    seriesGroup?: string | null;
    imprint?: string | null;
}

/** Strips characters invalid in file/folder names and neutralizes dot-only values, so a value can
 *  never become a "." or ".." path segment ("_" instead). Same rules as sanitizeFilename
 *  (utils/sanitize.ts, which pulls in sanitize-html) and the engine's sanitize_component. */
export function sanitizeNamingPart(value: string | null | undefined): string {
    const cleaned = String(value ?? '').replace(/[<>:"/\\|?*]/g, '').trim();
    const safe = cleaned.replace(/^\.+/, '').replace(/\.+$/, '').trim();
    return !safe && cleaned ? '_' : safe;
}

/** Removes what an empty token leaves behind: empty "()" and "[]", and in a file name doubled or
 *  dangling " - " separators; squeezes whitespace. */
function cleanPatternResult(s: string, fileMode: boolean): string {
    let out = s.replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '');
    if (fileMode) out = out.replace(/\s*-\s*-/g, ' - ').replace(/(^\s*-\s*|\s*-\s*$)/g, '');
    return out.replace(/\s+/g, ' ').trim();
}

/** One pass over `pattern`: each {Token} is replaced by its value (looked up by lower-cased
 *  name), inserted literally; a token the table doesn't know stays as written. */
function expandTokens(pattern: string, values: Map<string, string>): string {
    return pattern.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => values.get(name.toLowerCase()) ?? whole);
}

/** A folder segment that can only ever name a folder: not "..", ".", a dots-only run or a drive
 *  prefix. */
function isPlainSegment(segment: string): boolean {
    return !/^\.+$/.test(segment) && !/^[A-Za-z]:/.test(segment);
}

/** The series folder for `pattern`, as the path segments under the library root. Null when a
 *  segment isn't a plain name or nothing is left - a series folder is always a folder INSIDE the
 *  library. Engine twin: folder_segments. */
export function seriesFolderSegments(pattern: string, v: NamingInput): string[] | null {
    const publisherRaw = String(v.publisher ?? '').trim();
    const series = String(v.series ?? '');
    const year = yearText(v.seriesYear);
    const expanded = expandTokens(pattern, new Map([
        ['imprint', sanitizeNamingPart(v.imprint)],
        ['publisher', publisherRaw && publisherRaw !== 'Unknown' ? sanitizeNamingPart(publisherRaw) : 'Other'],
        ['series', sanitizeNamingPart(series.trim() ? series : 'Unknown')],
        ['year', year],
        ['volumeyear', year],
        ['universename', sanitizeNamingPart(v.universe)],
        ['seriesgroup', sanitizeNamingPart(v.seriesGroup)],
    ]));
    const segments = cleanPatternResult(expanded, false).split(/[/\\]/).map(s => s.trim()).filter(Boolean);
    if (segments.length === 0 || !segments.every(isPlainSegment)) return null;
    return segments;
}

/** One issue's file name for `pattern`, without the extension. Null when nothing is left.
 *  Publisher and series go in as they are (the whole name is sanitized at the end, so a name
 *  keeps an inner or trailing period); the other text values are sanitized on the way in.
 *  Engine twin: file_name. */
export function issueFileName(pattern: string, v: NamingInput, padding: IssuePadding): string | null {
    const publisher = String(v.publisher ?? '');
    const series = String(v.series ?? '');
    const year = yearText(v.seriesYear);
    const expanded = expandTokens(pattern, new Map([
        ['imprint', sanitizeNamingPart(v.imprint)],
        ['publisher', publisher.trim() ? publisher : 'Unknown'],
        ['series', series.trim() ? series : 'Unknown'],
        ['year', year],
        ['volumeyear', year],
        ['issueyear', issueYear(v.releaseDate, v.comicInfoYear, v.seriesYear)],
        ['issue', padIssue(v.issueNumber, padding)],
        ['issuetitle', sanitizeNamingPart(v.issueTitle)],
        ['universename', sanitizeNamingPart(v.universe)],
        ['seriesgroup', sanitizeNamingPart(v.seriesGroup)],
    ]));
    const name = sanitizeNamingPart(cleanPatternResult(expanded, true));
    return name || null;
}

/** An issue's title as {IssueTitle} carries it: a provider name that just repeats the series and
 *  number ("Batman #5: I Am Suicide", "Batman #5") loses that prefix. Engine twin: the title
 *  strip in renamer.rs run_bulk_rename. */
export function issueTitleForName(title: string | null | undefined, seriesName: string | null | undefined, number: string | number | null | undefined): string {
    const name = String(title ?? '');
    const series = String(seriesName ?? '');
    if (!series) return name;
    const exact = `${series} #${number ?? ''}`;
    if (name.startsWith(`${exact}: `)) return name.slice(exact.length + 2);
    return name === exact ? '' : name;
}
