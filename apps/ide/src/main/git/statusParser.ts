import type { GitChange, GitChangeLetter } from '../../shared/git.ts';

/**
 * A pure parser for `git status --porcelain=v2 -z --branch` (#17), and the
 * grouping Source Control shows. No git, no file system: unit-tested on
 * strings (test/git.test.ts).
 *
 * Format reference: git-status(1), "Porcelain Format Version 2". With `-z`
 * every record ends in NUL, paths are never quoted, and a rename or copy
 * record (`2`) is followed by one more NUL-terminated field, its source path.
 * Paths are relative to the top of the work tree.
 */

export interface PorcelainBranch {
    /** `branch.oid`; null for `(initial)` (no commit yet). */
    readonly oid: string | null;
    /** `branch.head`; null for `(detached)`. */
    readonly head: string | null;
    readonly upstream: string | null;
    readonly ahead: number;
    readonly behind: number;
}

export type PorcelainEntry =
    /** `1` (ordinary) and `2` (rename or copy): X is the index, Y the work tree, `.` meaning unchanged. */
    | { readonly kind: 'changed'; readonly x: string; readonly y: string; readonly path: string; readonly origPath?: string | undefined }
    | { readonly kind: 'unmerged'; readonly x: string; readonly y: string; readonly path: string }
    | { readonly kind: 'untracked'; readonly path: string }
    | { readonly kind: 'ignored'; readonly path: string };

export interface PorcelainStatus {
    readonly branch: PorcelainBranch;
    readonly entries: readonly PorcelainEntry[];
}

/** Splits `text` after the first `count` space-separated fields; the rest (a path, spaces allowed) is the last item. */
function fields(text: string, count: number): string[] | null {
    const out: string[] = [];
    let rest = text;
    for (let i = 0; i < count; i++) {
        const space = rest.indexOf(' ');
        if (space < 0) {
            return null;
        }
        out.push(rest.slice(0, space));
        rest = rest.slice(space + 1);
    }
    out.push(rest);
    return out;
}

export function parsePorcelainV2(output: string): PorcelainStatus {
    let oid: string | null = null;
    let head: string | null = null;
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;
    const entries: PorcelainEntry[] = [];
    const records = output.split('\0');
    for (let i = 0; i < records.length; i++) {
        const record = records[i] ?? '';
        if (record === '') {
            continue;
        }
        if (record.startsWith('# ')) {
            const [key, ...value] = record.slice(2).split(' ');
            const text = value.join(' ');
            if (key === 'branch.oid') {
                oid = text === '(initial)' ? null : text;
            } else if (key === 'branch.head') {
                head = text === '(detached)' ? null : text;
            } else if (key === 'branch.upstream') {
                upstream = text;
            } else if (key === 'branch.ab') {
                const match = /^\+(\d+) -(\d+)$/.exec(text);
                if (match) {
                    ahead = Number(match[1]);
                    behind = Number(match[2]);
                }
            }
            continue;
        }
        const type = record[0];
        const body = record.slice(2);
        if (type === '1') {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            const parts = fields(body, 7);
            const xy = parts?.[0];
            const path = parts?.[7];
            if (xy?.length === 2 && path) {
                entries.push({ kind: 'changed', x: xy[0] ?? '.', y: xy[1] ?? '.', path });
            }
        } else if (type === '2') {
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>, then <origPath> as the next record
            const parts = fields(body, 8);
            const xy = parts?.[0];
            const path = parts?.[8];
            const origPath = records[i + 1];
            i++;
            if (xy?.length === 2 && path) {
                entries.push({ kind: 'changed', x: xy[0] ?? '.', y: xy[1] ?? '.', path, origPath: origPath || undefined });
            }
        } else if (type === 'u') {
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            const parts = fields(body, 9);
            const xy = parts?.[0];
            const path = parts?.[9];
            if (xy?.length === 2 && path) {
                entries.push({ kind: 'unmerged', x: xy[0] ?? '.', y: xy[1] ?? '.', path });
            }
        } else if (type === '?' && body) {
            entries.push({ kind: 'untracked', path: body });
        } else if (type === '!' && body) {
            entries.push({ kind: 'ignored', path: body });
        }
    }
    return { branch: { oid, head, upstream, ahead, behind }, entries };
}

/** The letter for one side of an ordinary record (`.` means that side is unchanged). */
function letterOf(code: string): GitChangeLetter | null {
    switch (code) {
        case 'A': return 'A';
        case 'M': return 'M';
        case 'D': return 'D';
        case 'R': return 'R';
        case 'C': return 'C';
        case 'T': return 'T';
        default: return null;
    }
}

export interface GroupedChanges {
    readonly staged: GitChange[];
    readonly changes: GitChange[];
    readonly untracked: GitChange[];
}

/**
 * Groups entries as Source Control shows them: Staged (the index side),
 * Changes (the work-tree side and conflicts), Untracked. A file changed on
 * both sides is listed in both groups, as in VS Code.
 *
 * `prefix` is the open folder's place in the work tree (`git rev-parse
 * --show-prefix`, `''` at the top, otherwise ending in `/`): entries outside
 * it are dropped and the rest made relative to the folder.
 */
export function groupChanges(entries: readonly PorcelainEntry[], prefix = ''): GroupedChanges {
    const staged: GitChange[] = [];
    const changes: GitChange[] = [];
    const untracked: GitChange[] = [];
    const local = (path: string | undefined): string | undefined =>
        path !== undefined && path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : undefined;
    for (const entry of entries) {
        const path = local(entry.path);
        if (path === undefined || path.endsWith('/')) {
            continue;
        }
        if (entry.kind === 'untracked') {
            untracked.push({ path, letter: 'U' });
        } else if (entry.kind === 'unmerged') {
            changes.push({ path, letter: '!' });
        } else if (entry.kind === 'changed') {
            const index = letterOf(entry.x);
            const tree = letterOf(entry.y);
            if (index) {
                const origPath = local(entry.origPath);
                staged.push(origPath === undefined ? { path, letter: index } : { path, letter: index, origPath });
            }
            if (tree) {
                changes.push({ path, letter: tree });
            }
        }
    }
    const byPath = (a: GitChange, b: GitChange): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { staged: staged.sort(byPath), changes: changes.sort(byPath), untracked: untracked.sort(byPath) };
}
