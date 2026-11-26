import type { GitChange, GitChangeLetter, GitStatus } from '../../shared/git.ts';
import type { PaletteEntry, PaletteView } from '../commands/paletteModel.ts';

/**
 * Pure helpers of the Source Control view (#17): what each group and letter
 * says, the status-bar text, and the branch picker's entries. No DOM, so
 * they are unit-tested (test/git.test.ts).
 */

export type ScmGroupId = 'staged' | 'changes' | 'untracked';

export interface ScmGroup {
    readonly id: ScmGroupId;
    readonly label: string;
    readonly changes: readonly GitChange[];
}

/** The groups that have something in them, in VS Code's order. */
export function scmGroups(status: GitStatus): ScmGroup[] {
    const groups: ScmGroup[] = [
        { id: 'staged', label: 'Staged Changes', changes: status.staged },
        { id: 'changes', label: 'Changes', changes: status.changes },
        { id: 'untracked', label: 'Untracked', changes: status.untracked },
    ];
    return groups.filter((group) => group.changes.length > 0);
}

const LETTER_TITLES: Readonly<Record<GitChangeLetter, string>> = {
    A: 'Added',
    M: 'Modified',
    D: 'Deleted',
    U: 'Untracked',
    R: 'Renamed',
    C: 'Copied',
    T: 'Type changed',
    '!': 'Conflict',
};

export function letterTitle(letter: GitChangeLetter): string {
    return LETTER_TITLES[letter];
}

/** How many files have a change (a file both staged and changed counts once), for the activity badge. */
export function changeCount(status: GitStatus): number {
    return new Set([...status.staged, ...status.changes, ...status.untracked].map((change) => change.path)).size;
}

/** The status-bar item: the branch, or the detached commit, with ahead/behind counts. Null when there is no repository. */
export function branchLabel(status: GitStatus): string | null {
    if (status.state !== 'ok') {
        return null;
    }
    const name = status.branch ?? (status.head ? `${status.head} (detached)` : 'no commit');
    const sync = status.upstream && (status.ahead > 0 || status.behind > 0) ? ` ${status.behind}\u2193 ${status.ahead}\u2191` : '';
    return `${name}${sync}`;
}

/** The file name and its folder, as a row shows them. */
export function splitPath(path: string): { readonly name: string; readonly folder: string } {
    const slash = path.lastIndexOf('/');
    return slash < 0 ? { name: path, folder: '' } : { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}

/** The picker action ids: `switch:<name>`, or `create:<name>` for a new branch. */
export type BranchAction = { readonly kind: 'switch' | 'create'; readonly name: string } | null;

export function parseBranchAction(id: string): BranchAction {
    if (id.startsWith('switch:')) {
        return { kind: 'switch', name: id.slice('switch:'.length) };
    }
    if (id.startsWith('create:')) {
        return { kind: 'create', name: id.slice('create:'.length) };
    }
    return null;
}

/**
 * The branch picker, VS Code's "Select a ref to checkout": "Create new
 * branch" first (with the typed text as its name), then the local branches
 * matching the text, the current one marked.
 */
export function branchPickerView(branches: readonly string[], current: string | null, value: string): PaletteView {
    const query = value.trim();
    const lower = query.toLowerCase();
    const entries: PaletteEntry[] = [];
    if (query !== '' && !branches.includes(query)) {
        entries.push({ id: `create:${query}`, label: `Create new branch "${query}"`, highlights: [], runnable: true });
    } else if (query === '') {
        entries.push({ id: 'hint', label: 'Create new branch...', description: 'type its name', highlights: [], runnable: false });
    }
    for (const branch of branches) {
        const at = branch.toLowerCase().indexOf(lower);
        if (query !== '' && at < 0) {
            continue;
        }
        entries.push({
            id: `switch:${branch}`,
            label: branch,
            highlights: query === '' ? [] : Array.from({ length: query.length }, (_, offset) => at + offset),
            ...(branch === current ? { description: 'current branch' } : {}),
            runnable: true,
        });
    }
    return { entries, action: (entry) => ({ kind: 'pick', id: entry.id }), empty: 'No branches' };
}
