/**
 * #180: the debugger, the shared half. What a launch configuration is and how
 * `.codexr/launch.json` is read, the variables it may use, the Debug Adapter
 * Protocol's framing (`Content-Length` headers over a byte stream), and what
 * the renderer and the main process tell each other about a session. Pure,
 * unit-tested in Node; the main process runs the adapters
 * (main/debug/*) and the renderer draws the session (renderer/debug/*).
 */
import { stripJsonComments } from './tasks.ts';

export type DebugType = 'python' | 'node';
export const DEBUG_TYPES: readonly DebugType[] = ['python', 'node'];

export interface LaunchConfiguration {
    readonly name: string;
    readonly type: DebugType;
    readonly request: 'launch';
    /** The file to run; may use the variables below (`${file}`, `${workspaceFolder}`...). */
    readonly program: string;
    readonly args: readonly string[];
    /** Where it runs; the open folder by default. */
    readonly cwd: string | null;
    readonly env: Readonly<Record<string, string>>;
    readonly stopOnEntry: boolean;
    /** Python: step only through the folder's code, not the libraries'. */
    readonly justMyCode: boolean;
    /** The interpreter (`python` for Python, `runtimeExecutable` for Node); the setting or PATH by default. */
    readonly runtime: string | null;
}

export const LAUNCH_PATH = '.codexr/launch.json';

export const LAUNCH_TEMPLATE = `{
    // Debug configurations of this folder (Run and Debug view, F5).
    // Variables: \${workspaceFolder}, \${file}, \${relativeFile}, \${fileBasename},
    // \${fileDirname}, \${env:NAME}.
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Python: Current File",
            "type": "python",
            "request": "launch",
            "program": "\${file}",
            "justMyCode": true
        },
        {
            "name": "Node.js: Current File",
            "type": "node",
            "request": "launch",
            "program": "\${file}"
        }
    ]
}
`;

/** Running a folder's code under a debugger is running it: refused until the folder is trusted (#177). */
export const RESTRICTED_DEBUG_MESSAGE = 'Debugging is disabled in Restricted Mode. Trust this folder to debug its code.';

const MAX_CONFIGURATIONS = 100;
const TYPE_ALIASES: Readonly<Record<string, DebugType>> = { python: 'python', debugpy: 'python', node: 'node', 'pwa-node': 'node' };

/** The debugger a file gets with no launch configuration ("Debug the current file"), or null. */
export function debugTypeOf(path: string): DebugType | null {
    const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
    if (extension === 'py' || extension === 'pyw') {
        return 'python';
    }
    if (['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].includes(extension)) {
        return 'node';
    }
    return null;
}

export function currentFileConfiguration(type: DebugType): LaunchConfiguration {
    return {
        name: type === 'python' ? 'Python: Current File' : 'Node.js: Current File',
        type,
        request: 'launch',
        program: '${file}',
        args: [],
        cwd: null,
        env: {},
        stopOnEntry: false,
        justMyCode: true,
        runtime: null,
    };
}

/**
 * `.codexr/launch.json` (VS Code's format, comments and trailing commas
 * accepted). Entries that are not launches of a known type, or have no name
 * or program, are reported and skipped; the rest are kept.
 */
export function parseLaunchJson(text: string): { configurations: LaunchConfiguration[]; errors: string[] } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripJsonComments(text));
    } catch {
        return { configurations: [], errors: [`${LAUNCH_PATH} is not valid JSON.`] };
    }
    const list = isRecord(parsed) && Array.isArray(parsed['configurations']) ? parsed['configurations'] : null;
    if (!list) {
        return { configurations: [], errors: [`${LAUNCH_PATH} has no "configurations" list.`] };
    }
    const configurations: LaunchConfiguration[] = [];
    const errors: string[] = [];
    const names = new Set<string>();
    for (const [index, entry] of list.slice(0, MAX_CONFIGURATIONS).entries()) {
        if (!isRecord(entry)) {
            continue;
        }
        const name = typeof entry['name'] === 'string' ? entry['name'].trim().slice(0, 200) : '';
        const label = name || `configuration ${index + 1}`;
        const type = typeof entry['type'] === 'string' ? TYPE_ALIASES[entry['type']] : undefined;
        if (!type) {
            errors.push(`${LAUNCH_PATH}: "${label}" has a type the IDE cannot debug (${String(entry['type'])}). Use "python" or "node".`);
            continue;
        }
        if (entry['request'] !== undefined && entry['request'] !== 'launch') {
            errors.push(`${LAUNCH_PATH}: "${label}" is a "${String(entry['request'])}" request; only "launch" is supported.`);
            continue;
        }
        const program = typeof entry['program'] === 'string' ? entry['program'].trim() : '';
        if (!name || !program) {
            errors.push(`${LAUNCH_PATH}: "${label}" needs a "name" and a "program".`);
            continue;
        }
        if (names.has(name)) {
            errors.push(`${LAUNCH_PATH}: two configurations are called "${name}"; the second is skipped.`);
            continue;
        }
        names.add(name);
        const runtimeKey = type === 'python' ? 'python' : 'runtimeExecutable';
        configurations.push({
            name,
            type,
            request: 'launch',
            program,
            args: Array.isArray(entry['args']) ? entry['args'].filter((arg): arg is string => typeof arg === 'string') : [],
            cwd: typeof entry['cwd'] === 'string' && entry['cwd'].trim() ? entry['cwd'].trim() : null,
            env: isRecord(entry['env'])
                ? Object.fromEntries(Object.entries(entry['env']).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
                : {},
            stopOnEntry: entry['stopOnEntry'] === true,
            justMyCode: entry['justMyCode'] !== false,
            runtime: typeof entry[runtimeKey] === 'string' && (entry[runtimeKey] as string).trim() ? (entry[runtimeKey] as string).trim() : null,
        });
    }
    return { configurations, errors };
}

export interface LaunchVariables {
    /** Absolute path of the open folder. */
    readonly workspaceFolder: string;
    /** Absolute path of the active file, or null with none. */
    readonly file: string | null;
    /** The active file relative to the folder, `/`-separated. */
    readonly relativeFile: string | null;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly separator: '/' | '\\';
}

/** Replaces `${workspaceFolder}`, `${file}`... in `value`; throws on a variable it cannot fill. */
export function substituteVariables(value: string, variables: LaunchVariables): string {
    return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
        if (name.startsWith('env:')) {
            return variables.env[name.slice(4)] ?? '';
        }
        const needFile = (): string => {
            if (variables.file === null) {
                throw new Error(`\${${name}} needs an open file: open the file to debug first.`);
            }
            return variables.file;
        };
        switch (name) {
            case 'workspaceFolder':
            case 'workspaceRoot':
                return variables.workspaceFolder;
            case 'workspaceFolderBasename':
                return baseName(variables.workspaceFolder);
            case 'file':
                return needFile();
            case 'relativeFile':
                needFile();
                return (variables.relativeFile ?? '').split('/').join(variables.separator);
            case 'fileBasename':
                return baseName(needFile());
            case 'fileBasenameNoExtension':
                return baseName(needFile()).replace(/\.[^.]*$/, '');
            case 'fileDirname': {
                const file = needFile();
                const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
                return cut > 0 ? file.slice(0, cut) : file;
            }
            case 'fileExtname':
                return /\.[^./\\]*$/.exec(needFile())?.[0] ?? '';
            case 'pathSeparator':
                return variables.separator;
            default:
                throw new Error(`Unknown variable \${${name}} in ${LAUNCH_PATH}.`);
        }
    });
}

function baseName(file: string): string {
    return file.split(/[\\/]/).filter(Boolean).pop() ?? file;
}

// ---------------------------------------------------------------- DAP framing

/** One Debug Adapter Protocol message, as the adapter sends it. */
export interface DapMessage {
    readonly seq: number;
    readonly type: 'request' | 'response' | 'event';
    readonly command?: string;
    readonly event?: string;
    readonly request_seq?: number;
    readonly success?: boolean;
    readonly message?: string;
    readonly arguments?: unknown;
    readonly body?: unknown;
}

/** A message, ready to write to the adapter: `Content-Length` header, blank line, UTF-8 JSON. */
export function encodeDapMessage(message: object): Uint8Array {
    const body = new TextEncoder().encode(JSON.stringify(message));
    const header = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`);
    const result = new Uint8Array(header.length + body.length);
    result.set(header, 0);
    result.set(body, header.length);
    return result;
}

/** Above this a message is a broken adapter, not a big variable: the reader gives up. */
export const MAX_DAP_MESSAGE = 64 * 1024 * 1024;

/**
 * Cuts the adapter's byte stream into messages. Chunks may split a header,
 * a body or a UTF-8 character anywhere; `push` returns the messages it
 * completed. A malformed header or body throws.
 */
export class DapMessageReader {
    private buffer = new Uint8Array(0);
    private readonly decoder = new TextDecoder();

    push(chunk: Uint8Array): DapMessage[] {
        const joined = new Uint8Array(this.buffer.length + chunk.length);
        joined.set(this.buffer, 0);
        joined.set(chunk, this.buffer.length);
        this.buffer = joined;
        const messages: DapMessage[] = [];
        for (;;) {
            const headerEnd = indexOfBlankLine(this.buffer);
            if (headerEnd < 0) {
                if (this.buffer.length > 8192) {
                    throw new Error('The debug adapter sent a header with no end.');
                }
                return messages;
            }
            const header = this.decoder.decode(this.buffer.subarray(0, headerEnd));
            const length = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)?.[1];
            if (length === undefined) {
                throw new Error('The debug adapter sent a message without Content-Length.');
            }
            const size = Number(length);
            if (size > MAX_DAP_MESSAGE) {
                throw new Error('The debug adapter sent a message too large to read.');
            }
            const start = headerEnd + 4;
            if (this.buffer.length < start + size) {
                return messages;
            }
            const text = this.decoder.decode(this.buffer.subarray(start, start + size));
            this.buffer = this.buffer.slice(start + size);
            const parsed: unknown = JSON.parse(text);
            if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
                throw new Error('The debug adapter sent a message that is not DAP.');
            }
            messages.push(parsed as unknown as DapMessage);
        }
    }
}

function indexOfBlankLine(bytes: Uint8Array): number {
    for (let index = 0; index + 3 < bytes.length; index += 1) {
        if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) {
            return index;
        }
    }
    return -1;
}

// ---------------------------------------------------------------- renderer <-> main

export type DebugSessionState = 'starting' | 'running' | 'stopped' | 'ended';

export interface DebugSessionInfo {
    readonly id: number;
    readonly name: string;
    readonly type: DebugType;
    readonly state: DebugSessionState;
    /** The thread that stopped (state `stopped`). */
    readonly threadId: number | null;
    /** Why it stopped: breakpoint, step, pause, exception, entry. */
    readonly reason: string | null;
    /** The exception's text when it stopped on one. */
    readonly description: string | null;
    readonly exitCode: number | null;
}

export interface DebugBreakpoint {
    /** Workspace-relative, `/`-separated. */
    readonly path: string;
    readonly line: number;
    /** False when the adapter could not place it (no code on that line); unknown until a session runs. */
    readonly verified: boolean | null;
    readonly message: string | null;
}

export interface DebugStackFrame {
    readonly id: number;
    readonly name: string;
    /** Workspace-relative when the file is in the folder, else null (a library: shown, not opened). */
    readonly path: string | null;
    /** The file's name, for frames outside the folder. */
    readonly sourceName: string | null;
    readonly line: number;
    readonly column: number;
    /** `subtle` and `label` frames are drawn dimmed (library code, async boundaries). */
    readonly hint: 'normal' | 'label' | 'subtle';
}

export interface DebugScope {
    readonly name: string;
    readonly variablesReference: number;
    readonly expensive: boolean;
}

export interface DebugVariable {
    readonly name: string;
    readonly value: string;
    readonly type: string | null;
    /** Above zero when it has children to expand. */
    readonly variablesReference: number;
}

export interface DebugEvaluation {
    readonly result: string;
    readonly type: string | null;
    readonly variablesReference: number;
}

export type DebugEvent =
    | { readonly kind: 'session'; readonly session: DebugSessionInfo }
    | { readonly kind: 'output'; readonly sessionId: number; readonly category: 'stdout' | 'stderr' | 'console' | 'important'; readonly text: string }
    | { readonly kind: 'breakpoints'; readonly path: string; readonly breakpoints: readonly DebugBreakpoint[] };

export interface DebugConfigurationList {
    readonly trusted: boolean;
    readonly configurations: readonly LaunchConfiguration[];
    readonly errors: readonly string[];
}

/** What starting a session came to; an adapter that is missing can be installed with consent. */
export type DebugStartResult =
    | { readonly ok: true; readonly sessionId: number }
    | { readonly ok: false; readonly missing: 'debugpy'; readonly message: string }
    | { readonly ok: false; readonly missing: null; readonly message: string };

export type DebugStepKind = 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause';

export interface DebugApi {
    configurations(): Promise<DebugConfigurationList>;
    /** Starts the named configuration of `.codexr/launch.json`, or (name null) the active file with its debugger. */
    start(name: string | null, activeFile: string | null): Promise<DebugStartResult>;
    /** Installs the Python adapter (debugpy) into the IDE's Python environment; asked for first in the window. */
    installAdapter(adapter: 'debugpy'): Promise<boolean>;
    stop(): Promise<void>;
    restart(): Promise<DebugStartResult>;
    step(kind: DebugStepKind, threadId: number | null): Promise<void>;
    stackTrace(threadId: number): Promise<DebugStackFrame[]>;
    scopes(frameId: number): Promise<DebugScope[]>;
    variables(variablesReference: number): Promise<DebugVariable[]>;
    evaluate(expression: string, frameId: number | null, context: 'watch' | 'repl' | 'hover'): Promise<DebugEvaluation>;
    /** The file's breakpoints, all of them (an empty list clears it); sent to a running session too. */
    setBreakpoints(path: string, lines: readonly number[]): Promise<void>;
    /** Creates `.codexr/launch.json` with an example when it is missing; returns its workspace path. */
    configure(): Promise<string>;
    onEvent(listener: (event: DebugEvent) => void): () => void;
}

export const DEBUG_IPC_CHANNELS = {
    debugConfigurations: 'codexr:debug:configurations',
    debugStart: 'codexr:debug:start',
    debugInstallAdapter: 'codexr:debug:install-adapter',
    debugStop: 'codexr:debug:stop',
    debugRestart: 'codexr:debug:restart',
    debugStep: 'codexr:debug:step',
    debugStackTrace: 'codexr:debug:stack-trace',
    debugScopes: 'codexr:debug:scopes',
    debugVariables: 'codexr:debug:variables',
    debugEvaluate: 'codexr:debug:evaluate',
    debugSetBreakpoints: 'codexr:debug:set-breakpoints',
    debugConfigure: 'codexr:debug:configure',
} as const;

export const DEBUG_IPC_EVENTS = {
    debugEvent: 'codexr:debug:event',
} as const;

export const DEBUG_STEPS: readonly DebugStepKind[] = ['continue', 'next', 'stepIn', 'stepOut', 'pause'];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
