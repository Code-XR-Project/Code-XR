import * as childProcess from 'child_process';
import * as readline from 'readline';

/**
 * Runs `git -C cwd ...args` and hands stdout to `onLine` one line at a time
 * (EVO-12). `execFile` buffers the whole output and fails past its
 * `maxBuffer`, which a full `git log` of a very large history reaches; a
 * stream has no such ceiling. Same timeout and cancel signal as the buffered
 * runner, and the same error codes.
 */
export function streamGitLines(
    cwd: string,
    args: string[],
    onLine: (line: string) => void,
    options: { timeoutMs: number; signal?: AbortSignal; describeFailure: (error: unknown) => Error },
): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            if (error === undefined) {
                resolve();
            } else {
                reject(options.describeFailure(error));
            }
        };
        const child = childProcess.spawn('git', ['-C', cwd, ...args], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => {
            child.kill();
            finish(Object.assign(new Error('git command timed out'), { killed: true }));
        }, options.timeoutMs);
        const onAbort = () => {
            child.kill();
            finish(Object.assign(new Error('git command cancelled'), { name: 'AbortError' }));
        };
        if (options.signal?.aborted) {
            onAbort();
            return;
        }
        options.signal?.addEventListener('abort', onAbort, { once: true });

        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            // Only the head of stderr is kept: it is for the error message.
            if (stderr.length < 4096) {
                stderr += chunk;
            }
        });
        const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        lines.on('line', (line) => {
            if (settled || !line) {
                return;
            }
            try {
                onLine(line);
            } catch (error) {
                child.kill();
                finish(error);
            }
        });
        child.on('error', (error) => finish(error));
        // 'close' fires after stdout ended, so every line was delivered.
        child.on('close', (code) => {
            if (code === 0) {
                finish();
            } else {
                finish(new Error(`git exited with code ${code}: ${stderr.trim()}`));
            }
        });
    });
}
