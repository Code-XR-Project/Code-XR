import path from 'node:path';
import { emptyGitStatus, type GitBranchList, type GitStatus } from '../../shared/git.ts';
import { parseBlamePorcelain, type BlameLine } from './blameParser.ts';
import { resolveGitPath, resolveGitPaths, validateBranchName, validateCommitMessage } from './gitPaths.ts';
import { GitCommandError, GitNotFoundError, runGit, type GitRunner } from './gitRunner.ts';
import { groupChanges, parsePorcelainV2 } from './statusParser.ts';

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
