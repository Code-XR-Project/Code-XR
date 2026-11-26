import { execFile } from 'node:child_process';

/**
 * Runs the `git` CLI (#17): `execFile`, never a shell, so no argument is ever
 * interpreted; a timeout and an output cap on every call. Injected into
 * `GitService` so the service is tested against a real git in a temporary
 * repository and the runner can be swapped for a fake.
 */

export interface GitRunResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
}

export type GitRunner = (cwd: string, args: readonly string[], options?: GitRunOptions) => Promise<GitRunResult>;

export interface GitRunOptions {
    /** Exit codes that are not failures (`git diff --no-index` exits 1 when files differ). */
    readonly okExitCodes?: readonly number[] | undefined;
    readonly timeoutMs?: number | undefined;
}

/** Thrown when no `git` executable is on PATH. */
export class GitNotFoundError extends Error {
    constructor() {
        super('Git was not found on PATH.');
        this.name = 'GitNotFoundError';
    }
}

/** Thrown when git exits with a failure; `message` is git's own explanation. */
export class GitCommandError extends Error {
    readonly exitCode: number;
    readonly stderr: string;
    constructor(args: readonly string[], exitCode: number, stderr: string) {
        super(stderr.trim() || `git ${args[0] ?? ''} failed (exit code ${exitCode}).`);
        this.name = 'GitCommandError';
        this.exitCode = exitCode;
        this.stderr = stderr;
    }
}

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Options every call carries. They keep a repository from running commands
 * of its own choosing through what the IDE runs on its own (status runs on
 * every focus): `core.fsmonitor` and `diff.external`/textconv drivers are
 * commands named in the repository's config. Hooks still run on commit, as
 * they do from VS Code and the command line.
 */
export const BASE_ARGS: readonly string[] = [
    '-c', 'core.quotepath=false',
    '-c', 'core.fsmonitor=false',
    '-c', 'color.ui=false',
    '--literal-pathspecs',
    '--no-pager',
];

/** The environment git runs with: no prompt can block it, and status takes no optional locks. */
export function gitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base };
    // Electron's own switches must not reach a child process.
    delete env['ELECTRON_RUN_AS_NODE'];
    delete env['NODE_OPTIONS'];
    env['GIT_TERMINAL_PROMPT'] = '0';
    env['GIT_OPTIONAL_LOCKS'] = '0';
    return env;
}

export const runGit: GitRunner = (cwd, args, options = {}) => new Promise((resolve, reject) => {
    const fullArgs = [...BASE_ARGS, ...args];
    execFile('git', fullArgs, {
        cwd,
        env: gitEnvironment(process.env),
        timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        encoding: 'utf8',
    }, (error, stdout, stderr) => {
        if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                reject(new GitNotFoundError());
                return;
            }
            const exitCode = typeof code === 'number' ? code : -1;
            if ((options.okExitCodes ?? []).includes(exitCode)) {
                resolve({ stdout, stderr, exitCode });
                return;
            }
            if ((error as { killed?: boolean }).killed) {
                reject(new GitCommandError(args, exitCode, `git ${args[0] ?? ''} timed out.`));
                return;
            }
            reject(new GitCommandError(args, exitCode, stderr));
            return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
    });
});
