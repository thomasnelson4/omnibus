// Keep the fallback list and URL normalization aligned with annas_archive.rs.
export const DEFAULT_ANNAS_MIRRORS = [
    'https://annas-archive.gl',
    'https://annas-archive.se',
    'https://annas-archive.li',
    'https://annas-archive.org',
];

export function normalizeAnnasMirror(raw: string): string {
    const value = raw.trim();
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
            url.search || url.hash || !/^\/*$/.test(url.pathname)) {
            throw new Error('Invalid mirror');
        }
        return url.origin;
    } catch {
        throw new Error(`Invalid Anna's Archive mirror URL: ${value}. Use an HTTP or HTTPS address without a path, query, or credentials.`);
    }
}

export function parseAnnasMirrors(raw?: string | null): string[] {
    return [...new Set((raw || '').split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean).map(normalizeAnnasMirror))];
}

export function annasMirrorCandidates(baseUrl?: string | null, mirrors?: string | null, preferredUrl?: string): string[] {
    const primary = normalizeAnnasMirror(baseUrl?.trim() || DEFAULT_ANNAS_MIRRORS[0]);
    const candidates = [primary, ...parseAnnasMirrors(mirrors), ...DEFAULT_ANNAS_MIRRORS];
    if (preferredUrl) candidates.unshift(normalizeAnnasMirror(new URL(preferredUrl).origin));
    return [...new Set(candidates)];
}
