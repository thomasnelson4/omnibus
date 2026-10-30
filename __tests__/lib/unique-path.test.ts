// __tests__/lib/unique-path.test.ts
// The one naming rule for a file that must not replace another (the upload route, the importer's
// signature fix-up; the engine's move into /unmatched mirrors it): its own name when free, else
// " (copy N)". Never a bare " (N)" - the filename parser reads a trailing bare number as the issue
// number on scene-style names ("Saga 054 (2018) (Digital) (1).cbz" parses as #1), and the Smart
// Matcher numbers /unmatched files with that parser.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { copyName, resolveUniquePath, resolveUniquePathSync } from '@/lib/utils/unique-path';
import { describeIssueFromFilename } from '@/lib/utils/issue-parser';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-unique-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('copyName', () => {
    it('puts " (copy N)" before the extension, like the engine', () => {
        expect(copyName('Saga 054 (2018) (Digital).cbz', 1)).toBe('Saga 054 (2018) (Digital) (copy 1).cbz');
        expect(copyName('Batman 001.cbz', 12)).toBe('Batman 001 (copy 12).cbz');
        expect(copyName('archive.tar.gz', 1)).toBe('archive.tar (copy 1).gz');
        expect(copyName('README', 2)).toBe('README (copy 2)');
        expect(copyName('.hidden', 1)).toBe('.hidden (copy 1)');
    });

    it('never changes what the filename parser reads', () => {
        const names = [
            'Saga 054 (2018) (Digital).cbz',
            'X-Men 034 (2004) (c2c) (Zone-Empire).cbz',
            'Batman #001 (2016).cbz',
            'Batman Annual 002 (2017).cbz',
            '01.cbz',
        ];
        for (const name of names) {
            const original = describeIssueFromFilename(name);
            for (const n of [1, 2, 12]) expect(describeIssueFromFilename(copyName(name, n)), copyName(name, n)).toEqual(original);
        }
    });
});

describe.each([
    ['resolveUniquePath', (d: string, f: string) => resolveUniquePath(d, f)],
    ['resolveUniquePathSync', async (d: string, f: string) => resolveUniquePathSync(d, f)],
])('%s', (_label, resolve) => {
    it('keeps the name when nothing has it', async () => {
        expect(await resolve(dir, 'Batman 001.cbz')).toBe(path.join(dir, 'Batman 001.cbz'));
    });

    it('takes the first free copy number when the name is taken', async () => {
        fs.writeFileSync(path.join(dir, 'Batman 001.cbz'), 'first');
        expect(await resolve(dir, 'Batman 001.cbz')).toBe(path.join(dir, 'Batman 001 (copy 1).cbz'));

        fs.writeFileSync(path.join(dir, 'Batman 001 (copy 1).cbz'), 'second');
        expect(await resolve(dir, 'Batman 001.cbz')).toBe(path.join(dir, 'Batman 001 (copy 2).cbz'));
    });
});
