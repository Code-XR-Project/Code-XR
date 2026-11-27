import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
    currentFileConfiguration, DEBUG_IPC_CHANNELS, DEBUG_IPC_EVENTS, DEBUG_STEPS, debugTypeOf, LAUNCH_PATH, LAUNCH_TEMPLATE, parseLaunchJson,
    RESTRICTED_DEBUG_MESSAGE, substituteVariables,
    type DebugConfigurationList, type DebugEvent, type DebugStartResult, type DebugStepKind, type LaunchConfiguration,
} from '../../shared/debug.ts';
import { settingOf } from '../../shared/settings.ts';
import { findProgram, interpreterFor, NODE_INTERPRETER_SETTING, PYTHON_INTERPRETER_SETTING } from '../../shared/tasks.ts';
import { channelLog } from '../log.ts';
import type { PythonEnvironmentService } from '../python/pythonEnvironment.ts';
import type { SettingsService } from '../settings/settingsService.ts';
import { workspacePath } from '../tasks/problemMatchers.ts';
import { isWorkspaceTrusted } from '../trust/workspaceTrust.ts';
import type { Workspace } from '../workspace/workspace.ts';
import { workspaceOrNull } from '../workspace/workspaceWindows.ts';
import { DebugSession, type DebugAdapter } from './debugSession.ts';
import { startNodeAdapter } from './nodeAdapter.ts';

type Handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

const log = channelLog('debug');

/**
 * #180: the debugger in the main process. One session per window at a time.
 * The renderer names a configuration of `.codexr/launch.json` (or asks for
 * the active file); everything that runs is resolved here, from the folder's
 * own files, and only in a trusted folder (#177). Python runs under debugpy,
 * started from the IDE's Python environment (installed into it only after
 * the person agrees in the window); Node.js under the IDE's own adapter
 * over the inspector protocol (nodeAdapter.ts).
 */

interface WindowState {
    session: DebugSession | null;
    readonly breakpoints: Map<string, number[]>;
    last: { readonly name: string | null; readonly activeFile: string | null } | null;
}

const windows = new Map<number, WindowState>();
let nextSessionId = 1;

function stateOf(contents: WebContents): WindowState {
    let state = windows.get(contents.id);
    if (!state) {
        const created: WindowState = { session: null, breakpoints: new Map(), last: null };
        windows.set(contents.id, created);
        contents.once('destroyed', () => {
            void created.session?.stop();
            windows.delete(contents.id);
        });
        state = created;
    }
    return state;
}

/** Ends every session (the app quits). */
export async function stopAllDebugSessions(): Promise<void> {
    await Promise.all([...windows.values()].map((state) => state.session?.stop()));
}

export function registerDebugHandlers(handle: Handle, settings: SettingsService, python: () => PythonEnvironmentService): void {
    handle(DEBUG_IPC_CHANNELS.debugConfigurations, (event) => listConfigurations(event.sender));
    handle(DEBUG_IPC_CHANNELS.debugStart, (event, name, activeFile) =>
        start(event.sender, settings, python(), optionalString(name), optionalString(activeFile)));
    handle(DEBUG_IPC_CHANNELS.debugRestart, (event) => {
        const last = stateOf(event.sender).last;
        if (!last) {
            throw new Error('Nothing has been debugged in this window yet.');
        }
        return start(event.sender, settings, python(), last.name, last.activeFile);
    });
    handle(DEBUG_IPC_CHANNELS.debugInstallAdapter, async (event, adapter) => {
        requireTrusted(event.sender);
        if (adapter !== 'debugpy') {
            throw new Error('Unknown debug adapter.');
        }
        return python().installDebugpy();
    });
    handle(DEBUG_IPC_CHANNELS.debugStop, async (event) => {
        await stateOf(event.sender).session?.stop();
    });
    handle(DEBUG_IPC_CHANNELS.debugStep, async (event, kind, threadId) => {
        if (typeof kind !== 'string' || !DEBUG_STEPS.includes(kind as DebugStepKind)) {
            throw new Error('Unknown step.');
        }
        await sessionOf(event.sender).step(kind as DebugStepKind, typeof threadId === 'number' ? threadId : null);
    });
    handle(DEBUG_IPC_CHANNELS.debugStackTrace, (event, threadId) => sessionOf(event.sender).stackTrace(integer(threadId)));
    handle(DEBUG_IPC_CHANNELS.debugScopes, (event, frameId) => sessionOf(event.sender).scopes(integer(frameId)));
    handle(DEBUG_IPC_CHANNELS.debugVariables, (event, reference) => sessionOf(event.sender).variables(integer(reference)));
    handle(DEBUG_IPC_CHANNELS.debugEvaluate, (event, expression, frameId, context) => {
        if (typeof expression !== 'string' || expression.length > 10_000) {
            throw new Error('Not an expression.');
        }
        const kind = context === 'repl' || context === 'hover' ? context : 'watch';
        return sessionOf(event.sender).evaluate(expression, typeof frameId === 'number' ? frameId : null, kind);
    });
    handle(DEBUG_IPC_CHANNELS.debugSetBreakpoints, async (event, file, lines) => {
        if (typeof file !== 'string' || !file || file.length > 4096 || !Array.isArray(lines) || lines.length > 10_000) {
            throw new Error('Not a list of breakpoints.');
        }
        const clean = lines.filter((line): line is number => Number.isInteger(line) && line > 0);
        const state = stateOf(event.sender);
        if (clean.length === 0) {
            state.breakpoints.delete(file);
        } else {
            state.breakpoints.set(file, clean);
        }
        await state.session?.setBreakpoints(file, clean);
    });
    handle(DEBUG_IPC_CHANNELS.debugConfigure, async (event) => {
        const workspace = workspaceOrNull(event.sender);
        if (!workspace) {
            throw new Error('Open a folder to configure its debugging.');
        }
        const existing = await workspace.readFile(LAUNCH_PATH).then(() => true, () => false);
        if (!existing) {
            const [dir = '', name = ''] = LAUNCH_PATH.split('/');
            await workspace.createEntry('', dir, 'directory').catch(() => undefined);
            await workspace.createEntry(dir, name, 'file').catch(() => undefined);
            await workspace.writeFile(LAUNCH_PATH, LAUNCH_TEMPLATE);
        }
        return LAUNCH_PATH;
    });
}

async function listConfigurations(contents: WebContents): Promise<DebugConfigurationList> {
    const workspace = workspaceOrNull(contents);
    if (!workspace) {
        return { trusted: false, configurations: [], errors: [] };
    }
    return { trusted: isWorkspaceTrusted(contents), ...(await readLaunch(workspace)) };
}

async function readLaunch(workspace: Workspace): Promise<{ configurations: LaunchConfiguration[]; errors: string[] }> {
    const content = await workspace.readFile(LAUNCH_PATH).catch(() => null);
    if (content?.kind !== 'text') {
        return { configurations: [], errors: [] };
    }
    return parseLaunchJson(content.text);
}

function requireTrusted(contents: WebContents): Workspace {
    const workspace = workspaceOrNull(contents);
    if (!workspace) {
        throw new Error('Open a folder to debug its code.');
    }
    if (!isWorkspaceTrusted(contents)) {
        throw new Error(RESTRICTED_DEBUG_MESSAGE);
    }
    return workspace;
}

function sessionOf(contents: WebContents): DebugSession {
    const session = stateOf(contents).session;
    if (!session || session.ended) {
        throw new Error('No debug session is running.');
    }
    return session;
}

async function start(
    contents: WebContents,
    settings: SettingsService,
    python: PythonEnvironmentService,
    name: string | null,
    activeFile: string | null,
): Promise<DebugStartResult> {
    const workspace = requireTrusted(contents);
    const state = stateOf(contents);
    let configuration: LaunchConfiguration;
    if (name !== null) {
        const { configurations } = await readLaunch(workspace);
        const found = configurations.find((candidate) => candidate.name === name);
        if (!found) {
            return { ok: false, missing: null, message: `${LAUNCH_PATH} has no configuration called "${name}".` };
        }
        configuration = found;
    } else {
        const type = activeFile ? debugTypeOf(activeFile) : null;
        if (!type) {
            return { ok: false, missing: null, message: 'Open a Python or JavaScript file to debug it, or add a configuration to ' + `${LAUNCH_PATH}.` };
        }
        configuration = currentFileConfiguration(type);
    }

    const realRoot = await fs.promises.realpath(workspace.root).catch(() => workspace.root);
    const file = activeFile ? await workspace.runnableFile(activeFile).catch(() => null) : null;
    const variables = {
        workspaceFolder: workspace.root,
        file,
        relativeFile: file ? workspacePath(file, realRoot, process.platform) : null,
        env: process.env,
        separator: path.sep as '/' | '\\',
    };
    let program: string;
    let cwd: string;
    let args: string[];
    let env: Record<string, string>;
    try {
        program = path.resolve(workspace.root, substituteVariables(configuration.program, variables));
        cwd = configuration.cwd ? path.resolve(workspace.root, substituteVariables(configuration.cwd, variables)) : workspace.root;
        args = configuration.args.map((arg) => substituteVariables(arg, variables));
        env = Object.fromEntries(Object.entries(configuration.env).map(([key, value]) => [key, substituteVariables(value, variables)]));
    } catch (error) {
        return { ok: false, missing: null, message: error instanceof Error ? error.message : String(error) };
    }
    if (!(await isFile(program))) {
        return { ok: false, missing: null, message: `"${configuration.name}": ${program} is not a file.` };
    }
    if (!(await isDirectory(cwd))) {
        return { ok: false, missing: null, message: `"${configuration.name}": the folder ${cwd} does not exist.` };
    }

    const report = await settings.snapshot(workspace);
    const configured = {
        [PYTHON_INTERPRETER_SETTING]: settingOf<string>(report, PYTHON_INTERPRETER_SETTING),
        [NODE_INTERPRETER_SETTING]: settingOf<string>(report, NODE_INTERPRETER_SETTING),
    };
    const runtimeName = configuration.runtime
        ?? interpreterFor(configuration.type === 'python' ? 'x.py' : 'x.js', process.platform, configured)?.program
        ?? (configuration.type === 'python' ? 'python3' : 'node');
    const runtime = path.isAbsolute(runtimeName) || /[\\/]/.test(runtimeName)
        ? path.resolve(workspace.root, runtimeName)
        : await findProgram(runtimeName, process.env, process.platform, isFile);
    if (!runtime || !(await isFile(runtime))) {
        const setting = configuration.type === 'python' ? PYTHON_INTERPRETER_SETTING : NODE_INTERPRETER_SETTING;
        return { ok: false, missing: null, message: `${runtimeName} was not found. Set it in Settings (${setting}) or in the configuration.` };
    }

    await state.session?.stop();
    state.session = null;
    state.last = { name, activeFile };

    const id = nextSessionId++;
    const emit = (event: DebugEvent): void => {
        if (!contents.isDestroyed()) {
            contents.send(DEBUG_IPC_EVENTS.debugEvent, event);
        }
    };
    let adapter: DebugAdapter;
    let launchArguments: Record<string, unknown>;
    if (configuration.type === 'python') {
        const command = await python.debugAdapterCommand();
        if (command === 'missing-env') {
            return {
                ok: false, missing: null,
                message: 'The Python debugger runs from the IDE\'s Python environment, which is not set up yet. Set it up in the Analysis view, then try again.',
            };
        }
        if (command === 'missing-debugpy') {
            return { ok: false, missing: 'debugpy', message: 'Debugging Python needs debugpy, which is not in the IDE\'s Python environment yet.' };
        }
        adapter = spawnAdapter(command.executable, command.args, 'python');
        launchArguments = {
            name: configuration.name,
            type: 'python',
            request: 'launch',
            program,
            args,
            cwd,
            env,
            stopOnEntry: configuration.stopOnEntry,
            justMyCode: configuration.justMyCode,
            console: 'internalConsole',
            redirectOutput: true,
            showReturnValue: true,
            subProcess: false,
            python: [runtime],
        };
    } else {
        adapter = startNodeAdapter({ runtime, log: (message) => log.info(message) });
        launchArguments = { name: configuration.name, type: 'node', request: 'launch', program, args, cwd, env, stopOnEntry: configuration.stopOnEntry };
    }

    const roots = [...new Set([workspace.root, realRoot])];
    const session = new DebugSession({
        id,
        name: configuration.name,
        type: configuration.type,
        adapter,
        launchArguments,
        breakpoints: state.breakpoints,
        toAbsolute: (file) => path.join(realRoot, ...file.split('/')),
        toWorkspace: (absolute) => {
            for (const root of roots) {
                const relative = workspacePath(absolute, root, process.platform);
                if (relative !== null) {
                    return relative;
                }
            }
            return null;
        },
        emit,
        log: (message) => log.info(message),
    });
    state.session = session;
    session.onEnded(() => {
        log.info(`Debug session "${configuration.name}" ended.`);
        if (state.session === session) {
            state.session = null;
        }
    });
    log.info(`Debugging "${configuration.name}": ${runtime} ${program}${args.length > 0 ? ` ${args.join(' ')}` : ''}`);
    try {
        await session.start();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`Debug session "${configuration.name}" could not start: ${message}`);
        return { ok: false, missing: null, message: `Could not start "${configuration.name}": ${message}` };
    }
    return { ok: true, sessionId: id };
}

/** A debug adapter that is a process of its own, spoken to over its stdio. */
function spawnAdapter(executable: string, args: readonly string[], adapterId: string): DebugAdapter {
    const child = spawn(executable, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (error) => log.warn(`The ${adapterId} debug adapter could not start: ${error.message}`));
    child.stdin.on('error', () => undefined);
    return {
        adapterId,
        transport: {
            write: (bytes) => { child.stdin.write(bytes); },
            onData: (listener) => { child.stdout.on('data', (chunk: Buffer) => listener(new Uint8Array(chunk))); },
            onClose: (listener) => {
                child.on('close', (code) => {
                    if (code !== 0 && code !== null && stderr.trim()) {
                        log.warn(`The ${adapterId} debug adapter exited with code ${code}: ${stderr.trim()}`);
                    }
                    listener();
                });
                child.on('error', () => listener());
            },
        },
        kill: () => {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill();
            }
        },
    };
}

function optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : null;
}

function integer(value: unknown): number {
    if (!Number.isInteger(value)) {
        throw new Error('Not an id.');
    }
    return value as number;
}

function isFile(file: string): Promise<boolean> {
    return fs.promises.stat(file).then((stat) => stat.isFile(), () => false);
}

function isDirectory(folder: string): Promise<boolean> {
    return fs.promises.stat(folder).then((stat) => stat.isDirectory(), () => false);
}
