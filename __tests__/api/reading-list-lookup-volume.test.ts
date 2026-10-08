// __tests__/api/reading-list-lookup-volume.test.ts
//
// GET /api/reading-lists/lookup-volume — the volume a missing entry's Request is filed against.
// Pins the ComicVine ISSUE prefix (4000-; 4040- is a person) and the numeric-only id guard.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { GET } from '@/app/api/reading-lists/lookup-volume/route';
import { getReq } from '../helpers/request';

const mocks = vi.hoisted(() => ({
    settingFindUnique: vi.fn(),
    cachedCvGet: vi.fn(),
    metronAuth: vi.fn(),
    metronGet: vi.fn(),
}));

vi.mock('axios');
vi.mock('@/lib/db', () => ({ prisma: { systemSetting: { findUnique: mocks.settingFindUnique } } }));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: mocks.cachedCvGet }));
vi.mock('@/lib/metron/client', () => ({ getMetronAuth: mocks.metronAuth, metronGet: mocks.metronGet }));

const req = (params: Record<string, string>) =>
    getReq(`http://localhost/api/reading-lists/lookup-volume?${new URLSearchParams(params)}`);

describe('GET /api/reading-lists/lookup-volume', () => {
    beforeEach(() => {
        mocks.settingFindUnique.mockResolvedValue({ key: 'cv_api_key', value: 'cv_key' });
        mocks.cachedCvGet.mockResolvedValue({ data: { results: { volume: { id: 2133 }, cover_date: '1981-01-01' } }, cached: false });
    });

    it('looks the issue up with the ComicVine issue prefix', async () => {
        const res = await GET(req({ issueId: '123' }));
        expect(await res.json()).toEqual({ volumeId: 2133, year: '1981' });
        expect(mocks.cachedCvGet).toHaveBeenCalledWith('https://comicvine.gamespot.com/api/issue/4000-123/', expect.objectContaining({
            params: expect.objectContaining({ api_key: 'cv_key', field_list: 'volume,cover_date' }),
        }));
    });

    it('returns the empty answer without a key', async () => {
        mocks.settingFindUnique.mockResolvedValue(null);
        expect(await (await GET(req({ issueId: '123' }))).json()).toEqual({ volumeId: 0, year: null });
        expect(mocks.cachedCvGet).not.toHaveBeenCalled();
    });

    it.each(['abc', '1/../2', '12 3', '-1', '1.5'])('rejects non-numeric id %j before any provider call', async issueId => {
        for (const provider of ['COMICVINE', 'METRON']) {
            const res = await GET(req({ issueId, provider }));
            expect(await res.json()).toEqual({ volumeId: 0, year: null });
        }
        expect(mocks.cachedCvGet).not.toHaveBeenCalled();
        expect(axios.get).not.toHaveBeenCalled();
        expect(mocks.settingFindUnique).not.toHaveBeenCalled();
    });

    it('still serves Metron ids through the shared Metron client', async () => {
        mocks.metronAuth.mockResolvedValue({ kind: 'basic', user: 'u', pass: 'p' });
        mocks.metronGet.mockResolvedValue({ data: { series: { id: 77 }, cover_date: '2012-03-14' } });
        const res = await GET(req({ issueId: '4521', provider: 'METRON' }));
        expect(await res.json()).toEqual({ volumeId: 77, year: '2012' });
        expect(mocks.metronGet.mock.calls[0][0]).toBe('https://metron.cloud/api/issue/4521/');
    });

    it('returns the empty answer when Metron has no credentials', async () => {
        mocks.metronAuth.mockResolvedValue(null);
        expect(await (await GET(req({ issueId: '4521', provider: 'METRON' }))).json()).toEqual({ volumeId: 0, year: null });
        expect(mocks.metronGet).not.toHaveBeenCalled();
    });

    it('returns the empty answer when no issueId is given', async () => {
        expect(await (await GET(req({}))).json()).toEqual({ volumeId: 0, year: null });
    });
});
