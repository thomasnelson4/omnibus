// __tests__/helpers/platform.ts
//
// Pins process.platform for a test. The server-path rules (serverPathProblem in paths.ts) judge a
// path by the platform Omnibus runs on, so a suite must be able to play "Linux container" on the
// Windows dev box and "native Windows install" on Linux CI. Returns the restore function.
export function pinPlatform(platform: NodeJS.Platform): () => void {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    return () => { Object.defineProperty(process, 'platform', original); };
}
