// src/lib/utils/stored-folder.ts
//
// A folder ALREADY SAVED that Omnibus is about to write under, or a restored backup is bringing back
// (beta.018 follow-up). Stricter than the save-time serverPathProblem, which trims what's typed:
//   - the value is judged exactly as stored - a leading space saved before Settings trimmed folders
//     makes it a relative path;
//   - it has to exist - a typo or an unmapped volume would otherwise be created, and the engine
//     (which runs as root) creates it inside the container, where the next image update deletes it.
// Twin of the engine's server_paths.rs `folder_problem`; the wording matches, so the log and the
// Settings page say the same thing. Server-only (reads the disk).
import fs from 'fs';
import { serverPathProblem } from '@/lib/utils/paths';

export function storedFolderProblem(
    folder: string | null | undefined,
    opts: { example?: string } = {},
): string | null {
    const raw = folder ?? '';
    if (!raw.trim()) return 'No folder is set.';
    if (raw !== raw.trim()) return `"${raw}" starts or ends with a space. Save it again in Settings and the space is removed.`;

    const problem = serverPathProblem(raw, opts);
    if (problem) return problem;

    try {
        return fs.statSync(raw).isDirectory() ? null : `"${raw}" is a file, not a folder.`;
    } catch {
        return `"${raw}" doesn't exist on the server. Check that the folder is mapped into the container in your compose file.`;
    }
}
