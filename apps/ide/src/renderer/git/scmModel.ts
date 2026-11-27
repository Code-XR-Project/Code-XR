import type { GitChange, GitChangeLetter, GitRemoteOperation, GitStash, GitStatus } from '../../shared/git.ts';
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

/** The status-bar item: the branch, or the detached commit. Null when there is no repository. */
export function branchLabel(status: GitStatus): string | null {
    if (status.state !== 'ok') {
        return null;
    }
    return status.branch ?? (status.head ? `${status.head} (detached)` : 'no commit');
}

/** #284: the status-bar item beside the branch: its ahead/behind counts, and what a click does. */
export interface SyncItem {
    /** `2\u2193 1\u2191` (behind, then ahead, as in VS Code), or '' when in step. */
    readonly text: string;
    readonly title: string;
    /** Sync with an upstream, or publish a branch that has none. */
    readonly operation: 'sync' | 'push';
}

/** #284: null without a repository, on a detached HEAD, or before the first commit. */
export function syncItem(status: GitStatus): SyncItem | null {
    if (status.state !== 'ok' || status.branch === null || status.head === null) {
        return null;
    }
    if (!status.upstream) {
        return { text: '', title: `Publish Branch: push ${status.branch} and track it`, operation: 'push' };
    }
    const text = status.ahead > 0 || status.behind > 0 ? `${status.behind}\u2193 ${status.ahead}\u2191` : '';
    const parts = [
        ...(status.behind > 0 ? [`pull ${commits(status.behind)} from ${status.upstream}`] : []),
        ...(status.ahead > 0 ? [`push ${commits(status.ahead)} to ${status.upstream}`] : []),
    ];
    return { text, title: parts.length > 0 ? `Synchronize Changes: ${parts.join(', ')}` : `Synchronize Changes with ${status.upstream}`, operation: 'sync' };
}

function commits(count: number): string {
    return count === 1 ? '1 commit' : `${count} commits`;
}

/** #284: what a running remote operation's progress notification says. */
export function remoteProgressTitle(operation: GitRemoteOperation, status: GitStatus): string {
    const target = status.upstream ?? 'the remote';
    switch (operation) {
        case 'push': return status.upstream ? `Pushing to ${target}...` : `Publishing ${status.branch ?? 'the branch'}...`;
        case 'pull': return `Pulling from ${target}...`;
        case 'fetch': return 'Fetching...';
        case 'sync': return `Synchronizing with ${target}...`;
    }
}

/** #284: the stash picker; ids are `stash:<index>`. */
export function stashPickerView(stashes: readonly GitStash[], value: string): PaletteView {
    const lower = value.trim().toLowerCase();
    const entries: PaletteEntry[] = [];
    for (const stash of stashes) {
        const at = stash.label.toLowerCase().indexOf(lower);
        if (lower !== '' && at < 0) {
            continue;
        }
        entries.push({
            id: `stash:${stash.index}`,
            label: stash.label,
            description: `stash@{${stash.index}}`,
            highlights: lower === '' ? [] : Array.from({ length: lower.length }, (_, offset) => at + offset),
            runnable: true,
        });
    }
    return { entries, action: (entry) => ({ kind: 'pick', id: entry.id }), empty: 'No stashes' };
}

export function parseStashPick(id: string): number | null {
    const match = /^stash:(\d+)$/.exec(id);
    return match ? Number(match[1]) : null;
}

/** #284: the branch picker of Delete Branch: every local branch but the checked-out one; ids are `delete:<name>`. */
export function deleteBranchPickerView(branches: readonly string[], current: string | null, value: string): PaletteView {
    const lower = value.trim().toLowerCase();
    const entries: PaletteEntry[] = [];
    for (const branch of branches) {
        const at = branch.toLowerCase().indexOf(lower);
        if (branch === current || (lower !== '' && at < 0)) {
            continue;
        }
        entries.push({
            id: `delete:${branch}`,
            label: branch,
            highlights: lower === '' ? [] : Array.from({ length: lower.length }, (_, offset) => at + offset),
            runnable: true,
        });
    }
    return { entries, action: (entry) => ({ kind: 'pick', id: entry.id }), empty: 'No other local branch' };
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
