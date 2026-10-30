// src/lib/utils/paths.ts

import path from 'path';

/**
 * Canonical filesystem locations. Every path is configurable via environment
 * variable in Docker; the fallbacks below are the single source of truth —
 * never inline a path fallback anywhere else in the app.
 */

/** Root config volume; cache, logs, and backups default to subfolders of it. */
export const CONFIG_DIR = process.env.OMNIBUS_CONFIG_DIR || '/config';

/** Base directory for caches and temp work (cover cache, conversion temp dirs). */
export const CACHE_DIR = process.env.OMNIBUS_CACHE_DIR || '/config/cache';

/** Where omnibus.log is written and read from. */
export const LOGS_DIR = process.env.OMNIBUS_LOGS_DIR || '/config/logs';

/** Destination for database/settings backup archives. */
export const BACKUPS_DIR = process.env.OMNIBUS_BACKUPS_DIR || '/config/backups';

/** Drop folder scanned for new downloads to import. */
export const WATCHED_DIR = process.env.OMNIBUS_WATCHED_DIR || '/watched';

/** Holding area for files that could not be matched to a series. */
export const UNMATCHED_DIR = process.env.OMNIBUS_AWAITING_MATCH_DIR || '/unmatched';

/**
 * Why `p` can't be a folder Omnibus itself reads and writes (a library Root Path, the Download Scan
 * Root, a download client's Omnibus-side path), or null when it can. A path resolves on the machine
 * Omnibus runs on, and in Docker that is Linux, where a Windows path (`C:\Comics`) is not absolute:
 * it resolves under the app's root-owned working directory and every write fails with
 * "EACCES: permission denied, mkdir 'C:'" (Discord field report, 2026-10-13, Docker Desktop on
 * Windows). Judged by the server's own platform, so a native Windows install keeps its drive-letter
 * paths. `example` is the container-side folder the advice suggests.
 */
export function serverPathProblem(
  p: string | null | undefined,
  { example = '/data/comics', platform = process.platform }: { example?: string; platform?: NodeJS.Platform } = {},
): string | null {
  const value = (p ?? '').trim();
  if (!value) return 'No folder is set.';
  if (platform === 'win32') {
    return path.win32.isAbsolute(value) ? null : `"${value}" isn't a full path. Enter the whole folder path (e.g. C:\\Comics).`;
  }
  if (path.posix.isAbsolute(value)) return null;
  const drive = /^[a-z]:/i.test(value);
  if (drive || value.startsWith('\\\\')) {
    const hostSide = drive ? value.replace(/\\/g, '/').replace(/\/+$/, '') : 'C:/Comics';
    return `"${value}" is a Windows path, and Omnibus runs inside a Linux container that can't see it. `
      + `Map the folder into the container in your compose file (e.g. "- ${hostSide}:${example}" under volumes) `
      + `and enter the container side here: ${example}.`;
  }
  return `"${value}" isn't a full path. Enter the folder as Omnibus sees it inside its container, starting with / (e.g. ${example}).`;
}

/**
 * True when `filePath` resolves to a location inside one of the given library roots.
 * Normalizes both sides first (collapsing `..`) and requires a path-separator boundary,
 * so neither traversal (`<root>/../../etc/passwd`) nor a sibling-prefix (`<root>-evil`)
 * slips past a naive string `startsWith`. Shared by every endpoint that serves a file
 * from a client-supplied path (reader image/pages, library download).
 */
export function isPathWithinRoots(filePath: string, roots: string[]): boolean {
  const target = path.normalize(filePath).toLowerCase();
  return roots.some((r) => {
    const root = path.normalize(r).replace(/[\\/]+$/, '').toLowerCase();
    return target === root || target.startsWith(root + path.sep);
  });
}

/**
 * True when `folder` resolves to a location strictly INSIDE one of the library roots - never a root
 * itself. The gate for anything that moves or deletes a whole series folder: a series whose
 * folderPath is a library root (or anywhere outside the libraries) must never take that folder with it.
 */
export function isInsideLibraryRoot(folder: string | null | undefined, roots: string[]): boolean {
  if (!folder) return false;
  const target = path.normalize(folder).replace(/[\\/]+$/, '').toLowerCase();
  return roots.some((r) => {
    const root = path.normalize(r).replace(/[\\/]+$/, '').toLowerCase();
    return target.startsWith(root + path.sep);
  });
}
