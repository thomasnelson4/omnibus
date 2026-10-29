// src/app/komga/api/v2/[...rest]/route.ts — #206 Komga facade: every /komga/api/v2 path no route
// answers, as a Komga-style JSON 404 - the v2 twin of api/v1/[...rest]. Without it a v2 path fell
// through to the web app's HTML not-found page, which Paperback 0.9's Komga source can't parse
// (its settings form crashed on it). Every specific v2 route takes precedence over this catch-all.
import { komgaError } from '@/lib/komga/auth';

export const dynamic = 'force-dynamic';

function notFound(req: Request): Response {
    return komgaError(404, new URL(req.url).pathname.replace(/^\/komga/, ''));
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
