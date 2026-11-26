import type { TerminalCreated, TerminalDataEvent, TerminalExitEvent, TerminalProfile } from '../../shared/api.ts';

/**
 * The ptys behind the terminal panel (#137). They live here, in the main
 * process, and nowhere else: the renderer addresses a terminal by the number
 * `create` returned, and only the window that created it can write to it,
 * resize it, kill it or hear from it.
 *
 * node-pty is injected (`SpawnPty`), so this file loads without the native
 * module and is unit-tested with a fake pty.
 */

/** The part of node-pty's `IPty` used here. */
export interface PtyProcess {
    readonly pid: number;
    onData(listener: (data: string) => void): unknown;
    onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): unknown;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
}

export interface SpawnOptions {
    readonly name: string;
    readonly cols: number;
    readonly rows: number;
    readonly cwd: string;
    readonly env: Record<string, string>;
}

export type SpawnPty = (file: string, args: readonly string[], options: SpawnOptions) => PtyProcess | Promise<PtyProcess>;

/** The window side of a terminal: where its events go. `id` is the webContents id. */
export interface TerminalOwner {
    readonly id: number;
    send(channel: string, payload: TerminalDataEvent | TerminalExitEvent): void;
    isDestroyed(): boolean;
}

export interface TerminalServiceOptions {
    readonly spawn: SpawnPty;
    readonly resolveProfile: (id: unknown) => Promise<TerminalProfile>;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly dataChannel: string;
    readonly exitChannel: string;
    /** How long output is gathered before one IPC message carries it (ms). */
    readonly flushDelayMs?: number;
}

export const MAX_TERMINALS_PER_WINDOW = 20;
export const MAX_INPUT_LENGTH = 1_000_000;
const MAX_DIMENSION = 1000;
const FLUSH_BYTES = 64 * 1024;

interface Running {
    readonly owner: TerminalOwner;
    readonly pty: PtyProcess;
    pending: string;
    timer: ReturnType<typeof setTimeout> | undefined;
    exited: boolean;
}

/** Variables the IDE's own process carries that a shell must not inherit. */
const STRIPPED_ENV = /^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|ELECTRON_ENABLE_LOGGING|CODEXR_IDE_DEV_SERVER_URL|NODE_OPTIONS)$/i;

/** The environment a shell starts with: the IDE's, minus Electron's own switches, plus terminal capabilities. */
export function terminalEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && !STRIPPED_ENV.test(key)) {
            result[key] = value;
        }
    }
    result['TERM'] = 'xterm-256color';
    result['COLORTERM'] = 'truecolor';
    result['TERM_PROGRAM'] = 'codexr';
    return result;
}

function isDimension(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_DIMENSION;
}

export class TerminalService {
    private readonly options: TerminalServiceOptions;
    private readonly terminals = new Map<number, Running>();
    private nextId = 1;

    constructor(options: TerminalServiceOptions) {
        this.options = options;
    }

    async create(owner: TerminalOwner, profileId: unknown, cols: unknown, rows: unknown, cwd: string): Promise<TerminalCreated> {
        if (!isDimension(cols) || !isDimension(rows)) {
            throw new Error('Invalid terminal size.');
        }
        if (this.countOf(owner.id) >= MAX_TERMINALS_PER_WINDOW) {
            throw new Error(`At most ${MAX_TERMINALS_PER_WINDOW} terminals per window.`);
        }
        const profile = await this.options.resolveProfile(profileId);
        const pty = await this.options.spawn(profile.path, profile.args, {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env: terminalEnvironment(this.options.env),
        });
        const id = this.nextId++;
        const running: Running = { owner, pty, pending: '', timer: undefined, exited: false };
        this.terminals.set(id, running);
        pty.onData((data) => this.queue(id, running, data));
        pty.onExit(({ exitCode }) => {
            running.exited = true;
            this.flush(id, running);
            this.terminals.delete(id);
            if (!owner.isDestroyed()) {
                owner.send(this.options.exitChannel, { id, exitCode });
            }
        });
        return { id, profile, cwd };
    }

    input(owner: TerminalOwner, id: unknown, data: unknown): void {
        if (typeof data !== 'string' || data.length > MAX_INPUT_LENGTH) {
            throw new Error('Invalid terminal input.');
        }
        this.own(owner, id).pty.write(data);
    }

    resize(owner: TerminalOwner, id: unknown, cols: unknown, rows: unknown): void {
        if (!isDimension(cols) || !isDimension(rows)) {
            throw new Error('Invalid terminal size.');
        }
        const running = this.own(owner, id);
        if (!running.exited) {
            running.pty.resize(cols, rows);
        }
    }

    kill(owner: TerminalOwner, id: unknown): void {
        const running = this.terminals.get(id as number);
        if (running && running.owner.id === owner.id) {
            this.stop(id as number, running);
        }
    }

    /** Kills every terminal of one window (closed, reloaded or crashed). */
    killOwnedBy(ownerId: number): void {
        for (const [id, running] of [...this.terminals]) {
            if (running.owner.id === ownerId) {
                this.stop(id, running);
            }
        }
    }

    /** Kills every terminal: the app is quitting. */
    killAll(): void {
        for (const [id, running] of [...this.terminals]) {
            this.stop(id, running);
        }
    }

    get size(): number {
        return this.terminals.size;
    }

    private countOf(ownerId: number): number {
        return [...this.terminals.values()].filter((running) => running.owner.id === ownerId).length;
    }

    private own(owner: TerminalOwner, id: unknown): Running {
        const running = typeof id === 'number' ? this.terminals.get(id) : undefined;
        if (!running || running.owner.id !== owner.id) {
            throw new Error('Unknown terminal.');
        }
        return running;
    }

    private stop(id: number, running: Running): void {
        clearTimeout(running.timer);
        this.terminals.delete(id);
        if (!running.exited) {
            running.exited = true;
            try {
                running.pty.kill();
            } catch {
                // Already gone.
            }
        }
    }

    // Output is gathered for a few milliseconds so a burst (a build log) is a
    // handful of IPC messages instead of thousands.
    private queue(id: number, running: Running, data: string): void {
        running.pending += data;
        if (running.pending.length >= FLUSH_BYTES) {
            this.flush(id, running);
        } else {
            running.timer ??= setTimeout(() => this.flush(id, running), this.options.flushDelayMs ?? 5);
        }
    }

    private flush(id: number, running: Running): void {
        clearTimeout(running.timer);
        running.timer = undefined;
        if (running.pending.length === 0) {
            return;
        }
        const data = running.pending;
        running.pending = '';
        if (!running.owner.isDestroyed()) {
            running.owner.send(this.options.dataChannel, { id, data });
        }
    }
}
