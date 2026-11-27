import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Snapshots of a project's working tree in a shadow git repository the IDE
 * owns (epic #265: AF5 review of the agent's changes, AF6 checkpoints per turn).
 *
 * Why git and why a shadow repository: a snapshot per turn has to catch every
 * change, including the ones an agent makes through shell commands, so it must
 * capture the tree itself rather than record the edits that went through the
 * IDE. Git does that with content-addressed storage (an unchanged file costs
 * nothing) and a stat cache (an unchanged tree is fast to re-snapshot). The
 * repository lives outside the project, in `storageDir`, and the project's own
 * `.git` is never read as a repository or written: every call runs with its
 * own `GIT_DIR`, `GIT_WORK_TREE=projectRoot` and a private `GIT_INDEX_FILE`.
 *
 * Hardening, because a project must not run anything of its choosing through
 * this (see docs/ide/market-study/group-d-protocols.md, section 4 "Pitfalls"):
 * system and global config are not read, hooks point at an empty directory,
 * gpg signing, fsmonitor and the LFS filters are off, and an
 * `info/attributes` file in the shadow repository (which outranks every
 * `.gitattributes`) unsets `text`, `eol`, `filter`, `ident` and
 * `working-tree-encoding`, so the bytes of a file (CRLF included) are stored
 * and restored exactly. Commits are made with `commit-tree`, which runs no hook.
 *
 * What is not snapshotted: whatever the project's `.gitignore` files and
 * `.git/info/exclude` ignore, a default list (`node_modules/`, build output,
 * virtual environments, logs), files larger than `maxFileBytes`, and nested git
 * repositories (a sub-folder with its own `.git`), which are excluded rather
 * than having their `.git` renamed, as Cline does, because a crash mid-rename
 * would break the user's repository. A project with more than `maxFiles`
 * files, or a snapshot that times out, turns checkpoints off with a
 * `disabledReason` the IDE can show.
 *
 * Restores write through `fs` (a temporary file then a rename), never through
 * `git checkout`, so only the named paths are touched and an ignored file is
 * never deleted. Every operation on one project is serialized by an in-process
 * lock keyed on the shadow repository. Pure Node, no Electron, so the VS Code
 * extension can reuse it.
 */

export interface CheckpointStoreOptions {
    /** Directory holding the shadow repositories (one per project), e.g. `userData/checkpoints`. */
    readonly storageDir: string;
    /** The project whose working tree is snapshotted. */
    readonly projectRoot: string;
    /** The git executable. Default `git`, looked up on PATH (`git.exe` on Windows). */
    readonly git?: string | undefined;
    /** Files larger than this are not snapshotted. Default 5 MB. */
    readonly maxFileBytes?: number | undefined;
    /** More files than this turns checkpoints off. Default 20,000. */
    readonly maxFiles?: number | undefined;
    /** Timeout of each git call. A snapshot that times out turns checkpoints off. Default 60 s. */
    readonly timeoutMs?: number | undefined;
}

export interface Checkpoint {
    /** The commit sha in the shadow repository. */
    readonly id: string;
    readonly label: string;
    /** Milliseconds since the epoch. */
    readonly createdAt: number;
    /** Files in the snapshot. */
    readonly fileCount: number;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface ChangedFile {
    /** Relative to the project root, with forward slashes. */
    readonly path: string;
    readonly status: ChangeStatus;
    readonly additions: number;
    readonly deletions: number;
    /** True when git sees binary content: additions and deletions are then 0. */
    readonly binary: boolean;
}

export interface DiffText {
    /** The content at the checkpoint, or null when the file did not exist there. */
    readonly oldText: string | null;
    /** The content on disk now, or null when the file does not exist. */
    readonly newText: string | null;
}

export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 20_000;
export const DEFAULT_CHECKPOINT_TIMEOUT_MS = 60_000;

/** Excluded in every project, on top of its own ignore rules. */
export const DEFAULT_EXCLUDES: readonly string[] = [
    'node_modules/', '.git/', 'dist/', 'out/', 'build/', '.venv/', 'venv/', '__pycache__/', '*.log',
];

/** The ref that keeps the chain of checkpoints alive in the shadow repository. */
const CHECKPOINT_REF = 'refs/codexr/checkpoints';
const INDEX_NAME = 'codexr-index';
const HOOKS_DIR_NAME = 'codexr-no-hooks';
const EMPTY_CONFIG_NAME = 'codexr-empty-gitconfig';
const ATTRIBUTES = '* -text !eol -filter -ident -working-tree-encoding\n';
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
/** Upper bound of blob bytes requested from one `cat-file --batch` call. */
const BATCH_BYTES = 64 * 1024 * 1024;
const STAT_CONCURRENCY = 128;
const COMMIT_ID = /^[0-9a-f]{4,64}$/i;

/** Thrown by a git call that ran past its timeout. */
export class CheckpointTimeoutError extends Error {
    constructor(args: readonly string[], timeoutMs: number) {
        super(`git ${args[0] ?? ''} took longer than ${Math.round(timeoutMs / 1000)} s.`);
        this.name = 'CheckpointTimeoutError';
    }
}

/** Thrown when the project cannot be snapshotted; `message` is the reason to show. */
export class CheckpointsDisabledError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'CheckpointsDisabledError';
    }
}

interface RunOptions {
    readonly input?: string | Buffer | undefined;
    readonly okExitCodes?: readonly number[] | undefined;
    /** Without a work tree and an index: for `init` and object reads. */
    readonly bare?: boolean | undefined;
}

interface RunResult {
    readonly stdout: Buffer;
    readonly exitCode: number;
}

interface TreeEntry {
    readonly mode: string;
    readonly sha: string;
    readonly size: number;
}

interface StagedTree {
    readonly tree: string;
    readonly fileCount: number;
}

/** One promise chain per shadow repository: every operation on a project runs alone. */
const projectLocks = new Map<string, Promise<void>>();

function withProjectLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = projectLocks.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const settled = result.then(() => undefined, () => undefined);
    projectLocks.set(key, settled);
    void settled.then(() => {
        if (projectLocks.get(key) === settled) {
            projectLocks.delete(key);
        }
    });
    return result;
}

/** The shadow repository's directory name: a hash of the resolved project root (case-folded on Windows). */
export function shadowRepoName(projectRoot: string): string {
    const resolved = path.resolve(projectRoot);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    return `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.git`;
}

/**
 * Checks a project-relative path from a caller and returns it with forward
 * slashes. Absolute paths, `..`, and anything inside a `.git` are refused.
 */
export function normalizeProjectPath(relativePath: string): string {
    const posix = relativePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (posix === '' || posix.includes('\0')) {
        throw new Error(`Invalid project path: "${relativePath}".`);
    }
    if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) {
        throw new Error(`A checkpoint path must be relative to the project: "${relativePath}".`);
    }
    const segments = posix.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0) {
        throw new Error(`Invalid project path: "${relativePath}".`);
    }
    for (const segment of segments) {
        if (segment === '..') {
            throw new Error(`A checkpoint path cannot leave the project: "${relativePath}".`);
        }
        if (segment.toLowerCase() === '.git') {
            throw new Error(`A checkpoint never touches a .git folder: "${relativePath}".`);
        }
    }
    return segments.join('/');
}

/** Splits NUL-terminated git output into its records. */
function splitNul(output: Buffer | string): string[] {
    const text = typeof output === 'string' ? output : output.toString('utf8');
    return text.split('\0').filter((record) => record !== '');
}

function isNotFound(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Lines of the project's own `.git/info/exclude`, following a `.git` file (worktrees). */
async function readProjectExclude(projectRoot: string): Promise<string[]> {
    const dotGit = path.join(projectRoot, '.git');
    let gitDir = dotGit;
    try {
        const stat = await fs.stat(dotGit);
        if (stat.isFile()) {
            const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, 'utf8'));
            if (!pointer?.[1]) {
                return [];
            }
            gitDir = path.resolve(projectRoot, pointer[1].trim());
            const common = await fs.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => null);
            if (common !== null) {
                gitDir = path.resolve(gitDir, common.trim());
            }
        }
        const content = await fs.readFile(path.join(gitDir, 'info', 'exclude'), 'utf8');
        return content.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.startsWith('#'));
    } catch {
        return [];
    }
}

/** `mode` of a written file: the tree's executable bit, on top of the current or default permissions. */
function fileMode(treeMode: string, currentMode: number): number {
    const base = currentMode & 0o777;
    return treeMode === '100755' ? base | 0o111 : base & ~0o111;
}

export class CheckpointStore {
    readonly projectRoot: string;
    /** The shadow repository. */
    readonly gitDir: string;
    private readonly indexFile: string;
    private readonly gitExecutable: string;
    private readonly maxFileBytes: number;
    private readonly maxFiles: number;
    private readonly timeoutMs: number;
    private readonly env: NodeJS.ProcessEnv;
    private readonly configArgs: readonly string[];
    private initialized = false;
    private disposed = false;
    private disabled: string | null = null;

    constructor(options: CheckpointStoreOptions) {
        this.projectRoot = path.resolve(options.projectRoot);
        this.gitDir = path.join(path.resolve(options.storageDir), shadowRepoName(this.projectRoot));
        this.indexFile = path.join(this.gitDir, INDEX_NAME);
        this.gitExecutable = options.git ?? 'git';
        this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
        this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_CHECKPOINT_TIMEOUT_MS;
        this.env = this.buildEnvironment();
        this.configArgs = [
            '-c', `core.hooksPath=${path.join(this.gitDir, HOOKS_DIR_NAME)}`,
            '-c', 'commit.gpgsign=false',
            '-c', 'core.autocrlf=false',
            '-c', 'core.safecrlf=false',
            '-c', 'core.longpaths=true',
            '-c', 'core.symlinks=false',
            '-c', 'core.fsmonitor=false',
            '-c', 'core.quotepath=false',
            '-c', 'core.untrackedCache=false',
            '-c', 'filter.lfs.smudge=',
            '-c', 'filter.lfs.process=',
            '-c', 'filter.lfs.clean=',
            '-c', 'filter.lfs.required=false',
            '-c', 'advice.addEmbeddedRepo=false',
            '-c', 'gc.auto=0',
            '-c', 'maintenance.auto=false',
            '-c', 'user.name=Code-XR',
            '-c', 'user.email=checkpoints@code-xr.local',
            '--no-pager',
        ];
    }

    /** Why checkpoints are off for this project, or null while they work. */
    get disabledReason(): string | null {
        return this.disabled;
    }

    /** Turns checkpoints back on after a timeout or a too-large project (the next snapshot re-checks). */
    clearDisabled(): void {
        this.disabled = null;
    }

    /**
     * Snapshots the working tree. Returns null, with `disabledReason` set, when
     * the project is too large or the snapshot times out.
     */
    snapshot(label: string): Promise<Checkpoint | null> {
        return this.locked(async () => {
            if (this.disabled !== null) {
                return null;
            }
            let staged: StagedTree;
            try {
                staged = await this.stageWorkingTree();
            } catch (error) {
                if (error instanceof CheckpointsDisabledError) {
                    return null;
                }
                throw error;
            }
            const parent = await this.currentHead();
            const args = ['commit-tree', staged.tree, ...(parent ? ['-p', parent] : []), '-F', '-'];
            const message = label.trim() === '' ? 'Checkpoint' : label;
            const id = (await this.run(args, { input: message })).stdout.toString('utf8').trim();
            await this.run(['update-ref', CHECKPOINT_REF, id]);
            return { id, label: message, createdAt: Date.now(), fileCount: staged.fileCount };
        });
    }

    /** Files that differ between checkpoint `baseId` and the working tree as it is now. */
    changes(baseId: string): Promise<ChangedFile[]> {
        return this.locked(async () => {
            const base = await this.resolveCommit(baseId);
            const { tree } = await this.stageOrThrow();
            return this.diffTrees(base, tree);
        });
    }

    /** The content of `filePath` at a checkpoint (utf8), or null when it did not exist there. */
    fileAt(commitId: string, filePath: string): Promise<string | null> {
        return this.locked(async () => {
            const content = await this.readBlob(await this.resolveCommit(commitId), normalizeProjectPath(filePath));
            return content === null ? null : content.toString('utf8');
        });
    }

    /** Old (checkpoint) and new (disk) text of one file, for the review UI. */
    diffText(commitId: string, filePath: string): Promise<DiffText> {
        return this.locked(async () => {
            const relative = normalizeProjectPath(filePath);
            const old = await this.readBlob(await this.resolveCommit(commitId), relative);
            const current = await fs.readFile(this.absolute(relative)).catch((error: unknown) => {
                if (isNotFound(error) || (error as NodeJS.ErrnoException).code === 'EISDIR') {
                    return null;
                }
                throw error;
            });
            return { oldText: old === null ? null : old.toString('utf8'), newText: current === null ? null : current.toString('utf8') };
        });
    }

    /** Puts each file back as it was at the checkpoint, deleting the ones that did not exist there. */
    restoreFiles(commitId: string, paths: readonly string[]): Promise<void> {
        return this.locked(async () => {
            const commit = await this.resolveCommit(commitId);
            const relative = [...new Set(paths.map(normalizeProjectPath))];
            await this.writeFromCommit(commit, relative);
        });
    }

    /** Restores every snapshotted file that differs from the checkpoint; returns the paths changed. */
    restoreAll(commitId: string): Promise<string[]> {
        return this.locked(async () => {
            const paths = await this.pathsToRestore(commitId);
            await this.writeFromCommit(await this.resolveCommit(commitId), paths);
            return paths;
        });
    }

    /** What `restoreAll` would change, without writing anything. */
    previewRestore(commitId: string): Promise<string[]> {
        return this.locked(() => this.pathsToRestore(commitId));
    }

    /** Waits for the running operation, then refuses any new one. The shadow repository stays on disk. */
    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        await withProjectLock(this.gitDir, async () => {
            this.disposed = true;
        });
    }

    // ---- internals -----------------------------------------------------------------

    private locked<T>(task: () => Promise<T>): Promise<T> {
        if (this.disposed) {
            return Promise.reject(new Error('The checkpoint store was disposed.'));
        }
        return withProjectLock(this.gitDir, async () => {
            if (this.disposed) {
                throw new Error('The checkpoint store was disposed.');
            }
            await this.ensureInitialized();
            return task();
        });
    }

    private buildEnvironment(): NodeJS.ProcessEnv {
        const env: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(process.env)) {
            // An inherited GIT_DIR, GIT_INDEX_FILE or GIT_CONFIG_* would redirect every call.
            if (!key.toUpperCase().startsWith('GIT_')) {
                env[key] = value;
            }
        }
        delete env['ELECTRON_RUN_AS_NODE'];
        delete env['NODE_OPTIONS'];
        env['GIT_CONFIG_NOSYSTEM'] = '1';
        env['GIT_CONFIG_GLOBAL'] = path.join(this.gitDir, EMPTY_CONFIG_NAME);
        env['GIT_TERMINAL_PROMPT'] = '0';
        env['LC_ALL'] = 'C';
        return env;
    }

    /** Runs git with the shadow repository, the project as work tree and the private index. */
    private run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
        const env: NodeJS.ProcessEnv = { ...this.env };
        if (!options.bare) {
            env['GIT_DIR'] = this.gitDir;
            env['GIT_WORK_TREE'] = this.projectRoot;
            env['GIT_INDEX_FILE'] = this.indexFile;
        }
        const fullArgs = [...this.configArgs, ...args];
        return new Promise((resolve, reject) => {
            const child = execFile(this.gitExecutable, fullArgs, {
                cwd: options.bare ? undefined : this.projectRoot,
                env,
                timeout: this.timeoutMs,
                maxBuffer: MAX_OUTPUT_BYTES,
                windowsHide: true,
                encoding: 'buffer',
            }, (error, stdout, stderr) => {
                if (!error) {
                    resolve({ stdout, exitCode: 0 });
                    return;
                }
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'ENOENT') {
                    reject(new Error(`Checkpoints need git, and "${this.gitExecutable}" was not found.`));
                    return;
                }
                if ((error as { killed?: boolean }).killed) {
                    reject(new CheckpointTimeoutError(args, this.timeoutMs));
                    return;
                }
                const exitCode = typeof code === 'number' ? code : -1;
                if ((options.okExitCodes ?? []).includes(exitCode)) {
                    resolve({ stdout, exitCode });
                    return;
                }
                const message = stderr.toString('utf8').trim();
                reject(new Error(`Checkpoint git ${args[0] ?? ''} failed${message ? `: ${message}` : ` (exit code ${exitCode}).`}`));
            });
            child.stdin?.on('error', () => undefined);
            child.stdin?.end(options.input ?? '');
        });
    }

    private async ensureInitialized(): Promise<void> {
        if (this.initialized) {
            return;
        }
        const head = path.join(this.gitDir, 'HEAD');
        const exists = await fs.access(head).then(() => true, () => false);
        await fs.mkdir(this.gitDir, { recursive: true });
        await fs.writeFile(path.join(this.gitDir, EMPTY_CONFIG_NAME), '', { flag: 'a' });
        await fs.mkdir(path.join(this.gitDir, HOOKS_DIR_NAME), { recursive: true });
        if (!exists) {
            await this.run(['init', '--bare', '--quiet', this.gitDir], { bare: true });
            // Bare at creation (nothing is checked out next to it), a work tree in use.
            await this.run(['--git-dir', this.gitDir, 'config', 'core.bare', 'false'], { bare: true });
            await this.run(['--git-dir', this.gitDir, 'config', 'core.logAllRefUpdates', 'false'], { bare: true });
            await fs.writeFile(path.join(this.gitDir, 'codexr-project.json'), `${JSON.stringify({ projectRoot: this.projectRoot }, null, 2)}\n`);
        }
        await fs.mkdir(path.join(this.gitDir, 'info'), { recursive: true });
        await fs.writeFile(path.join(this.gitDir, 'info', 'attributes'), ATTRIBUTES);
        this.initialized = true;
    }

    /** Rewrites `info/exclude`: the defaults, the project's own exclude file, and the shadow repo if it sits inside the project. */
    private async writeExcludes(): Promise<void> {
        const lines = ['# Written by Code-XR checkpoints; rewritten before every snapshot.', ...DEFAULT_EXCLUDES];
        const inside = path.relative(this.projectRoot, path.dirname(this.gitDir));
        if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))) {
            lines.push(`/${path.relative(this.projectRoot, this.gitDir).split(path.sep).join('/')}/`);
        }
        lines.push(...await readProjectExclude(this.projectRoot));
        const file = path.join(this.gitDir, 'info', 'exclude');
        const content = `${lines.join('\n')}\n`;
        const current = await fs.readFile(file, 'utf8').catch(() => null);
        if (current !== content) {
            await fs.writeFile(file, content);
        }
    }

    /**
     * Brings the private index in line with the working tree and writes it as a
     * tree. Throws `CheckpointsDisabledError` (with `disabledReason` set) when the
     * project is too large or git times out.
     */
    private async stageWorkingTree(): Promise<StagedTree> {
        try {
            await this.writeExcludes();
            const listed = splitNul((await this.run(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout);
            // Untracked nested repositories are listed as their folder, with a trailing slash.
            const nested = listed.filter((entry) => entry.endsWith('/'));
            const files = listed.filter((entry) => !entry.endsWith('/'));
            if (files.length > this.maxFiles) {
                return this.disable(`This project is too large for checkpoints (more than ${this.maxFiles.toLocaleString('en-US')} files).`);
            }
            const large = await this.largeFiles(files);
            const pathspecs = ['.', ...[...nested, ...large].map((entry) => `:(exclude,literal)${entry}`)];
            await this.run(['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${pathspecs.join('\0')}\0` });
            const tree = (await this.run(['write-tree'])).stdout.toString('utf8').trim();
            const fileCount = splitNul((await this.run(['ls-files', '-z'])).stdout).length;
            return { tree, fileCount };
        } catch (error) {
            if (error instanceof CheckpointTimeoutError) {
                // A killed git can leave its lock behind; nothing else of ours runs now (project lock).
                await fs.rm(`${this.indexFile}.lock`, { force: true });
                return this.disable(`Checkpoints are off: a snapshot of this project took longer than ${Math.round(this.timeoutMs / 1000)} s.`);
            }
            throw error;
        }
    }

    private async stageOrThrow(): Promise<StagedTree> {
        if (this.disabled !== null) {
            throw new CheckpointsDisabledError(this.disabled);
        }
        return this.stageWorkingTree();
    }

    private disable(reason: string): never {
        this.disabled = reason;
        throw new CheckpointsDisabledError(reason);
    }

    /** The listed files larger than `maxFileBytes` (missing ones are skipped: they were deleted). */
    private async largeFiles(files: readonly string[]): Promise<string[]> {
        const large: string[] = [];
        for (let start = 0; start < files.length; start += STAT_CONCURRENCY) {
            const chunk = files.slice(start, start + STAT_CONCURRENCY);
            const sizes = await Promise.all(chunk.map((file) => fs.lstat(this.absolute(file)).then((stat) => (stat.isFile() ? stat.size : 0), () => 0)));
            sizes.forEach((size, index) => {
                const file = chunk[index];
                if (size > this.maxFileBytes && file !== undefined) {
                    large.push(file);
                }
            });
        }
        return large;
    }

    private async currentHead(): Promise<string | null> {
        const result = await this.run(['rev-parse', '--verify', '--quiet', CHECKPOINT_REF], { okExitCodes: [1] });
        const sha = result.stdout.toString('utf8').trim();
        return result.exitCode === 0 && sha !== '' ? sha : null;
    }

    /** Validates a checkpoint id and returns its full sha. */
    private async resolveCommit(commitId: string): Promise<string> {
        if (!COMMIT_ID.test(commitId)) {
            throw new Error(`Not a checkpoint id: "${commitId}".`);
        }
        const result = await this.run(['rev-parse', '--verify', '--quiet', `${commitId}^{commit}`], { okExitCodes: [1, 128] });
        const sha = result.stdout.toString('utf8').trim();
        if (result.exitCode !== 0 || sha === '') {
            throw new Error(`Checkpoint ${commitId} does not exist in this project's history.`);
        }
        return sha;
    }

    private async diffTrees(base: string, tree: string): Promise<ChangedFile[]> {
        const statusOutput = splitNul((await this.run(['diff-tree', '-r', '-z', '--no-renames', '--name-status', base, tree])).stdout);
        const numstatOutput = splitNul((await this.run(['diff-tree', '-r', '-z', '--no-renames', '--numstat', base, tree])).stdout);
        const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
        for (const record of numstatOutput) {
            const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
            if (match?.[3] !== undefined) {
                const binary = match[1] === '-';
                counts.set(match[3], { additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]), binary });
            }
        }
        const changes: ChangedFile[] = [];
        for (let index = 0; index + 1 < statusOutput.length; index += 2) {
            const letter = statusOutput[index] ?? '';
            const filePath = statusOutput[index + 1] ?? '';
            const status: ChangeStatus = letter.startsWith('A') ? 'added' : letter.startsWith('D') ? 'deleted' : 'modified';
            const count = counts.get(filePath) ?? { additions: 0, deletions: 0, binary: false };
            changes.push({ path: filePath, status, ...count });
        }
        return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }

    private async pathsToRestore(commitId: string): Promise<string[]> {
        const commit = await this.resolveCommit(commitId);
        const { tree } = await this.stageOrThrow();
        const output = await this.run(['diff-tree', '-r', '-z', '--no-renames', '--name-only', commit, tree]);
        return splitNul(output.stdout).sort();
    }

    /** One file's blob at a commit, or null when the path is not a file there. */
    private async readBlob(commit: string, relative: string): Promise<Buffer | null> {
        const entry = (await this.treeEntries(commit, [relative])).get(relative);
        if (!entry) {
            return null;
        }
        return (await this.readBlobs([entry.sha])).get(entry.sha) ?? null;
    }

    /** Blob entries of a commit's tree, limited to `only` when given. */
    private async treeEntries(commit: string, only?: readonly string[]): Promise<Map<string, TreeEntry>> {
        const wanted = only ? new Set(only) : null;
        const output = splitNul((await this.run(['ls-tree', '-r', '-z', '-l', '--full-tree', commit])).stdout);
        const entries = new Map<string, TreeEntry>();
        for (const record of output) {
            const match = /^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t(.*)$/s.exec(record);
            if (match?.[5] === undefined || match[2] !== 'blob' || (wanted && !wanted.has(match[5]))) {
                continue;
            }
            entries.set(match[5], { mode: match[1] ?? '100644', sha: match[3] ?? '', size: Number(match[4]) || 0 });
        }
        return entries;
    }

    /** Reads blobs through `cat-file --batch`, as raw bytes. */
    private async readBlobs(shas: readonly string[]): Promise<Map<string, Buffer>> {
        const blobs = new Map<string, Buffer>();
        if (shas.length === 0) {
            return blobs;
        }
        const output = (await this.run(['cat-file', '--batch'], { input: `${shas.join('\n')}\n`, bare: false })).stdout;
        let offset = 0;
        while (offset < output.length) {
            const newline = output.indexOf(0x0a, offset);
            if (newline < 0) {
                break;
            }
            const header = output.subarray(offset, newline).toString('utf8');
            const match = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
            if (!match?.[1] || !match[3]) {
                // "<sha> missing": no body follows.
                offset = newline + 1;
                continue;
            }
            const size = Number(match[3]);
            blobs.set(match[1], output.subarray(newline + 1, newline + 1 + size));
            offset = newline + 1 + size + 1;
        }
        return blobs;
    }

    private absolute(relative: string): string {
        return path.join(this.projectRoot, ...relative.split('/'));
    }

    /** Writes each path as it is in `commit`, or deletes it when the commit does not have it. */
    private async writeFromCommit(commit: string, paths: readonly string[]): Promise<void> {
        if (paths.length === 0) {
            return;
        }
        const entries = await this.treeEntries(commit, paths);
        const toDelete = paths.filter((relative) => !entries.has(relative));
        const toWrite = paths.filter((relative) => entries.has(relative));
        for (const relative of toDelete) {
            await this.deleteFile(relative);
        }
        let batch: string[] = [];
        let batchBytes = 0;
        const flush = async (): Promise<void> => {
            const unique = [...new Set(batch.map((relative) => entries.get(relative)?.sha ?? ''))];
            const blobs = await this.readBlobs(unique);
            for (const relative of batch) {
                const entry = entries.get(relative);
                const content = entry ? blobs.get(entry.sha) : undefined;
                if (!entry || content === undefined) {
                    throw new Error(`Checkpoint ${commit.slice(0, 12)} has no content for ${relative}.`);
                }
                await this.writeFile(relative, entry.mode, content);
            }
            batch = [];
            batchBytes = 0;
        };
        for (const relative of toWrite) {
            const size = entries.get(relative)?.size ?? 0;
            if (batch.length > 0 && batchBytes + size > BATCH_BYTES) {
                await flush();
            }
            batch.push(relative);
            batchBytes += size;
        }
        if (batch.length > 0) {
            await flush();
        }
    }

    private async deleteFile(relative: string): Promise<void> {
        const target = this.absolute(relative);
        const stat = await fs.lstat(target).catch((error: unknown) => {
            if (isNotFound(error)) {
                return null;
            }
            throw error;
        });
        if (stat === null) {
            return;
        }
        if (stat.isDirectory()) {
            throw new Error(`Cannot restore ${relative}: it is a folder now.`);
        }
        await fs.unlink(target);
        await this.removeEmptyParents(path.dirname(target));
    }

    /** Removes folders left empty by a deletion, up to (not including) the project root. */
    private async removeEmptyParents(directory: string): Promise<void> {
        let current = directory;
        while (current !== this.projectRoot && current.startsWith(this.projectRoot + path.sep)) {
            const removed = await fs.rmdir(current).then(() => true, () => false);
            if (!removed) {
                return;
            }
            current = path.dirname(current);
        }
    }

    /** Writes a file's bytes through a temporary sibling and a rename; recreates a symbolic link where the platform allows it. */
    private async writeFile(relative: string, treeMode: string, content: Buffer): Promise<void> {
        const target = this.absolute(relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const current = await fs.lstat(target).catch((error: unknown) => {
            if (isNotFound(error)) {
                return null;
            }
            throw error;
        });
        if (current?.isDirectory()) {
            throw new Error(`Cannot restore ${relative}: it is a folder now.`);
        }
        if (treeMode === '120000') {
            const linkTarget = content.toString('utf8');
            if (current?.isSymbolicLink() && (await fs.readlink(target)) === linkTarget) {
                return;
            }
            await fs.rm(target, { force: true });
            await fs.symlink(linkTarget, target);
            return;
        }
        if (current?.isFile()) {
            const existing = await fs.readFile(target);
            if (existing.equals(content) && fileMode(treeMode, current.mode) === (current.mode & 0o777)) {
                return;
            }
        }
        const temporary = `${target}.codexr-${randomBytes(6).toString('hex')}.tmp`;
        // An existing file keeps its permissions (executable bit from the tree); a new one gets the umask's.
        const existingMode = current?.isFile() ? fileMode(treeMode, current.mode) : null;
        try {
            await fs.writeFile(temporary, content, { mode: existingMode ?? (treeMode === '100755' ? 0o777 : 0o666) });
            if (current?.isSymbolicLink()) {
                await fs.rm(target, { force: true });
            }
            await fs.rename(temporary, target);
        } catch (error) {
            await fs.rm(temporary, { force: true });
            if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EBUSY') {
                // Windows refuses to rename over a file another process holds open; write in place instead.
                await fs.writeFile(target, content);
                return;
            }
            throw error;
        }
        if (existingMode !== null && process.platform !== 'win32') {
            await fs.chmod(target, existingMode);
        }
    }
}
