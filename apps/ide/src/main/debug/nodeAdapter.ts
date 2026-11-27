import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DapMessageReader, encodeDapMessage, type DapMessage } from '../../shared/debug.ts';
import type { DebugAdapter } from './debugSession.ts';

/**
 * #180: the Node.js debug adapter, in the IDE itself. It speaks DAP to the
 * session (debugSession.ts) and the Chrome DevTools Protocol to the program:
 * Node is started with `--inspect-brk` on a free local port, the adapter
 * connects to the WebSocket address Node prints, and translates breakpoints,
 * steps, the stack, scopes, variables and evaluation between the two. One
 * thread (the main one); worker threads and child processes are not followed.
 * Nothing to install: it needs only the `node` the person runs their code with.
 */

export interface NodeAdapterOptions {
    /** The `node` executable. */
    readonly runtime: string;
    readonly log: (message: string) => void;
}

interface LaunchArguments {
    readonly program: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly stopOnEntry: boolean;
}

interface RemoteObject {
    readonly type: string;
    readonly subtype?: string;
    readonly className?: string;
    readonly value?: unknown;
    readonly unserializableValue?: string;
    readonly description?: string;
    readonly objectId?: string;
}

interface CallFrame {
    readonly callFrameId: string;
    readonly functionName: string;
    readonly location: { readonly scriptId: string; readonly lineNumber: number; readonly columnNumber?: number };
    readonly url?: string;
    readonly scopeChain: readonly { readonly type: string; readonly name?: string; readonly object: RemoteObject }[];
    readonly this?: RemoteObject;
}

const THREAD_ID = 1;
const LISTENING = /Debugger listening on (ws:\/\/[^\s]+)/;
/** What Node prints about the inspector, which is not the program's output. */
const INSPECTOR_NOISE = /^(Debugger listening on |For help, see: https:\/\/nodejs\.org\/|Debugger attached\.|Waiting for the debugger to disconnect\.\.\.)/;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_PROPERTIES = 1000;
const MAX_VALUE_LENGTH = 1000;

/** The DevTools address in Node's stderr, or null. */
export function inspectorAddress(stderr: string): string | null {
    return LISTENING.exec(stderr)?.[1] ?? null;
}

/** Drops the inspector's own lines from a chunk of stderr. */
export function withoutInspectorNoise(text: string): string {
    return text.split(/(?<=\n)/).filter((line) => !INSPECTOR_NOISE.test(line.trim())).join('');
}

/**
 * The URL pattern of a file's breakpoints: CommonJS scripts are known by
 * their path, ES modules by their `file://` URL; Windows paths match in any
 * case and with either slash.
 */
export function breakpointUrlRegex(file: string, platform: string = process.platform): string {
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    if (platform === 'win32') {
        const parts = file.split(/[\\/]+/).filter(Boolean);
        const caseless = (text: string): string => [...text].map((char) => {
            const lower = char.toLowerCase();
            const upper = char.toUpperCase();
            return lower !== upper ? `[${lower}${upper}]` : escape(char);
        }).join('');
        const body = parts.map(caseless).join('[\\\\/]');
        return `^(?:file:\\/\\/\\/)?${body}$`;
    }
    const url = pathToFileURL(file, { windows: false }).href;
    return `^(?:${escape(url)}|${escape(file)})$`;
}

/** A script's URL as a path (null for Node's internals and evaluated code). */
export function scriptPath(url: string): string | null {
    if (url.startsWith('file://')) {
        try {
            return fileURLToPath(url);
        } catch {
            return null;
        }
    }
    return path.isAbsolute(url) || /^[a-zA-Z]:[\\/]/.test(url) ? url : null;
}

/** How a value reads in Variables, Watch and the console. */
export function formatRemoteObject(object: RemoteObject): string {
    let text: string;
    if (object.type === 'string') {
        text = JSON.stringify(object.value ?? '');
    } else if (object.unserializableValue !== undefined) {
        text = object.unserializableValue;
    } else if (object.type === 'undefined') {
        text = 'undefined';
    } else if (object.type === 'object' && object.subtype === 'null') {
        text = 'null';
    } else if (object.type === 'number' || object.type === 'boolean') {
        text = String(object.value);
    } else if (object.type === 'function') {
        const first = (object.description ?? 'function').split('\n')[0] ?? 'function';
        text = first.replace(/\s*\{\s*$/, '');
    } else {
        text = object.description ?? (object.value === undefined ? object.type : JSON.stringify(object.value));
    }
    return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 3)}...` : text;
}

const SCOPE_NAMES: Readonly<Record<string, string>> = {
    local: 'Local', closure: 'Closure', global: 'Global', block: 'Block', script: 'Script', module: 'Module', catch: 'Catch', with: 'With', eval: 'Eval',
};

export function startNodeAdapter(options: NodeAdapterOptions): DebugAdapter {
    const dataListeners: ((chunk: Uint8Array) => void)[] = [];
    const closeListeners: (() => void)[] = [];
    const reader = new DapMessageReader();
    let seq = 1;
    let closed = false;

    let child: ChildProcess | null = null;
    let socket: WebSocket | null = null;
    let cdpSeq = 1;
    const cdpPending = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();
    const scripts = new Map<string, string>();
    /** Breakpoint ids by file, so a new list replaces the old one. */
    const placed = new Map<string, string[]>();
    let callFrames: readonly CallFrame[] = [];
    /** Object ids behind DAP's variable references, valid while paused. */
    let handles: (string | null)[] = [null];
    let paused = false;
    let lastAction: 'step' | 'pause' | null = null;
    let entryPending = true;
    let stopOnEntry = false;
    let mainContextId: number | null = null;
    let exitCode: number | null = null;

    function emit(message: Record<string, unknown>): void {
        if (closed) {
            return;
        }
        const bytes = encodeDapMessage({ seq: seq++, ...message });
        for (const listener of dataListeners) {
            listener(bytes);
        }
    }
    const event = (name: string, body?: unknown): void => emit({ type: 'event', event: name, ...(body === undefined ? {} : { body }) });

    let ending = false;
    function shutdown(): void {
        if (ending) {
            return;
        }
        ending = true;
        event('exited', { exitCode: exitCode ?? 0 });
        event('terminated');
        closed = true;
        for (const pending of cdpPending.values()) {
            pending.reject(new Error('The program has ended.'));
        }
        cdpPending.clear();
        socket?.close();
        socket = null;
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill();
        }
        for (const listener of closeListeners) {
            listener();
        }
    }

    function cdp<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const open = socket;
        if (!open || open.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('The program is not running.'));
        }
        const id = cdpSeq++;
        return new Promise<T>((resolve, reject) => {
            cdpPending.set(id, { resolve: resolve as (result: unknown) => void, reject });
            open.send(JSON.stringify({ id, method, params }));
        });
    }

    function onCdpMessage(text: string): void {
        let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown> };
        try {
            message = JSON.parse(text) as typeof message;
        } catch {
            return;
        }
        if (typeof message.id === 'number') {
            const pending = cdpPending.get(message.id);
            cdpPending.delete(message.id);
            if (message.error) {
                pending?.reject(new Error(message.error.message ?? 'The inspector refused the request.'));
            } else {
                pending?.resolve(message.result);
            }
            return;
        }
        const params = message.params ?? {};
        switch (message.method) {
            case 'Debugger.scriptParsed':
                if (typeof params['scriptId'] === 'string' && typeof params['url'] === 'string') {
                    scripts.set(params['scriptId'], params['url']);
                }
                break;
            case 'Debugger.paused':
                onPaused(params);
                break;
            case 'Debugger.resumed':
                if (paused) {
                    paused = false;
                    callFrames = [];
                    handles = [null];
                    event('continued', { threadId: THREAD_ID, allThreadsContinued: true });
                }
                break;
            case 'Runtime.executionContextCreated': {
                const context = params['context'] as { id?: number } | undefined;
                if (mainContextId === null && typeof context?.id === 'number') {
                    mainContextId = context.id;
                }
                break;
            }
            case 'Runtime.executionContextDestroyed':
                // The program ran to its end; Node waits for the debugger to let go.
                if (params['executionContextId'] === mainContextId) {
                    socket?.close();
                }
                break;
            default:
                break;
        }
    }

    function onPaused(params: Record<string, unknown>): void {
        callFrames = (params['callFrames'] as CallFrame[] | undefined) ?? [];
        handles = [null];
        paused = true;
        const cdpReason = typeof params['reason'] === 'string' ? params['reason'] : 'other';
        const hit = Array.isArray(params['hitBreakpoints']) && params['hitBreakpoints'].length > 0;
        if (entryPending) {
            // --inspect-brk stops before the first line; a breakpoint there counts as one.
            entryPending = false;
            if (!stopOnEntry && !hit) {
                void cdp('Debugger.resume').catch(() => undefined);
                return;
            }
            event('stopped', { reason: hit ? 'breakpoint' : 'entry', threadId: THREAD_ID, allThreadsStopped: true });
            return;
        }
        let reason = 'pause';
        let text: string | undefined;
        if (hit) {
            reason = 'breakpoint';
        } else if (cdpReason === 'exception' || cdpReason === 'promiseRejection') {
            reason = 'exception';
            text = formatRemoteObject((params['data'] ?? { type: 'undefined' }) as RemoteObject);
        } else if (lastAction === 'step') {
            reason = 'step';
        } else if (cdpReason === 'debugCommand' || cdpReason === 'other') {
            reason = lastAction === 'pause' ? 'pause' : 'breakpoint';
        }
        lastAction = null;
        event('stopped', { reason, threadId: THREAD_ID, allThreadsStopped: true, ...(text ? { text, description: 'Exception' } : {}) });
    }

    async function connect(address: string): Promise<void> {
        const ws = new WebSocket(address);
        await new Promise<void>((resolve, reject) => {
            ws.addEventListener('open', () => resolve(), { once: true });
            ws.addEventListener('error', () => reject(new Error('Could not connect to the Node.js inspector.')), { once: true });
        });
        socket = ws;
        ws.addEventListener('message', (message) => onCdpMessage(typeof message.data === 'string' ? message.data : String(message.data)));
        ws.addEventListener('close', () => {
            socket = null;
            for (const pending of cdpPending.values()) {
                pending.reject(new Error('The program has ended.'));
            }
            cdpPending.clear();
        });
        await cdp('Runtime.enable');
        await cdp('Debugger.enable');
        await cdp('Debugger.setPauseOnExceptions', { state: 'none' });
    }

    async function launch(args: LaunchArguments): Promise<void> {
        stopOnEntry = args.stopOnEntry;
        const node = spawn(options.runtime, ['--inspect-brk=127.0.0.1:0', args.program, ...args.args], {
            cwd: args.cwd,
            env: { ...process.env, ...args.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        child = node;
        let stderr = '';
        const address = new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Node.js did not open its inspector.')), CONNECT_TIMEOUT_MS);
            node.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString('utf8');
                if (stderr.length < 8192) {
                    stderr += text;
                    const found = inspectorAddress(stderr);
                    if (found) {
                        clearTimeout(timer);
                        resolve(found);
                    }
                }
                const output = withoutInspectorNoise(text);
                if (output) {
                    event('output', { category: 'stderr', output });
                }
            });
            node.on('error', (error) => {
                clearTimeout(timer);
                reject(new Error(`Could not start ${options.runtime}: ${error.message}`));
            });
            node.on('exit', (code) => {
                clearTimeout(timer);
                reject(new Error(`Node.js exited with code ${code ?? 'unknown'} before the debugger could attach.`));
            });
        });
        node.stdout?.on('data', (chunk: Buffer) => event('output', { category: 'stdout', output: chunk.toString('utf8') }));
        node.on('exit', (code) => {
            exitCode = code;
            shutdown();
        });
        await connect(await address);
        event('initialized');
    }

    async function setBreakpoints(file: string, lines: readonly number[]): Promise<unknown> {
        for (const id of placed.get(file) ?? []) {
            await cdp('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => undefined);
        }
        const ids: string[] = [];
        const breakpoints = [];
        for (const line of lines) {
            try {
                const result = await cdp<{ breakpointId: string; locations: { lineNumber: number }[] }>('Debugger.setBreakpointByUrl', {
                    lineNumber: line - 1,
                    urlRegex: breakpointUrlRegex(file),
                    columnNumber: 0,
                });
                ids.push(result.breakpointId);
                const resolved = result.locations[0];
                breakpoints.push({ verified: true, line: resolved ? resolved.lineNumber + 1 : line });
            } catch (error) {
                breakpoints.push({ verified: false, line, message: error instanceof Error ? error.message : String(error) });
            }
        }
        placed.set(file, ids);
        return { breakpoints };
    }

    function frame(frameId: number): CallFrame {
        const found = callFrames[frameId - 1];
        if (!paused || !found) {
            throw new Error('That frame is no longer current.');
        }
        return found;
    }

    function handle(objectId: string | undefined): number {
        if (!objectId) {
            return 0;
        }
        handles.push(objectId);
        return handles.length - 1;
    }

    async function request(command: string, args: Record<string, unknown>): Promise<unknown> {
        switch (command) {
            case 'initialize':
                return { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true, supportsTerminateRequest: false };
            case 'launch':
                await launch(args as unknown as LaunchArguments);
                return undefined;
            case 'setBreakpoints': {
                const source = args['source'] as { path?: unknown } | undefined;
                const lines = Array.isArray(args['lines']) ? args['lines'].filter((line): line is number => typeof line === 'number') : [];
                if (typeof source?.path !== 'string') {
                    throw new Error('A breakpoint needs a file.');
                }
                return setBreakpoints(source.path, lines);
            }
            case 'configurationDone':
                await cdp('Runtime.runIfWaitingForDebugger').catch(() => undefined);
                return undefined;
            case 'threads':
                return { threads: [{ id: THREAD_ID, name: 'Main Thread' }] };
            case 'continue':
                await cdp('Debugger.resume');
                return { allThreadsContinued: true };
            case 'next':
                lastAction = 'step';
                await cdp('Debugger.stepOver');
                return undefined;
            case 'stepIn':
                lastAction = 'step';
                await cdp('Debugger.stepInto');
                return undefined;
            case 'stepOut':
                lastAction = 'step';
                await cdp('Debugger.stepOut');
                return undefined;
            case 'pause':
                lastAction = 'pause';
                await cdp('Debugger.pause');
                return undefined;
            case 'stackTrace': {
                const stackFrames = callFrames.map((callFrame, index) => {
                    const url = callFrame.url || scripts.get(callFrame.location.scriptId) || '';
                    const file = scriptPath(url);
                    const internal = url.startsWith('node:');
                    return {
                        id: index + 1,
                        name: callFrame.functionName || '(anonymous)',
                        line: callFrame.location.lineNumber + 1,
                        column: (callFrame.location.columnNumber ?? 0) + 1,
                        source: file ? { path: file, name: path.basename(file) } : { name: url || '(unknown)', presentationHint: 'deemphasize' },
                        ...(internal || file?.includes(`${path.sep}node_modules${path.sep}`) ? { presentationHint: 'subtle' } : {}),
                    };
                });
                return { stackFrames, totalFrames: stackFrames.length };
            }
            case 'scopes': {
                const current = frame(Number(args['frameId']));
                const scopes = current.scopeChain.map((scope) => ({
                    name: SCOPE_NAMES[scope.type] ?? scope.type,
                    variablesReference: handle(scope.object.objectId),
                    expensive: scope.type === 'global',
                }));
                return { scopes };
            }
            case 'variables': {
                const objectId = handles[Number(args['variablesReference'])];
                if (!objectId) {
                    return { variables: [] };
                }
                const result = await cdp<{ result: { name: string; value?: RemoteObject; get?: RemoteObject; enumerable?: boolean; isOwn?: boolean }[] }>(
                    'Runtime.getProperties', { objectId, ownProperties: true, generatePreview: false },
                );
                const variables = result.result
                    .filter((property) => property.value !== undefined)
                    .slice(0, MAX_PROPERTIES)
                    .map((property) => {
                        const value = property.value as RemoteObject;
                        const expandable = value.type === 'object' && value.subtype !== 'null' ? value.objectId : undefined;
                        return { name: property.name, value: formatRemoteObject(value), type: value.className ?? value.type, variablesReference: handle(expandable) };
                    });
                return { variables };
            }
            case 'evaluate': {
                const expression = String(args['expression'] ?? '');
                const context = args['context'];
                const frameId = typeof args['frameId'] === 'number' ? args['frameId'] : null;
                const evaluated = paused && frameId !== null
                    ? await cdp<{ result: RemoteObject; exceptionDetails?: { exception?: RemoteObject; text?: string } }>('Debugger.evaluateOnCallFrame', {
                        callFrameId: frame(frameId).callFrameId, expression, silent: context !== 'repl', generatePreview: false, includeCommandLineAPI: context === 'repl',
                    })
                    : await cdp<{ result: RemoteObject; exceptionDetails?: { exception?: RemoteObject; text?: string } }>('Runtime.evaluate', {
                        expression, silent: context !== 'repl', generatePreview: false, includeCommandLineAPI: context === 'repl',
                    });
                if (evaluated.exceptionDetails) {
                    const exception = evaluated.exceptionDetails.exception;
                    throw new Error(exception ? formatRemoteObject(exception) : evaluated.exceptionDetails.text ?? 'The expression threw.');
                }
                const value = evaluated.result;
                const expandable = value.type === 'object' && value.subtype !== 'null' ? value.objectId : undefined;
                return { result: formatRemoteObject(value), type: value.className ?? value.type, variablesReference: handle(expandable) };
            }
            case 'disconnect':
            case 'terminate':
                shutdown();
                return undefined;
            default:
                throw new Error(`The Node.js debugger does not support "${command}".`);
        }
    }

    function onDapMessage(message: DapMessage): void {
        if (message.type !== 'request' || typeof message.command !== 'string') {
            return;
        }
        const command = message.command;
        const args = (message.arguments ?? {}) as Record<string, unknown>;
        request(command, args).then(
            (body) => emit({ type: 'response', request_seq: message.seq, command, success: true, ...(body === undefined ? {} : { body }) }),
            (error: unknown) => emit({ type: 'response', request_seq: message.seq, command, success: false, message: error instanceof Error ? error.message : String(error) }),
        );
    }

    return {
        adapterId: 'node',
        transport: {
            write: (bytes) => {
                for (const message of reader.push(bytes)) {
                    onDapMessage(message);
                }
            },
            onData: (listener) => { dataListeners.push(listener); },
            onClose: (listener) => { closeListeners.push(listener); },
        },
        kill: () => shutdown(),
    };
}
