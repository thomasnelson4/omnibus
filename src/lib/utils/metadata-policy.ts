// Provider policies shared by the Node fallback; mirrored in the Rust metadata engine.
export function isCvRateLimited(status: unknown): boolean {
    return status === 429 || status === 420;
}

export function isRealGenre(name: string): boolean {
    return new Set([
        'action', 'adventure', 'alternate history', 'anthology', 'biography', 'comedy', 'crime',
        'cyberpunk', 'drama', 'espionage', 'fantasy', 'historical', 'horror', 'humor', 'mystery',
        'noir', 'post-apocalyptic', 'romance', 'satire', 'science fiction', 'slice of life',
        'sports', 'superhero', 'supernatural', 'survival', 'thriller', 'war', 'western', 'zombies',
    ]).has(name.trim().toLowerCase());
}

export function guessBookTypeFromCvVolume(volume: {
    name?: string; count_of_issues?: number; start_year?: number | string | null;
}, currentYear = new Date().getUTCFullYear()): string | null {
    const name = volume.name || '';
    if (/graphic novel|\bOGN\b/i.test(name)) return 'GN';
    if (/\bTPB\b|trade paperback|\bHC\b|hardcover/i.test(name)) return 'TPB';
    const year = Number(volume.start_year);
    if (volume.count_of_issues === 1 && Number.isInteger(year) && year > 0 && year < currentYear) return 'OneShot';
    return null;
}

export function resolveSyncedReleaseDate(
    existing: string | null | undefined, incoming: string | null | undefined,
    locked: boolean, filePriority: boolean, hasFile: boolean,
): string | null | undefined {
    if (locked) return existing;
    return filePriority && hasFile && existing?.trim() ? existing : incoming;
}
