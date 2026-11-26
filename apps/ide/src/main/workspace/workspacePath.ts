import path from 'node:path';

/**
 * Workspace-relative paths, the only kind the renderer may send (#14).
 *
 * The renderer is untrusted: it names files as `/`-separated paths relative
 * to the open folder, and everything here refuses a path that could point
 * outside it. A symlink inside the folder that leads out is the service's job
 * (it compares real paths); this module only parses.
 */

const MAX_PATH_LENGTH = 4096;

/**
 * Validates a workspace-relative path from the renderer and returns its
 * segments. `''` is the root. Throws on anything that is not a plain relative
 * path: absolute paths, drive letters, `\`, `.` or `..` segments, empty
 * segments, NUL.
 */
export function parseWorkspacePath(input: unknown): readonly string[] {
    if (typeof input !== 'string') {
        throw new Error('A workspace path must be a string.');
    }
    if (input === '') {
        return [];
    }
    if (input.length > MAX_PATH_LENGTH) {
        throw new Error('Workspace path is too long.');
    }
    if (input.includes('\0') || input.includes('\\')) {
        throw new Error(`Invalid workspace path: ${JSON.stringify(input)}`);
    }
    if (input.startsWith('/') || /^[a-zA-Z]:/.test(input)) {
        throw new Error(`Workspace paths are relative: ${JSON.stringify(input)}`);
    }
    const segments = input.split('/');
    for (const segment of segments) {
        if (segment === '' || segment === '.' || segment === '..') {
            throw new Error(`Invalid workspace path: ${JSON.stringify(input)}`);
        }
    }
    return segments;
}

/** The absolute path of a validated workspace path; refuses anything that lands outside `root`. */
export function resolveInWorkspace(root: string, relativePath: unknown): string {
    const absolute = path.join(root, ...parseWorkspacePath(relativePath));
    if (!isInside(root, absolute)) {
        throw new Error(`Path leaves the workspace: ${String(relativePath)}`);
    }
    return absolute;
}

/** True when `candidate` is `root` or below it (compares resolved paths). */
export function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Joins a workspace-relative parent and a child name with `/`. */
export function childPath(parent: string, name: string): string {
    return parent === '' ? name : `${parent}/${name}`;
}

/** The flag that opens a folder at startup: `--folder=<path>` (scripts, the smoke run, a shell alias). */
export const FOLDER_FLAG = '--folder=';

/** The folder named by `--folder=<path>` on the command line, if any (the last one wins). */
export function folderArgument(argv: readonly string[]): string | undefined {
    const value = [...argv].reverse().find((arg) => arg.startsWith(FOLDER_FLAG))?.slice(FOLDER_FLAG.length);
    return value ? value : undefined;
}
