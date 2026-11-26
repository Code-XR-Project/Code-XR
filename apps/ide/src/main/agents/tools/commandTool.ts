import type { PtyProcess, SpawnPty } from '../../terminal/terminalService.ts';
import { terminalEnvironment } from '../../terminal/terminalService.ts';
import { numberArg, stringArg, type AgentTool } from './toolTypes.ts';

/**
 * `run_command` (A9): runs one command for an agent, after the person
 * approved the exact command line, in a pty of the default terminal profile
 * (#137) started in the project folder. The output streams into the chat as
 * it comes and goes back to the model capped (head and tail); a timeout or
 * Stop kills it.
 */

export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 600;
/** What the model gets back: the first and the last part of the output. */
export const MAX_OUTPUT_CHARS = 16_000;
const MAX_COMMAND_CHARS = 4000;

export interface CommandResult {
    readonly exitCode: number | null;
    readonly output: string;
    readonly timedOut: boolean;
    readonly stopped: boolean;
}

export interface CommandRunner {
    run(command: string, cwd: string, options: { readonly timeoutMs: number; readonly signal: AbortSignal; onOutput(text: string): void }): Promise<CommandResult>;
}

/** How a shell runs one command and exits, by the shell's executable name. */
export function shellInvocation(shellPath: string, command: string): readonly string[] {
    const name = shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
    if (name === 'pwsh' || name === 'powershell') {
        return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command];
    }
    if (name === 'cmd') {
        return ['/d', '/s', '/c', command];
    }
    // bash, zsh, sh, fish, dash, Git Bash…: all take -c.
    return ['-c', command];
}

// CSI, OSC and the few two-byte escapes a shell or a progress bar prints.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Terminal output as plain text: no colours, no carriage-return redraws. */
export function plainOutput(raw: string): string {
    return raw
        .replace(ANSI, '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.slice(line.lastIndexOf('\r') + 1))
        .join('\n');
}

/** Keeps the start and the end, which is where errors and summaries are. */
export function capOutput(text: string, max = MAX_OUTPUT_CHARS): string {
    if (text.length <= max) {
        return text;
    }
    const head = Math.floor(max * 0.3);
    const tail = max - head;
    return `${text.slice(0, head)}\n… (${text.length - max} characters left out) …\n${text.slice(text.length - tail)}`;
}

/** The runner over node-pty: the profile's shell with `-c` (or its equivalent), killed on timeout or abort. */
export function ptyCommandRunner(spawn: SpawnPty, shellPath: () => Promise<string>, env: Readonly<Record<string, string | undefined>>): CommandRunner & { killAll(): void } {
    const running = new Set<PtyProcess>();
    return {
        async run(command, cwd, options) {
            const shell = await shellPath();
            const pty = await spawn(shell, shellInvocation(shell, command), {
                name: 'xterm-256color',
                cols: 160,
                rows: 40,
                cwd,
                env: { ...terminalEnvironment(env), CI: '1', NO_COLOR: '1', GIT_PAGER: 'cat', PAGER: 'cat' },
            });
            running.add(pty);
            return new Promise<CommandResult>((resolve) => {
                let output = '';
                let timedOut = false;
                let stopped = false;
                const kill = (): void => {
                    try {
                        pty.kill();
                    } catch {
                        // Already gone.
                    }
                };
                const timer = setTimeout(() => {
                    timedOut = true;
                    kill();
                }, options.timeoutMs);
                const onAbort = (): void => {
                    stopped = true;
                    kill();
                };
                options.signal.addEventListener('abort', onAbort, { once: true });
                pty.onData((data) => {
                    output += data;
                    // Keep memory bounded on a command that never stops talking.
                    if (output.length > MAX_OUTPUT_CHARS * 8) {
                        output = output.slice(0, MAX_OUTPUT_CHARS) + output.slice(-MAX_OUTPUT_CHARS * 4);
                    }
                    options.onOutput(data);
                });
                pty.onExit(({ exitCode }) => {
                    clearTimeout(timer);
                    options.signal.removeEventListener('abort', onAbort);
                    running.delete(pty);
                    resolve({ exitCode: timedOut || stopped ? null : exitCode, output: plainOutput(output), timedOut, stopped });
                });
                if (options.signal.aborted) {
                    onAbort();
                }
            });
        },
        killAll() {
            for (const pty of running) {
                try {
                    pty.kill();
                } catch {
                    // Already gone.
                }
            }
            running.clear();
        },
    };
}

export function runCommandTool(runner: CommandRunner): AgentTool {
    return {
        name: 'run_command',
        title: 'Run a command',
        description: 'Runs one shell command in the project folder (the person approves it first) and returns its exit code and output. '
            + `Non-interactive only: it has no input. Default timeout ${DEFAULT_TIMEOUT_SECONDS}s, at most ${MAX_TIMEOUT_SECONDS}s. Long output is cut in the middle.`,
        risk: 'run',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The command line, e.g. "npm test" or "git status".' },
                timeout_seconds: { type: 'integer', description: `Seconds before it is killed (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}).` },
            },
            required: ['command'],
        },
        preview(args) {
            const command = String(args['command'] ?? '');
            return { summary: `run ${command.length > 80 ? `${command.slice(0, 80)}…` : command}`, detail: `$ ${command}\n\nin the project folder` };
        },
        async run(args, context) {
            if (!context.workspace) {
                throw new Error('No folder is open in the IDE, so there is nowhere to run a command.');
            }
            const command = (stringArg(args, 'command', true) ?? '').trim();
            if (!command || command.length > MAX_COMMAND_CHARS || command.includes('\0')) {
                throw new Error('Invalid command.');
            }
            const seconds = Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, numberArg(args, 'timeout_seconds') ?? DEFAULT_TIMEOUT_SECONDS));
            let shown = '';
            const result = await runner.run(command, context.workspace.root, {
                timeoutMs: seconds * 1000,
                signal: context.signal,
                onOutput: (data) => {
                    shown = (shown + data).slice(-4000);
                    context.progress?.(plainOutput(shown).slice(-1500));
                },
            });
            const status = result.timedOut
                ? `Killed after ${seconds}s (timeout).`
                : result.stopped ? 'Stopped by the person.' : `Exit code ${result.exitCode ?? 'unknown'}.`;
            return `$ ${command}\n${status}\n${capOutput(result.output.trimEnd()) || '(no output)'}`;
        },
    };
}
