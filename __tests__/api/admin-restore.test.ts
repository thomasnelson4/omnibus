// __tests__/api/admin-restore.test.ts
// Backup restore and the folders it brings back (beta.018 follow-up). A restore writes every table as
// the backup has it - libraries, settings and download clients, but also every series folder and
// issue file path - so a folder the server can't use must NOT block it: a backup moved from a native
// Windows install to Docker has C:\ paths everywhere and has to come in before they can be fixed.
// The restore trims the folder settings Settings would have trimmed, restores everything, and says
// which folders need fixing.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/admin/restore/route';
import { auditLog } from '../helpers/setup-global';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    settingFindUnique: vi.fn(),
    transaction: vi.fn(),
    storedFolderProblem: vi.fn(),
    tx: {
        systemSetting: { upsert: vi.fn() },
        library: { upsert: vi.fn() },
        downloadClient: { upsert: vi.fn() },
    },
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findUnique: mocks.settingFindUnique },
        $transaction: mocks.transaction,
    }
}));
vi.mock('@/lib/utils/stored-folder', () => ({ storedFolderProblem: mocks.storedFolderProblem }));

const restore = (data: Record<string, unknown>) => {
    const form = new FormData();
    form.append('file', new File([JSON.stringify({ data })], 'omnibus-backup.json', { type: 'application/json' }));
    return POST(new Request('http://localhost/api/admin/restore', { method: 'POST', body: form }));
};

const upsertedRow = (model: { upsert: ReturnType<typeof vi.fn> }, id: string) =>
    model.upsert.mock.calls.map(([args]) => args).find(a => a.where.id === id || a.where.key === id);

describe('Backup restore: the folders it brings back', () => {
    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } });
        mocks.settingFindUnique.mockResolvedValue({ key: 'setup_complete', value: 'true' });
        mocks.transaction.mockImplementation(async (fn: (tx: typeof mocks.tx) => unknown) => fn(mocks.tx));
        mocks.storedFolderProblem.mockReturnValue(null);
        auditLog.mockResolvedValue(undefined);
    });

    it('trims the folder settings, as Settings would have, and leaves every other value alone', async () => {
        const res = await restore({
            libraries: [{ id: 'lib_1', name: 'Comics', path: ' /data/comics ' }],
            downloadClients: [{ id: 'c_1', name: 'SABnzbd', localPath: '/data/downloads ', remotePath: ' /downloads' }],
            settings: [{ key: 'download_path', value: ' /data/downloads' }, { key: 'site_title', value: '  Omnibus  ' }],
        });

        expect(res.status).toBe(200);
        expect(upsertedRow(mocks.tx.library, 'lib_1')).toMatchObject({ create: { path: '/data/comics' }, update: { path: '/data/comics' } });
        expect(upsertedRow(mocks.tx.downloadClient, 'c_1')).toMatchObject({ create: { localPath: '/data/downloads', remotePath: ' /downloads' } });
        expect(upsertedRow(mocks.tx.systemSetting, 'download_path')).toMatchObject({ create: { value: '/data/downloads' } });
        expect(upsertedRow(mocks.tx.systemSetting, 'site_title')).toMatchObject({ create: { value: '  Omnibus  ' } });
    });

    it('restores a backup whose folders the server can\'t use, and says which ones to fix', async () => {
        mocks.storedFolderProblem.mockImplementation((p: string) => ({
            'C:\\Comics': '"C:\\Comics" is a Windows path, and Omnibus runs inside a Linux container that can\'t see it.',
            '/mnt/old-downloads': '"/mnt/old-downloads" doesn\'t exist on the server.',
            'D:\\SAB': '"D:\\SAB" is a Windows path.',
        } as Record<string, string>)[p] ?? null);

        const res = await restore({
            libraries: [{ id: 'lib_1', name: 'Comics', path: 'C:\\Comics' }, { id: 'lib_2', name: 'Manga', path: '/data/manga' }],
            downloadClients: [{ id: 'c_1', name: 'SABnzbd', localPath: 'D:\\SAB' }, { id: 'c_2', name: 'qBittorrent', localPath: null }],
            settings: [{ key: 'download_path', value: '/mnt/old-downloads' }],
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.warnings).toEqual([
            'Root Path of library "Comics": "C:\\Comics" is a Windows path, and Omnibus runs inside a Linux container that can\'t see it.',
            'Download Scan Root: "/mnt/old-downloads" doesn\'t exist on the server.',
            'Local Path of download client "SABnzbd": "D:\\SAB" is a Windows path.',
        ]);
        // Nothing was held back: the bad library is restored, to be fixed in Settings.
        expect(upsertedRow(mocks.tx.library, 'lib_1')).toMatchObject({ create: { path: 'C:\\Comics' } });
        // An empty Download Scan Root or an unmapped client isn't a problem (Settings allows both).
        expect(mocks.storedFolderProblem).not.toHaveBeenCalledWith(null, expect.anything());
    });

    it('answers with no warnings when every restored folder is usable', async () => {
        const res = await restore({
            libraries: [{ id: 'lib_1', name: 'Comics', path: '/data/comics' }],
            settings: [{ key: 'download_path', value: '' }],
        });

        expect(res.status).toBe(200);
        expect((await res.json()).warnings).toEqual([]);
        expect(mocks.storedFolderProblem).toHaveBeenCalledWith('/data/comics', expect.objectContaining({ example: '/data/comics' }));
    });
});
