import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import {
    MAX_SINGLE_FILE_BYTES,
    MAX_SNAPSHOT_BYTES,
    planDirectorySnapshot,
} from './gitSnapshotPlan';
import { currentLaunchSignal } from '../analysis/launch/launchControl';
import { streamGitLines } from './gitLineStream';
import {
    PARTIAL_CLONE_MISSING_MESSAGE,
    PARTIAL_CLONE_NOTICE,
    gitOfflineEnvironment,
    isPartialCloneConfig,
    isPartialCloneMissingObject,
} from './gitOfflineEnvironment';
import type {
    ComparisonSource,
    GitReferenceType,
    GitRevisionType,
    HistoricalComparisonReferences,
} from './historicalComparisonModels';

const execFile = promisify(childProcess.execFile);
/**
 * Recent commits the pickers offer (HIST-11). Was 50, which left a commit
 * picked a week ago out of reach on a busy repository.
 */
export const PICKER_COMMIT_COUNT = 200;
/** One git command longer than this is killed and reported (HIST-7, EVO-3). */
export const GIT_COMMAND_TIMEOUT_MS = 180_000;

/** The error a failed git command is reported with: timeout and cancel get their own codes. */
function describeGitFailure(error: unknown): Error {
    const failure = error as { name?: string; killed?: boolean; code?: unknown; message?: string } | null;
    if (failure?.name === 'AbortError' || failure?.code === 'ABORT_ERR') {
        return new Error('git-command-cancelled');
    }
    if (failure?.killed) {
        return new Error(`git-command-timeout: a git command took more than ${GIT_COMMAND_TIMEOUT_MS / 1000} s`);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (isPartialCloneMissingObject(`${message}\n${String((error as { stderr?: unknown })?.stderr ?? '')}`)) {
        return new Error(PARTIAL_CLONE_MISSING_MESSAGE);
    }
    return new Error(`git-command-failed: ${message}`);
}

interface GitCommandResult {
    stdout: string;
    stderr: string;
}

export interface MaterializedGitTarget {
    targetPath: string | null;
    missingTarget: boolean;
    warnings: string[];
}

export class GitRepositoryService {
    private readonly sourceById = new Map<string, ComparisonSource>();

    public constructor(
        private readonly targetPath: string,
        private readonly snapshotRoot: string,
    ) {}

    public async listReferences(): Promise<HistoricalComparisonReferences> {
        const repositoryRoot = await this.resolveRepositoryRoot();
        const targetRelativePath = this.resolveTargetRelativePath(repositoryRoot);
        const workingTreeDirty = (await this.runGit(
            repositoryRoot,
            ['status', '--porcelain', '--untracked-files=normal', '--', targetRelativePath],
        )).stdout.trim().length > 0;
        const headName = (await this.tryRunGit(repositoryRoot, [
            'symbolic-ref',
            '--quiet',
            '--short',
            'HEAD',
        ]))?.stdout.trim() || null;
        const detachedSha = headName
            ? null
            : (await this.runGit(repositoryRoot, ['rev-parse', '--short=8', 'HEAD'])).stdout.trim();

        const branchOutput = (await this.runGit(repositoryRoot, [
            'for-each-ref',
            '--format=%(refname)%00%(objectname)%00%(refname:short)%00%(committerdate:short)%00%(committerdate:unix)',
            'refs/heads',
            'refs/remotes',
        ])).stdout;
        const tagOutput = (await this.runGit(repositoryRoot, [
            'for-each-ref',
            '--format=%(refname)%00%(*objectname)%00%(objectname)%00%(refname:short)%00%(*committerdate:short)%00%(committerdate:short)%00%(*committerdate:unix)%00%(committerdate:unix)%00%(*objecttype)%00%(objecttype)',
            'refs/tags',
        ])).stdout;
        const commitOutput = (await this.runGit(repositoryRoot, [
            'log',
            // Branches, tags and remotes, not `--all`: `--all` also walks
            // refs/stash and refs/notes, whose commits are not history (EVO-6).
            '--branches',
            '--tags',
            '--remotes',
            `--max-count=${PICKER_COMMIT_COUNT}`,
            '--date=short',
            '--format=%H%x00%ad%x00%ct%x00%P%x00%s',
        ])).stdout;
        const sources: ComparisonSource[] = [
            this.buildWorkingCopySource(headName, detachedSha, workingTreeDirty),
            ...this.parseBranchRefs(branchOutput, headName),
            ...this.parseTagRefs(tagOutput),
            ...this.parseCommitLog(commitOutput),
        ];

        // Added to, never cleared (HIST-2): a commit picked for a live
        // comparison stays resolvable after newer commits push it out of
        // this listing. Branch and tag ids are re-verified on resolve.
        for (const source of sources) {
            this.sourceById.set(source.id, source);
        }

        const partialClone = await this.isPartialClone(repositoryRoot);
        return {
            repositoryRoot,
            targetRelativePath,
            workingTreeDirty,
            activeBranch: headName,
            sources,
            pageSize: 5,
            partialClone,
            notice: partialClone ? PARTIAL_CLONE_NOTICE : null,
        };
    }

    /** Whether `git clone --filter` made this repository (EVO-10). */
    public async isPartialClone(repositoryRoot: string): Promise<boolean> {
        const config = await this.tryRunGit(repositoryRoot, [
            'config',
            '--get-regexp',
            '^(extensions\\.partialclone|remote\\..*\\.promisor)$',
        ]);
        return isPartialCloneConfig(config?.stdout ?? '');
    }

    public async getRepositoryContext(): Promise<{
        repositoryRoot: string;
        targetRelativePath: string;
    }> {
        const repositoryRoot = await this.resolveRepositoryRoot();
        return {
            repositoryRoot,
            targetRelativePath: this.resolveTargetRelativePath(repositoryRoot),
        };
    }

    public async resolveSource(sourceId: string): Promise<ComparisonSource> {
        if (sourceId === 'working-copy' || this.sourceById.size === 0) {
            await this.listReferences();
        }
        const source = this.sourceById.get(sourceId);
        if (!source) {
            throw new Error('unknown-comparison-source');
        }
        if (source.kind === 'workingCopy') {
            return { ...source };
        }

        const repositoryRoot = await this.resolveRepositoryRoot();
        const resolved = (await this.tryRunGit(repositoryRoot, ['rev-parse', '--verify', '--quiet', `${source.refName}^{commit}`]))
            ?.stdout.trim() ?? '';
        if (!this.isCommitSha(resolved)) {
            throw new Error('comparison-reference-not-found');
        }
        return { ...source, commitSha: resolved };
    }

    /**
     * Oldest first: the first-parent history of `tip` (HEAD), never `--all`
     * (EVO-6), so stashes, notes and other branches are never frames. `exclude`
     * stops the walk (a range start). No clamp, and streamed (EVO-12).
     */
    public async listTimelineSources(
        maxCount: number | null = 200,
        tip = 'HEAD',
        exclude?: string,
    ): Promise<ComparisonSource[]> {
        const repositoryRoot = await this.resolveRepositoryRoot();
        if (!await this.revisionExists(repositoryRoot, tip)) {
            return [];
        }
        const limitArguments = maxCount === null ? [] : [`--max-count=${Math.max(1, Math.floor(maxCount))}`];
        const sources: ComparisonSource[] = [];
        await streamGitLines(repositoryRoot, [
            'log',
            '--first-parent',
            '--reverse',
            ...limitArguments,
            '--date=short',
            '--format=%H%x00%ad%x00%ct%x00%P%x00%s',
            tip,
            ...(exclude ? [`^${exclude}`] : []),
            '--',
        ], (line) => {
            const source = this.parseCommitLine(line);
            if (source) {
                sources.push(source);
            }
        }, { timeoutMs: GIT_COMMAND_TIMEOUT_MS, signal: currentLaunchSignal(), describeFailure: describeGitFailure });
        for (const source of sources) {
            this.sourceById.set(source.id, source);
        }
        return sources;
    }

    /** Export preflight: the commits listTimelineSources(null) would list. */
    public async countTimelineCommits(): Promise<number> {
        const repositoryRoot = await this.resolveRepositoryRoot();
        if (!await this.revisionExists(repositoryRoot, 'HEAD')) {
            return 0;
        }
        const rawCount = (await this.runGit(repositoryRoot, [
            'rev-list',
            '--first-parent',
            '--count',
            'HEAD',
            '--',
        ])).stdout.trim();
        const count = Number.parseInt(rawCount, 10);
        if (!Number.isFinite(count) || count < 0) {
            throw new Error('git-timeline-count-invalid');
        }
        return count;
    }

    /** Whether `ancestor` is reachable from `descendant` (a commit is its own ancestor). */
    public async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
        return this.isCommitSha(ancestor) && this.isCommitSha(descendant) && await this.tryRunGit(
            await this.resolveRepositoryRoot(), ['merge-base', '--is-ancestor', ancestor, descendant],
        ) !== null;
    }

    /** The best common ancestor of two commits, or null for unrelated histories. */
    public async mergeBase(first: string, second: string): Promise<string | null> {
        const base = this.isCommitSha(first) && this.isCommitSha(second)
            ? (await this.tryRunGit(await this.resolveRepositoryRoot(), ['merge-base', first, second]))?.stdout.trim()
            : '';
        return base && this.isCommitSha(base) ? base : null;
    }

    /** The commit HEAD points at, or null in an empty repository. */
    public async resolveHeadCommit(): Promise<string | null> {
        const head = await this.tryRunGit(await this.resolveRepositoryRoot(), ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
        const sha = head?.stdout.trim() ?? '';
        return this.isCommitSha(sha) ? sha : null;
    }

    public async resolveSourcesInChronologicalOrder(sourceIds: string[]): Promise<ComparisonSource[]> {
        if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
            return [];
        }
        const resolved = await Promise.all(sourceIds.map((sourceId) => this.resolveSource(sourceId)));
        // Oldest first, like the offline export (EVO-13): a movie plays in
        // history order whatever order the commits were picked in. Dated refs
        // by committer time, then undated ones in pick order, and the working
        // copy (the present) last.
        const group = (source: ComparisonSource): number => {
            if (source.kind === 'workingCopy') {
                return 2;
            }
            return typeof source.timestamp === 'number' ? 0 : 1;
        };
        const time = (source: ComparisonSource): number => (
            source.kind === 'gitRef' && typeof source.timestamp === 'number' ? source.timestamp : 0
        );
        return resolved
            .map((source, index) => ({ source, index }))
            .sort((a, b) => group(a.source) - group(b.source)
                || time(a.source) - time(b.source)
                || a.index - b.index)
            .map((entry) => entry.source);
    }

    /**
     * Writes one revision of the target into the snapshot folder. A shallow
     * directory analysis reads only the target's own files, so only those are
     * copied and counted against the limits (HIST-5).
     */
    public async materialize(source: ComparisonSource, options: { recursive?: boolean } = {}): Promise<MaterializedGitTarget> {
        if (source.kind === 'workingCopy') {
            return {
                targetPath: this.targetPath,
                missingTarget: false,
                warnings: [],
            };
        }

        const repositoryRoot = await this.resolveRepositoryRoot();
        const targetRelativePath = this.resolveTargetRelativePath(repositoryRoot);
        const sourceDirectory = path.join(this.snapshotRoot, this.safeSnapshotName(source.commitSha));
        const destinationPath = path.join(sourceDirectory, ...targetRelativePath.split('/'));
        this.assertInside(sourceDirectory, destinationPath);
        await fs.promises.rm(sourceDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        await fs.promises.mkdir(sourceDirectory, { recursive: true });

        const targetStat = await fs.promises.stat(this.targetPath);
        return targetStat.isDirectory()
            ? this.materializeDirectory(repositoryRoot, source.commitSha, targetRelativePath, sourceDirectory, options.recursive !== false)
            : this.materializeFile(repositoryRoot, source.commitSha, targetRelativePath, destinationPath);
    }

    /** Deletes one revision's snapshot once its analysis is done (EVO-8). */
    public async releaseSnapshot(source: ComparisonSource): Promise<void> {
        if (source.kind !== 'gitRef' || !this.isCommitSha(source.commitSha)) {
            return;
        }
        const sourceDirectory = path.join(this.snapshotRoot, this.safeSnapshotName(source.commitSha));
        this.assertInside(this.snapshotRoot, sourceDirectory);
        await fs.promises.rm(sourceDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    public async dispose(): Promise<void> {
        await fs.promises.rm(this.snapshotRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    /**
     * Whether the analyzed target sits inside a local Git repository. Shared
     * by every Git-gated analysis (historical comparison, project evolution)
     * so the availability rule lives in one place.
     */
    public async getAvailability(
        reason = 'The analyzed target is not inside a local Git repository.',
    ): Promise<{ enabled: boolean; reason: string | null }> {
        try {
            await this.resolveRepositoryRoot();
            return { enabled: true, reason: null };
        } catch {
            return { enabled: false, reason };
        }
    }

    public async resolveRepositoryRoot(): Promise<string> {
        const startPath = (await fs.promises.stat(this.targetPath)).isDirectory()
            ? this.targetPath
            : path.dirname(this.targetPath);
        const result = await this.runGit(startPath, ['rev-parse', '--show-toplevel']);
        const repositoryRoot = path.resolve(result.stdout.trim());
        if (!repositoryRoot) {
            throw new Error('not-a-git-repository');
        }
        this.resolveTargetRelativePath(repositoryRoot);
        return repositoryRoot;
    }

    private async materializeFile(
        repositoryRoot: string,
        commitSha: string,
        targetRelativePath: string,
        destinationPath: string,
    ): Promise<MaterializedGitTarget> {
        const objectSpec = `${commitSha}:${targetRelativePath}`;
        if (!(await this.gitObjectExists(repositoryRoot, objectSpec))) {
            return { targetPath: null, missingTarget: true, warnings: [] };
        }
        const size = Number((await this.runGit(repositoryRoot, ['cat-file', '-s', objectSpec])).stdout.trim());
        if (!Number.isFinite(size) || size > MAX_SINGLE_FILE_BYTES) {
            throw new Error('comparison-file-too-large');
        }
        const content = await this.runGitBuffer(repositoryRoot, ['show', objectSpec]);
        await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.promises.writeFile(destinationPath, content);
        return { targetPath: destinationPath, missingTarget: false, warnings: [] };
    }

    private async materializeDirectory(
        repositoryRoot: string,
        commitSha: string,
        targetRelativePath: string,
        sourceDirectory: string,
        recursive: boolean,
    ): Promise<MaterializedGitTarget> {
        const isRepositoryRoot = targetRelativePath === '.';
        const treeSpec = isRepositoryRoot
            ? `${commitSha}^{tree}`
            : `${commitSha}:${targetRelativePath}`;
        if (!(await this.gitObjectExists(repositoryRoot, treeSpec))) {
            return { targetPath: null, missingTarget: true, warnings: [] };
        }
        const treeArguments = [
            'ls-tree',
            '-r',
            '-z',
            '-l',
            commitSha,
        ];
        if (!isRepositoryRoot) {
            treeArguments.push('--', targetRelativePath);
        }
        const rawTree = await this.runGitBuffer(repositoryRoot, [
            ...treeArguments,
        ]);
        const { repositoryPaths, warnings } = planDirectorySnapshot(rawTree, targetRelativePath, recursive);
        await this.copyPlannedFiles(repositoryRoot, commitSha, sourceDirectory, repositoryPaths);

        return {
            targetPath: isRepositoryRoot
                ? sourceDirectory
                : path.join(sourceDirectory, ...targetRelativePath.split('/')),
            missingTarget: false,
            warnings,
        };
    }


    /**
     * Write each planned blob under `sourceDirectory` at its repository path.
     * The plan only holds paths shouldMaterializeDirectoryFile accepted, so
     * none is empty or escapes the target; assertInside still guards the
     * destination.
     */
    private async copyPlannedFiles(
        repositoryRoot: string,
        commitSha: string,
        sourceDirectory: string,
        repositoryPaths: string[],
    ): Promise<void> {
        for (const repositoryPath of repositoryPaths) {
            const destination = path.join(sourceDirectory, ...repositoryPath.split('/'));
            this.assertInside(sourceDirectory, destination);
            const content = await this.runGitBuffer(
                repositoryRoot,
                ['show', `${commitSha}:${repositoryPath}`],
            );
            await fs.promises.mkdir(path.dirname(destination), { recursive: true });
            await fs.promises.writeFile(destination, content);
        }
    }


    private buildWorkingCopySource(
        headName: string | null,
        detachedSha: string | null,
        dirty: boolean,
    ): ComparisonSource {
        const modified = dirty ? ' (modified)' : '';
        return {
            id: 'working-copy',
            kind: 'workingCopy',
            label: headName
                ? `${headName} (live)${modified}`
                : `Detached HEAD ${detachedSha} (live)${modified}`,
            activeBranch: headName,
            dirty,
            live: true,
            revisionType: 'working-copy',
        };
    }

    /** Local and remote branches, minus remote HEAD aliases and the checked-out branch. */
    private parseBranchRefs(stdout: string, headName: string | null): ComparisonSource[] {
        const sources: ComparisonSource[] = [];
        for (const line of splitGitLines(stdout)) {
            const [fullRef, commitSha, shortName, committerDate, committerUnix] = line.split('\0');
            // `%(refname:short)` of refs/remotes/origin/HEAD is just "origin",
            // so the alias is recognised by its full ref (EVO-18).
            if (!fullRef || !this.isCommitSha(commitSha) || !shortName || fullRef.endsWith('/HEAD')) {
                continue;
            }
            if (headName && fullRef === `refs/heads/${headName}`) {
                continue;
            }
            sources.push(this.createGitSource('branch', fullRef, shortName, commitSha, undefined, undefined, 0, committerDate, committerUnix));
        }
        return sources;
    }

    /** Tags, annotated ones resolved to the peeled commit and its dates. */
    private parseTagRefs(stdout: string): ComparisonSource[] {
        const sources: ComparisonSource[] = [];
        for (const line of splitGitLines(stdout)) {
            const [fullRef, peeledSha, objectSha, shortName, peeledDate, tagDate, peeledUnix, tagUnix, peeledType, objectType] = line.split('\0');
            const commitSha = peeledSha || objectSha;
            // A tag on a tree or a blob has no history to show and cannot be
            // resolved as a commit: it is not offered (EVO-7).
            if ((peeledType || objectType) !== 'commit') {
                continue;
            }
            if (!fullRef || !this.isCommitSha(commitSha) || !shortName) {
                continue;
            }
            sources.push(this.createGitSource('tag', fullRef, shortName, commitSha, undefined, undefined, 0, peeledDate || tagDate, peeledUnix || tagUnix));
        }
        return sources;
    }

    /** Recent commits from `git log`, merges typed as such. */
    private parseCommitLog(stdout: string): ComparisonSource[] {
        return splitGitLines(stdout)
            .map((line) => this.parseCommitLine(line))
            .filter((source): source is ComparisonSource => source !== null);
    }

    /** One `%H %ad %ct %P %s` log line (NUL-separated) as a commit source. */
    private parseCommitLine(line: string): ComparisonSource | null {
        const [commitSha, date, committerUnix, parents, subject] = line.split('\0');
        if (!this.isCommitSha(commitSha)) {
            return null;
        }
        const parentCount = this.countParents(parents);
        return this.createGitSource(
            'commit',
            commitSha,
            commitSha.slice(0, 8),
            commitSha,
            `${date || ''} ${subject || ''}`.trim(),
            parentCount > 1 ? 'merge' : 'commit',
            parentCount,
            date,
            committerUnix,
        );
    }

    private createGitSource(
        refType: GitReferenceType,
        refName: string,
        label: string,
        commitSha: string,
        description?: string,
        revisionType?: GitRevisionType,
        parentCount = 0,
        date?: string,
        timestamp?: string,
    ): ComparisonSource {
        const id = `${refType}-${crypto.createHash('sha256').update(refName).digest('hex').slice(0, 16)}`;
        const parsedTimestamp = Number.parseInt(String(timestamp || '').trim(), 10);
        return {
            id,
            kind: 'gitRef',
            refType,
            refName,
            commitSha,
            label,
            description,
            // Committer date (YYYY-MM-DD) of the ref's target commit, so every
            // source — branches and tags included — can be shown and time-sorted
            // in the picker, not just commits.
            date: (date || '').trim() || undefined,
            // Precise committer time (epoch seconds): the short date is
            // day-granular, so same-day refs need this to order correctly.
            timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : undefined,
            live: false,
            revisionType: revisionType || refType,
            parentCount,
        };
    }

    private countParents(value: string | undefined): number {
        return String(value || '').split(/\s+/).filter(Boolean).length;
    }

    private resolveTargetRelativePath(repositoryRoot: string): string {
        // Git reports the repository root in canonical form, while the target
        // can arrive through a symlink (macOS /var -> /private/var, a linked
        // workspace) or a Windows 8.3 short name (C:\Users\RUNNER~1). Compare
        // canonical paths, or a target inside the repository looks outside it.
        const relativePath = path.relative(canonicalPath(repositoryRoot), canonicalPath(this.targetPath));
        if (!relativePath || relativePath === '.') {
            return '.';
        }
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            throw new Error('analysis-target-outside-repository');
        }
        return relativePath.split(path.sep).join('/');
    }

    private async revisionExists(repositoryRoot: string, revision: string): Promise<boolean> {
        return (await this.tryRunGit(repositoryRoot, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])) !== null;
    }

    private async gitObjectExists(repositoryRoot: string, objectSpec: string): Promise<boolean> {
        try {
            await this.runGit(repositoryRoot, ['cat-file', '-e', objectSpec]);
            return true;
        } catch {
            return false;
        }
    }

    private async runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
        try {
            // The job's signal (if this runs inside one) kills git on Cancel;
            // the timeout stops a command that hangs on a network drive or a
            // lazy fetch (HIST-7, EVO-3).
            const result = await execFile('git', ['-C', cwd, ...args], {
                windowsHide: true,
                maxBuffer: 16 * 1024 * 1024,
                encoding: 'utf8',
                env: gitOfflineEnvironment(),
                timeout: GIT_COMMAND_TIMEOUT_MS,
                signal: currentLaunchSignal(),
            });
            return {
                stdout: result.stdout,
                stderr: result.stderr,
            };
        } catch (error) {
            throw describeGitFailure(error);
        }
    }

    private async tryRunGit(cwd: string, args: string[]): Promise<GitCommandResult | null> {
        try {
            return await this.runGit(cwd, args);
        } catch {
            return null;
        }
    }

    private runGitBuffer(cwd: string, args: string[]): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            childProcess.execFile(
                'git',
                ['-C', cwd, ...args],
                {
                    windowsHide: true,
                    maxBuffer: MAX_SNAPSHOT_BYTES + (16 * 1024 * 1024),
                    encoding: 'buffer',
                    env: gitOfflineEnvironment(),
                    timeout: GIT_COMMAND_TIMEOUT_MS,
                    signal: currentLaunchSignal(),
                },
                (error, stdout) => {
                    if (error) {
                        reject(describeGitFailure(error));
                        return;
                    }
                    resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
                },
            );
        });
    }

    private assertInside(root: string, candidate: string): void {
        const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            throw new Error('comparison-snapshot-path-escape');
        }
    }

    private safeSnapshotName(commitSha: string): string {
        if (!this.isCommitSha(commitSha)) {
            throw new Error('invalid-comparison-commit');
        }
        return commitSha;
    }

    private isCommitSha(value: string): boolean {
        return /^[0-9a-f]{40}$/i.test(value || '');
    }

}

/** A repository path relative to the target folder (`.` is the repository root). */

/** The non-empty lines of a git command's output, LF or CRLF. */
function splitGitLines(stdout: string): string[] {
    return stdout.split(/\r?\n/).filter(Boolean);
}

/**
 * The canonical form of an existing path (symlinks and Windows short names
 * resolved); the plain absolute path when it cannot be resolved.
 */
function canonicalPath(targetPath: string): string {
    try {
        return fs.realpathSync.native(targetPath);
    } catch {
        return path.resolve(targetPath);
    }
}
