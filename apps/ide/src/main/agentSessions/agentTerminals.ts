import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { CreateTerminalRequest, TerminalOutputResponse, WaitForTerminalExitResponse } from '@agentclientprotocol/sdk';
import type { TerminalSnapshot } from './acpMapping.ts';

/**
 * AF1: the ACP `terminal/*` methods. An agent asks the IDE to run a command
 * (`terminal/create`) instead of running it itself, so the person sees the
 * command and its output live in the tool card. Each terminal is a child
 * process with its output kept up to the agent's `outputByteLimit` (the
 * oldest output is dropped first, at a character boundary), its exit status,
 * and listeners for the chat. The command line comes from the agent, so it
 * runs through a shell; the folder is the project unless the agent names a
 * folder inside it.
 */

export const DEFAULT_OUTPUT_LIMIT = 1_000_000;
export const MAX_TERMINALS_PER_SESSION = 32;

export interface TerminalEvents {
    /** New output (already appended to the terminal's buffer), or the exit with an empty chunk. */
    onOutput(terminalId: string, chunk: string, exitCode: number | null | undefined, truncated: boolean): void;
}

interface Running {
    readonly child: ChildProcess;
    output: string;
    truncated: boolean;
    readonly limit: number;
    exit: { exitCode: number | null; signal: string | null } | null;
    readonly exited: Promise<void>;
}

/** The last `limit` bytes of `text` (UTF-8), cut at a character boundary. */
export function keepTail(text: string, limit: number): { text: string; truncated: boolean } {
    if (Buffer.byteLength(text, 'utf8') <= limit) {
        return { text, truncated: false };
    }
    const bytes = Buffer.from(text, 'utf8');
    let start = bytes.length - limit;
    // Skip UTF-8 continuation bytes so the result starts on a character.
    while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) {
        start++;
    }
    return { text: bytes.subarray(start).toString('utf8'), truncated: true };
}

/** Quotes one argument for the platform's shell when it needs it. */
function quoteArg(arg: string, platform: NodeJS.Platform): string {
    if (arg !== '' && /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg)) {
        return arg;
    }
    return platform === 'win32' ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The command line a terminal runs: the agent's command as written, then its arguments quoted. */
export function terminalCommandLine(command: string, args: readonly string[], platform: NodeJS.Platform = process.platform): string {
    return [command, ...args.map((arg) => quoteArg(arg, platform))].join(' ');
}

export class AgentTerminals {
    private readonly terminals = new Map<string, Running>();
    private readonly root: string;
    private readonly env: Readonly<Record<string, string>>;
    private readonly events: TerminalEvents;
    private readonly isInside: (root: string, candidate: string) => boolean;
    private nextId = 1;

    constructor(options: { readonly root: string; readonly env: Readonly<Record<string, string>>; readonly events: TerminalEvents; readonly isInside: (root: string, candidate: string) => boolean }) {
        this.root = options.root;
        this.env = options.env;
        this.events = options.events;
        this.isInside = options.isInside;
    }

    create(params: CreateTerminalRequest): string {
        if (typeof params.command !== 'string' || !params.command.trim()) {
            throw new Error('terminal/create needs a command.');
        }
        if (this.terminals.size >= MAX_TERMINALS_PER_SESSION) {
            throw new Error(`At most ${MAX_TERMINALS_PER_SESSION} terminals per chat; release one first.`);
        }
        const cwd = params.cwd ? path.resolve(this.root, params.cwd) : this.root;
        if (!this.isInside(this.root, cwd)) {
            throw new Error(`Commands run inside the project folder; ${cwd} is outside it.`);
        }
        const env: Record<string, string> = { ...this.env };
        for (const variable of params.env ?? []) {
            env[variable.name] = variable.value;
        }
        const limit = typeof params.outputByteLimit === 'number' && params.outputByteLimit > 0 ? Math.min(params.outputByteLimit, DEFAULT_OUTPUT_LIMIT) : DEFAULT_OUTPUT_LIMIT;
        const child = spawn(terminalCommandLine(params.command, params.args ?? []), {
            cwd,
            env,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            // Its own process group, so a kill reaches what the shell started too.
            detached: process.platform !== 'win32',
        });
        const id = `term-${this.nextId++}`;
        let markExited: () => void = () => undefined;
        const exited = new Promise<void>((resolve) => {
            markExited = resolve;
        });
        const running: Running = { child, output: '', truncated: false, limit, exit: null, exited };
        this.terminals.set(id, running);
        const append = (chunk: string): void => {
            const kept = keepTail(running.output + chunk, running.limit);
            running.output = kept.text;
            running.truncated ||= kept.truncated;
            this.events.onOutput(id, chunk, undefined, running.truncated);
        };
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', append);
        child.stderr?.on('data', append);
        const finish = (exitCode: number | null, signal: string | null): void => {
            if (running.exit) {
                return;
            }
            running.exit = { exitCode, signal };
            this.events.onOutput(id, '', exitCode ?? (signal ? 1 : null), running.truncated);
            markExited();
        };
        child.on('error', (error) => {
            append(`${error.message}\n`);
            finish(127, null);
        });
        child.on('close', (code, signal) => finish(code, signal));
        return id;
    }

    snapshot(terminalId: string): TerminalSnapshot | undefined {
        const running = this.terminals.get(terminalId);
        return running ? { output: running.output, exitCode: running.exit ? (running.exit.exitCode ?? 1) : null, truncated: running.truncated } : undefined;
    }

    output(terminalId: string): TerminalOutputResponse {
        const running = this.get(terminalId);
        return {
            output: running.output,
            truncated: running.truncated,
            ...(running.exit ? { exitStatus: { exitCode: running.exit.exitCode, signal: running.exit.signal } } : {}),
        };
    }

    async waitForExit(terminalId: string, signal?: AbortSignal): Promise<WaitForTerminalExitResponse> {
        const running = this.get(terminalId);
        if (!running.exit) {
            await new Promise<void>((resolve, reject) => {
                const onAbort = (): void => reject(new Error('Cancelled.'));
                signal?.addEventListener('abort', onAbort, { once: true });
                void running.exited.then(() => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                });
            });
        }
        return { exitCode: running.exit?.exitCode ?? null, signal: running.exit?.signal ?? null };
    }

    kill(terminalId: string): void {
        const running = this.get(terminalId);
        if (!running.exit) {
            killTree(running.child);
        }
    }

    release(terminalId: string): void {
        const running = this.terminals.get(terminalId);
        if (!running) {
            return;
        }
        if (!running.exit) {
            killTree(running.child);
        }
        this.terminals.delete(terminalId);
    }

    disposeAll(): void {
        for (const id of [...this.terminals.keys()]) {
            this.release(id);
        }
    }

    private get(terminalId: string): Running {
        const running = this.terminals.get(terminalId);
        if (!running) {
            throw new Error(`Unknown terminal ${terminalId}.`);
        }
        return running;
    }
}

/** Stops the shell and what it started (on Windows, `taskkill /t`). */
function killTree(child: ChildProcess): void {
    try {
        if (process.platform === 'win32' && child.pid !== undefined) {
            spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
        } else if (child.pid !== undefined) {
            process.kill(-child.pid, 'SIGTERM');
        } else {
            child.kill();
        }
    } catch {
        // Already gone.
    }
}

/**
 * The line a terminal login runs in the person's default shell: the agent's
 * login command with each argument quoted for that shell, preceded by the
 * variables the shell does not already have (`ELECTRON_RUN_AS_NODE` for an
 * agent the IDE runs with its own Node, a login method's own variables).
 */
export function loginCommandLine(shell: 'posix' | 'cmd' | 'powershell', quoted: string, env: Readonly<Record<string, string>>, shellEnv: Readonly<Record<string, string | undefined>>): string {
    const extra = Object.entries(env).filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && shellEnv[key] !== value);
    if (extra.length === 0) {
        return quoted;
    }
    if (shell === 'powershell') {
        return `${extra.map(([key, value]) => `$env:${key}='${value.replace(/'/g, "''")}'`).join('; ')}; ${quoted}`;
    }
    if (shell === 'cmd') {
        if (extra.some(([, value]) => /["%&|<>^]/.test(value))) {
            throw new Error('A login variable cannot be passed to cmd.exe safely.');
        }
        return `${extra.map(([key, value]) => `set "${key}=${value}"`).join(' && ')} && ${quoted}`;
    }
    return `env ${extra.map(([key, value]) => `${key}='${value.replace(/'/g, `'\\''`)}'`).join(' ')} ${quoted}`;
}
