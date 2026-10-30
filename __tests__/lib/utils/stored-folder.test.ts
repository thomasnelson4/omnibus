// __tests__/lib/utils/stored-folder.test.ts
// storedFolderProblem: a folder ALREADY SAVED that Omnibus is about to write under, or a restored
// backup is about to bring back (beta.018 follow-up). Stricter than the save-time serverPathProblem:
// the value is judged exactly as stored (a leading space saved before Settings trimmed it makes it
// relative), and it has to exist - a typo or an unmapped volume would otherwise be created inside the
// container. Twin of the engine's server_paths.rs folder_problem.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storedFolderProblem } from '@/lib/utils/stored-folder';
import { pinPlatform } from '../../helpers/platform';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-stored-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('storedFolderProblem', () => {
    it('accepts a full path that exists', () => {
        expect(storedFolderProblem(dir)).toBeNull();
    });

    it('says when no folder is set', () => {
        expect(storedFolderProblem('')).toBe('No folder is set.');
        expect(storedFolderProblem(null)).toBe('No folder is set.');
    });

    it('refuses a folder saved with a space around it, as saved', () => {
        expect(storedFolderProblem(` ${dir}`)).toContain('starts or ends with a space');
        expect(storedFolderProblem(`${dir} `)).toContain('starts or ends with a space');
    });

    it('refuses a relative folder', () => {
        expect(storedFolderProblem('comics')).toContain('"comics" isn\'t a full path');
    });

    it('refuses a full path that nothing is mounted at, without creating it', () => {
        const missing = path.join(dir, 'not-mounted');
        expect(storedFolderProblem(missing)).toContain('doesn\'t exist on the server');
        expect(fs.existsSync(missing)).toBe(false);
    });

    it('refuses a file', () => {
        const file = path.join(dir, 'comics.txt');
        fs.writeFileSync(file, 'x');
        expect(storedFolderProblem(file)).toContain('is a file, not a folder');
    });

    it('explains a Windows path inside the Linux container, with the example it is given', () => {
        const restore = pinPlatform('linux');
        try {
            const problem = storedFolderProblem('D:\\Downloads', { example: '/data/downloads' });
            expect(problem).toContain('"D:\\Downloads" is a Windows path');
            expect(problem).toContain('D:/Downloads:/data/downloads');
        } finally {
            restore();
        }
    });
});
