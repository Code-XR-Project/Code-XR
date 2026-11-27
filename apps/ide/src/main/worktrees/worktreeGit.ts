import { execFile } from 'node:child_process';
import { BASE_ARGS, DEFAULT_GIT_TIMEOUT_MS, GitCommandError, GitNotFoundError, gitEnvironment } from '../git/gitRunner.ts';

/**
 * The git runner of the agent worktrees (AF12, #277).
 *
 * It reuses the Source Control runner's conventions (src/main/git/gitRunner.ts):
 * `execFile`, never a shell; the same hardening options (`BASE_ARGS`: no
 * fsmonitor, literal pathspecs, no pager); the same error classes; and the same
 * environment (`gitEnvironment`: no prompt, no Electron switches). On top of
 * that it drops every inherited `GIT_*` variable before `gitEnvironment` adds
 * its own: an inherited `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE` (set
 * when the IDE itself is launched from a git hook, for example) would point
 * every call at the wrong repository, and a worktree is precisely a second
 * work tree of one repository.
 *
 * It is a separate runner rather than `runGit` because the worktree code needs
 * per-call `-c` options (the empty hooks directory, the fallback identity)
 * placed before the subcommand, and that inherited-env stripping, which the
 * Source Control view does not do today.
 */

export interface WorktreeGitResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
}

export interface WorktreeGitOptions {
    /** `-c key=value` pairs placed before the subcommand, for this call only. */
    readonly config?: readonly string[] | undefined;
    /** Exit codes that are not failures. */
    readonly okExitCodes?: readonly number[] | undefined;
    readonly timeoutMs?: number | undefined;
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The process environment without any inherited `GIT_*` variable, then hardened by `gitEnvironment`. */
export function worktreeGitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const clean: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(base)) {
        if (!key.toUpperCase().startsWith('GIT_')) {
            clean[key] = value;
        }
    }
    return gitEnvironment(clean);
}

export function runWorktreeGit(cwd: string, args: readonly string[], options: WorktreeGitOptions = {}): Promise<WorktreeGitResult> {
    const config: string[] = [];
    for (const pair of options.config ?? []) {
        config.push('-c', pair);
    }
    const fullArgs = [...BASE_ARGS, ...config, ...args];
    return new Promise((resolve, reject) => {
        const child = execFile('git', fullArgs, {
            cwd,
            env: worktreeGitEnvironment(process.env),
            timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true,
            encoding: 'utf8',
        }, (error, stdout, stderr) => {
            if (!error) {
                resolve({ stdout, stderr, exitCode: 0 });
                return;
            }
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
        });
        child.stdin?.on('error', () => undefined);
        child.stdin?.end('');
    });
}
