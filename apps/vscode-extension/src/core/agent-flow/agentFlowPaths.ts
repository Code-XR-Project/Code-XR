/**
 * Path normalization shared by the builder and its phases: every path an
 * event or a metrics file names becomes root-relative with forward slashes,
 * or is dropped when it lies outside the analysed root.
 */

const DRIVE_PREFIX = /^[A-Za-z]:\//;

function normalizeSeparators(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * An absolute path made relative to `rootNorm` (case-insensitively on a
 * Windows root), a relative one unchanged; null when outside or the root itself.
 */
function stripRoot(rootNorm: string, path: string): string | null {
    const isAbsolute = path.startsWith('/') || DRIVE_PREFIX.test(path);
    if (!isAbsolute) { return path; }
    const windows = DRIVE_PREFIX.test(rootNorm);
    const a = windows ? path.toLowerCase() : path;
    const b = windows ? rootNorm.toLowerCase() : rootNorm;
    if (a === b) { return null; }
    if (!a.startsWith(`${b}/`)) { return null; }
    return path.slice(rootNorm.length + 1);
}

/** Resolves `.` and `..` segments; null when the path climbs out of the root. */
function collapseSegments(path: string): string | null {
    const parts: string[] = [];
    for (const part of path.split('/')) {
        if (part === '' || part === '.') { continue; }
        if (part === '..') {
            if (parts.length === 0) { return null; }
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    return parts.length > 0 ? parts.join('/') : null;
}

/** Root-relative forward-slash path, or null when it lies outside the root. */
export function relativeToRoot(root: string, candidate: string): string | null {
    if (!candidate) { return null; }
    const stripped = stripRoot(normalizeSeparators(root), normalizeSeparators(candidate.trim()));
    if (stripped === null) { return null; }
    const path = stripped.replace(/^(\.\/)+/, '');
    if (!path || path === '.' || path.startsWith('../') || path === '..') { return null; }
    return collapseSegments(path);
}
