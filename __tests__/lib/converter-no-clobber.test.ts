// __tests__/lib/converter-no-clobber.test.ts
//
// beta.021: converting a CBR to CBZ never clobbers an existing .cbz - the rule the engine's page
// removal and cover insertion already follow - and never writes the .cbz in place. The original is
// kept (CBR/CB7 read natively through the engine) and the import carries on with it. Runs against
// a real temp folder: a ZIP-in-disguise .cbr goes through the local pipeline (the engine is down)
// without unrar.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

const mocks = vi.hoisted(() => ({
    findManySettings: vi.fn(),
    fetch: vi.fn(),
    cacheDir: `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/omnibus-conv-cache-${process.pid}`,
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findMany: mocks.findManySettings },
        issue: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
    },
}));
vi.mock('@/lib/utils/paths', async (importOriginal) => ({ ...(await importOriginal<any>()), CACHE_DIR: mocks.cacheDir }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

import { convertCbrToCbz } from '@/lib/converter';

let dir: string;
const tmpLeftovers = () => fs.readdirSync(dir).filter(n => n.endsWith('.tmp'));

function writeCbr(name: string): string {
    const zip = new AdmZip(); // a ZIP in disguise: the converter routes it by magic bytes
    zip.addFile('01.jpg', Buffer.from('page one'));
    zip.addFile('02.jpg', Buffer.from('page two'));
    const p = path.join(dir, name);
    zip.writeZip(p);
    return p;
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-conv-'));
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.fetch.mockRejectedValue(new Error('engine unavailable'));
    mocks.findManySettings.mockResolvedValue([]);
});
afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.remove(dir).catch(() => {});
    await fs.remove(mocks.cacheDir).catch(() => {});
});

describe('convertCbrToCbz never clobbers an existing .cbz', () => {
    it('refuses when the .cbz name is taken: keeps the .cbr, never asks the engine, leaves the .cbz as it was', async () => {
        const cbr = writeCbr('Batman #001.cbr');
        const cbz = path.join(dir, 'Batman #001.cbz');
        fs.writeFileSync(cbz, 'the copy you already had');

        expect(await convertCbrToCbz(cbr)).toBeNull();
        expect(fs.existsSync(cbr)).toBe(true);
        expect(fs.readFileSync(cbz, 'utf8')).toBe('the copy you already had');
        // A refused engine conversion answers 500 - the local pipeline must not then overwrite it.
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(tmpLeftovers()).toEqual([]);
    });

    it('converts through a temp file: the .cbr is retired, the .cbz holds the pages, nothing is left behind', async () => {
        const cbr = writeCbr('Batman #002.cbr');

        const out = await convertCbrToCbz(cbr);
        expect(out).toBe(path.join(dir, 'Batman #002.cbz'));
        expect(fs.existsSync(cbr)).toBe(false);
        expect(new AdmZip(out!).getEntries().map(e => e.entryName).sort()).toEqual(['page_0001.jpg', 'page_0002.jpg']);
        expect(tmpLeftovers()).toEqual([]);
    });

    it('refuses at the last moment if a .cbz appears while converting, and cleans up', async () => {
        const cbr = writeCbr('Batman #003.cbr');
        const cbz = path.join(dir, 'Batman #003.cbz');
        // The settings lookup runs mid-conversion (after the first check): drop a .cbz in then.
        mocks.findManySettings.mockImplementation(async () => {
            fs.writeFileSync(cbz, 'arrived mid-conversion');
            return [];
        });

        expect(await convertCbrToCbz(cbr)).toBeNull();
        expect(fs.readFileSync(cbz, 'utf8')).toBe('arrived mid-conversion');
        expect(fs.existsSync(cbr)).toBe(true);
        expect(tmpLeftovers()).toEqual([]);
    });
});
