// src/lib/komga/factory.ts
//
// Builds a KomgaClient from saved settings. Not hot-path safe (pulls in the client); hot paths use
// getKomgaHotFlags from ./settings instead.
import { KomgaClient } from './client';
import { getKomgaSettings, getKomgaCustomHeaders, type KomgaSettings } from './settings';

/** Client for the saved Komga server, or null when Komga is disabled or the URL/API key is missing. */
export async function getKomgaClient(settings?: KomgaSettings): Promise<KomgaClient | null> {
    const s = settings ?? await getKomgaSettings();
    if (!s.enabled || !s.url || !s.apiKey) return null;
    return createKomgaClientFor(s.url, s.apiKey);
}

/** Client for an explicit (possibly unsaved) URL/key, with the saved global custom headers. */
export async function createKomgaClientFor(url: string, apiKey: string): Promise<KomgaClient> {
    const headers = await getKomgaCustomHeaders();
    return new KomgaClient({ baseUrl: url.trim(), apiKey: apiKey.trim(), headers });
}
