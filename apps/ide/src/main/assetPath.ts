import path from 'node:path';

/**
 * Maps a `codexr://app/...` request path onto a file inside the built
 * renderer folder, or returns null when it would escape that folder.
 *
 * `URL` already normalises `..` segments in the path, but encoded forms
 * (`%2e%2e`, `%5c` on Windows) survive it, so the check is done again on the
 * decoded, resolved file-system path.
 */
export function resolveRendererAsset(rendererRoot: string, requestPathname: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(requestPathname);
    } catch {
        return null;
    }
    if (decoded.includes('\0')) {
        return null;
    }
    const relative = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^[/\\]+/, '');
    const root = path.resolve(rendererRoot);
    const resolved = path.resolve(root, relative);
    const rel = path.relative(root, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        return null;
    }
    return resolved;
}
