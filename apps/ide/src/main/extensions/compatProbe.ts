import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    activationEventsOf, HOST_METHODS, MAIN_METHODS, RpcEndpoint,
    type HostActivationEvent, type HostInitData, type HostLogLine,
} from '../../shared/extensionHostProtocol.ts';
import { HOST_VSCODE_API_VERSION, type ContributionSummary, type ExtensionId } from '../../shared/extensions.ts';
import { ExtensionStore, type LoadedExtension } from './extensionStore.ts';
import { engineSupported, summarizeContributions } from './manifest.ts';

/**
 * #264: the compatibility probe. Installs a .vsix through the IDE's own
 * install path (ExtensionStore: the same unpack, manifest checks and
 * folder layout as the Extensions view), starts the real extension host on
 * it in a plain Node process, fires every activation event the extension
 * declares, and records what happened: activated or failed, which vscode
 * APIs it reached for that the host does not implement, the errors it
 * logged, and the commands it registered.
 *
 * It answers "does the code start, and what API does it miss at start-up",
 * not "does every feature work": a feature behind a command or a language
 * request may still reach an unimplemented API later. No Electron import:
 * `scripts/extensionCompat.mjs` runs it under Node.
 */

export type ProbeOutcome = 'activated' | 'failed' | 'no-code' | 'not-installed' | 'timeout';

export interface ProbeResult {
    readonly file: string;
    readonly id: ExtensionId | null;
    readonly version: string | null;
    readonly outcome: ProbeOutcome;
    /** The engine range is one the IDE's API version satisfies. */
    readonly engineSupported: boolean | null;
    readonly contributions: ContributionSummary | null;
    /** vscode API names the extension used and the host does not implement, in first-use order. */
    readonly missingApi: readonly string[];
    /** Error and warning lines the host or the extension logged. */
    readonly errors: readonly string[];
    readonly registeredCommands: number;
    readonly milliseconds: number;
    readonly detail: string | null;
}

export interface ProbeOptions {
    /** Absolute path of `src/extensionHost/index.ts` (or the built host). */
    readonly hostEntry: string;
    /** Node flags for the host process (type stripping when it runs from source). */
    readonly execArgv?: readonly string[];
    /** A folder the host sees as the open workspace; a throw-away one when absent. */
    readonly workspaceFolder?: string;
    readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Every event worth firing at start-up: what the extension declares (and the implicit ones), with `*` and `onStartupFinished`. */
export function probeEvents(extension: LoadedExtension, folder: string): string[] {
    const events = new Set<string>(['*', 'onStartupFinished']);
    for (const event of activationEventsOf(extension.manifest.activationEvents, extension.manifest.contributes)) {
        // workspaceContains: the IDE fires it after a folder walk finds a match; the probe fires it as if one had.
        events.add(event);
    }
    if (fs.existsSync(folder)) {
        events.add('onFileSystem:file');
    }
    return [...events];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Probes one .vsix in a store of its own and a host of its own, so one extension cannot spoil the next one's result. */
export async function probeVsix(file: string, options: ProbeOptions): Promise<ProbeResult> {
    const started = Date.now();
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-compat-')));
    const base = { file, id: null, version: null, engineSupported: null, contributions: null, missingApi: [], errors: [], registeredCommands: 0, detail: null };
    try {
        const store = new ExtensionStore(path.join(scratch, 'extensions'));
        try {
            await store.install(file, 'vsix');
        } catch (error) {
            return { ...base, outcome: 'not-installed', milliseconds: Date.now() - started, detail: error instanceof Error ? error.message : String(error) };
        }
        const installed = store.list();
        const extension = installed.at(-1);
        if (!extension) {
            return { ...base, outcome: 'not-installed', milliseconds: Date.now() - started, detail: 'The store lists nothing after the install.' };
        }
        const described = {
            ...base,
            id: extension.manifest.id,
            version: extension.manifest.version,
            engineSupported: engineSupported(extension.manifest.engine, HOST_VSCODE_API_VERSION),
            contributions: summarizeContributions(extension.manifest),
        };
        if (!extension.manifest.main) {
            return { ...described, outcome: 'no-code', milliseconds: Date.now() - started };
        }
        const folder = options.workspaceFolder ?? path.join(scratch, 'workspace');
        fs.mkdirSync(folder, { recursive: true });
        const result = await runHost(extension, installed, folder, scratch, options);
        return { ...described, ...result, milliseconds: Date.now() - started };
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

async function runHost(
    extension: LoadedExtension,
    installed: readonly LoadedExtension[],
    folder: string,
    scratch: string,
    options: ProbeOptions,
): Promise<Pick<ProbeResult, 'outcome' | 'missingApi' | 'errors' | 'registeredCommands' | 'detail'>> {
    const missingApi: string[] = [];
    const errors: string[] = [];
    let activation: HostActivationEvent | null = null;
    const child = fork(options.hostEntry, [], {
        execArgv: [...(options.execArgv ?? [])],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'advanced',
    });
    child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
            errors.push(`[stderr] ${text.slice(0, 400)}`);
        }
    });
    const main = new RpcEndpoint((message) => child.send(message));
    child.on('message', (message) => main.receive(message));
    main.handle(MAIN_METHODS.log, (...params) => {
        const line = params[0] as HostLogLine;
        if (line.level === 'error' || line.level === 'warn') {
            errors.push(line.message.slice(0, 400));
        }
        return undefined;
    });
    main.handle(MAIN_METHODS.notImplemented, (...params) => {
        const api = String(params[1]);
        if (!missingApi.includes(api)) {
            missingApi.push(api);
        }
        return undefined;
    });
    main.handle(MAIN_METHODS.activation, (...params) => {
        const event = params[0] as HostActivationEvent;
        if (event.id === extension.manifest.id && (event.state === 'active' || event.state === 'failed')) {
            activation = event;
        }
        return undefined;
    });
    // The workbench's side, answered the way a person who clicks nothing would.
    for (const method of [MAIN_METHODS.uiNotify, MAIN_METHODS.webview, MAIN_METHODS.diagnostics, MAIN_METHODS.registerProvider, MAIN_METHODS.unregisterProvider,
        MAIN_METHODS.updateConfiguration, MAIN_METHODS.secretStore, MAIN_METHODS.secretDelete, MAIN_METHODS.clipboardWrite]) {
        main.handle(method, () => undefined);
    }
    main.handle(MAIN_METHODS.ui, () => null);
    main.handle(MAIN_METHODS.secretGet, () => null);
    main.handle(MAIN_METHODS.clipboardRead, () => '');
    main.handle(MAIN_METHODS.openExternal, () => false);
    main.handle(MAIN_METHODS.showDialog, () => null);
    main.handle(MAIN_METHODS.executeWorkbenchCommand, () => undefined);
    const withCode = installed.filter((entry) => entry.manifest.main);
    const init: HostInitData = {
        extensions: withCode.map((entry) => ({
            id: entry.manifest.id,
            location: entry.location,
            main: entry.manifest.main as string,
            packageJSON: entry.manifest.raw,
            activationEvents: activationEventsOf(entry.manifest.activationEvents, entry.manifest.contributes),
            extensionDependencies: entry.manifest.extensionDependencies,
        })),
        passive: installed.filter((entry) => !entry.manifest.main).map((entry) => ({ id: entry.manifest.id, location: entry.location, packageJSON: entry.manifest.raw })),
        workspaceFolder: folder,
        trusted: true,
        configuration: {},
        globalStorageRoot: path.join(scratch, 'storage', 'global'),
        workspaceStorageRoot: path.join(scratch, 'storage', 'workspace'),
        logRoot: path.join(scratch, 'logs'),
        env: { appName: 'Code-XR IDE', appRoot: scratch, appHost: 'desktop', language: 'en', machineId: 'compat-probe', sessionId: 'compat-probe', uriScheme: 'codexr', shell: '/bin/sh', version: '0.0.0' },
        isDevelopment: false,
        documents: [],
        activeEditor: null,
    };
    const exited = new Promise<string>((resolve) => child.on('exit', (code, signal) => resolve(`The host exited (${signal ?? code}).`)));
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
        const run = async (): Promise<number> => {
            await main.request(HOST_METHODS.init, init);
            for (const event of probeEvents(extension, folder)) {
                await main.request(HOST_METHODS.activateByEvent, event);
            }
            const commands = await main.request<string[]>(HOST_METHODS.registeredCommands);
            return commands.length;
        };
        const outcome = await withTimeout(Promise.race([run(), exited.then((reason) => Promise.reject(new Error(reason)))]), timeoutMs);
        if (outcome === 'timeout') {
            return { outcome: 'timeout', missingApi, errors, registeredCommands: 0, detail: `No answer within ${timeoutMs} ms.` };
        }
        const settled = activation as HostActivationEvent | null;
        if (!settled) {
            return { outcome: 'failed', missingApi, errors, registeredCommands: outcome, detail: 'No activation event matched: the extension was never activated.' };
        }
        return { outcome: settled.state === 'active' ? 'activated' : 'failed', missingApi, errors, registeredCommands: outcome, detail: settled.error ?? null };
    } catch (error) {
        return { outcome: 'failed', missingApi, errors, registeredCommands: 0, detail: error instanceof Error ? error.message : String(error) };
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            await withTimeout(main.request(HOST_METHODS.shutdown).catch(() => undefined), 3000);
            child.kill();
            // Windows keeps the files the process opened locked until it has exited: wait, so the scratch folder can go.
            await withTimeout(exited, 5000);
        }
        main.dispose();
    }
}

function cell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** The results as the Markdown table of docs/ide/extensions-compatibility.md. */
export function probeTable(results: readonly ProbeResult[]): string {
    const rows = ['| Extension | Version | Result | Missing vscode API at start-up | Notes |', '|---|---|---|---|---|'];
    for (const result of results) {
        const name = result.id ?? path.basename(result.file);
        const notes = [
            result.engineSupported === false ? 'engine range above the IDE\'s API version' : '',
            result.registeredCommands > 0 ? `${result.registeredCommands} commands registered` : '',
            result.detail ?? '',
            result.errors.length > 0 ? `${result.errors.length} error line(s): ${result.errors[0]}` : '',
        ].filter(Boolean).join('; ');
        rows.push(`| ${cell(name)} | ${cell(result.version ?? '')} | ${result.outcome} | ${cell(result.missingApi.join(', ') || 'none')} | ${cell(notes.slice(0, 300))} |`);
    }
    return rows.join('\n');
}
