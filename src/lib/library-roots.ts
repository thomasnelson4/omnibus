// src/lib/library-roots.ts
import { prisma } from './db';

// Library root paths for containment checks, cached briefly. The cover route fires once per grid
// card (24+ per page), and each hit was its own `library.findMany` against the SQLite file the
// engine hammers during scans (issue #183). Roots change only when an admin edits libraries; a
// 30s lag there costs at most a placeholder cover until the cache rolls.
const TTL_MS = 30_000;

let cache: { roots: string[]; at: number } | null = null;
// Same TTL and same query shape, kept in one cache slot: the Komga hot path needs id+path (to map a
// changed path to a library), the cover route needs path only.
let idCache: { entries: { id: string; path: string }[]; at: number } | null = null;

export async function getLibraryRoots(): Promise<string[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.roots;
  const libraries = await prisma.library.findMany({ select: { path: true } });
  cache = { roots: libraries.map(l => l.path), at: Date.now() };
  return cache.roots;
}

/**
 * Library id + path, for callers that must attribute a path to a library (Komga change tracking).
 * Shares the 30 s TTL with getLibraryRoots so a library edit cannot leave the two views disagreeing
 * for long.
 */
export async function getLibraryRootEntries(): Promise<{ id: string; path: string }[]> {
  if (idCache && Date.now() - idCache.at < TTL_MS) return idCache.entries;
  const libraries = await prisma.library.findMany({ select: { id: true, path: true } });
  idCache = { entries: libraries.map(l => ({ id: l.id, path: l.path })), at: Date.now() };
  return idCache.entries;
}

// Test hook — module-level cache would otherwise leak between vitest cases.
export function resetLibraryRootsCache(): void {
  cache = null;
  idCache = null;
}
