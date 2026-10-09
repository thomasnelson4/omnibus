// src/lib/getcomics.ts
//
// The Node GetComics SEARCH stack (GetComicsService.search/performSearch + the FlareSolverr HTML
// fetcher) was retired: every caller now goes through the Rust engine — automation + the retry
// route's recovery search via /api/automation/search, interactive via /api/search/interactive,
// article scraping via /api/getcomics/scrape. What remains here is the engine scrape client and
// the hoster-priority helpers shared by the routes.
import { Logger } from './logger';
import { getErrorMessage } from './utils/error';
import { ENGINE_URL, engineHeaders } from './engine';

/**
 * Resolve a GetComics article to a concrete hoster link via the Rust engine's section-targeting
 * scraper (/api/getcomics/scrape) — instead of the flat Node scrapeDeepLink, which can hand back the
 * wrong volume's archive from a multi-pack page. Pass the request `name` (and per-issue `year`) so the
 * engine can target the section for the requested issue. Returns the top enabled-hoster link; `hoster`
 * is empty when nothing resolved, and `ambiguous` is true when the article is a multi-pack page with no
 * clean match (the caller should NOT grab an arbitrary archive — fall back to a fresh search instead).
 */
export async function scrapeDeepLinkViaEngine(
    articleUrl: string,
    opts?: { name?: string | null; year?: string | null }
): Promise<{ url: string; hoster: string; ambiguous: boolean }> {
    // Only target when the name explicitly names an issue (same marker rule as the engine's caller).
    let issueNum: number | null = null;
    if (opts?.name) {
        const m = opts.name.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(-?\d+(?:\.\d+)?)/i);
        if (m) { const n = parseFloat(m[1]); if (!isNaN(n)) issueNum = n; }
    }
    try {
        const res = await fetch(ENGINE_URL + '/api/getcomics/scrape', {
            method: 'POST',
            headers: engineHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ url: articleUrl, issue_num: issueNum, year: opts?.year ?? null }),
        });
        if (!res.ok) {
            Logger.log(`[GetComics] engine scrape returned ${res.status} for ${articleUrl}`, 'warn');
            return { url: '', hoster: '', ambiguous: false };
        }
        const data = await res.json();
        if (data.ambiguous) return { url: '', hoster: '', ambiguous: true };
        const first = Array.isArray(data.links) && data.links.length > 0 ? data.links[0] : null;
        return first ? { url: first.url, hoster: first.hoster, ambiguous: false } : { url: '', hoster: '', ambiguous: false };
    } catch (e) {
        Logger.log(`[GetComics] engine scrape failed for ${articleUrl}: ${getErrorMessage(e)}`, 'warn');
        return { url: '', hoster: '', ambiguous: false };
    }
}

// --- Shared hoster-priority helpers (kept in lock-step with the Rust engine's getcomics.rs) ---
// The hoster-priority helpers live in a LEAF module (no imports) so client components can share the
// exact same default order as the server without pulling this module's engine/undici dependency chain
// into the browser bundle. Re-exported here so `import { ... } from '@/lib/getcomics'` keeps working.
export * from './hoster-prefs';
