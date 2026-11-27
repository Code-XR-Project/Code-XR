import { app, BrowserWindow, clipboard, dialog, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
    activationEventsOf, HOST_METHODS, MAIN_METHODS, RpcEndpoint,
    type DialogRequest, type HostActivationEvent, type HostInitData, type HostLogLine, type HostUiEvent, type UiNotification, type UiRequest,
} from '../../shared/extensionHostProtocol.ts';
import { isProviderKind, type DiagnosticsUpdate, type ProvideRequest, type ProviderRegistration, type WorkspaceEditData } from '../../shared/extensionLanguageProtocol.ts';
import { EXTENSION_IPC_CHANNELS, EXTENSION_IPC_EVENTS, isWorkbenchActivationEvent, type ExtensionActivation, type ExtensionId } from '../../shared/extensions.ts';
import { KeyVault } from '../agents/keyVault.ts';
import { electronCipher } from '../agents/electronCipher.ts';
import { channelLog } from '../log.ts';
import { serverEnvironment } from '../lsp/lspServers.ts';
import { isOpenableExternalLink } from '../security.ts';
import { addTrustChangeListener, isWorkspaceTrusted } from '../trust/workspaceTrust.ts';
import { addFolderChangeListener, workspaceOrNull } from '../workspace/workspaceWindows.ts';
import { matchGlob } from '../../extensionHost/glob.ts';
import { parseViewRequest } from '../../shared/extensionViewsProtocol.ts';
import { DocumentMirror, FolderPaths } from './documentMirror.ts';
import { inlineTreeIcons } from './viewIcons.ts';
import { ExtensionSettingsStore } from './extensionSettings.ts';
import type { ActivationSource, ExtensionsService } from './extensionsService.ts';
import type { LoadedExtension } from './extensionStore.ts';

type Handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

const extLog = channelLog('extensions');

/** Restarts after a crash before the host is left stopped (the person can still restart it by hand). */
const MAX_CRASH_RESTARTS = 3;
const CRASH_WINDOW_MS = 5 * 60_000;
/** How long the extensions get to deactivate when a window closes or the host restarts. */
const SHUTDOWN_GRACE_MS = 3000;
/** How long `workspaceContains:` may walk the folder before giving up. */
const WORKSPACE_CONTAINS_BUDGET = 20_000;

interface HostConnection {
    readonly contents: WebContents;
    readonly child: ChildProcess;
    readonly rpc: RpcEndpoint;
    readonly activations: Map<ExtensionId, { state: ExtensionActivation; error?: string }>;
    readonly pendingUi: Map<number, (result: unknown) => void>;
    readonly ready: Promise<void>;
    stopping: boolean;
}

/**
 * The extension host of each window (#259, ADR 0002): a Node child process
 * running on Electron's own Node (`ELECTRON_RUN_AS_NODE`), started once the
 * workbench says it is ready, restarted when the folder, the installed
 * extensions or the folder's trust change, and stopped with its window.
 *
 * It only runs the extensions this window may run (`ExtensionsService.mayRun`:
 * enabled, and trusted folder or Restricted Mode support, #263). The host
 * asks the main process for what only Electron can do (clipboard, dialogs,
 * secrets, settings) and for what the person has to see (forwarded to the
 * renderer as `extensionsHostUi`).
 */
export class ExtensionHostManager implements ActivationSource {
    private readonly service: ExtensionsService;
    private readonly hostScript: string;
    private readonly isDevelopment: boolean;
    private readonly hosts = new Map<number, HostConnection>();
    /** Windows whose workbench said it is ready: only they get a host (and its UI requests). */
    private readonly readyWindows = new Set<number>();
    private readonly crashes = new Map<number, number[]>();
    /** #260: each window's editor documents, so a host that starts later gets them too. */
    private readonly mirrors = new Map<number, DocumentMirror>();
    private readonly settingsStore: ExtensionSettingsStore;
    private readonly secrets: KeyVault;
    private readonly machineId: string;
    private readonly sessionId = crypto.randomUUID();
    private nextUiId = 1;
    /** #261: tree icons read from disk, by absolute path. */
    private readonly iconCache = new Map<string, string | null>();

    constructor(options: { service: ExtensionsService; hostScript: string; isDevelopment: boolean }) {
        this.service = options.service;
        this.hostScript = options.hostScript;
        this.isDevelopment = options.isDevelopment;
        const root = this.service.store.root;
        this.settingsStore = new ExtensionSettingsStore(path.join(root, 'settings.json'));
        this.secrets = new KeyVault(path.join(root, 'secrets.json'), electronCipher());
        this.machineId = readOrCreateMachineId(path.join(root, 'machine-id'));
        this.service.setActivationSource(this);
        this.service.onDidChange(() => this.restartAll('the installed extensions changed'));
        addFolderChangeListener((contents) => {
            // The editor closes every tab of the old folder; its open events follow for the new one.
            this.mirrors.get(contents.id)?.reset();
            if (this.readyWindows.has(contents.id)) {
                void this.restart(contents, 'the folder changed');
            }
        });
        addTrustChangeListener((contents) => {
            if (isWorkspaceTrusted(contents)) {
                const connection = this.hosts.get(contents.id);
                connection?.rpc.notify(HOST_METHODS.trustChanged, true);
                // Extensions held back by Restricted Mode can run now.
                if (this.runnable(contents).length !== this.runningCount(contents)) {
                    void this.restart(contents, 'the folder is trusted now');
                }
            } else if (this.hosts.has(contents.id)) {
                void this.restart(contents, 'the folder is in Restricted Mode now');
            }
        });
    }

    /* ------------------------------ ActivationSource ------------------------------ */

    activation(contents: WebContents, id: ExtensionId): { state: ExtensionActivation; error?: string } {
        return this.hosts.get(contents.id)?.activations.get(id) ?? { state: 'inactive' };
    }

    /* ------------------------------ lifecycle ------------------------------ */

    private runnable(contents: WebContents): LoadedExtension[] {
        return this.service.enabled().filter((extension) => extension.manifest.main && this.service.mayRun(contents, extension));
    }

    private runningCount(contents: WebContents): number {
        return this.hosts.get(contents.id)?.activations.size ?? 0;
    }

    /** Starts the window's host if an extension with code may run and none is running yet. */
    async start(contents: WebContents): Promise<void> {
        if (contents.isDestroyed() || this.hosts.has(contents.id) || !this.readyWindows.has(contents.id)) {
            return;
        }
        const runnable = this.runnable(contents);
        if (runnable.length === 0) {
            return;
        }
        if (!fs.existsSync(this.hostScript)) {
            extLog.error(`The extension host is missing (${this.hostScript}); extensions with code cannot run.`);
            return;
        }
        const folder = workspaceOrNull(contents)?.root ?? null;
        const child = fork(this.hostScript, [], {
            execPath: process.execPath,
            cwd: folder ?? app.getPath('home'),
            env: serverEnvironment(process.env, { ELECTRON_RUN_AS_NODE: '1', CODEXR_EXTENSION_HOST: '1' }),
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            serialization: 'advanced',
            ...(this.isDevelopment ? { execArgv: ['--enable-source-maps'] } : {}),
        });
        const rpc = new RpcEndpoint((message) => {
            if (child.connected) {
                child.send(message);
            } else {
                throw new Error('The extension host is not connected.');
            }
        });
        let markReady: () => void = () => undefined;
        const connection: HostConnection = {
            contents,
            child,
            rpc,
            activations: new Map(runnable.map((extension) => [extension.manifest.id, { state: 'inactive' as const }])),
            pendingUi: new Map(),
            ready: new Promise<void>((resolve) => {
                markReady = resolve;
            }),
            stopping: false,
        };
        this.hosts.set(contents.id, connection);
        this.wire(connection);
        // A new host has none of the previous one's providers or diagnostics.
        this.sendUi(contents, { type: 'notify', notification: { kind: 'providersReset' } });
        child.on('message', (message) => rpc.receive(message));
        for (const stream of [child.stdout, child.stderr]) {
            if (stream) {
                readline.createInterface({ input: stream }).on('line', (line) => extLog.info(`[host] ${line}`));
            }
        }
        child.on('exit', (code, signal) => this.exited(connection, code, signal));
        child.on('error', (error) => extLog.error(`The extension host could not start: ${error.message}`));
        contents.once('destroyed', () => void this.stop(contents.id));

        try {
            await rpc.request(HOST_METHODS.init, this.initData(contents, runnable, folder));
            markReady();
            this.service.notify(contents);
            await rpc.request(HOST_METHODS.activateByEvent, '*');
            await this.fireWorkspaceContains(connection, runnable, folder);
            await rpc.request(HOST_METHODS.activateByEvent, 'onStartupFinished');
        } catch (error) {
            if (!connection.stopping) {
                extLog.error(`The extension host did not start: ${String(error)}`);
            }
        }
    }

    private initData(contents: WebContents, runnable: readonly LoadedExtension[], folder: string | null): HostInitData {
        const root = this.service.store.root;
        const enabledIds = new Set(runnable.map((extension) => extension.manifest.id));
        return {
            extensions: runnable.map((extension) => ({
                id: extension.manifest.id,
                location: extension.location,
                main: extension.manifest.main as string,
                packageJSON: extension.manifest.raw,
                activationEvents: activationEventsOf(extension.manifest.activationEvents, extension.manifest.contributes),
                extensionDependencies: extension.manifest.extensionDependencies,
            })),
            passive: this.service.enabled().filter((extension) => !enabledIds.has(extension.manifest.id)).map((extension) => ({ id: extension.manifest.id, location: extension.location, packageJSON: extension.manifest.raw })),
            workspaceFolder: folder,
            trusted: isWorkspaceTrusted(contents),
            configuration: this.settingsStore.values(),
            globalStorageRoot: path.join(root, '.storage', 'global'),
            workspaceStorageRoot: folder ? path.join(root, '.storage', 'workspace', crypto.createHash('sha256').update(folder).digest('hex').slice(0, 24)) : null,
            logRoot: path.join(root, '.logs'),
            env: {
                appName: 'Code-XR IDE',
                appRoot: app.getAppPath(),
                appHost: 'desktop',
                language: 'en',
                machineId: this.machineId,
                sessionId: this.sessionId,
                uriScheme: 'codexr',
                shell: process.platform === 'win32' ? (process.env['COMSPEC'] ?? 'cmd.exe') : (process.env['SHELL'] ?? '/bin/sh'),
                version: app.getVersion(),
            },
            isDevelopment: this.isDevelopment,
            ...(folder ? this.mirror(contents).snapshot(new FolderPaths(folder)) : { documents: [], activeEditor: null }),
        };
    }

    /** `workspaceContains:<glob or file>`: fired once per pattern that matches a file of the folder. */
    private async fireWorkspaceContains(connection: HostConnection, runnable: readonly LoadedExtension[], folder: string | null): Promise<void> {
        if (!folder) {
            return;
        }
        const patterns = new Set<string>();
        for (const extension of runnable) {
            for (const event of extension.manifest.activationEvents) {
                if (event.startsWith('workspaceContains:')) {
                    patterns.add(event.slice('workspaceContains:'.length));
                }
            }
        }
        if (patterns.size === 0) {
            return;
        }
        const pending = new Set(patterns);
        let budget = WORKSPACE_CONTAINS_BUDGET;
        const walk = (dir: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (pending.size === 0 || --budget <= 0) {
                    return;
                }
                if (entry.name === 'node_modules' || entry.name === '.git') {
                    continue;
                }
                const full = path.join(dir, entry.name);
                const relative = path.relative(folder, full).split(path.sep).join('/');
                for (const pattern of [...pending]) {
                    if (matchGlob(pattern, relative)) {
                        pending.delete(pattern);
                        void connection.rpc.request(HOST_METHODS.activateByEvent, `workspaceContains:${pattern}`).catch(() => undefined);
                    }
                }
                if (entry.isDirectory()) {
                    walk(full);
                }
            }
        };
        walk(folder);
    }

    async stop(contentsId: number): Promise<void> {
        const connection = this.hosts.get(contentsId);
        if (!connection) {
            return;
        }
        connection.stopping = true;
        this.hosts.delete(contentsId);
        const exited = new Promise<void>((resolve) => {
            if (connection.child.exitCode !== null || connection.child.signalCode !== null) {
                resolve();
            } else {
                connection.child.once('exit', () => resolve());
            }
        });
        await Promise.race([connection.rpc.request(HOST_METHODS.shutdown).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))]);
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
        if (connection.child.exitCode === null && connection.child.signalCode === null) {
            connection.child.kill();
        }
        connection.rpc.dispose();
        for (const resolve of connection.pendingUi.values()) {
            resolve(null);
        }
        if (!connection.contents.isDestroyed()) {
            this.sendUi(connection.contents, { type: 'notify', notification: { kind: 'providersReset' } });
        }
    }

    async restart(contents: WebContents, reason: string): Promise<void> {
        if (contents.isDestroyed()) {
            return;
        }
        const had = this.hosts.has(contents.id);
        await this.stop(contents.id);
        if (had) {
            extLog.info(`Restarting the extension host: ${reason}.`);
        }
        this.service.notify(contents);
        await this.start(contents);
    }

    private restartAll(reason: string): void {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed() && this.readyWindows.has(win.webContents.id)) {
                void this.restart(win.webContents, reason);
            }
        }
    }

    private mirror(contents: WebContents): DocumentMirror {
        let mirror = this.mirrors.get(contents.id);
        if (!mirror) {
            mirror = new DocumentMirror();
            this.mirrors.set(contents.id, mirror);
            contents.once('destroyed', () => this.mirrors.delete(contents.id));
        }
        return mirror;
    }

    private folderPaths(contents: WebContents): FolderPaths | null {
        const root = workspaceOrNull(contents)?.root;
        return root ? new FolderPaths(root) : null;
    }

    private exited(connection: HostConnection, code: number | null, signal: string | null): void {
        connection.rpc.dispose();
        this.sendUi(connection.contents, { type: 'notify', notification: { kind: 'providersReset' } });
        for (const resolve of connection.pendingUi.values()) {
            resolve(null);
        }
        if (connection.stopping || this.hosts.get(connection.contents.id) !== connection) {
            return;
        }
        this.hosts.delete(connection.contents.id);
        const reason = signal ? `signal ${signal}` : `exit code ${code ?? '?'}`;
        extLog.error(`The extension host stopped unexpectedly (${reason}).`);
        const contents = connection.contents;
        if (contents.isDestroyed()) {
            return;
        }
        const now = Date.now();
        const recent = (this.crashes.get(contents.id) ?? []).filter((time) => now - time < CRASH_WINDOW_MS);
        recent.push(now);
        this.crashes.set(contents.id, recent);
        if (recent.length <= MAX_CRASH_RESTARTS) {
            void this.start(contents);
        } else {
            this.sendUi(contents, { type: 'notify', notification: { kind: 'hostStopped', reason: `The extension host stopped ${recent.length} times in five minutes (${reason}); it was not restarted.` } });
            this.service.notify(contents);
        }
    }

    /* ------------------------------ host -> main ------------------------------ */

    private sendUi(contents: WebContents, event: HostUiEvent): void {
        if (!contents.isDestroyed()) {
            contents.send(EXTENSION_IPC_EVENTS.extensionsHostUi, event);
        }
    }

    private askRenderer(connection: HostConnection, request: UiRequest): Promise<unknown> {
        const id = this.nextUiId++;
        return new Promise((resolve) => {
            connection.pendingUi.set(id, resolve);
            this.sendUi(connection.contents, { type: 'request', id, request });
        });
    }

    private wire(connection: HostConnection): void {
        const { rpc, contents } = connection;
        const ownerWindow = (): BrowserWindow | null => BrowserWindow.fromWebContents(contents);
        rpc.handle(MAIN_METHODS.log, (line) => {
            const { level, extensionId, channel, message } = line as HostLogLine;
            const prefix = `${extensionId ? `[${extensionId}]` : '[host]'}${channel ? ` [${channel}]` : ''}`;
            const text = `${prefix} ${message}`;
            if (level === 'error') {
                extLog.error(text);
            } else if (level === 'warn') {
                extLog.warn(text);
            } else {
                extLog.info(text);
            }
        });
        rpc.handle(MAIN_METHODS.notImplemented, (extensionId, api) => {
            extLog.warn(`[${String(extensionId)}] uses vscode.${String(api)}, which the Code-XR IDE does not implement yet; that part of the extension will not work.`);
        });
        rpc.handle(MAIN_METHODS.activation, (event) => {
            const { id, state, error } = event as HostActivationEvent;
            connection.activations.set(id, { state, ...(error !== undefined ? { error } : {}) });
            this.service.notify(contents);
        });
        rpc.handle(MAIN_METHODS.executeWorkbenchCommand, (id, args) => this.askRenderer(connection, { kind: 'command', id: String(id), args: Array.isArray(args) ? args : [] }));
        rpc.handle(MAIN_METHODS.updateConfiguration, async (key, value) => {
            if (typeof key !== 'string' || key.length > 300) {
                throw new Error('Invalid setting key.');
            }
            this.settingsStore.update(key, value === null ? undefined : value);
            this.broadcastConfiguration();
        });
        rpc.handle(MAIN_METHODS.secretGet, (extensionId, key) => this.secrets.get(`${String(extensionId)}/${String(key)}`) ?? null);
        rpc.handle(MAIN_METHODS.secretStore, async (extensionId, key, value) => {
            await this.secrets.set(`${String(extensionId)}/${String(key)}`, String(value));
        });
        rpc.handle(MAIN_METHODS.secretDelete, async (extensionId, key) => {
            await this.secrets.delete(`${String(extensionId)}/${String(key)}`);
        });
        rpc.handle(MAIN_METHODS.clipboardRead, () => clipboard.readText());
        rpc.handle(MAIN_METHODS.clipboardWrite, (text) => clipboard.writeText(String(text)));
        rpc.handle(MAIN_METHODS.openExternal, async (url) => {
            if (!isOpenableExternalLink(url)) {
                extLog.warn(`An extension asked to open ${String(url)}; only http, https and mailto links open outside the IDE.`);
                return false;
            }
            await shell.openExternal(url);
            return true;
        });
        rpc.handle(MAIN_METHODS.showDialog, async (raw) => {
            const request = raw as DialogRequest;
            const win = ownerWindow();
            const filters = Object.entries(request.filters ?? {}).map(([name, extensions]) => ({ name, extensions: [...extensions] }));
            if (request.kind === 'save') {
                const options = { ...(request.title ? { title: request.title } : {}), ...(request.defaultPath ? { defaultPath: request.defaultPath } : {}), ...(request.openLabel ? { buttonLabel: request.openLabel } : {}), filters };
                const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
                return result.canceled || !result.filePath ? null : [result.filePath];
            }
            const properties: ('openFile' | 'openDirectory' | 'multiSelections')[] = [];
            if (request.canSelectFiles !== false) {
                properties.push('openFile');
            }
            if (request.canSelectFolders) {
                properties.push('openDirectory');
            }
            if (request.canSelectMany) {
                properties.push('multiSelections');
            }
            const options = { ...(request.title ? { title: request.title } : {}), ...(request.defaultPath ? { defaultPath: request.defaultPath } : {}), ...(request.openLabel ? { buttonLabel: request.openLabel } : {}), filters, properties };
            const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
            return result.canceled ? null : result.filePaths;
        });
        rpc.handle(MAIN_METHODS.ui, async (raw) => {
            const request = raw as UiRequest;
            if (request.kind === 'message' && request.modal) {
                // A modal message is a native dialog, as in VS Code: it must be answered before anything else.
                const win = ownerWindow();
                const buttons = [...request.items, 'Cancel'];
                const options = { type: request.severity === 'info' ? 'info' as const : request.severity, message: request.message, ...(request.detail ? { detail: request.detail } : {}), buttons, cancelId: buttons.length - 1, defaultId: 0, noLink: true, title: request.extensionId };
                const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
                return response < request.items.length ? response : null;
            }
            if (request.kind === 'applyEdit') {
                // Every file of the edit must be in the folder, or none of it is applied.
                const paths = this.folderPaths(contents);
                const edits = request.edit.edits;
                const relative = paths ? edits.map((entry) => ({ path: paths.toWorkspace(entry.path), edits: entry.edits })) : [];
                if (!paths || relative.some((entry) => entry.path === null)) {
                    extLog.warn('An extension tried to edit a file outside the folder; the edit was not applied.');
                    return false;
                }
                const edit: WorkspaceEditData = { edits: relative as { path: string; edits: WorkspaceEditData['edits'][number]['edits'] }[] };
                return this.askRenderer(connection, { kind: 'applyEdit', edit });
            }
            if (request.kind === 'saveFile' || request.kind === 'insertSnippet') {
                const workspacePath = this.folderPaths(contents)?.toWorkspace(request.path) ?? null;
                return workspacePath === null ? false : this.askRenderer(connection, { ...request, path: workspacePath });
            }
            if (request.kind === 'openFile') {
                const folder = workspaceOrNull(contents)?.root;
                if (!folder || !(request.path === folder || request.path.startsWith(folder + path.sep))) {
                    extLog.warn(`An extension asked to open ${request.path}, which is outside the folder; the IDE only opens files of the open folder.`);
                    return null;
                }
                return this.askRenderer(connection, { ...request, path: path.relative(folder, request.path).split(path.sep).join('/') });
            }
            return this.askRenderer(connection, request);
        });
        rpc.handle(MAIN_METHODS.uiNotify, (notification) => this.sendUi(contents, { type: 'notify', notification: notification as UiNotification }));
        rpc.handle(MAIN_METHODS.diagnostics, (raw) => {
            const paths = this.folderPaths(contents);
            const update = raw as DiagnosticsUpdate;
            if (!paths || typeof update?.owner !== 'string') {
                return;
            }
            this.sendUi(contents, { type: 'notify', notification: { kind: 'diagnostics', update: paths.outward(update) as DiagnosticsUpdate } });
        });
        rpc.handle(MAIN_METHODS.registerProvider, (raw) => {
            const registration = raw as ProviderRegistration;
            if (typeof registration?.handle === 'number' && isProviderKind(registration.kind)) {
                this.sendUi(contents, { type: 'notify', notification: { kind: 'providerRegistered', registration } });
            }
        });
        rpc.handle(MAIN_METHODS.unregisterProvider, (handle) => {
            if (typeof handle === 'number') {
                this.sendUi(contents, { type: 'notify', notification: { kind: 'providerUnregistered', handle } });
            }
        });
    }

    private broadcastConfiguration(): void {
        const values = this.settingsStore.values();
        for (const connection of this.hosts.values()) {
            connection.rpc.notify(HOST_METHODS.configurationChanged, values);
        }
    }

    /* ------------------------------ renderer -> main ------------------------------ */

    register(handle: Handle): void {
        handle(EXTENSION_IPC_CHANNELS.extensionsHostReady, (event) => {
            const contents = event.sender;
            if (!this.readyWindows.has(contents.id)) {
                this.readyWindows.add(contents.id);
                contents.once('destroyed', () => this.readyWindows.delete(contents.id));
            }
            // A reload of the page: the old host answered a renderer that is gone.
            return this.hosts.has(contents.id) ? this.restart(contents, 'the window reloaded') : this.start(contents);
        });
        handle(EXTENSION_IPC_CHANNELS.extensionsRestartHost, (event) => {
            this.crashes.delete(event.sender.id);
            return this.restart(event.sender, 'asked from the workbench');
        });
        handle(EXTENSION_IPC_CHANNELS.extensionsExecuteCommand, async (event, id, args) => {
            if (typeof id !== 'string' || id.length > 300) {
                throw new Error('Invalid command id.');
            }
            let connection = this.hosts.get(event.sender.id);
            if (!connection) {
                await this.start(event.sender);
                connection = this.hosts.get(event.sender.id);
            }
            if (!connection) {
                throw new Error(`command '${id}' not found: no extension that may run in this folder provides it.`);
            }
            await connection.ready;
            return connection.rpc.request(HOST_METHODS.executeCommand, id, Array.isArray(args) ? args : []);
        });
        handle(EXTENSION_IPC_CHANNELS.extensionsActivateByEvent, async (event, activationEvent) => {
            if (!isWorkbenchActivationEvent(activationEvent)) {
                throw new Error('Invalid activation event.');
            }
            const connection = this.hosts.get(event.sender.id);
            if (connection) {
                await connection.ready;
                await connection.rpc.request(HOST_METHODS.activateByEvent, activationEvent);
            }
        });
        handle(EXTENSION_IPC_CHANNELS.extensionsDocuments, (event, events) => {
            const paths = this.folderPaths(event.sender);
            if (!paths) {
                return;
            }
            const accepted = this.mirror(event.sender).accept(events, paths);
            // Forwarded at once, so the host has a change before any request the renderer sends after it.
            if (accepted.length > 0) {
                this.hosts.get(event.sender.id)?.rpc.notify(HOST_METHODS.documents, accepted);
            }
        });
        handle(EXTENSION_IPC_CHANNELS.extensionsProvide, async (event, raw) => {
            const request = raw as ProvideRequest;
            const paths = this.folderPaths(event.sender);
            const connection = this.hosts.get(event.sender.id);
            const kindOk = isProviderKind(request?.kind) || request?.kind === 'resolveCompletion' || request?.kind === 'resolveCodeLens' || request?.kind === 'prepareRename';
            if (!paths || !connection || !kindOk || typeof request.handle !== 'number' || typeof request.args !== 'object' || request.args === null) {
                return null;
            }
            const inward: ProvideRequest = { handle: request.handle, kind: request.kind, path: paths.toAbsolute(request.path), args: paths.inward(request.args) as ProvideRequest['args'] };
            await connection.ready;
            const result = await connection.rpc.request(HOST_METHODS.provide, inward);
            return paths.outward(result);
        });
        handle(EXTENSION_IPC_CHANNELS.extensionsView, async (event, raw) => {
            const request = parseViewRequest(raw);
            const connection = this.hosts.get(event.sender.id);
            if (!request || !connection) {
                return null;
            }
            await connection.ready;
            const result = await connection.rpc.request(HOST_METHODS.view, request);
            if (request.kind !== 'treeChildren') {
                return null;
            }
            // Icons first (their files lie outside the folder, where `outward` would drop them), then the resources.
            const paths = this.folderPaths(event.sender);
            const roots = [...this.service.enabled().map((extension) => extension.location), ...(paths ? [paths.root] : [])];
            const inlined = inlineTreeIcons(result, roots, this.iconCache);
            return paths ? paths.outward(inlined) : stripResources(inlined);
        });
        handle(EXTENSION_IPC_CHANNELS.extensionsHostReply, (event, id, result) => {
            const connection = this.hosts.get(event.sender.id);
            const resolve = typeof id === 'number' ? connection?.pendingUi.get(id) : undefined;
            if (connection && resolve && typeof id === 'number') {
                connection.pendingUi.delete(id);
                resolve(result ?? null);
            }
        });
    }

    /** Stops every host (the app is quitting). */
    async stopAll(): Promise<void> {
        await Promise.all([...this.hosts.keys()].map((id) => this.stop(id)));
    }
}

/** Without a folder no resource has a workspace path: keep only their names. */
function stripResources(result: unknown): unknown {
    if (typeof result !== 'object' || result === null || !Array.isArray((result as { items?: unknown }).items)) {
        return result;
    }
    return { ...(result as object), items: (result as { items: Record<string, unknown>[] }).items.map((item) => ({ ...item, resource: null })) };
}

function readOrCreateMachineId(file: string): string {
    // A random id per installation, never derived from the hardware: extensions get a stable id, not a fingerprint.
    try {
        const existing = fs.readFileSync(file, 'utf8').trim();
        if (/^[0-9a-f]{64}$/.test(existing)) {
            return existing;
        }
    } catch {
        // First run.
    }
    const id = crypto.randomBytes(32).toString('hex');
    try {
        fs.writeFileSync(file, id);
    } catch {
        // Read-only folder: a new id each run.
    }
    return id;
}
