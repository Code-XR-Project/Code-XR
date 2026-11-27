import type {
    DebugBreakpoint, DebugEvaluation, DebugEvent, DebugScope, DebugSessionInfo, DebugSessionState, DebugStackFrame, DebugStepKind, DebugType,
    DebugVariable,
} from '../../shared/debug.ts';
import { DapClient, type DapTransport } from './dapClient.ts';

/**
 * #180: one debug session, whatever the adapter (debugpy for Python, the
 * IDE's own for Node). It runs DAP's start-up dance (initialize, launch,
 * wait for `initialized`, send the breakpoints, configurationDone), turns
 * the adapter's events into the renderer's `DebugEvent`s, and maps paths:
 * the adapter speaks absolute paths, the renderer workspace-relative ones.
 */

export interface DebugAdapter {
    readonly transport: DapTransport;
    /** DAP's `adapterID`. */
    readonly adapterId: string;
    /** Ends the adapter for good (its process, its debuggee). */
    kill(): void;
}

export interface DebugSessionOptions {
    readonly id: number;
    readonly name: string;
    readonly type: DebugType;
    readonly adapter: DebugAdapter;
    /** The `launch` request's arguments, already resolved (absolute program, interpreter...). */
    readonly launchArguments: Readonly<Record<string, unknown>>;
    /** Every file's breakpoint lines, by workspace path, when the session starts. */
    readonly breakpoints: ReadonlyMap<string, readonly number[]>;
    readonly toAbsolute: (path: string) => string;
    /** Null for a file outside the folder. */
    readonly toWorkspace: (absolute: string) => string | null;
    readonly emit: (event: DebugEvent) => void;
    readonly log: (message: string) => void;
}

const INITIALIZED_TIMEOUT_MS = 30_000;
const DISCONNECT_TIMEOUT_MS = 3_000;
const MAX_FRAMES = 200;
const MAX_VARIABLES = 1000;

interface PlacedBreakpoint {
    readonly id: number | null;
    line: number;
    verified: boolean;
    message: string | null;
}

export class DebugSession {
    private readonly options: DebugSessionOptions;
    private readonly client: DapClient;
    private state: DebugSessionState = 'starting';
    private threadId: number | null = null;
    private reason: string | null = null;
    private description: string | null = null;
    private exitCode: number | null = null;
    private capabilities: Record<string, unknown> = {};
    private readonly placed = new Map<string, PlacedBreakpoint[]>();
    private initialized: (() => void) | null = null;
    private endedListeners: (() => void)[] = [];
    private stopping = false;

    constructor(options: DebugSessionOptions) {
        this.options = options;
        this.client = new DapClient(options.adapter.transport, {
            onEvent: (event, body) => this.onEvent(event, body),
            onReverseRequest: (command) => Promise.reject(new Error(`The IDE does not support "${command}".`)),
            onClosed: (reason) => {
                if (reason) {
                    options.log(`Debug adapter connection closed: ${reason}`);
                }
                this.end();
            },
        });
    }

    get id(): number {
        return this.options.id;
    }

    get ended(): boolean {
        return this.state === 'ended';
    }

    info(): DebugSessionInfo {
        return {
            id: this.options.id,
            name: this.options.name,
            type: this.options.type,
            state: this.state,
            threadId: this.threadId,
            reason: this.reason,
            description: this.description,
            exitCode: this.exitCode,
        };
    }

    onEnded(listener: () => void): void {
        if (this.ended) {
            listener();
        } else {
            this.endedListeners.push(listener);
        }
    }

    /** Runs the start-up sequence; rejects (and ends the session) when the adapter refuses the launch. */
    async start(): Promise<void> {
        this.publish();
        const initialized = new Promise<void>((resolve, reject) => {
            this.initialized = resolve;
            setTimeout(() => reject(new Error('The debug adapter did not get ready in time.')), INITIALIZED_TIMEOUT_MS).unref?.();
        });
        initialized.catch(() => undefined);
        try {
            this.capabilities = (await this.client.request<Record<string, unknown> | undefined>('initialize', {
                clientID: 'codexr-ide',
                clientName: 'Code-XR IDE',
                adapterID: this.options.adapter.adapterId,
                locale: 'en',
                pathFormat: 'path',
                linesStartAt1: true,
                columnsStartAt1: true,
                supportsVariableType: true,
                supportsVariablePaging: false,
                supportsRunInTerminalRequest: false,
                supportsStartDebuggingRequest: false,
                supportsProgressReporting: false,
                supportsInvalidatedEvent: false,
            })) ?? {};
            // The launch answers only after configurationDone (debugpy), so it is not awaited here.
            const launched = this.client.request('launch', this.options.launchArguments, null);
            launched.catch(() => undefined);
            await Promise.race([initialized, launched.then(() => initialized)]);
            for (const [path, lines] of this.options.breakpoints) {
                await this.sendBreakpoints(path, lines);
            }
            if (this.capabilities['exceptionBreakpointFilters'] !== undefined) {
                await this.client.request('setExceptionBreakpoints', { filters: [] }).catch(() => undefined);
            }
            if (this.capabilities['supportsConfigurationDoneRequest'] === true) {
                await this.client.request('configurationDone');
            }
            await launched;
            if (this.state === 'starting') {
                this.state = 'running';
                this.publish();
            }
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    /** The file's breakpoints, all of them; placed now when the session runs. */
    async setBreakpoints(path: string, lines: readonly number[]): Promise<void> {
        if (this.ended || this.state === 'starting') {
            return;
        }
        await this.sendBreakpoints(path, lines);
    }

    async step(kind: DebugStepKind, threadId: number | null): Promise<void> {
        const thread = threadId ?? this.threadId ?? (await this.firstThread());
        if (thread === null) {
            return;
        }
        if (kind === 'pause') {
            await this.client.request('pause', { threadId: thread });
            return;
        }
        // Running from now: some adapters send no `continued` event for the thread they were asked
        // to move, and the next `stopped` may arrive before the answer to this request.
        if (this.state === 'stopped') {
            this.markRunning();
        }
        await this.client.request(kind, { threadId: thread });
    }

    async stackTrace(threadId: number): Promise<DebugStackFrame[]> {
        const body = await this.client.request<{ stackFrames?: unknown[] }>('stackTrace', { threadId, startFrame: 0, levels: MAX_FRAMES });
        return (body?.stackFrames ?? []).flatMap((value): DebugStackFrame[] => {
            const frame = value as { id?: unknown; name?: unknown; line?: unknown; column?: unknown; presentationHint?: unknown; source?: { path?: unknown; name?: unknown; presentationHint?: unknown } };
            if (typeof frame.id !== 'number') {
                return [];
            }
            const absolute = typeof frame.source?.path === 'string' ? frame.source.path : null;
            const hint = frame.presentationHint === 'label' ? 'label'
                : frame.presentationHint === 'subtle' || frame.source?.presentationHint === 'deemphasize' ? 'subtle' : 'normal';
            return [{
                id: frame.id,
                name: typeof frame.name === 'string' ? frame.name : '(unknown)',
                path: absolute === null ? null : this.options.toWorkspace(absolute),
                sourceName: typeof frame.source?.name === 'string' ? frame.source.name : absolute,
                line: typeof frame.line === 'number' ? frame.line : 0,
                column: typeof frame.column === 'number' ? frame.column : 0,
                hint,
            }];
        });
    }

    async scopes(frameId: number): Promise<DebugScope[]> {
        const body = await this.client.request<{ scopes?: unknown[] }>('scopes', { frameId });
        return (body?.scopes ?? []).flatMap((value): DebugScope[] => {
            const scope = value as { name?: unknown; variablesReference?: unknown; expensive?: unknown };
            return typeof scope.name === 'string' && typeof scope.variablesReference === 'number'
                ? [{ name: scope.name, variablesReference: scope.variablesReference, expensive: scope.expensive === true }]
                : [];
        });
    }

    async variables(variablesReference: number): Promise<DebugVariable[]> {
        const body = await this.client.request<{ variables?: unknown[] }>('variables', { variablesReference });
        return (body?.variables ?? []).slice(0, MAX_VARIABLES).flatMap((value): DebugVariable[] => {
            const variable = value as { name?: unknown; value?: unknown; type?: unknown; variablesReference?: unknown };
            return typeof variable.name === 'string'
                ? [{
                    name: variable.name,
                    value: typeof variable.value === 'string' ? variable.value : String(variable.value ?? ''),
                    type: typeof variable.type === 'string' && variable.type ? variable.type : null,
                    variablesReference: typeof variable.variablesReference === 'number' ? variable.variablesReference : 0,
                }]
                : [];
        });
    }

    async evaluate(expression: string, frameId: number | null, context: 'watch' | 'repl' | 'hover'): Promise<DebugEvaluation> {
        const body = await this.client.request<{ result?: unknown; type?: unknown; variablesReference?: unknown }>('evaluate', {
            expression,
            context,
            ...(frameId === null ? {} : { frameId }),
        });
        return {
            result: typeof body?.result === 'string' ? body.result : String(body?.result ?? ''),
            type: typeof body?.type === 'string' && body.type ? body.type : null,
            variablesReference: typeof body?.variablesReference === 'number' ? body.variablesReference : 0,
        };
    }

    /** Ends the debuggee and the adapter: `disconnect` first, the process killed if it does not go. */
    async stop(): Promise<void> {
        if (this.ended || this.stopping) {
            return;
        }
        this.stopping = true;
        if (!this.client.isClosed) {
            await this.client.request('disconnect', { restart: false, terminateDebuggee: true }, DISCONNECT_TIMEOUT_MS).catch(() => undefined);
        }
        this.options.adapter.kill();
        this.client.close(null);
        this.end();
    }

    private async sendBreakpoints(path: string, lines: readonly number[]): Promise<void> {
        const unique = [...new Set(lines)].filter((line) => Number.isInteger(line) && line > 0).sort((a, b) => a - b);
        let placed: PlacedBreakpoint[];
        try {
            const body = await this.client.request<{ breakpoints?: unknown[] }>('setBreakpoints', {
                source: { path: this.options.toAbsolute(path) },
                breakpoints: unique.map((line) => ({ line })),
                lines: unique,
                sourceModified: false,
            });
            const answered = body?.breakpoints ?? [];
            placed = unique.map((line, index) => {
                const value = answered[index] as { id?: unknown; verified?: unknown; line?: unknown; message?: unknown } | undefined;
                return {
                    id: typeof value?.id === 'number' ? value.id : null,
                    line: typeof value?.line === 'number' ? value.line : line,
                    verified: value?.verified === true,
                    message: typeof value?.message === 'string' ? value.message : null,
                };
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            placed = unique.map((line) => ({ id: null, line, verified: false, message }));
        }
        if (placed.length === 0) {
            this.placed.delete(path);
        } else {
            this.placed.set(path, placed);
        }
        this.publishBreakpoints(path);
    }

    private publishBreakpoints(path: string): void {
        const breakpoints: DebugBreakpoint[] = (this.placed.get(path) ?? []).map((breakpoint) => ({
            path, line: breakpoint.line, verified: breakpoint.verified, message: breakpoint.message,
        }));
        this.options.emit({ kind: 'breakpoints', path, breakpoints });
    }

    private async firstThread(): Promise<number | null> {
        const body = await this.client.request<{ threads?: { id?: unknown }[] }>('threads').catch(() => undefined);
        const id = body?.threads?.[0]?.id;
        return typeof id === 'number' ? id : null;
    }

    private onEvent(event: string, body: unknown): void {
        const data = (body ?? {}) as Record<string, unknown>;
        switch (event) {
            case 'initialized':
                this.initialized?.();
                this.initialized = null;
                break;
            case 'stopped':
                void this.onStopped(data);
                break;
            case 'continued':
                if (this.state === 'stopped') {
                    this.markRunning();
                }
                break;
            case 'output': {
                const category = data['category'];
                const text = typeof data['output'] === 'string' ? data['output'] : '';
                if (category === 'telemetry' || !text) {
                    break;
                }
                const kind = category === 'stdout' || category === 'stderr' || category === 'important' ? category : 'console';
                this.options.emit({ kind: 'output', sessionId: this.options.id, category: kind, text });
                break;
            }
            case 'exited':
                this.exitCode = typeof data['exitCode'] === 'number' ? data['exitCode'] : null;
                break;
            case 'terminated':
                void this.stop();
                break;
            case 'breakpoint':
                this.onBreakpointChanged(data['breakpoint']);
                break;
            default:
                break;
        }
    }

    private async onStopped(data: Record<string, unknown>): Promise<void> {
        const threadId = typeof data['threadId'] === 'number' ? data['threadId'] : await this.firstThread();
        if (this.ended) {
            return;
        }
        this.state = 'stopped';
        this.threadId = threadId;
        this.reason = typeof data['reason'] === 'string' ? data['reason'] : null;
        const text = typeof data['text'] === 'string' ? data['text'] : null;
        const description = typeof data['description'] === 'string' ? data['description'] : null;
        this.description = this.reason === 'exception' ? (text ?? description) : description;
        this.publish();
    }

    private onBreakpointChanged(value: unknown): void {
        const changed = value as { id?: unknown; verified?: unknown; line?: unknown; message?: unknown } | undefined;
        if (typeof changed?.id !== 'number') {
            return;
        }
        for (const [path, list] of this.placed) {
            const breakpoint = list.find((entry) => entry.id === changed.id);
            if (breakpoint) {
                breakpoint.verified = changed.verified === true;
                breakpoint.line = typeof changed.line === 'number' ? changed.line : breakpoint.line;
                breakpoint.message = typeof changed.message === 'string' ? changed.message : null;
                this.publishBreakpoints(path);
                return;
            }
        }
    }

    private markRunning(): void {
        if (this.ended) {
            return;
        }
        this.state = 'running';
        this.threadId = null;
        this.reason = null;
        this.description = null;
        this.publish();
    }

    private end(): void {
        if (this.state === 'ended') {
            return;
        }
        this.state = 'ended';
        this.threadId = null;
        this.initialized = null;
        this.publish();
        const listeners = this.endedListeners;
        this.endedListeners = [];
        for (const listener of listeners) {
            listener();
        }
    }

    private publish(): void {
        this.options.emit({ kind: 'session', session: this.info() });
    }
}
