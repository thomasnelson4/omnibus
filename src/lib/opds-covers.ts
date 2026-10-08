// src/lib/opds-covers.ts
//
// OPDS covers. Feeds used to link every non-remote cover as `/api/library/cover?path=…`, which the
// middleware 401s for an OPDS client (it has an OPDS key, never a session cookie) — so custom and
// local covers never loaded, and the links exposed server folder paths. Feeds now link the
// API-key routes under /api/opds/cover, which hand off to the cover route in-process (see
// lib/komga/cover.ts), always at a fixed width: the cover route then serves a disk-cached WebP,
// so every cover is the same type, bounded in size, and fetched from the provider at most once.

/** `image` width: big enough for a detail page. */
export const OPDS_COVER_WIDTH = '1024';
/** `image/thumbnail` width: a grid tile (#221). */
export const OPDS_THUMB_WIDTH = '320';

// The cover route's own cached widths (ALLOWED_WIDTHS in api/library/cover/route.ts).
const ALLOWED = new Set(['160', '320', '480', '640', '1024']);

/** The width a cover request asks for, limited to the cover route's cached widths. */
export function opdsCoverWidth(req: Request): string {
    const w = new URL(req.url).searchParams.get('w');
    return w && ALLOWED.has(w) ? w : OPDS_COVER_WIDTH;
}

/** The image + thumbnail links for a series or issue entry. */
export function opdsCoverLinks(baseUrl: string, kind: 'series' | 'issue', id: string): string {
    const href = `${baseUrl}/api/opds/cover/${kind}/${encodeURIComponent(id)}`;
    return `<link rel="http://opds-spec.org/image" href="${href}" type="image/webp"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="${href}?w=${OPDS_THUMB_WIDTH}" type="image/webp"/>`;
}
