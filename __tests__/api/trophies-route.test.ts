// The trophies route's save path, which nothing could reach until the admin page called the right
// URL (found in the v1.4.7 permission sweep: the page asked /api/admin/trophies, a route that never
// existed). Now that saves arrive, a bad form is a 400 with a reason instead of a Prisma 500, and an
// icon is stored under the extension of the image it actually is — the uploads route serves by
// extension, and an SVG data URL used to slip past the prefix strip and be written as a corrupt .png.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    ensureDir: vi.fn(),
    writeFile: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({ prisma: { trophy: { create: mocks.create, update: mocks.update, findMany: vi.fn(), findUnique: vi.fn(), delete: vi.fn() } } }));
vi.mock('fs-extra', () => ({ default: { ensureDir: mocks.ensureDir, writeFile: mocks.writeFile } }));

import { POST } from '@/app/api/trophies/route';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const save = (body: Record<string, unknown>) =>
    POST(new Request('http://localhost/api/trophies', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
const valid = { name: 'Bronze Reader', description: 'Read 10 comics.', actionType: 'READ_COUNT', targetValue: '10' };

describe('POST /api/trophies — form validation and icon storage', () => {
    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } });
        mocks.create.mockImplementation(async ({ data }: any) => ({ id: 't1', ...data }));
        mocks.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data }));
        mocks.ensureDir.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);
    });

    it('saves a valid trophy with its target as a number', async () => {
        const res = await save(valid);
        expect(res.status).toBe(200);
        expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: 'Bronze Reader', targetValue: 10 }) });
    });

    it.each([
        ['an empty target', { targetValue: '' }],
        ['a zero target', { targetValue: '0' }],
        ['a fractional target', { targetValue: '2.5' }],
        ['a blank name', { name: '   ' }],
        ['an unknown action type', { actionType: 'LOGIN_COUNT' }],
    ])('refuses %s with 400 and writes nothing', async (_label, patch) => {
        const res = await save({ ...valid, ...patch });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBeTruthy();
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.update).not.toHaveBeenCalled();
    });

    it.each([
        ['image/png', '.png'],
        ['image/jpeg', '.jpg'],
        ['image/webp', '.webp'],
        ['image/gif', '.gif'],
    ])('stores a %s icon as %s', async (mime, ext) => {
        const res = await save({ ...valid, iconBase64: `data:${mime};base64,${PNG_1PX}` });
        expect(res.status).toBe(200);
        const [filePath, data, encoding] = mocks.writeFile.mock.calls[0];
        expect(String(filePath).endsWith(ext)).toBe(true);
        expect(data).toBe(PNG_1PX);
        expect(encoding).toBe('base64');
        expect(mocks.create.mock.calls[0][0].data.iconUrl).toMatch(new RegExp(`^/api/uploads/trophies/\\d+\\${ext}$`));
    });

    it('refuses an icon that is not png/jpeg/webp/gif (an SVG used to be written as a corrupt .png)', async () => {
        const res = await save({ ...valid, iconBase64: 'data:image/svg+xml;base64,PHN2Zy8+' });
        expect(res.status).toBe(400);
        expect(mocks.writeFile).not.toHaveBeenCalled();
        expect(mocks.create).not.toHaveBeenCalled();
    });

    it('edits keep the stored icon when none is sent, and take a numeric target as the list returns it', async () => {
        // The page edits the row it listed, so targetValue comes back as a number.
        const res = await save({ ...valid, id: 't1', targetValue: 25 });
        expect(res.status).toBe(200);
        expect(mocks.update.mock.calls[0][0].data).toEqual(expect.objectContaining({ targetValue: 25 }));
        expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty('iconUrl');
    });
});
