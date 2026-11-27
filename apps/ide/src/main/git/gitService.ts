import path from 'node:path';
import { emptyGitStatus, type GitBranchList, type GitStash, type GitStatus } from '../../shared/git.ts';
import { parseBlamePorcelain, type BlameLine } from './blameParser.ts';
import { resolveGitPath, resolveGitPaths, validateBranchName, validateCommitMessage } from './gitPaths.ts';
import { GitCommandError, GitNotFoundError, REMOTE_GIT_ENV, runGit, type GitRunner, type GitRunOptions } from './gitRunner.ts';
import { remoteErrorMessage } from './remoteErrors.ts';
import { groupChanges, parsePorcelainV2 } from './statusParser.ts';

/** #284: stash takes no pathspec from the IDE, and `-u` needs its own `:/` read as a pathspec (see `literalPathspecs`). */
const STASH_OPTIONS: GitRunOptions = { literalPathspecs: false };

/** Where the open folder sits in its repository. */
export interface GitRepoInfo {
    /** The folder's path inside the work tree: `''` at the top, otherwise ending in `/`. */
    readonly prefix: string;
    /** The repository's git directory (absolute), for watching the index and HEAD. */
    readonly gitDir: string;
    /**
     * Where branches and packed refs live (absolute): the same as `gitDir`,
     * except in a linked worktree (`git worktree add`), whose own git
     * directory holds only its HEAD and index.
     */
    readonly commonDir: string;
}

/** What discarding a change means for one file. */
export type DiscardPlan =
    | { readonly kind: 'restore'; readonly path: string }
    | { readonly kind: 'trash'; readonly path: string; readonly absolute: string };

/** #284: how long a push, pull or fetch may take before it is stopped. */
export const REMOTE_TIMEOUT_MS = 120_000;

/** #284: what a remote operation takes from its caller. */
export interface RemoteOptions {
    /** Aborting it kills git (the Cancel of the progress notification). */
    readonly signal?: AbortSignal | undefined;
    /**
     * Asked when a branch with no upstream is pushed and the repository has
     * several remotes, none named `origin`; null cancels the push.
     */
    readonly chooseRemote?: ((remotes: readonly string[]) => Promise<string | null>) | undefined;
}

/** #284: a branch's upstream, from `branch.<name>.remote` and `.merge`. */
interface Upstream {
    readonly remote: string;
    /** The full ref on the remote (`refs/heads/main`). */
    readonly ref: string;
}

/**
 * Git for one open folder (#17), in the main process. Reusable beyond the
 * Source Control view: `diff(file)` and `blame(file)` are the base for
 * gutter markers and inline blame (#175).
 *
 * Every path it takes is workspace-relative and goes through
 * `resolveGitPath` (inside the folder, by real path), so a caller may hand
 * it what the renderer sent. Git runs with the folder as its working
 * directory and every path after `--` with `--literal-pathspecs`; the folder
 * may be the top of a work tree or any folder inside one, and only changes
 * inside the folder are reported.
 */
export class GitService {
    readonly root: string;
    private readonly realRoot: string;
    private readonly run: GitRunner;
    private repoInfo: GitRepoInfo | null = null;
    /** #284: the limit of each push, pull and fetch (tests shorten it). */
    remoteTimeoutMs = REMOTE_TIMEOUT_MS;

    /** `realRoot` is `root` with symlinks resolved (`fs.realpath`). */
    constructor(root: string, realRoot: string, run: GitRunner = runGit) {
        this.root = root;
        this.realRoot = realRoot;
        this.run = run;
    }

    /** The repository the folder belongs to; null when git is missing or the folder is not in a work tree. */
    async repository(): Promise<GitRepoInfo | null> {
        if (this.repoInfo) {
            return this.repoInfo;
        }
        try {
            const { stdout } = await this.run(this.root, ['rev-parse', '--is-inside-work-tree', '--show-prefix', '--absolute-git-dir', '--git-common-dir']);
            const [inside, prefix, gitDir, commonDir] = stdout.replace(/\r/g, '').split('\n');
            if (inside !== 'true' || !gitDir) {
                return null;
            }
            // `--git-common-dir` may be relative to the folder git ran in.
            this.repoInfo = { prefix: prefix ?? '', gitDir: path.normalize(gitDir), commonDir: commonDir ? path.resolve(this.root, commonDir) : path.normalize(gitDir) };
            return this.repoInfo;
        } catch (error) {
            if (error instanceof GitCommandError) {
                return null;
            }
            throw error;
        }
    }

    /** The folder's changes and branch. Never throws for a missing git or a folder outside a repository. */
    async status(): Promise<GitStatus> {
        let repo: GitRepoInfo | null;
        try {
            repo = await this.repository();
        } catch (error) {
            return error instanceof GitNotFoundError
                ? emptyGitStatus('no-git', 'Git was not found. Install Git and make sure it is on PATH, then reopen the folder.')
                : emptyGitStatus('error', String(error instanceof Error ? error.message : error));
        }
        if (!repo) {
            return emptyGitStatus('not-repo', 'The open folder is not in a Git repository.');
        }
        try {
            const { stdout } = await this.run(this.root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', '.']);
            const parsed = parsePorcelainV2(stdout);
            const groups = groupChanges(parsed.entries, repo.prefix);
            const { oid, head, upstream, ahead, behind } = parsed.branch;
            return {
                state: 'ok',
                branch: head,
                head: oid ? oid.slice(0, 7) : null,
                upstream,
                ahead,
                behind,
                ...groups,
            };
        } catch (error) {
            // The repository went away (`.git` deleted): look again next time.
            this.repoInfo = null;
            if (error instanceof GitNotFoundError) {
                return emptyGitStatus('no-git', error.message);
            }
            return emptyGitStatus('error', String(error instanceof Error ? error.message : error));
        }
    }

    /** Stages files (new, modified or deleted). */
    async stage(paths: unknown): Promise<void> {
        const files = await resolveGitPaths(this.root, this.realRoot, paths);
        await this.run(this.root, ['add', '--all', '--', ...files]);
    }

    /** Stages every change inside the folder. */
    async stageAll(): Promise<void> {
        await this.requireRepository();
        await this.run(this.root, ['add', '--all', '--', '.']);
    }

    /** Moves staged changes back to the working tree (a rename's source is unstaged with it). */
    async unstage(paths: unknown, origPaths: readonly string[] = []): Promise<void> {
        const files = await resolveGitPaths(this.root, this.realRoot, paths);
        const all = [...new Set([...files, ...origPaths])];
        if (await this.hasHead()) {
            await this.run(this.root, ['restore', '--staged', '--', ...all]);
        } else {
            // Before the first commit there is no HEAD to restore from: remove from the index only.
            await this.run(this.root, ['rm', '--cached', '--quiet', '-r', '--', ...all]);
        }
    }

    /**
     * What discarding `file`'s working-tree change does: restore it from the
     * index, or move an untracked file to the trash. Refuses a file that has
     * no working-tree change, so nothing else can be touched through it.
     */
    async discardPlan(file: unknown): Promise<DiscardPlan> {
        const relative = await resolveGitPath(this.root, this.realRoot, file);
        const status = await this.status();
        if (status.untracked.some((change) => change.path === relative)) {
            return { kind: 'trash', path: relative, absolute: path.join(this.root, ...relative.split('/')) };
        }
        if (status.changes.some((change) => change.path === relative)) {
            return { kind: 'restore', path: relative };
        }
        throw new Error(`${relative} has no change to discard.`);
    }

    /** Restores a tracked file's working tree from the index (`git restore --worktree`). */
    async restore(file: unknown): Promise<void> {
        const relative = await resolveGitPath(this.root, this.realRoot, file);
        await this.run(this.root, ['restore', '--worktree', '--', relative]);
    }

    /** Commits what is staged; resolves with the new commit's abbreviated hash. */
    async commit(message: unknown): Promise<string> {
        const text = validateCommitMessage(message);
        await this.requireRepository();
        await this.run(this.root, ['commit', '--quiet', '--cleanup=strip', '-m', text], { timeoutMs: 120_000 });
        const { stdout } = await this.run(this.root, ['rev-parse', '--short', 'HEAD']);
        return stdout.trim();
    }

    async branches(): Promise<GitBranchList> {
        await this.requireRepository();
        const [{ stdout }, status] = await Promise.all([
            this.run(this.root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']),
            this.status(),
        ]);
        const branches = stdout.replace(/\r/g, '').split('\n').filter((name) => name !== '');
        return { current: status.branch, branches };
    }

    /** Checks out an existing local branch; a name that is not one is refused before git runs. */
    async switchBranch(name: unknown): Promise<void> {
        const branch = validateBranchName(name);
        const { branches } = await this.branches();
        if (!branches.includes(branch)) {
            throw new Error(`There is no local branch named ${branch}.`);
        }
        await this.run(this.root, ['switch', '--quiet', branch]);
    }

    /** Creates a branch at HEAD and checks it out. */
    async createBranch(name: unknown): Promise<void> {
        const branch = validateBranchName(name);
        await this.requireRepository();
        await this.run(this.root, ['check-ref-format', '--branch', branch]);
        await this.run(this.root, ['switch', '--quiet', '-c', branch]);
    }

    /**
     * The unified diff of `file` between HEAD and the working tree (staged
     * and unstaged changes together). An untracked file, or any file before
     * the first commit, is diffed against nothing. `''` when nothing changed.
     */
    async diff(file: unknown): Promise<string> {
        const relative = await resolveGitPath(this.root, this.realRoot, file);
        await this.requireRepository();
        if (await this.hasHead() && await this.isTracked(relative)) {
            const { stdout } = await this.run(this.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', relative]);
            return stdout;
        }
        const { stdout } = await this.run(this.root, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', '/dev/null', relative], { okExitCodes: [1] });
        return stdout;
    }

    /**
     * `git blame --porcelain` of `file`, parsed: one entry per line of the
     * working-tree file. Lines not committed yet carry `commit.uncommitted`.
     * Rejects for a file git does not track.
     */
    async blame(file: unknown, contents?: string): Promise<BlameLine[]> {
        const relative = await resolveGitPath(this.root, this.realRoot, file);
        await this.requireRepository();
        // #175: with `contents`, the editor's text is blamed (its unsaved lines come back uncommitted).
        const args = contents === undefined
            ? ['blame', '--porcelain', '--no-textconv', '--', relative]
            : ['blame', '--porcelain', '--no-textconv', '--contents', '-', '--', relative];
        const { stdout } = await this.run(this.root, args, { timeoutMs: 60_000, input: contents });
        return parseBlamePorcelain(stdout);
    }

    /** `file`'s text at HEAD; null when there is no HEAD or HEAD has no such file. */
    async headContent(file: unknown): Promise<string | null> {
        const relative = await resolveGitPath(this.root, this.realRoot, file);
        await this.requireRepository();
        if (!(await this.hasHead())) {
            return null;
        }
        try {
            // `./` makes the path relative to the folder git runs in, not to the top of the work tree.
            const { stdout } = await this.run(this.root, ['show', '--no-textconv', `HEAD:./${relative}`]);
            return stdout;
        } catch (error) {
            if (error instanceof GitCommandError) {
                return null;
            }
            throw error;
        }
    }

    /** #284: the configured remotes, by name. */
    async remotes(): Promise<string[]> {
        await this.requireRepository();
        const { stdout } = await this.run(this.root, ['remote']);
        return stdout.replace(/\r/g, '').split('\n').filter((name) => name !== '');
    }

    /**
     * #284: pushes the current branch to its upstream, or publishes it: with
     * no upstream it goes to `origin` (or the only remote, or the one
     * `chooseRemote` picks) under the same name, and becomes its upstream.
     * Resolves with git's report, or null when the choice was cancelled.
     */
    async push(options: RemoteOptions = {}): Promise<string | null> {
        const branch = await this.currentBranch('push');
        const upstream = await this.upstreamOf(branch);
        if (upstream) {
            return this.runRemote(['push', upstream.remote, `refs/heads/${branch}:${upstream.ref}`], options);
        }
        const remotes = await this.remotes();
        if (remotes.length === 0) {
            throw new Error('This repository has no remote to push to. Add one with "git remote add <name> <url>" in a terminal.');
        }
        const remote = remotes.includes('origin') ? 'origin'
            : remotes.length === 1 ? remotes[0] ?? null
                : await options.chooseRemote?.(remotes) ?? null;
        if (remote === null) {
            return null;
        }
        if (!remotes.includes(remote)) {
            throw new Error(`There is no remote named ${remote}.`);
        }
        return this.runRemote(['push', '--set-upstream', checkRemoteName(remote), `refs/heads/${branch}:refs/heads/${branch}`], options);
    }

    /**
     * #284: pulls the current branch from its upstream. Without a pull
     * strategy in the configuration it merges (`--no-rebase`), as git did
     * before it started refusing to guess; a configured one is respected.
     */
    async pull(options: RemoteOptions = {}): Promise<string> {
        const branch = await this.currentBranch('pull');
        const upstream = await this.upstreamOf(branch);
        if (!upstream) {
            throw new Error(`The branch ${branch} has no upstream branch to pull from. Push it first to publish it.`);
        }
        const configured = await this.configValue('pull.rebase') ?? await this.configValue('pull.ff') ?? await this.configValue(`branch.${branch}.rebase`);
        return this.runRemote(['pull', '--no-edit', ...(configured === null ? ['--no-rebase'] : [])], options);
    }

    /** #284: fetches the current branch's remote (or `origin`, the only remote, or all of them), pruning deleted branches. */
    async fetch(options: RemoteOptions = {}): Promise<string> {
        const remotes = await this.remotes();
        if (remotes.length === 0) {
            throw new Error('This repository has no remote to fetch from.');
        }
        const status = await this.status();
        const upstream = status.branch ? await this.upstreamOf(status.branch) : null;
        const remote = upstream?.remote ?? (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined);
        return this.runRemote(remote === undefined ? ['fetch', '--prune', '--all'] : ['fetch', '--prune', checkRemoteName(remote)], options);
    }

    /** #284: pull, then push; a branch with no upstream is published instead. */
    async sync(options: RemoteOptions = {}): Promise<string | null> {
        const branch = await this.currentBranch('sync');
        if (!(await this.upstreamOf(branch))) {
            return this.push(options);
        }
        const pulled = await this.pull(options);
        const pushed = await this.push(options);
        return [pulled, pushed ?? ''].filter((text) => text !== '').join('\n');
    }

    /** #284: stashes the changes of the work tree, untracked files too with `includeUntracked`. */
    async stash(includeUntracked: unknown): Promise<void> {
        await this.requireRepository();
        const { stdout } = await this.run(this.root, ['stash', 'push', ...(includeUntracked === true ? ['--include-untracked'] : [])], STASH_OPTIONS);
        if (/no local changes to save/i.test(stdout)) {
            throw new Error('There are no local changes to stash.');
        }
    }

    /** #284: the stash list, newest first. */
    async stashes(): Promise<GitStash[]> {
        await this.requireRepository();
        const { stdout } = await this.run(this.root, ['stash', 'list', '--format=%gd%x00%gs']);
        const list: GitStash[] = [];
        for (const line of stdout.replace(/\r/g, '').split('\n')) {
            const [ref, label] = line.split('\0');
            const index = /^stash@\{(\d+)\}$/.exec(ref ?? '')?.[1];
            if (index !== undefined) {
                list.push({ index: Number(index), label: label ?? '' });
            }
        }
        return list;
    }

    /** #284: applies, pops or drops one stash; the index must be one `stashes()` lists. */
    async stashAction(action: 'apply' | 'pop' | 'drop', index: unknown): Promise<void> {
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
            throw new Error('A stash is named by its index in the stash list.');
        }
        const list = await this.stashes();
        if (!list.some((entry) => entry.index === index)) {
            throw new Error(`There is no stash number ${index}.`);
        }
        await this.run(this.root, ['stash', action, `stash@{${index}}`], STASH_OPTIONS);
    }

    /**
     * #284: deletes a local branch other than the checked-out one. Without
     * `force` git refuses a branch whose commits are not merged: that
     * resolves with `not-merged`, and the caller asks before forcing.
     */
    async deleteBranch(name: unknown, force: boolean): Promise<'deleted' | 'not-merged'> {
        const branch = validateBranchName(name);
        const { branches, current } = await this.branches();
        if (!branches.includes(branch)) {
            throw new Error(`There is no local branch named ${branch}.`);
        }
        if (branch === current) {
            throw new Error(`${branch} is checked out: switch to another branch before deleting it.`);
        }
        try {
            await this.run(this.root, ['branch', force ? '-D' : '-d', branch]);
            return 'deleted';
        } catch (error) {
            if (!force && error instanceof GitCommandError && /not fully merged/i.test(error.stderr)) {
                return 'not-merged';
            }
            throw error;
        }
    }

    /** #284: the checked-out branch, or an error naming the operation when HEAD is detached. */
    private async currentBranch(operation: string): Promise<string> {
        await this.requireRepository();
        const status = await this.status();
        if (status.state !== 'ok') {
            throw new Error(status.message ?? 'Source Control is not available.');
        }
        if (!status.branch) {
            throw new Error(`HEAD is detached: check out a branch to ${operation}.`);
        }
        return status.branch;
    }

    private async configValue(key: string): Promise<string | null> {
        const { stdout, exitCode } = await this.run(this.root, ['config', '--get', key], { okExitCodes: [1] });
        return exitCode === 0 ? stdout.trim() : null;
    }

    private async upstreamOf(branch: string): Promise<Upstream | null> {
        const remote = await this.configValue(`branch.${branch}.remote`);
        const ref = await this.configValue(`branch.${branch}.merge`);
        if (!remote || !ref || remote === '.') {
            return null;
        }
        return { remote: checkRemoteName(remote), ref };
    }

    /** Runs a command that talks to a remote: no prompts, its own timeout, cancellable, readable errors. */
    private async runRemote(args: readonly string[], options: RemoteOptions): Promise<string> {
        try {
            const { stdout, stderr } = await this.run(this.root, args, { env: REMOTE_GIT_ENV, timeoutMs: this.remoteTimeoutMs, signal: options.signal });
            return [stdout.trim(), stderr.trim()].filter((text) => text !== '').join('\n');
        } catch (error) {
            // A timeout keeps its own message; any other failure is explained.
            if (error instanceof GitCommandError && !/ timed out after /.test(error.message)) {
                throw new GitCommandError(args, error.exitCode, remoteErrorMessage(error.stderr));
            }
            throw error;
        }
    }

    private async requireRepository(): Promise<GitRepoInfo> {
        const repo = await this.repository();
        if (!repo) {
            throw new Error('The open folder is not in a Git repository.');
        }
        return repo;
    }

    private async hasHead(): Promise<boolean> {
        try {
            await this.run(this.root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
            return true;
        } catch (error) {
            if (error instanceof GitCommandError) {
                return false;
            }
            throw error;
        }
    }

    private async isTracked(relative: string): Promise<boolean> {
        try {
            await this.run(this.root, ['ls-files', '--error-unmatch', '--', relative]);
            return true;
        } catch (error) {
            if (error instanceof GitCommandError) {
                // A file deleted from the work tree but still in HEAD is tracked for a diff.
                return (await this.headContent(relative)) !== null;
            }
            throw error;
        }
    }
}

/** #284: a remote name read from the configuration; one that looks like an option is refused before it reaches the command line. */
function checkRemoteName(remote: string): string {
    if (remote === '' || remote.startsWith('-') || /[\0\s]/.test(remote)) {
        throw new Error(`Not a usable remote name: ${JSON.stringify(remote)}`);
    }
    return remote;
}
