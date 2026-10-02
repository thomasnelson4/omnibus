// Pure matching input contract. No database, queue, network or browser dependencies.
import { normalizeFractionNumbers, stripSeriesPrefix } from '@/lib/utils/issue-parser';

export const MATCH_VERSION = 'evidence-1';
export type Provider = 'COMICVINE' | 'METRON';
export type Domain = 'regular' | 'annual' | 'collected';
export interface Signal<T> { value: T; source: string; confidence: 'high' | 'medium' | 'low' }
export interface ParsedSignals {
    title: string;
    alternateTitles: string[];
    issue?: Signal<string>;
    domain: Domain;
    publicationYear?: Signal<number>;
    seriesYear?: Signal<number>;
    run?: Signal<number>;
    publisher?: Signal<string>;
    format?: Signal<string>;
    releaseTags: string[];
    warnings: string[];
}
export interface ExactId { provider: Provider; id: string; kind: 'series' | 'issue'; source: string; issueNumber?: string; domain?: Domain }
export interface MatchEvidence {
    parsed: ParsedSignals;
    files: ParsedSignals[];
    ids: ExactId[];
    incomplete: boolean;
    fingerprintData?: unknown;
}

export function canonicalNumber(value: unknown): string {
    const s = normalizeFractionNumbers(String(value ?? '').trim()).replace(/^#\s*/, '');
    const m = s.match(/^(-?)(\d+)(\.\d+)?\s*([a-z]*)$/i);
    if (!m) return s.toUpperCase();
    return `${Number(m[1] + m[2] + (m[3] || ''))}${m[4].toUpperCase()}`;
}

export function titleTokens(s: string): Set<string> {
    return new Set(s.normalize('NFKC').toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean));
}
/** Set Dice is symmetric and bounded, including duplicate words. */
export function titleSimilarity(a: string, b: string): number {
    const ta = titleTokens(a), tb = titleTokens(b);
    if (!ta.size || !tb.size) return 0;
    return 2 * [...ta].filter(t => tb.has(t)).length / (ta.size + tb.size);
}

/** One collected/annual vocabulary for filenames, ComicInfo/series.json formats, provider series
 *  types and candidate names (word-bounded: "HC" never matches "Hardcore", "GN" never "Gnome"). */
export const COLLECTED_FORMAT = /\b(?:tpb|trade paperbacks?|hard ?covers?|hc|gn|graphic novels?|omnibus|compendium|manga|collected)\b/i;
export const isCollectedFormat = (text: string): boolean => COLLECTED_FORMAT.test(text);
export const isAnnualFormat = (text: string): boolean => /\bannual\b/i.test(text);

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const signal = <T>(value: T, source: string, confidence: Signal<T>['confidence'] = 'high'): Signal<T> => ({ value, source, confidence });

/** A filename's bracketed year is publication evidence; a series label's is run evidence.
 * Bare 19xx/20xx tokens are titles unless explicitly annotated. Numberless files stay unknown. */
export function parseSignals(name: string, kind: 'filename' | 'series' = 'series', knownSeries?: string): ParsedSignals {
    let text = name.replace(/\.(cbz|cbr|zip|rar|epub|pdf|cb7|7z)$/i, '');
    text = normalizeFractionNumbers(text).replace(/_/g, ' ');
    // "Batman.001.(2016)" is dot-separated release style; a spaced name keeps abbreviation dots
    // ("Kaiju No. 8", "Mr. Miracle") so the title survives verbatim. Decimal issues always survive.
    if (!/\s/.test(text)) text = text.replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
    const result: ParsedSignals = { title: '', alternateTitles: [], domain: 'regular', releaseTags: [], warnings: [] };
    text = text.replace(/[([{]\s*((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?\s*[)\]}]/g, (all, y, end) => {
        const field = kind === 'series' || end ? 'seriesYear' : 'publicationYear';
        if (result[field] && result[field]!.value !== Number(y)) result.warnings.push('Conflicting annotated years');
        result[field] = signal(Number(y), end ? 'year range' : `${kind} bracketed year`, end ? 'high' : 'medium');
        return ' ';
    });
    text = text.replace(/[([{]([^\])}]+)[)\]}]/g, (all, raw) => {
        const tag = squash(raw);
        if (/^(dc(?: comics)?|marvel(?: comics)?|image(?: comics)?|dark horse(?: comics)?|boom!? studios|idw|vertigo|dynamite)$/i.test(tag)) {
            result.publisher = signal(tag, 'filename publisher');
        } else if (/^(digital|retail|web|scan|scanned|c2c|noads|empire|zone[- ]empire|dcp|minutemen|[^ ]*[- ]empire|\d+ of \d+)$/i.test(tag)) {
            result.releaseTags.push(tag);
        } else if (/^(tpb|hc|hard ?cover|trade paperback|gn|graphic novel|omnibus|compendium|annual)$/i.test(tag)) {
            result.format = signal(tag, 'filename format');
        } else {
            result.alternateTitles.push(squash(text.replace(all, ' ')));
            result.warnings.push(`Unclassified annotation: ${tag}`);
            result.releaseTags.push(tag);
        }
        return ' ';
    });
    const fmt = text.match(/\b(trade paperback|tpb|hard ?cover|hc|gn|graphic novel|omnibus|compendium|annual)\b/i)?.[1];
    if (fmt) result.format = signal(fmt, `${kind} format`);
    const format = result.format?.value || '';
    result.domain = isAnnualFormat(format) ? 'annual' : isCollectedFormat(format) ? 'collected' : 'regular';
    text = text.replace(/\b(?:vol(?:ume)?\s*\.?|v)\s*(\d+)\b/gi, (all, n, offset) => {
        // Volume=2020 is a series-start year, volume=3 is a run ordinal.
        if (Number(n) >= 1900 && Number(n) <= 2099) result.seriesYear = signal(Number(n), 'volume year');
        else {
            const tail = text.slice(offset + all.length).trim();
            if (kind === 'filename' && !tail) {
                result.issue = signal(canonicalNumber(n), 'filename volume numbering', 'medium');
                result.domain = 'collected';
                result.format ||= signal('volume', 'filename volume numbering', 'medium');
                result.warnings.push('Volume numbering may mean a collected/manga volume or a run ordinal');
            } else result.run = signal(Number(n), 'run volume');
        }
        return ' ';
    });
    text = squash(text);
    const remainder = knownSeries ? stripSeriesPrefix(text, knownSeries.replace(/_/g, ' ')) : null;
    const issueText = remainder !== null ? squash(remainder) : text;
    const explicit = issueText.match(/(?:#|\b(?:issue|chapter)\s*#?)\s*(-?\d+(?:\.\d+)?[a-z]*)\b/i);
    const trailing = issueText.match(/(?:^|\s)(-?\d+(?:\.\d+)?[a-z]*)\s*$/i);
    const token = explicit?.[1] || trailing?.[1];
    const titleNumber = /\b(?:no|number)\s*\.?\s*\d+$/i.test(text) || (token && /^(?:19|20)\d{2}$/.test(token) && !result.publicationYear);
    if (token && (explicit || kind === 'filename' && !titleNumber)) {
        result.issue = signal(canonicalNumber(token), explicit ? 'explicit issue marker' : knownSeries ? 'known series prefix' : 'filename trailing number', explicit || knownSeries || /^0\d/.test(token) ? 'high' : 'medium');
        text = explicit ? text.slice(0, text.indexOf(explicit[0])) : text.replace(new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), ' ');
    }
    if (kind === 'series' && explicit) result.warnings.push('Issue marker in series label');
    // TPB/HC are presentation labels. Compendium/Omnibus can be provider identities: retain them.
    text = squash(text.replace(/\b(tpb|trade paperback|hc|hardcover)\b/gi, ' '));
    result.title = knownSeries && remainder !== null ? squash(knownSeries) : text || squash(name);
    if (result.domain === 'collected') result.alternateTitles.push(squash(result.title.replace(/\b(omnibus|compendium)\b(?:\s+(?:one|two|three|\d+))?/gi, ' ')));
    result.alternateTitles = [...new Set(result.alternateTitles.map(squash))].filter(t => t && t !== result.title).slice(0, 2);
    return result;
}
