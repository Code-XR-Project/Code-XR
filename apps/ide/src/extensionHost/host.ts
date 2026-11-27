import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import {
    activationMatches, MAIN_METHODS, type HostActivationEvent, type HostExtensionDescription, type HostInitData, type HostLogLine, type HostPassiveExtension, type RpcEndpoint, type UiNotification, type UiRequest,
} from '../shared/extensionHostProtocol.ts';
import type { ExtensionActivation, ExtensionId } from '../shared/extensions.ts';
import { createVscodeApi } from './api.ts';
import { DocumentsAndEditors } from './documents.ts';
import { LanguageFeatures } from './languageFeatures.ts';
import { ConfigurationModel } from './configuration.ts';
import { FileMemento } from './memento.ts';
import type { TextDocumentModel } from './textDocument.ts';
import { BUILTIN_LANGUAGES } from './textDocument.ts';
import { Disposable, EventEmitter, Uri } from './types.ts';
import { TreeViews } from './treeViews.ts';
import { fromWire, toWire } from './wire.ts';

/**
 * The extension host (#259, ADR 0002): runs the extensions' code in its own
 * Node process, one per window, never in the renderer. It
 *
 * - answers `require('vscode')` with an API object made for the extension
 *   that asks (so every call knows who made it);
 * - activates each extension on its activation events, after the
 *   extensions it depends on, and deactivates them all on shutdown;
 * - keeps the commands the extensions register and runs them for the
 *   workbench, and forwards what the workbench must show to the main process.
 *
 * Nothing here trusts the extensions: they run with the rights of the IDE's
 * user (as in VS Code), which is why the main process only starts this host
 * in a trusted folder unless every extension supports Restricted Mode (#263).
 */

export interface ExtensionRecord {
    readonly description: HostExtensionDescription;
    state: ExtensionActivation;
    error?: string;
    exports: unknown;
    activation: Promise<void> | null;
    module: { activate?: (context: unknown) => unknown; deactivate?: () => unknown } | null;
    context: ExtensionContextImpl | null;
    api: unknown;
}

export interface ExtensionContextImpl {
    readonly subscriptions: { dispose(): unknown }[];
    readonly globalState: FileMemento;
    readonly workspaceState: FileMemento;
}

interface RegisteredCommand {
    readonly callback: (...args: unknown[]) => unknown;
    readonly thisArg: unknown;
    readonly extensionId: ExtensionId;
}

type ModuleWithLoad = typeof Module & { _load(request: string, parent: { filename?: string } | null | undefined, isMain: boolean): unknown };

export class ExtensionHost {
    readonly rpc: RpcEndpoint;
    data!: HostInitData;
    readonly records = new Map<ExtensionId, ExtensionRecord>();
    passive: readonly HostPassiveExtension[] = [];
    readonly commands = new Map<string, RegisteredCommand>();
    readonly configuration: ConfigurationModel;
    readonly documents = new Map<string, TextDocumentModel>();
    /** Language id by file extension (`.toml` -> `toml`) and by file name. */
    readonly languagesByExtension = new Map<string, string>(Object.entries(BUILTIN_LANGUAGES));
    readonly languagesByName = new Map<string, string>();
    readonly onDidChangeConfiguration = new EventEmitter<{ affectsConfiguration(section: string, scope?: unknown): boolean }>();
    readonly onDidGrantWorkspaceTrust = new EventEmitter<void>();
    readonly onDidChangeExtensions = new EventEmitter<void>();
    readonly contentProviders = new Map<string, { provideTextDocumentContent(uri: Uri, token: unknown): unknown }>();
    /** #260: the editor's documents and active editor, and the extensions' language features. */
    readonly documentsAndEditors: DocumentsAndEditors;
    readonly languageFeatures: LanguageFeatures;
    /** #261: the extensions' tree views. */
    readonly treeViews: TreeViews;
    private readonly reported = new Set<string>();
    private readonly firedEvents = new Set<string>();
    private moduleHooked = false;
    private sequence = 0;
    trusted = false;

    constructor(rpc: RpcEndpoint) {
        this.rpc = rpc;
        this.documentsAndEditors = new DocumentsAndEditors(this);
        this.languageFeatures = new LanguageFeatures(this);
        this.treeViews = new TreeViews(this);
        this.configuration = new ConfigurationModel((key, value, target) => this.rpc.request(MAIN_METHODS.updateConfiguration, key, toWire(value), target).then(() => undefined));
    }

    init(data: HostInitData): void {
        this.data = data;
        this.trusted = data.trusted;
        this.passive = data.passive;
        for (const description of data.extensions) {
            this.records.set(description.id, { description, state: 'inactive', exports: undefined, activation: null, module: null, context: null, api: null });
        }
        this.configuration.setDefaults([...data.extensions.map((ext) => ext.packageJSON), ...data.passive.map((ext) => ext.packageJSON)].map((json) => (typeof json['contributes'] === 'object' && json['contributes'] !== null ? json['contributes'] as Record<string, unknown> : {})));
        this.configuration.setUserValues(data.configuration);
        for (const json of [...data.extensions, ...data.passive].map((ext) => ext.packageJSON)) {
            this.learnLanguages(json);
        }
        this.hookRequire();
        // The editor's state before any extension activates, so `*` extensions see the open files.
        this.documentsAndEditors.accept([
            ...(data.documents ?? []).map((document) => ({ kind: 'open' as const, ...document })),
            { kind: 'editor' as const, editor: data.activeEditor ?? null },
        ]);
        this.log({ level: 'info', extensionId: null, message: `Extension host started (pid ${process.pid}) with ${data.extensions.length} extension(s) with code.` });
    }

    private learnLanguages(json: Readonly<Record<string, unknown>>): void {
        const contributes = json['contributes'];
        const languages = typeof contributes === 'object' && contributes !== null ? (contributes as Record<string, unknown>)['languages'] : undefined;
        if (!Array.isArray(languages)) {
            return;
        }
        for (const language of languages as unknown[]) {
            if (typeof language !== 'object' || language === null) {
                continue;
            }
            const { id, extensions, filenames } = language as Record<string, unknown>;
            if (typeof id !== 'string') {
                continue;
            }
            for (const extension of Array.isArray(extensions) ? extensions : []) {
                if (typeof extension === 'string') {
                    this.languagesByExtension.set(extension.toLowerCase(), id);
                }
            }
            for (const name of Array.isArray(filenames) ? filenames : []) {
                if (typeof name === 'string') {
                    this.languagesByName.set(name.toLowerCase(), id);
                }
            }
        }
    }

    languageOf(file: string): string {
        const base = path.basename(file).toLowerCase();
        const byName = this.languagesByName.get(base);
        if (byName) {
            return byName;
        }
        // Longest extension first: `.d.ts` before `.ts`.
        const dots = [...base.matchAll(/\./g)].map((match) => match.index);
        for (const dot of dots) {
            const language = this.languagesByExtension.get(base.slice(dot));
            if (language) {
                return language;
            }
        }
        return 'plaintext';
    }

    allLanguages(): string[] {
        return [...new Set([...this.languagesByExtension.values(), ...this.languagesByName.values(), 'plaintext'])].sort();
    }

    /* ------------------------------ logging ------------------------------ */

    log(line: HostLogLine): void {
        this.rpc.notify(MAIN_METHODS.log, line);
    }

    /** An extension used API the host does not implement: said once per extension and name. */
    reportMissing(extensionId: ExtensionId, api: string): void {
        const key = `${extensionId}\u0000${api}`;
        if (this.reported.has(key)) {
            return;
        }
        this.reported.add(key);
        this.rpc.notify(MAIN_METHODS.notImplemented, extensionId, api);
    }

    nextKey(extensionId: ExtensionId): string {
        return `${extensionId}/${++this.sequence}`;
    }

    ui(request: UiRequest): Promise<unknown> {
        return this.rpc.request(MAIN_METHODS.ui, request);
    }

    uiNotify(notification: UiNotification): void {
        this.rpc.notify(MAIN_METHODS.uiNotify, toWire(notification));
    }

    /* ------------------------------ require('vscode') ------------------------------ */

    /** The extension a file belongs to: the one whose folder holds it (the deepest, for nested folders). */
    extensionOfFile(file: string | undefined): ExtensionRecord | undefined {
        if (!file) {
            return undefined;
        }
        let best: ExtensionRecord | undefined;
        for (const record of this.records.values()) {
            const location = record.description.location;
            if ((file === location || file.startsWith(location + path.sep)) && (!best || location.length > best.description.location.length)) {
                best = record;
            }
        }
        return best;
    }

    apiFor(record: ExtensionRecord): unknown {
        record.api ??= createVscodeApi(record, this);
        return record.api;
    }

    private hookRequire(): void {
        if (this.moduleHooked) {
            return;
        }
        this.moduleHooked = true;
        const loader = Module as ModuleWithLoad;
        const original = loader._load.bind(loader);
        loader._load = (request, parent, isMain) => {
            if (request === 'vscode') {
                const record = this.extensionOfFile(parent?.filename);
                if (!record) {
                    // Code outside every extension (a shared dependency hoisted elsewhere): the first extension's view is the best guess.
                    const first = this.records.values().next().value;
                    if (!first) {
                        throw new Error('Cannot find module \'vscode\'');
                    }
                    return this.apiFor(first);
                }
                return this.apiFor(record);
            }
            return original(request, parent, isMain);
        };
    }

    /* ------------------------------ activation ------------------------------ */

    private setState(record: ExtensionRecord, state: ExtensionActivation, error?: string): void {
        record.state = state;
        if (error === undefined) {
            delete record.error;
        } else {
            record.error = error;
        }
        const event: HostActivationEvent = { id: record.description.id, state, ...(error !== undefined ? { error } : {}) };
        this.rpc.notify(MAIN_METHODS.activation, event);
    }

    /** Activates every extension listening for `event`; resolves when they have all settled. */
    async activateByEvent(event: string): Promise<void> {
        this.firedEvents.add(event);
        const waiting: Promise<void>[] = [];
        for (const record of this.records.values()) {
            if (record.state === 'inactive' && activationMatches(record.description.activationEvents, event)) {
                waiting.push(this.activate(record.description.id));
            }
        }
        await Promise.all(waiting);
    }

    /** Whether an event fired already (`*`, `onStartupFinished`, `workspaceContains:`): late activations replay them. */
    hasFired(event: string): boolean {
        return this.firedEvents.has(event);
    }

    activate(id: ExtensionId, chain: readonly ExtensionId[] = []): Promise<void> {
        const record = this.records.get(id);
        if (!record) {
            return Promise.resolve();
        }
        record.activation ??= this.doActivate(record, [...chain, id]);
        return record.activation;
    }

    private async doActivate(record: ExtensionRecord, chain: readonly ExtensionId[]): Promise<void> {
        const { description } = record;
        for (const dependency of description.extensionDependencies) {
            if (chain.includes(dependency)) {
                continue; // a cycle: VS Code refuses it too; activate what we can
            }
            if (this.records.has(dependency)) {
                await this.activate(dependency, chain);
                const dependencyRecord = this.records.get(dependency);
                if (dependencyRecord?.state === 'failed') {
                    this.setState(record, 'failed', `Its dependency ${dependency} failed to activate.`);
                    return;
                }
            } else if (!this.passive.some((passive) => passive.id === dependency)) {
                this.log({ level: 'warn', extensionId: description.id, message: `Depends on ${dependency}, which is not installed or not enabled.` });
            }
        }
        this.setState(record, 'activating');
        const started = Date.now();
        try {
            const entry = this.resolveMain(description);
            const loaded = Module.createRequire(entry)(entry) as ExtensionRecord['module'];
            record.module = loaded ?? {};
            record.context = this.createContext(record);
            const result = typeof record.module.activate === 'function' ? await record.module.activate.call(record.module, record.context) : undefined;
            record.exports = result;
            this.setState(record, 'active');
            this.log({ level: 'info', extensionId: description.id, message: `Activated in ${Date.now() - started} ms.` });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.setState(record, 'failed', message);
            this.log({ level: 'error', extensionId: description.id, message: `Failed to activate: ${error instanceof Error && error.stack ? error.stack : message}` });
        }
    }

    private resolveMain(description: HostExtensionDescription): string {
        const base = path.resolve(description.location, description.main);
        for (const candidate of [base, `${base}.js`, `${base}.cjs`, path.join(base, 'index.js')]) {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                const real = fs.realpathSync(candidate);
                const root = fs.realpathSync(description.location);
                if (real !== root && !real.startsWith(root + path.sep)) {
                    throw new Error(`Its main file (${description.main}) is outside the extension's folder.`);
                }
                return real;
            }
        }
        throw new Error(`Its main file (${description.main}) does not exist.`);
    }

    private storageFolder(root: string | null, id: ExtensionId): string | null {
        return root ? path.join(root, id) : null;
    }

    private createContext(record: ExtensionRecord): ExtensionContextImpl {
        const { description } = record;
        const globalStorage = this.storageFolder(this.data.globalStorageRoot, description.id) as string;
        const workspaceStorage = this.storageFolder(this.data.workspaceStorageRoot, description.id);
        const logFolder = path.join(this.data.logRoot, description.id);
        const globalState = new FileMemento(path.join(globalStorage, 'state.json'));
        const workspaceState = new FileMemento(workspaceStorage ? path.join(workspaceStorage, 'state.json') : null);
        const secretsChanged = new EventEmitter<{ key: string }>();
        const subscriptions: { dispose(): unknown }[] = [];
        const extensionUri = Uri.file(description.location);
        const host = this;
        const variables = new Map<string, { value: string; type: number; options: unknown }>();
        const environmentVariableCollection = {
            persistent: true,
            description: undefined as unknown,
            replace: (variable: string, value: string, options?: unknown) => variables.set(variable, { value, type: 1, options }),
            append: (variable: string, value: string, options?: unknown) => variables.set(variable, { value, type: 2, options }),
            prepend: (variable: string, value: string, options?: unknown) => variables.set(variable, { value, type: 3, options }),
            get: (variable: string) => variables.get(variable),
            forEach: (callback: (variable: string, mutator: unknown, collection: unknown) => void) => variables.forEach((mutator, variable) => callback(variable, mutator, environmentVariableCollection)),
            delete: (variable: string) => variables.delete(variable),
            clear: () => variables.clear(),
            getScoped: () => environmentVariableCollection,
            [Symbol.iterator]: function* iterate() {
                yield* [...variables.entries()];
            },
        };
        const context = {
            subscriptions,
            globalState,
            workspaceState,
            secrets: {
                get: (key: string) => host.rpc.request<string | null>(MAIN_METHODS.secretGet, description.id, key).then((value) => value ?? undefined),
                store: async (key: string, value: string) => {
                    await host.rpc.request(MAIN_METHODS.secretStore, description.id, key, value);
                    secretsChanged.fire({ key });
                },
                delete: async (key: string) => {
                    await host.rpc.request(MAIN_METHODS.secretDelete, description.id, key);
                    secretsChanged.fire({ key });
                },
                keys: () => Promise.resolve([] as string[]),
                onDidChange: secretsChanged.event,
            },
            extensionUri,
            extensionPath: description.location,
            asAbsolutePath: (relative: string) => path.join(description.location, relative),
            storageUri: workspaceStorage ? Uri.file(workspaceStorage) : undefined,
            storagePath: workspaceStorage ?? undefined,
            globalStorageUri: Uri.file(globalStorage),
            globalStoragePath: globalStorage,
            logUri: Uri.file(logFolder),
            logPath: logFolder,
            extensionMode: 1, // ExtensionMode.Production
            environmentVariableCollection,
            extension: this.extensionObject(description.id),
            languageModelAccessInformation: { onDidChange: new EventEmitter<void>().event, canSendRequest: () => undefined },
        };
        return context;
    }

    /** `vscode.Extension` for an id (with code or not). */
    extensionObject(id: ExtensionId): unknown {
        const record = this.records.get(id.toLowerCase());
        const passive = this.passive.find((extension) => extension.id === id.toLowerCase());
        const location = record?.description.location ?? passive?.location;
        const packageJSON = record?.description.packageJSON ?? passive?.packageJSON;
        if (!location || !packageJSON) {
            return undefined;
        }
        const host = this;
        const json = packageJSON;
        return {
            id: `${String(json['publisher'] ?? '')}.${String(json['name'] ?? '')}`,
            extensionUri: Uri.file(location),
            extensionPath: location,
            packageJSON: json,
            extensionKind: 2, // ExtensionKind.Workspace
            get isActive() {
                return record ? record.state === 'active' : true;
            },
            get exports() {
                return record?.exports;
            },
            activate: async () => {
                if (record) {
                    await host.activate(record.description.id);
                    return record.exports;
                }
                return undefined;
            },
        };
    }

    /* ------------------------------ commands ------------------------------ */

    registerCommand(extensionId: ExtensionId, id: string, callback: (...args: unknown[]) => unknown, thisArg?: unknown): Disposable {
        if (typeof id !== 'string' || id.trim() === '') {
            throw new Error('Invalid command id');
        }
        if (this.commands.has(id)) {
            throw new Error(`command '${id}' already exists`);
        }
        const entry: RegisteredCommand = { callback, thisArg, extensionId };
        this.commands.set(id, entry);
        return new Disposable(() => {
            if (this.commands.get(id) === entry) {
                this.commands.delete(id);
            }
        });
    }

    /** Runs a command for an extension: its own registered ones, the built-in `vscode` ones, then the workbench's. */
    async executeCommand(id: string, args: readonly unknown[]): Promise<unknown> {
        const builtin = await this.builtinCommand(id, args);
        if (builtin.handled) {
            return builtin.result;
        }
        if (!this.commands.has(id)) {
            await this.activateByEvent(`onCommand:${id}`);
        }
        const command = this.commands.get(id);
        if (command) {
            return command.callback.apply(command.thisArg, [...args]);
        }
        const result = await this.rpc.request(MAIN_METHODS.executeWorkbenchCommand, id, toWire(args));
        return fromWire(result);
    }

    /** The `vscode.*` commands the host answers itself (`setContext`, `vscode.open`, ...). */
    private async builtinCommand(id: string, args: readonly unknown[]): Promise<{ handled: boolean; result?: unknown }> {
        switch (id) {
            case 'setContext':
                this.uiNotify({ kind: 'contextKey', key: String(args[0]), value: toWire(args[1]) });
                return { handled: true };
            case 'vscode.open':
            case 'vscode.openWith': {
                const target = args[0] instanceof Uri ? args[0] : typeof args[0] === 'string' ? Uri.parse(args[0]) : null;
                if (!target) {
                    throw new Error('vscode.open needs a Uri');
                }
                if (target.scheme === 'http' || target.scheme === 'https' || target.scheme === 'mailto') {
                    await this.rpc.request(MAIN_METHODS.openExternal, target.toString(true));
                } else if (target.scheme === 'file') {
                    const options = args[1] as { selection?: { start?: { line?: number; character?: number } } } | undefined;
                    const start = options?.selection?.start;
                    await this.ui({ kind: 'openFile', path: target.fsPath, preview: true, ...(typeof start?.line === 'number' ? { line: start.line + 1, column: (start.character ?? 0) + 1 } : {}) });
                } else {
                    throw new Error(`vscode.open cannot open ${target.scheme}: URIs in the Code-XR IDE yet`);
                }
                return { handled: true };
            }
            case 'vscode.openFolder':
                throw new Error('Opening another folder from an extension is not supported; use File > Open Folder.');
            case 'workbench.action.openWalkthrough':
            case 'workbench.action.focusActiveEditorGroup':
                return { handled: true };
            default:
                return { handled: false };
        }
    }

    /** The workbench runs an extension's command (the palette, a status bar item, a key). */
    async executeFromWorkbench(id: string, args: readonly unknown[]): Promise<unknown> {
        if (!this.commands.has(id)) {
            await this.activateByEvent(`onCommand:${id}`);
        }
        const command = this.commands.get(id);
        if (!command) {
            // #260: a code action or lens may run a built-in `vscode.*` command (never a workbench one: that would loop back).
            const builtin = await this.builtinCommand(id, fromWire(args) as unknown[]);
            if (builtin.handled) {
                return toWire(builtin.result);
            }
            throw new Error(`command '${id}' not found`);
        }
        const result: unknown = await command.callback.apply(command.thisArg, (fromWire(args) as unknown[]));
        return toWire(result);
    }

    /* ------------------------------ configuration, trust ------------------------------ */

    configurationChanged(values: Readonly<Record<string, unknown>>): void {
        const changed = this.configuration.setUserValues(values);
        if (changed.length > 0) {
            this.onDidChangeConfiguration.fire({ affectsConfiguration: (section: string) => changed.some((key) => ConfigurationModel.affects(key, section)) });
        }
    }

    trustChanged(trusted: boolean): void {
        if (trusted && !this.trusted) {
            this.trusted = true;
            this.onDidGrantWorkspaceTrust.fire();
        }
    }

    /* ------------------------------ shutdown ------------------------------ */

    async shutdown(): Promise<void> {
        const active = [...this.records.values()].filter((record) => record.state === 'active' || record.state === 'activating');
        await Promise.all(active.map(async (record) => {
            try {
                const result = record.module?.deactivate?.();
                if (result instanceof Promise) {
                    await Promise.race([result, new Promise((resolve) => setTimeout(resolve, 5000))]);
                }
            } catch (error) {
                this.log({ level: 'warn', extensionId: record.description.id, message: `deactivate() failed: ${String(error)}` });
            }
            for (const subscription of record.context?.subscriptions ?? []) {
                try {
                    subscription?.dispose();
                } catch {
                    // Keep disposing.
                }
            }
            record.context?.globalState.flush();
            record.context?.workspaceState.flush();
        }));
    }
}
