import fs from 'node:fs/promises';
import path from 'node:path';
import { GitCommandError, GitNotFoundError } from '../git/gitRunner.ts';
import { runWorktreeGit, type WorktreeGitOptions, type WorktreeGitResult } from './worktreeGit.ts';
import {
    agentBranchName, isAgentBranch, isSafeSessionId, parseNameStatus, parseNulList, parsePorcelain, parseWorktreeList, repoHash,
    type WorktreeChangeStatus,
} from './worktreeModel.ts';

/**
 * Agent worktrees (AF12, #277): a chat can run in its own `git worktree`, on
 * its own branch, so several agents work on one project in parallel without
 * writing over each other's files, and the person then merges or discards
 * each result. Pure Node, no Electron; the IPC layer wraps these functions.
 *
 * Lifecycle:
 *   canUseWorktrees(projectRoot)      the folder is in a work tree with a commit
 *   createWorktree({...})             branch `codexr/agent/<slug>-<id>` from HEAD,
 *                                     worktree at `storageDir/<repo-hash>/<sessionId>`
 *   worktreeStatus(info)              what the agent changed since baseCommit
 *   commitAll(info, message)          `add -A` + commit inside the worktree
 *   mergeIntoCurrent(info, {...})     into the main tree's current branch
 *   removeWorktree(info, {...})       worktree remove --force + prune (+ branch -D)
 *   listWorktrees(projectRoot)        ours only, after a restart
 *
 * Choices:
 * - The worktree starts from HEAD, not from the main tree's uncommitted
 *   state; `createWorktree` reports `dirty` so the UI can say that those
 *   changes are not in the agent's copy.
 * - Worktrees live outside the project (in `storageDir`, e.g. userData), so the
 *   project's file watchers, search and analyses never see a second copy of
 *   it. The folder is keyed on a hash of the repository's common git
 *   directory, so a project opened from a sub-folder and all of its worktrees
 *   share one place. A JSON sidecar next to each worktree
 *   (`<sessionId>.json`) keeps `baseCommit`, the label and the sub-folder, so
 *   `listWorktrees` returns complete records after a restart; without it the
 *   base falls back to the merge base with the main tree's HEAD.
 * - Hooks. What the IDE does on the agent's behalf runs none of the
 *   repository's hooks: `worktree add` (post-checkout) and the worktree
 *   commits (pre-commit, prepare-commit-msg, commit-msg, post-commit) run
 *   with `core.hooksPath` pointing at an empty directory the IDE owns, and the
 *   commits also pass `--no-verify`. `--no-verify` alone is not enough: it
 *   skips neither prepare-commit-msg nor post-commit. Those commits are also
 *   unsigned (`commit.gpgsign=false`): they are scratch history on a throwaway
 *   branch, and a signing prompt would hang an unattended agent. The final
 *   merge into the person's branch is theirs, so it runs with their hooks and
 *   their signing configuration, as if they had typed it.
 * - Identity: worktree commits use the repository's own `user.name` and
 *   `user.email` (local or global config). When either is missing, that one
 *   commit is made as `Code-XR agent <agent@code-xr.invalid>` via `-c`; no
 *   configuration file is ever written.
 * - Merge safety: the merge refuses, before touching anything, when the main
 *   tree has staged changes, uncommitted changes to a file the branch also
 *   changes, an operation in progress, a detached HEAD, or when
 *   `git merge-tree --write-tree` predicts a conflict. If the real merge
 *   still fails (an older git without merge-tree, a hook that rejects), it is
 *   undone with `merge --abort` / `reset --merge`, which keeps the person's
 *   unrelated uncommitted edits, and the error says why. `merge` makes a
 *   merge commit (`--no-ff`, so the agent's work stays one visible unit);
 *   `squash` makes one ordinary commit.
 * - Environment: inherited `GIT_*` variables, `ELECTRON_RUN_AS_NODE` and
 *   `NODE_OPTIONS` are dropped (worktreeGit.ts). Paths go through `path`;
 *   what git prints (forward slashes, also on Windows) is resolved before it
 *   is compared, and file paths reported to callers stay git's POSIX form.
 * - Mutating calls on one repository are serialized by an in-process lock, so
 *   two chats finishing together cannot interleave two merges.
 */

export type WorktreeErrorCode =
    | 'git-missing'
    | 'not-a-repo'
    | 'bare-repo'
    | 'no-commits'
    | 'invalid-argument'
    | 'storage-inside-project'
    | 'already-exists'
    | 'worktree-missing'
    | 'branch-missing'
    | 'branch-changed'
    | 'not-ours'
    | 'detached-head'
    | 'operation-in-progress'
    | 'staged-changes'
    | 'dirty-overlap'
    | 'uncommitted-in-worktree'
    | 'conflicts'
    | 'merge-failed';

/** Every refusal of this module; `files` lists the paths involved (POSIX, repository-relative) when there are any. */
export class WorktreeError extends Error {
    readonly code: WorktreeErrorCode;
    readonly files: readonly string[];
    constructor(code: WorktreeErrorCode, message: string, files: readonly string[] = []) {
        super(message);
        this.name = 'WorktreeError';
        this.code = code;
        this.files = files;
    }
}

export type WorktreeAvailability =
    | { readonly ok: true; readonly repoRoot: string; readonly head: string }
    | { readonly ok: false; readonly reason: 'git-missing' | 'not-a-repo' | 'bare-repo' | 'no-commits'; readonly message: string };

/** Everything needed to act on one agent worktree; the caller keeps it with the chat. */
export interface WorktreeInfo {
    readonly sessionId: string;
    readonly label: string;
    /** Top of the main work tree, where merges land. */
    readonly repoRoot: string;
    /** Top of the agent's worktree. */
    readonly path: string;
    /** Where the agent should run: `path` plus the project's sub-folder inside the repository. */
    readonly cwd: string;
    readonly branch: string;
    /** The commit the branch started from. */
    readonly baseCommit: string;
    /** Milliseconds since the epoch. */
    readonly createdAt: number;
}

export interface CreateWorktreeOptions {
    readonly projectRoot: string;
    /** Directory owned by the IDE, outside every project (e.g. `userData/worktrees`). */
    readonly storageDir: string;
    readonly sessionId: string;
    /** Human label (the chat title); becomes the branch slug. */
    readonly label: string;
}

export interface CreatedWorktree extends WorktreeInfo {
    /** The main tree had uncommitted changes (tracked or untracked), which the worktree does not have. */
    readonly dirty: boolean;
}

export interface WorktreeFileChange {
    /** Repository-relative, forward slashes. */
    readonly path: string;
    readonly status: WorktreeChangeStatus;
    /** Changed by a commit on the branch. */
    readonly committed: boolean;
    /** Changed in the worktree and not committed yet. */
    readonly uncommitted: boolean;
}

export interface WorktreeStatus {
    readonly exists: boolean;
    readonly files: readonly WorktreeFileChange[];
    /** Commits on the branch since baseCommit. */
    readonly ahead: number;
    /** Commits on the main tree's HEAD that the branch does not have. */
    readonly behind: number;
    readonly hasUncommitted: boolean;
}

export interface CommitResult {
    readonly commit: string;
    readonly fileCount: number;
    /** The fallback identity was used because the repository has none configured. */
    readonly fallbackIdentity: boolean;
}

export type MergeStrategy = 'merge' | 'squash';

export interface MergeOptions {
    readonly strategy: MergeStrategy;
    /** Commit message; defaults to git's own for a merge, and a summary line for a squash. */
    readonly message?: string | undefined;
}

export interface MergeResult {
    readonly strategy: MergeStrategy;
    /** The branch merged into. */
    readonly into: string;
    /** The new HEAD of the main tree; null when there was nothing to merge. */
    readonly commit: string | null;
    readonly nothingToMerge: boolean;
}

export interface RemoveOptions {
    /** Also delete the branch (`branch -D`: a squashed branch never counts as merged). */
    readonly deleteBranch: boolean;
}

export interface RemoveResult {
    readonly removedWorktree: boolean;
    readonly deletedBranch: boolean;
}

export interface ListedWorktree {
    readonly info: WorktreeInfo;
    /** HEAD of the worktree. */
    readonly head: string | null;
    readonly locked: boolean;
    /** Git reports the folder as gone; `removeWorktree` cleans it up. */
    readonly prunable: boolean;
    /** The sidecar was missing: label, cwd and baseCommit were reconstructed. */
    readonly recovered: boolean;
}

/** Hooks and checks can take time on the final merge. */
const MERGE_TIMEOUT_MS = 120_000;
const FALLBACK_NAME = 'Code-XR agent';
const FALLBACK_EMAIL = 'agent@code-xr.invalid';
const EMPTY_HOOKS_DIR = '.no-hooks';
const SIDECAR_VERSION = 1;

interface RepoContext {
    readonly repoRoot: string;
    readonly commonDir: string;
    /** The project folder relative to repoRoot, OS separators; '' at the top. */
    readonly subdir: string;
}

// ---------------------------------------------------------------------------
// Public API

export async function canUseWorktrees(projectRoot: string): Promise<WorktreeAvailability> {
    try {
        const inside = await git(projectRoot, ['rev-parse', '--is-inside-work-tree'], { okExitCodes: [128] });
        if (inside.exitCode === 128) {
            return { ok: false, reason: 'not-a-repo', message: 'This folder is not inside a git repository.' };
        }
        if (inside.stdout.trim() !== 'true') {
            return { ok: false, reason: 'bare-repo', message: 'This folder is not a git work tree (a bare repository or a .git folder).' };
        }
        const head = await git(projectRoot, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { okExitCodes: [1] });
        if (head.exitCode !== 0 || !head.stdout.trim()) {
            return { ok: false, reason: 'no-commits', message: 'The repository has no commit yet; an agent worktree starts from the current commit.' };
        }
        const context = await repoContext(projectRoot);
        return { ok: true, repoRoot: context.repoRoot, head: head.stdout.trim() };
    } catch (error) {
        if (error instanceof GitNotFoundError) {
            return { ok: false, reason: 'git-missing', message: 'Agent worktrees need git, and git was not found on PATH.' };
        }
        throw error;
    }
}

export async function createWorktree(options: CreateWorktreeOptions): Promise<CreatedWorktree> {
    const { projectRoot, sessionId, label } = options;
    if (!isSafeSessionId(sessionId)) {
        throw new WorktreeError('invalid-argument', `"${sessionId}" cannot name a worktree folder.`);
    }
    const availability = await canUseWorktrees(projectRoot);
    if (!availability.ok) {
        throw new WorktreeError(availability.reason, availability.message);
    }
    const context = await repoContext(projectRoot);
    const storageDir = path.resolve(options.storageDir);
    if (isInside(storageDir, context.repoRoot)) {
        throw new WorktreeError('storage-inside-project', 'Agent worktrees must be stored outside the repository.');
    }
    return withRepoLock(context.commonDir, async () => {
        const repoDir = path.join(storageDir, repoHash(context.commonDir));
        await fs.mkdir(repoDir, { recursive: true });
        // Registered by its real path, so later comparisons with git's output hold (macOS /var -> /private/var).
        const realRepoDir = await fs.realpath(repoDir);
        const worktreePath = path.join(realRepoDir, sessionId);
        if (await exists(worktreePath)) {
            throw new WorktreeError('already-exists', `A worktree for this chat already exists at ${worktreePath}.`);
        }
        const baseCommit = (await git(context.repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
        const dirty = (await mainTreeStatus(context.repoRoot)).length > 0;
        const branch = await freshBranchName(context.repoRoot, label);
        const hooks = await emptyHooksDir(realRepoDir);
        try {
            await git(context.repoRoot, ['worktree', 'add', '-b', branch, '--', worktreePath, baseCommit], {
                config: [`core.hooksPath=${hooks}`],
                timeoutMs: MERGE_TIMEOUT_MS,
            });
        } catch (error) {
            // `worktree add -b` can leave the branch behind when the checkout fails.
            await git(context.repoRoot, ['branch', '-D', branch], { okExitCodes: [1] }).catch(() => undefined);
            await git(context.repoRoot, ['worktree', 'prune']).catch(() => undefined);
            throw error;
        }
        const info: WorktreeInfo = {
            sessionId,
            label,
            repoRoot: context.repoRoot,
            path: worktreePath,
            cwd: context.subdir ? path.join(worktreePath, context.subdir) : worktreePath,
            branch,
            baseCommit,
            createdAt: Date.now(),
        };
        await writeSidecar(info);
        return { ...info, dirty };
    });
}

export async function worktreeStatus(info: WorktreeInfo): Promise<WorktreeStatus> {
    const behind = await countCommits(info.repoRoot, `${info.branch}..HEAD`).catch(() => 0);
    if (!(await isWorktreeFolder(info.path))) {
        const ahead = await countCommits(info.repoRoot, `${info.baseCommit}..${info.branch}`).catch(() => 0);
        return { exists: false, files: [], ahead, behind, hasUncommitted: false };
    }
    const committed = parseNameStatus((await git(info.path, ['diff', '--name-status', '-z', '--no-renames', info.baseCommit, 'HEAD', '--'])).stdout);
    const net = parseNameStatus((await git(info.path, ['diff', '--name-status', '-z', '--no-renames', info.baseCommit, '--'])).stdout);
    const untracked = parseNulList((await git(info.path, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout);
    for (const file of untracked) {
        net.set(file, 'added');
    }
    const uncommitted = new Set(parsePorcelain((await git(info.path, statusArgs())).stdout).map((entry) => entry.path));
    const paths = new Set([...net.keys(), ...committed.keys()]);
    const files = [...paths].sort().map((file): WorktreeFileChange => ({
        path: file,
        status: net.get(file) ?? committed.get(file) ?? 'modified',
        committed: committed.has(file),
        uncommitted: uncommitted.has(file),
    }));
    const ahead = await countCommits(info.path, `${info.baseCommit}..HEAD`);
    return { exists: true, files, ahead, behind, hasUncommitted: uncommitted.size > 0 };
}

/** Stages everything in the worktree and commits it; null when there is nothing to commit. */
export async function commitAll(info: WorktreeInfo, message: string): Promise<CommitResult | null> {
    if (!message.trim() || message.includes('\0')) {
        throw new WorktreeError('invalid-argument', 'A commit needs a message.');
    }
    await assertWorktreeOnBranch(info);
    await git(info.path, ['add', '-A', '--', '.']);
    const staged = parseNulList((await git(info.path, ['diff', '--cached', '--name-only', '-z', '--no-renames'])).stdout);
    if (staged.length === 0) {
        return null;
    }
    const name = await configValue(info.path, 'user.name');
    const email = await configValue(info.path, 'user.email');
    const fallbackIdentity = !name || !email;
    const config = [`core.hooksPath=${await emptyHooksDir(path.dirname(info.path))}`, 'commit.gpgsign=false'];
    if (fallbackIdentity) {
        config.push(`user.name=${FALLBACK_NAME}`, `user.email=${FALLBACK_EMAIL}`);
    }
    await git(info.path, ['commit', '--no-verify', '-q', '-m', message], { config, timeoutMs: MERGE_TIMEOUT_MS });
    const commit = (await git(info.path, ['rev-parse', 'HEAD'])).stdout.trim();
    return { commit, fileCount: staged.length, fallbackIdentity };
}

export async function mergeIntoCurrent(info: WorktreeInfo, options: MergeOptions): Promise<MergeResult> {
    const { strategy } = options;
    if (strategy !== 'merge' && strategy !== 'squash') {
        throw new WorktreeError('invalid-argument', `Unknown merge strategy "${String(strategy)}".`);
    }
    if (!isAgentBranch(info.branch)) {
        throw new WorktreeError('not-ours', `${info.branch} is not an agent branch.`);
    }
    const context = await repoContext(info.repoRoot);
    return withRepoLock(context.commonDir, async () => {
        const root = context.repoRoot;
        const branchRef = `refs/heads/${info.branch}`;
        if ((await git(root, ['rev-parse', '--verify', '-q', branchRef], { okExitCodes: [1] })).exitCode !== 0) {
            throw new WorktreeError('branch-missing', `The branch ${info.branch} no longer exists.`);
        }
        if (await isWorktreeFolder(info.path)) {
            const pending = parsePorcelain((await git(info.path, statusArgs())).stdout).map((entry) => entry.path);
            if (pending.length > 0) {
                throw new WorktreeError('uncommitted-in-worktree', 'The agent\'s worktree has uncommitted changes. Commit or discard them before merging.', pending);
            }
        }
        const current = await git(root, ['symbolic-ref', '-q', '--short', 'HEAD'], { okExitCodes: [1] });
        const into = current.stdout.trim();
        if (current.exitCode !== 0 || !into) {
            throw new WorktreeError('detached-head', 'The project is not on a branch (detached HEAD). Check out a branch before merging.');
        }
        if (into === info.branch) {
            throw new WorktreeError('invalid-argument', 'The project already has the agent branch checked out.');
        }
        await assertNoOperationInProgress(root);

        const ahead = await countCommits(root, `HEAD..${branchRef}`);
        if (ahead === 0) {
            return { strategy, into, commit: null, nothingToMerge: true };
        }
        const branchFiles = new Set(parseNulList((await git(root, ['diff', '--name-only', '-z', '--no-renames', `HEAD...${branchRef}`, '--'])).stdout));
        const mainStatus = await mainTreeStatus(root);
        const staged = mainStatus.filter((entry) => entry.staged).map((entry) => entry.path);
        if (staged.length > 0) {
            throw new WorktreeError('staged-changes', 'The project has staged changes. Commit or unstage them before merging an agent\'s work.', staged);
        }
        const overlap = mainStatus.map((entry) => entry.path).filter((file) => branchFiles.has(file));
        if (overlap.length > 0) {
            throw new WorktreeError(
                'dirty-overlap',
                'The project has uncommitted changes to files the agent also changed. Commit, stash or discard them before merging.',
                overlap,
            );
        }
        const predicted = await predictConflicts(root, branchRef);
        if (predicted && predicted.length > 0) {
            throw new WorktreeError('conflicts', `Merging ${info.branch} into ${into} would conflict. Nothing was changed.`, predicted);
        }

        if (strategy === 'merge') {
            const message = options.message?.trim() || `Merge branch '${info.branch}'`;
            try {
                await git(root, ['merge', '--no-ff', '--no-edit', '-m', message, branchRef], { timeoutMs: MERGE_TIMEOUT_MS });
            } catch (error) {
                const conflicted = await conflictedFiles(root);
                await git(root, ['merge', '--abort'], { okExitCodes: [128] }).catch(() => git(root, ['reset', '--merge']));
                throw mergeFailure(error, conflicted, info.branch, into);
            }
        } else {
            const message = options.message?.trim() || `Squashed changes from ${info.branch}`;
            try {
                await git(root, ['merge', '--squash', branchRef], { timeoutMs: MERGE_TIMEOUT_MS });
            } catch (error) {
                const conflicted = await conflictedFiles(root);
                await git(root, ['reset', '--merge']);
                throw mergeFailure(error, conflicted, info.branch, into);
            }
            try {
                await git(root, ['commit', '-q', '-m', message], { timeoutMs: MERGE_TIMEOUT_MS });
            } catch (error) {
                await git(root, ['reset', '--merge']);
                throw mergeFailure(error, [], info.branch, into);
            }
        }
        const commit = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
        return { strategy, into, commit, nothingToMerge: false };
    });
}

export async function removeWorktree(info: WorktreeInfo, options: RemoveOptions): Promise<RemoveResult> {
    if (!isAgentBranch(info.branch)) {
        throw new WorktreeError('not-ours', `${info.branch} is not an agent branch; it is never deleted.`);
    }
    const context = await repoContext(info.repoRoot);
    return withRepoLock(context.commonDir, async () => {
        const root = context.repoRoot;
        const entries = await worktreeEntries(root);
        const target = await comparablePath(info.path);
        let registered = null;
        for (const entry of entries) {
            if (await comparablePath(entry.path) === target) {
                registered = entry;
            }
        }
        if (registered && registered.branch !== null && !isAgentBranch(registered.branch)) {
            throw new WorktreeError('not-ours', `The worktree at ${info.path} is on ${registered.branch}, not on an agent branch.`);
        }
        let removedWorktree = false;
        // Only a folder git itself registered as a worktree is ever deleted.
        if (registered && !registered.prunable) {
            await git(root, ['worktree', 'remove', '--force', '--', registered.path], { timeoutMs: MERGE_TIMEOUT_MS });
            removedWorktree = true;
        }
        await git(root, ['worktree', 'prune']);
        if (registered && registered.prunable) {
            removedWorktree = true;
        }
        let deletedBranch = false;
        if (options.deleteBranch) {
            const branchRef = `refs/heads/${info.branch}`;
            if ((await git(root, ['rev-parse', '--verify', '-q', branchRef], { okExitCodes: [1] })).exitCode === 0) {
                await git(root, ['branch', '-D', info.branch]);
                deletedBranch = true;
            }
        }
        await fs.rm(sidecarPath(info.path), { force: true });
        return { removedWorktree, deletedBranch };
    });
}

/** The agent worktrees of the repository `projectRoot` belongs to (branch prefix `codexr/agent/`). */
export async function listWorktrees(projectRoot: string): Promise<ListedWorktree[]> {
    const context = await repoContext(projectRoot);
    const listed: ListedWorktree[] = [];
    for (const entry of await worktreeEntries(context.repoRoot)) {
        if (entry.bare || entry.branch === null || !isAgentBranch(entry.branch)) {
            continue;
        }
        const worktreePath = path.resolve(entry.path);
        const sidecar = await readSidecar(worktreePath, entry.branch);
        if (sidecar) {
            listed.push({ info: { ...sidecar, repoRoot: context.repoRoot }, head: entry.head, locked: entry.locked, prunable: entry.prunable, recovered: false });
            continue;
        }
        const base = await git(context.repoRoot, ['merge-base', 'HEAD', `refs/heads/${entry.branch}`], { okExitCodes: [1] });
        const info: WorktreeInfo = {
            sessionId: path.basename(worktreePath),
            label: entry.branch.slice(entry.branch.lastIndexOf('/') + 1),
            repoRoot: context.repoRoot,
            path: worktreePath,
            cwd: context.subdir ? path.join(worktreePath, context.subdir) : worktreePath,
            branch: entry.branch,
            baseCommit: base.stdout.trim() || (entry.head ?? ''),
            createdAt: 0,
        };
        listed.push({ info, head: entry.head, locked: entry.locked, prunable: entry.prunable, recovered: true });
    }
    return listed;
}

// ---------------------------------------------------------------------------
// Internals

function git(cwd: string, args: readonly string[], options: WorktreeGitOptions = {}): Promise<WorktreeGitResult> {
    return runWorktreeGit(cwd, args, options);
}

const repoLocks = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier task on the same repository has settled. */
function withRepoLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = repoLocks.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(() => undefined, () => undefined);
    repoLocks.set(key, settled);
    void settled.then(() => {
        if (repoLocks.get(key) === settled) {
            repoLocks.delete(key);
        }
    });
    return next;
}

async function repoContext(projectRoot: string): Promise<RepoContext> {
    let stdout: string;
    try {
        ({ stdout } = await git(projectRoot, ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir']));
    } catch (error) {
        if (error instanceof GitCommandError) {
            throw new WorktreeError('not-a-repo', 'This folder is not inside a git work tree.');
        }
        throw error;
    }
    const [top, common] = stdout.replace(/\r/g, '').split('\n');
    if (!top || !common) {
        throw new WorktreeError('not-a-repo', 'This folder is not inside a git work tree.');
    }
    const repoRoot = path.resolve(top);
    const realProject = await fs.realpath(projectRoot).catch(() => path.resolve(projectRoot));
    const realRepo = await fs.realpath(repoRoot).catch(() => repoRoot);
    const subdir = isInside(realProject, realRepo) ? path.relative(realRepo, realProject) : '';
    return { repoRoot, commonDir: await fs.realpath(path.resolve(common)).catch(() => path.resolve(common)), subdir };
}

function statusArgs(): string[] {
    return ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'];
}

async function mainTreeStatus(root: string): Promise<ReturnType<typeof parsePorcelain>> {
    return parsePorcelain((await git(root, statusArgs())).stdout);
}

async function freshBranchName(root: string, label: string): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const branch = agentBranchName(label);
        const exists = await git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { okExitCodes: [1] });
        if (exists.exitCode !== 0) {
            return branch;
        }
    }
    throw new WorktreeError('already-exists', 'Could not find a free agent branch name.');
}

async function emptyHooksDir(parent: string): Promise<string> {
    // Session ids start with a letter or digit, so this name never collides with a worktree.
    const dir = path.join(parent, EMPTY_HOOKS_DIR);
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

async function countCommits(cwd: string, range: string): Promise<number> {
    const { stdout } = await git(cwd, ['rev-list', '--count', range, '--']);
    return Number.parseInt(stdout.trim(), 10) || 0;
}

async function configValue(cwd: string, key: string): Promise<string> {
    const { stdout } = await git(cwd, ['config', '--get', key], { okExitCodes: [1] });
    return stdout.trim();
}

async function assertWorktreeOnBranch(info: WorktreeInfo): Promise<void> {
    if (!(await isWorktreeFolder(info.path))) {
        throw new WorktreeError('worktree-missing', `The agent worktree at ${info.path} no longer exists.`);
    }
    const current = await git(info.path, ['symbolic-ref', '-q', '--short', 'HEAD'], { okExitCodes: [1] });
    if (current.stdout.trim() !== info.branch) {
        throw new WorktreeError('branch-changed', `The agent worktree is no longer on ${info.branch}; nothing was committed.`);
    }
}

async function assertNoOperationInProgress(root: string): Promise<void> {
    for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
        if ((await git(root, ['rev-parse', '--verify', '-q', ref], { okExitCodes: [1] })).exitCode === 0) {
            throw new WorktreeError('operation-in-progress', 'The project has a merge, cherry-pick or revert in progress. Finish or abort it first.');
        }
    }
    for (const dir of ['rebase-merge', 'rebase-apply']) {
        const gitPath = (await git(root, ['rev-parse', '--git-path', dir])).stdout.trim();
        if (gitPath && await exists(path.resolve(root, gitPath))) {
            throw new WorktreeError('operation-in-progress', 'The project has a rebase in progress. Finish or abort it first.');
        }
    }
}

/**
 * Conflicted paths of merging `branchRef` into HEAD, computed without touching
 * the index or the work tree (`merge-tree --write-tree`, git 2.38+); null when
 * this git cannot tell, and the real merge is then the check.
 */
async function predictConflicts(root: string, branchRef: string): Promise<string[] | null> {
    try {
        const result = await git(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', 'HEAD', branchRef], { okExitCodes: [1] });
        if (result.exitCode === 0) {
            return [];
        }
        const fields = result.stdout.split('\0');
        const files: string[] = [];
        for (const field of fields.slice(1)) {
            if (field === '') {
                break;
            }
            files.push(field);
        }
        return [...new Set(files)];
    } catch (error) {
        if (error instanceof GitCommandError) {
            return null;
        }
        throw error;
    }
}

async function conflictedFiles(root: string): Promise<string[]> {
    const result = await git(root, ['diff', '--name-only', '-z', '--diff-filter=U'], { okExitCodes: [1, 128] }).catch(() => null);
    return result ? [...new Set(parseNulList(result.stdout))] : [];
}

function mergeFailure(error: unknown, conflicted: readonly string[], branch: string, into: string): WorktreeError {
    if (conflicted.length > 0) {
        return new WorktreeError('conflicts', `Merging ${branch} into ${into} conflicted; the merge was aborted.`, conflicted);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new WorktreeError('merge-failed', `Merging ${branch} into ${into} failed and was undone: ${detail}`);
}

async function worktreeEntries(root: string): Promise<ReturnType<typeof parseWorktreeList>> {
    try {
        return parseWorktreeList((await git(root, ['worktree', 'list', '--porcelain', '-z'])).stdout);
    } catch (error) {
        if (!(error instanceof GitCommandError)) {
            throw error;
        }
        // git before 2.36 has no -z: the same records, newline-separated.
        const { stdout } = await git(root, ['worktree', 'list', '--porcelain']);
        return parseWorktreeList(stdout.replace(/\r/g, '').replace(/\n/g, '\0'));
    }
}

/** A worktree folder: it exists and has the `.git` file `worktree add` writes. */
async function isWorktreeFolder(worktreePath: string): Promise<boolean> {
    return exists(path.join(worktreePath, '.git'));
}

async function exists(target: string): Promise<boolean> {
    return fs.access(target).then(() => true, () => false);
}

function isInside(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** A path in a form two spellings of one folder compare equal in (real path, case-folded where the file system is). */
async function comparablePath(target: string): Promise<string> {
    const resolved = await fs.realpath(path.resolve(target)).catch(() => path.resolve(target));
    return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

function sidecarPath(worktreePath: string): string {
    return `${path.resolve(worktreePath)}.json`;
}

async function writeSidecar(info: WorktreeInfo): Promise<void> {
    const target = sidecarPath(info.path);
    const temporary = `${target}.tmp`;
    const { sessionId, label, path: worktreePath, cwd, branch, baseCommit, createdAt } = info;
    await fs.writeFile(temporary, JSON.stringify({ version: SIDECAR_VERSION, sessionId, label, path: worktreePath, cwd, branch, baseCommit, createdAt }, null, 2));
    await fs.rename(temporary, target);
}

async function readSidecar(worktreePath: string, branch: string): Promise<Omit<WorktreeInfo, 'repoRoot'> | null> {
    try {
        const raw = JSON.parse(await fs.readFile(sidecarPath(worktreePath), 'utf8')) as Record<string, unknown>;
        const { sessionId, label, cwd, baseCommit, createdAt } = raw;
        if (raw['version'] !== SIDECAR_VERSION || raw['branch'] !== branch || typeof sessionId !== 'string' || typeof label !== 'string'
            || typeof cwd !== 'string' || typeof baseCommit !== 'string' || typeof createdAt !== 'number') {
            return null;
        }
        return { sessionId, label, path: worktreePath, cwd, branch, baseCommit, createdAt };
    } catch {
        return null;
    }
}
