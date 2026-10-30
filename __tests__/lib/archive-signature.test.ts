// __tests__/lib/archive-signature.test.ts
// fixMagicNumberSync renames an archive whose extension lies about its format to the extension its
// first bytes say it is - on real files, because the danger is the rename itself: a ZIP named
// "X.cbr" beside a real "X.cbz" used to be renamed straight over it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fixMagicNumberSync } from '@/lib/utils/archive-signature';

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00]); // "PK\3\4" - a ZIP's first bytes
const RAR = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]); // "Rar!" - a RAR's first bytes

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-signature-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('fixMagicNumberSync', () => {
    it('renames a ZIP named .cbr to .cbz', () => {
        const fake = path.join(dir, 'Batman 001.cbr');
        fs.writeFileSync(fake, ZIP);

        const result = fixMagicNumberSync(fake);

        expect(result).toBe(path.join(dir, 'Batman 001.cbz'));
        expect(fs.readFileSync(result)).toEqual(ZIP);
        expect(fs.existsSync(fake)).toBe(false);
    });

    it('renames a RAR named .cbz to .cbr', () => {
        const fake = path.join(dir, 'Batman 001.cbz');
        fs.writeFileSync(fake, RAR);

        expect(fixMagicNumberSync(fake)).toBe(path.join(dir, 'Batman 001.cbr'));
    });

    it('leaves a file whose extension is already right alone', () => {
        const real = path.join(dir, 'Batman 001.cbz');
        fs.writeFileSync(real, ZIP);

        expect(fixMagicNumberSync(real)).toBe(real);
        expect(fs.readdirSync(dir)).toEqual(['Batman 001.cbz']);
    });

    it('never renames over a file that already has the corrected name', () => {
        const fake = path.join(dir, 'Batman 001.cbr');
        const existing = path.join(dir, 'Batman 001.cbz');
        fs.writeFileSync(existing, 'the comic that was already here');
        fs.writeFileSync(fake, ZIP);

        const result = fixMagicNumberSync(fake);

        expect(fs.readFileSync(existing, 'utf8')).toBe('the comic that was already here');
        expect(result).toBe(path.join(dir, 'Batman 001 (copy 1).cbz'));
        expect(fs.readFileSync(result)).toEqual(ZIP);
        expect(fs.existsSync(fake)).toBe(false);
    });
});
