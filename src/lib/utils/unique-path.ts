// src/lib/utils/unique-path.ts
//
// The one naming rule for a file that must not replace another: its own name when free, else
// "<name> (copy N)<ext>" with the first free N. Used by the upload route and the importer's
// signature fix-up; the engine's move into /unmatched (watched_sync.rs `copy_name`) follows the
// same rule, so a duplicate reads the same whichever door it came through.
//
// Never a bare " (N)": the filename parser reads a trailing bare number as the issue number on
// scene-style names - "Saga 054 (2018) (Digital) (1).cbz" parses as issue 1 - and the Smart
// Matcher numbers /unmatched files with that parser. " (copy N)" leaves the number alone.
import fs from 'fs-extra';
import path from 'path';

// How many copy numbers are tried before giving up, so a folder full of copies throws instead of
// searching forever.
const MAX_COPIES = 9999;

export function copyName(filename: string, n: number): string {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    return `${base} (copy ${n})${ext}`;
}

export async function resolveUniquePath(dir: string, filename: string): Promise<string> {
    let candidate = path.join(dir, filename);
    for (let n = 1; await fs.pathExists(candidate); n++) {
        if (n > MAX_COPIES) throw new Error(`No free name for "${filename}" in ${dir}`);
        candidate = path.join(dir, copyName(filename, n));
    }
    return candidate;
}

export function resolveUniquePathSync(dir: string, filename: string): string {
    let candidate = path.join(dir, filename);
    for (let n = 1; fs.existsSync(candidate); n++) {
        if (n > MAX_COPIES) throw new Error(`No free name for "${filename}" in ${dir}`);
        candidate = path.join(dir, copyName(filename, n));
    }
    return candidate;
}
