/**
 * The contract of Source Control (#17, the Git part): the renderer's view of
 * the repository the open folder belongs to.
 *
 * Kept apart from api.ts, like agents.ts, so the Git work and the rest of the
 * IDE do not edit the same lists: api.ts only spreads these channels into its
 * own. Shared by main, preload and renderer, so it stays free of any Node,
 * Electron or DOM import.
 *
 * Every path here is relative to the open folder, `/`-separated on every OS,
 * like the workspace API. The main process resolves each one inside the
 * folder and refuses anything else; it never trusts a path from the page.
 */

/**
 * The letter a change shows, as in VS Code: Added, Modified, Deleted,
 * Untracked, Renamed, Copied, Type changed, and `!` for a merge conflict.
 */
export type GitChangeLetter = 'A' | 'M' | 'D' | 'U' | 'R' | 'C' | 'T' | '!';

export interface GitChange {
    /** Relative to the open folder. */
    readonly path: string;
    readonly letter: GitChangeLetter;
    /** A rename or copy's source, when it is inside the open folder. */
    readonly origPath?: string | undefined;
}

/**
 * Why there is nothing to show, or `ok`.
 * - `no-folder`: no folder is open.
 * - `no-git`: no `git` executable on PATH.
 * - `not-repo`: the folder is not inside a Git work tree.
 * - `error`: git ran and failed (`message` says how).
 */
export type GitRepoState = 'ok' | 'no-folder' | 'no-git' | 'not-repo' | 'error';

export interface GitStatus {
    readonly state: GitRepoState;
    /** For display when the state is not `ok`. */
    readonly message?: string | undefined;
    /** The checked-out branch; null when HEAD is detached. */
    readonly branch: string | null;
    /** The commit HEAD points at (abbreviated), null before the first commit. */
    readonly head: string | null;
    readonly upstream: string | null;
    readonly ahead: number;
    readonly behind: number;
    /** Changes in the index (to be committed). */
    readonly staged: readonly GitChange[];
    /** Changes in the working tree that are not staged, conflicts included. */
    readonly changes: readonly GitChange[];
    readonly untracked: readonly GitChange[];
}

/** The local branches, for the status bar's picker. */
export interface GitBranchList {
    readonly current: string | null;
    readonly branches: readonly string[];
}

/** The result of a commit: the new commit's abbreviated hash, or null when the person cancelled. */
export interface GitCommitResult {
    readonly commit: string | null;
}

/** What the renderer can ask of Source Control (`window.codexr.git`). */
export interface GitApi {
    /** The repository's state, computed now. Never rejects for a missing git or a non-repository. */
    status(): Promise<GitStatus>;
    /** Stages these changes (deletions included). */
    stage(paths: readonly string[]): Promise<GitStatus>;
    /** Moves these staged changes back to the working tree. */
    unstage(paths: readonly string[]): Promise<GitStatus>;
    /**
     * Discards a working-tree change after a native confirmation in the main
     * process; an untracked file goes to the OS trash. Resolves with the new
     * status (unchanged when the person cancels).
     */
    discard(path: string): Promise<GitStatus>;
    /**
     * Commits the staged changes with `message`. With nothing staged the main
     * process asks, in a native dialog, whether to stage everything first.
     */
    commit(message: string): Promise<GitCommitResult>;
    branches(): Promise<GitBranchList>;
    /** Checks out a branch from `branches()`; any other name is refused. */
    switchBranch(name: string): Promise<GitStatus>;
    /** Creates a branch at HEAD and checks it out. */
    createBranch(name: string): Promise<GitStatus>;
    /** A file's text at HEAD, for the diff view; null when HEAD has no such file. */
    headContent(path: string): Promise<string | null>;
    /** Fires when the repository changed on disk (index, HEAD, refs), from the IDE or outside it. */
    onDidChange(listener: () => void): () => void;
}

/** Channels of Source Control; api.ts merges them into IPC_CHANNELS. */
export const GIT_IPC_CHANNELS = {
    gitStatus: 'codexr:git:status',
    gitStage: 'codexr:git:stage',
    gitUnstage: 'codexr:git:unstage',
    gitDiscard: 'codexr:git:discard',
    gitCommit: 'codexr:git:commit',
    gitBranches: 'codexr:git:branches',
    gitSwitchBranch: 'codexr:git:switch-branch',
    gitCreateBranch: 'codexr:git:create-branch',
    gitHeadContent: 'codexr:git:head-content',
} as const;

/** Main -> renderer events of Source Control; api.ts merges them into IPC_EVENTS. */
export const GIT_IPC_EVENTS = {
    gitChanged: 'codexr:git:changed',
} as const;

/** A status with nothing in it, for the states that are not `ok`. */
export function emptyGitStatus(state: GitRepoState, message?: string): GitStatus {
    return { state, message, branch: null, head: null, upstream: null, ahead: 0, behind: 0, staged: [], changes: [], untracked: [] };
}
