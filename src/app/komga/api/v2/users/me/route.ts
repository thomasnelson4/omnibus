// src/app/komga/api/v2/users/me/route.ts — #206 Komga facade: who the caller is (Komga's UserDto).
// Paperback 0.9's "Komga" source asks this when its Server Settings are saved: a 2xx saves them, a
// 401 shows "Invalid credentials", and any other status is read as Komga's validation error -
// without this route the source got the web app's HTML not-found page and crashed with
// "undefined is not an object (evaluating 'e.violations.map')".
import { authenticateKomga, komgaGuard, komgaJson } from '@/lib/komga/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    return komgaGuard('v2 users/me', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;

        const sharedAllLibraries = auth.libs === 'ALL';
        return komgaJson({
            id: auth.user.id,
            // Komga signs in by email; the source sends the Omnibus username in that field.
            email: auth.user.username,
            // Only what this facade serves: pages stream to every signed-in user; there is no
            // file-download endpoint here, so FILE_DOWNLOAD is not claimed.
            roles: auth.user.role === 'ADMIN' ? ['ADMIN', 'PAGE_STREAMING'] : ['PAGE_STREAMING'],
            sharedAllLibraries,
            sharedLibrariesIds: sharedAllLibraries ? [] : auth.libs,
            labelsAllow: [],
            labelsExclude: [],
        });
    });
}
