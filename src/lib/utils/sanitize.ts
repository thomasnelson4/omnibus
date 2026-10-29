import sanitizeHtml from 'sanitize-html';
import { sanitizeNamingPart } from '@/lib/utils/naming';

/**
 * Robustly sanitizes HTML strings from external metadata providers.
 * Strips dangerous tags (script, object, iframe) and 
 * dangerous attributes (onerror, onclick, onload).
 */
/**
 * Strips characters that are invalid in file/folder names.
 * Used everywhere Omnibus builds paths from series/publisher names —
 * all callers MUST use this so renames and imports produce identical paths.
 */
export function sanitizeFilename(str: string): string {
    // One rule, kept in naming.ts (no imports, so the browser can use it too): strip illegal
    // characters and neutralize path traversal - a value that is only dots becomes "_", so untrusted
    // ComicInfo metadata can never become a "." or ".." segment of a folder path.
    return sanitizeNamingPart(str);
}

// Wiki bases for resolving the RELATIVE hrefs providers embed in description HTML. ComicVine is
// the notorious one: volume descriptions link characters/arcs/other volumes as root-relative
// paths like /wolverine/4005-1440/, which used to survive sanitization verbatim and 404 against
// the Omnibus origin (fork review 2026-07-29, their #8).
const PROVIDER_WIKI_BASE: Record<string, string> = {
    COMICVINE: 'https://comicvine.gamespot.com',
    METRON: 'https://metron.cloud',
    MANGADEX: 'https://mangadex.org',
};

/** Wiki base URL for a Series.metadataSource value, or null when unknown. */
export function providerWikiBase(source: string | null | undefined): string | null {
    return PROVIDER_WIKI_BASE[String(source || '').toUpperCase()] || null;
}

export function sanitizeDescription(html: string | null | undefined, wikiBase?: string | null): string {
    if (!html) return "";

    return sanitizeHtml(html, {
        allowedTags: [
            'b', 'i', 'em', 'strong', 'a', 'p', 'br', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote'
        ],
        allowedAttributes: {
            'a': ['href', 'target', 'rel']
        },
        allowedSchemes: ['http', 'https', 'mailto'],
        // Forces security best practices for all links, and resolves provider-relative hrefs
        // against the provider's wiki so they stop 404ing on the Omnibus origin. With no base to
        // resolve against, the href is dropped instead — unclickable text beats a guaranteed 404.
        transformTags: {
            'a': (tagName, attribs) => {
                const out: Record<string, string> = { ...attribs, rel: 'noopener noreferrer', target: '_blank' };
                const href = (attribs.href || '').trim();
                const isAbsolute = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href); // scheme or protocol-relative
                if (href && !isAbsolute) {
                    let resolved: string | null = null;
                    if (wikiBase) {
                        try {
                            const url = new URL(href, wikiBase);
                            // Belt and braces: only keep results on the sanctioned schemes, without
                            // relying on the library's post-transform filter ordering.
                            if (url.protocol === 'http:' || url.protocol === 'https:') resolved = url.toString();
                        } catch { /* unparseable → drop the href */ }
                    }
                    if (resolved) out.href = resolved; else delete out.href;
                }
                return { tagName: 'a', attribs: out };
            }
        }
    });
}