// __tests__/api/reader-pages.test.ts
//
// #215: opening a book in the web reader lists its pages. For a zip the route used to build an
// AdmZip over the WHOLE file just to read the entry names - a memory spike on a 1-2 GB compendium
// and a hard failure over 2 GB (readFileSync's limit). It now lists pages from the zip's index
// (lib/utils/archive-pages listArchivePages) and keeps the reader's natural page order.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    listArchivePages: vi.fn(),
    admZipCtor: vi.fn(),
    existsSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
    const actual: any = await importOriginal();
    return { ...actual, default: { ...actual, existsSync: mocks.existsSync }, existsSync: mocks.existsSync };
});
vi.mock('adm-zip', () => ({ default: vi.fn().mockImplementation((...args: any[]) => { mocks.admZipCtor(...args); throw new Error('AdmZip must not be used to list a zip'); }) }));
vi.mock('@/lib/utils/archive-pages', () => ({ listArchivePages: mocks.listArchivePages }));
vi.mock('@/lib/db', () => ({ prisma: { library: { findMany: vi.fn().mockResolvedValue([{ path: '/comics' }]) } } }));
vi.mock('next-auth/next', () => ({ getServerSession: vi.fn().mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } }) }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryPaths: vi.fn().mockResolvedValue('ALL'),
    canAccessPath: vi.fn().mockReturnValue(true),
}));

import { GET } from '@/app/api/reader/pages/route';

const req = (p: string) => new Request(`http://localhost/api/reader/pages?path=${encodeURIComponent(p)}`);

beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
});

describe('GET /api/reader/pages (zip)', () => {
    it('lists pages from the zip index in natural order, without loading the archive', async () => {
        mocks.listArchivePages.mockResolvedValue(['Vol 1/page 10.jpg', 'Vol 1/page 2.jpg', 'Vol 1/page 1.jpg']);

        const res = await GET(req('/comics/Image/Spawn (1992)/Spawn Compendium Vol. 01.cbz'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ pages: ['Vol 1/page 1.jpg', 'Vol 1/page 2.jpg', 'Vol 1/page 10.jpg'] });
        expect(mocks.listArchivePages).toHaveBeenCalledWith('/comics/Image/Spawn (1992)/Spawn Compendium Vol. 01.cbz');
        expect(mocks.admZipCtor).not.toHaveBeenCalled();
    });

    it('answers 500 when the archive cannot be read at all', async () => {
        mocks.listArchivePages.mockRejectedValue(new Error('EOCD signature not found'));
        const res = await GET(req('/comics/broken.cbz'));
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Failed to read archive' });
    });
});
