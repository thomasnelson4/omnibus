// __tests__/lib/utils/paths.test.ts
//
// The containment rules every series-folder write and every destructive folder operation leans on.
import { describe, it, expect, afterEach } from 'vitest';
import { isPathWithinRoots, isInsideLibraryRoot, serverPathProblem } from '@/lib/utils/paths';
import { pinPlatform } from '../../helpers/platform';

describe('isPathWithinRoots', () => {
    it('collapses .. before checking, and needs a separator boundary', () => {
        expect(isPathWithinRoots('/data/comics/Batman/01.cbz', ['/data/comics'])).toBe(true);
        expect(isPathWithinRoots('/data/comics/../../etc/passwd', ['/data/comics'])).toBe(false);
        expect(isPathWithinRoots('/data/comics-secret/x.cbz', ['/data/comics'])).toBe(false);
    });
});

describe('isInsideLibraryRoot', () => {
    const roots = ['/data/comics', '/data/manga/'];

    it('accepts a folder strictly inside a library root', () => {
        expect(isInsideLibraryRoot('/data/comics/Image/Saga (2012)', roots)).toBe(true);
        expect(isInsideLibraryRoot('/data/manga/Chainsaw Man', roots)).toBe(true);
        expect(isInsideLibraryRoot('/DATA/Comics/Image', roots)).toBe(true);
    });

    it('never accepts a library root itself, however it is spelled', () => {
        expect(isInsideLibraryRoot('/data/comics', roots)).toBe(false);
        expect(isInsideLibraryRoot('/data/comics/', roots)).toBe(false);
        expect(isInsideLibraryRoot('/data/manga', roots)).toBe(false);
        expect(isInsideLibraryRoot('/data/comics/Image/..', roots)).toBe(false);
        expect(isInsideLibraryRoot('/data/comics/../comics', roots)).toBe(false);
    });

    it('refuses anything that climbs out, a sibling prefix, or nothing at all', () => {
        expect(isInsideLibraryRoot('/data/comics/Image/../../config', roots)).toBe(false);
        expect(isInsideLibraryRoot('/data', roots)).toBe(false);
        expect(isInsideLibraryRoot('/', roots)).toBe(false);
        expect(isInsideLibraryRoot('/data/comics-secret/x', roots)).toBe(false);
        expect(isInsideLibraryRoot('', roots)).toBe(false);
        expect(isInsideLibraryRoot(null, roots)).toBe(false);
        expect(isInsideLibraryRoot('/data/comics/Image', [])).toBe(false);
    });
});

// Discord field report (2026-10-13, Docker Desktop on a Surface Pro): a library saved as `C:\…`
// made every Smart Match fail with "EACCES: permission denied, mkdir 'C:'". Inside the Linux
// container that path isn't absolute — it resolves under the app's root-owned working directory.
describe('serverPathProblem', () => {
    describe('on a Linux server (the Docker image)', () => {
        const linux = { platform: 'linux' as const };

        it('accepts an absolute container path', () => {
            expect(serverPathProblem('/data/comics', linux)).toBeNull();
            expect(serverPathProblem('  /data/comics/ ', linux)).toBeNull();
            expect(serverPathProblem('/', linux)).toBeNull();
        });

        it('names a Windows drive path as one, with the volume line that fixes it', () => {
            const problem = serverPathProblem('C:\\Comics\\Library', linux);
            expect(problem).toContain('"C:\\Comics\\Library" is a Windows path');
            expect(problem).toContain('C:/Comics/Library:/data/comics');
            expect(problem).toMatch(/enter the container side here: \/data\/comics\.$/);
            expect(serverPathProblem('c:/comics/', linux)).toContain('c:/comics:/data/comics');
        });

        it('names a Windows network share as a Windows path too', () => {
            expect(serverPathProblem('\\\\nas\\comics', linux)).toContain('is a Windows path');
        });

        it('rejects a relative path - it would land under the app folder', () => {
            for (const p of ['comics', './comics', 'data/comics', '~/comics']) {
                expect(serverPathProblem(p, linux)).toContain(`"${p}" isn't a full path`);
            }
            expect(serverPathProblem('comics', linux)).toContain('starting with / (e.g. /data/comics)');
        });

        it('rejects a missing folder', () => {
            for (const p of ['', '   ', null, undefined]) {
                expect(serverPathProblem(p, linux)).toBe('No folder is set.');
            }
        });

        it('uses the caller\'s example for the container side', () => {
            const opts = { ...linux, example: '/data/downloads' };
            expect(serverPathProblem('D:\\Downloads', opts)).toContain('D:/Downloads:/data/downloads');
            expect(serverPathProblem('downloads', opts)).toContain('(e.g. /data/downloads)');
        });
    });

    describe('on a native Windows install', () => {
        const win = { platform: 'win32' as const };

        it('keeps drive-letter paths and rooted paths', () => {
            expect(serverPathProblem('C:\\Users\\adam\\LIBRARIES\\comics', win)).toBeNull();
            expect(serverPathProblem('D:/Comics', win)).toBeNull();
            expect(serverPathProblem('\\\\nas\\comics', win)).toBeNull();
            expect(serverPathProblem('/sabnzbd/downloads', win)).toBeNull();
        });

        it('still rejects a relative path, with a Windows example', () => {
            expect(serverPathProblem('comics', win)).toBe('"comics" isn\'t a full path. Enter the whole folder path (e.g. C:\\Comics).');
            expect(serverPathProblem('C:comics', win)).toContain('isn\'t a full path');
        });
    });

    describe('without an explicit platform', () => {
        let restore: (() => void) | null = null;
        afterEach(() => { restore?.(); restore = null; });

        it('judges by the platform the server runs on', () => {
            restore = pinPlatform('linux');
            expect(serverPathProblem('C:\\Comics')).toContain('is a Windows path');
            restore();
            restore = pinPlatform('win32');
            expect(serverPathProblem('C:\\Comics')).toBeNull();
        });
    });
});
