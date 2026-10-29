// @vitest-environment jsdom
// __tests__/lib/restore-warnings.test.ts
// What the restore screens say about the folders a backup brought back (beta.018 follow-up). The
// restore never refuses a backup over a folder the server can't use - it restores and returns
// `warnings`. The Jobs page reloads right after a restore (its schedule fields still hold the
// pre-restore values), so its warnings ride across the reload in sessionStorage.
import { describe, it, expect, beforeEach } from 'vitest';
import { restoreCompleteToast, rememberRestoreWarnings, takeRestoreWarnings, RESTORE_WARNINGS_KEY } from '@/lib/restore-warnings';

const warnings = [
    'Root Path of library "Comics": "C:\\Comics" is a Windows path, and Omnibus runs inside a Linux container that can\'t see it.',
    'Download Scan Root: "/mnt/old" doesn\'t exist on the server.',
];

describe('restoreCompleteToast', () => {
    it('is the plain success toast when every folder came back usable', () => {
        expect(restoreCompleteToast([], 'All merged!')).toEqual({ title: 'Restore Complete', description: 'All merged!' });
        expect(restoreCompleteToast(undefined, 'All merged!')).toEqual({ title: 'Restore Complete', description: 'All merged!' });
    });

    it('lists the folders to fix, and where', () => {
        const toast = restoreCompleteToast(warnings, 'All merged!');
        expect(toast.title).toBe('Restore Complete - fix these folders');
        expect(toast.description).toContain('Root Path of library "Comics"');
        expect(toast.description).toContain('Download Scan Root');
        expect(toast.description).toContain('Settings → Library & Files');
        expect(toast.variant).toBe('destructive');
    });
});

describe('the warnings across the Jobs page reload', () => {
    beforeEach(() => sessionStorage.clear());

    it('hands them to the reloaded page once, then forgets them', () => {
        rememberRestoreWarnings(warnings);
        expect(takeRestoreWarnings()).toEqual(warnings);
        expect(takeRestoreWarnings()).toEqual([]);
        expect(sessionStorage.getItem(RESTORE_WARNINGS_KEY)).toBeNull();
    });

    it('stores nothing for a clean restore, and survives junk in storage', () => {
        rememberRestoreWarnings([]);
        expect(sessionStorage.getItem(RESTORE_WARNINGS_KEY)).toBeNull();
        sessionStorage.setItem(RESTORE_WARNINGS_KEY, '{not json');
        expect(takeRestoreWarnings()).toEqual([]);
    });
});
