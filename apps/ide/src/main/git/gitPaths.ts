import fs from 'node:fs/promises';
import path from 'node:path';
import { isInside, parseWorkspacePath } from '../workspace/workspacePath.ts';

/**
 * The path guard of Source Control (#17). Every path git is asked about comes
 * from the renderer, so it is checked like the workspace API checks its own
 * (`parseWorkspacePath`: relative, `/`-separated, no `..`, no NUL, no drive
 * letter), then resolved inside the open folder.
 *
 * Git works on files that may no longer exist (a deletion to stage or
 * discard), so the real-path check cannot always look at the file itself: it
 * resolves the nearest ancestor that exists, which is enough to catch a
 * symlinked folder inside the workspace that leads out of it.
 *
 * The result is the workspace-relative path, re-joined with `/`, which is
 * what git gets after `--` (with `--literal-pathspecs`, so `*` or `:(top)`
 * in a name is a name and not a pattern).
 */
export async function resolveGitPath(root: string, realRoot: string, input: unknown): Promise<string> {
    const segments = parseWorkspacePath(input);
    if (segments.length === 0) {
        throw new Error('A file path is required.');
    }
    const absolute = path.join(root, ...segments);
    if (!isInside(root, absolute)) {
        throw new Error(`Path leaves the workspace: ${String(input)}`);
    }
    let probe = absolute;
    for (;;) {
        try {
            const real = await fs.realpath(probe);
            if (!isInside(realRoot, real)) {
                throw new Error(`Path leaves the workspace: ${String(input)}`);
            }
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
                throw error;
            }
            const parent = path.dirname(probe);
            if (parent === probe || !isInside(root, parent)) {
                throw new Error(`Path leaves the workspace: ${String(input)}`);
            }
            probe = parent;
        }
    }
    return segments.join('/');
}

/** A list of paths from the renderer: an array of at most `max` strings, each resolved by `resolveGitPath`. */
export async function resolveGitPaths(root: string, realRoot: string, input: unknown, max = 10_000): Promise<string[]> {
    if (!Array.isArray(input) || input.length === 0) {
        throw new Error('A list of paths is required.');
    }
    if (input.length > max) {
        throw new Error(`At most ${max} paths at a time.`);
    }
    const out: string[] = [];
    for (const item of input) {
        out.push(await resolveGitPath(root, realRoot, item));
    }
    return out;
}

/**
 * Validates a branch name from the renderer before git sees it. Git's own
 * `check-ref-format --branch` is the authority and runs after this; this
 * only refuses what could be read as an option or is not a plain string.
 */
export function validateBranchName(input: unknown): string {
    if (typeof input !== 'string') {
        throw new Error('A branch name must be a string.');
    }
    const name = input.trim();
    if (name === '' || name.length > 250) {
        throw new Error('A branch name is required (at most 250 characters).');
    }
    if (name.startsWith('-') || /[\s\0~^:?*[\\\u0000-\u001f\u007f]/.test(name) || name.includes('..') || name.includes('@{')) {
        throw new Error(`Not a valid branch name: ${JSON.stringify(name)}`);
    }
    return name;
}

/** Validates a commit message: non-empty after trimming, no NUL, at most 64 KiB. */
export function validateCommitMessage(input: unknown): string {
    if (typeof input !== 'string') {
        throw new Error('A commit message must be a string.');
    }
    if (input.trim() === '') {
        throw new Error('A commit message is required.');
    }
    if (input.includes('\0') || input.length > 65_536) {
        throw new Error('That commit message cannot be used (NUL character, or over 64 KiB).');
    }
    return input;
}
