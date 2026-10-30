// src/lib/restore-warnings.ts
//
// What the restore screens say about the folders a backup brought back (beta.018 follow-up). The
// restore never refuses a backup over a folder the server can't use - a backup moved from a native
// Windows install to Docker has C:\ paths everywhere - it restores and returns `warnings`; these turn
// them into the toast both restore screens show. The Jobs page reloads right after a restore (it
// must: its schedule fields still hold the pre-restore values), so its warnings ride across the
// reload in sessionStorage. Client-safe.
export const RESTORE_WARNINGS_KEY = 'omnibus_restore_warnings';

const asWarnings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((w): w is string => typeof w === 'string' && w.length > 0) : [];

export function restoreCompleteToast(
    warnings: unknown,
    okDescription: string,
): { title: string; description: string; variant?: 'destructive' } {
    const list = asWarnings(warnings);
    if (list.length === 0) return { title: 'Restore Complete', description: okDescription };
    return {
        title: 'Restore Complete - fix these folders',
        description: `${list.join(' ')} Fix them in Settings → Library & Files.`,
        variant: 'destructive',
    };
}

export function rememberRestoreWarnings(warnings: unknown): void {
    const list = asWarnings(warnings);
    if (list.length === 0) return;
    try { sessionStorage.setItem(RESTORE_WARNINGS_KEY, JSON.stringify(list)); } catch { /* storage blocked: the toast before the reload still showed them */ }
}

export function takeRestoreWarnings(): string[] {
    try {
        const raw = sessionStorage.getItem(RESTORE_WARNINGS_KEY);
        if (!raw) return [];
        sessionStorage.removeItem(RESTORE_WARNINGS_KEY);
        return asWarnings(JSON.parse(raw));
    } catch {
        return [];
    }
}
