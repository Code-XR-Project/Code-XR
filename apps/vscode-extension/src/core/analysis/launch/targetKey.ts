/**
 * One identity for an analysis target, whatever produced its path.
 *
 * Entry points hand the launcher paths spelled differently: `uri.fsPath`
 * (lower-case drive letter on Windows), `path.resolve(workspace, rel)`, and
 * paths reported by the Python backend. Compared raw, `C:\proj\a.ts` and
 * `c:\proj\a.ts` were two targets, which let a second launch past the
 * duplicate guard (LAUNCHER-17). Every identity comparison goes through this;
 * the original string is kept for display and for spawning.
 *
 * Deliberately pure (only `path`), so it is testable for every platform from
 * any platform.
 */
import * as path from 'path';

/**
 * Normalised identity of `targetPath`: resolved, without a trailing
 * separator, and case-folded where the file system usually is
 * case-insensitive (Windows always, macOS by default).
 */
export function targetKey(targetPath: string, platform: NodeJS.Platform = process.platform): string {
    const api = platform === 'win32' ? path.win32 : path.posix;
    let resolved = api.resolve(String(targetPath || ''));
    const root = api.parse(resolved).root;
    while (resolved.length > root.length && (resolved.endsWith(api.sep) || resolved.endsWith('/'))) {
        resolved = resolved.slice(0, -1);
    }
    return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** The key one launch reserves: a kind on a target, at one depth. */
export function launchKey(
    kind: string,
    targetPath: string,
    targetType: string,
    isDeep: boolean,
    platform: NodeJS.Platform = process.platform,
): string {
    return [kind, targetType, isDeep ? 'deep' : 'shallow', targetKey(targetPath, platform)].join('|');
}
