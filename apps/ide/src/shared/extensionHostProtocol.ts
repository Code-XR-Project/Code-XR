/**
 * The extension host (#259, ADR 0002): the messages between the main process
 * and the host process that runs the extensions' code, and between the main
 * process and the renderer for what the host asks the workbench to show.
 *
 * One small RPC both ways: a request carries an id and gets one response; a
 * notification gets none. Values must survive structured cloning (the host
 * talks over Node's IPC channel, the renderer over Electron's), so no
 * functions, class instances or `undefined` inside arrays.
 *
 * Shared by main, the host and the renderer: no Node, Electron or DOM import.
 */

import type { DiagnosticsUpdate, EditorStateData, ProviderRegistration, RangeData, WorkspaceEditData } from './extensionLanguageProtocol.ts';
import type { ViewNotification } from './extensionViewsProtocol.ts';
import type { WebviewUiEvent } from './extensionWebviewProtocol.ts';
import type { ExtensionActivation, ExtensionId } from './extensions.ts';

export type RpcMessage =
    | { readonly kind: 'req'; readonly id: number; readonly method: string; readonly params: readonly unknown[] }
    | { readonly kind: 'res'; readonly id: number; readonly ok: true; readonly result: unknown }
    | { readonly kind: 'res'; readonly id: number; readonly ok: false; readonly error: string }
    | { readonly kind: 'evt'; readonly method: string; readonly params: readonly unknown[] };

export function isRpcMessage(value: unknown): value is RpcMessage {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const message = value as Record<string, unknown>;
    switch (message['kind']) {
        case 'req':
            return typeof message['id'] === 'number' && typeof message['method'] === 'string' && Array.isArray(message['params']);
        case 'res':
            return typeof message['id'] === 'number' && typeof message['ok'] === 'boolean';
        case 'evt':
            return typeof message['method'] === 'string' && Array.isArray(message['params']);
        default:
            return false;
    }
}

type Handler = (...params: unknown[]) => unknown;

/**
 * One end of the RPC. `send` writes a message to the other end; `receive` is
 * fed every message that arrives. A request whose method has no handler is
 * answered with an error, so the caller never waits forever; `dispose`
 * rejects every request still waiting (the other end went away).
 */
export class RpcEndpoint {
    private readonly send: (message: RpcMessage) => void;
    private readonly handlers = new Map<string, Handler>();
    private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    private nextId = 1;
    private disposed = false;

    constructor(send: (message: RpcMessage) => void) {
        this.send = send;
    }

    /** Answers requests and notifications called `method`. */
    handle(method: string, handler: Handler): void {
        this.handlers.set(method, handler);
    }

    request<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
        if (this.disposed) {
            return Promise.reject(new Error('The extension host is not running.'));
        }
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
            try {
                this.send({ kind: 'req', id, method, params });
            } catch (error) {
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    notify(method: string, ...params: unknown[]): void {
        if (!this.disposed) {
            try {
                this.send({ kind: 'evt', method, params });
            } catch {
                // The other end is gone; dispose() follows from its exit.
            }
        }
    }

    receive(message: unknown): void {
        if (!isRpcMessage(message) || this.disposed) {
            return;
        }
        if (message.kind === 'res') {
            const waiting = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (waiting) {
                if (message.ok) {
                    waiting.resolve(message.result);
                } else {
                    waiting.reject(new Error(message.error));
                }
            }
            return;
        }
        const handler = this.handlers.get(message.method);
        if (message.kind === 'evt') {
            try {
                const result = handler?.(...message.params);
                if (result instanceof Promise) {
                    result.catch(() => undefined);
                }
            } catch {
                // A notification has nobody to tell.
            }
            return;
        }
        const { id } = message;
        if (!handler) {
            this.reply({ kind: 'res', id, ok: false, error: `Unknown method "${message.method}".` });
            return;
        }
        Promise.resolve()
            .then(() => handler(...message.params))
            .then(
                (result) => this.reply({ kind: 'res', id, ok: true, result: result === undefined ? null : result }),
                (error: unknown) => this.reply({ kind: 'res', id, ok: false, error: error instanceof Error ? error.message : String(error) }),
            );
    }

    private reply(message: RpcMessage): void {
        if (this.disposed) {
            return;
        }
        try {
            this.send(message);
        } catch (error) {
            if (message.kind === 'res' && message.ok) {
                // The result could not be cloned: say so instead of leaving the caller waiting.
                try {
                    this.send({ kind: 'res', id: message.id, ok: false, error: `The result could not be sent: ${error instanceof Error ? error.message : String(error)}` });
                } catch {
                    // Gone.
                }
            }
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const waiting of this.pending.values()) {
            waiting.reject(new Error('The extension host stopped.'));
        }
        this.pending.clear();
        this.handlers.clear();
    }
}

/* ------------------------------------------------------------------ */
/* main -> host                                                         */
/* ------------------------------------------------------------------ */

/** An extension with code, as the host needs it. */
export interface HostExtensionDescription {
    readonly id: ExtensionId;
    /** The extension's folder (absolute). */
    readonly location: string;
    /** `main`, relative to `location`. */
    readonly main: string;
    /** The whole `package.json`, localised (`vscode.extensions.getExtension(id).packageJSON`). */
    readonly packageJSON: Readonly<Record<string, unknown>>;
    /** Declared and implicit activation events (`onCommand:` for contributed commands, ...). */
    readonly activationEvents: readonly string[];
    readonly extensionDependencies: readonly ExtensionId[];
}

/** An extension without code: `vscode.extensions.all` lists it too. */
export interface HostPassiveExtension {
    readonly id: ExtensionId;
    readonly location: string;
    readonly packageJSON: Readonly<Record<string, unknown>>;
}

export interface HostInitData {
    readonly extensions: readonly HostExtensionDescription[];
    readonly passive: readonly HostPassiveExtension[];
    /** The folder this window has open, absolute, or null. */
    readonly workspaceFolder: string | null;
    readonly trusted: boolean;
    /** User values of the extensions' settings, by full key. */
    readonly configuration: Readonly<Record<string, unknown>>;
    /** Per-extension storage: `<root>/<id>/` for global state, `<root>/<workspace hash>/<id>/` for the folder's. */
    readonly globalStorageRoot: string;
    readonly workspaceStorageRoot: string | null;
    readonly logRoot: string;
    readonly env: {
        readonly appName: string;
        readonly appRoot: string;
        readonly appHost: string;
        readonly language: string;
        readonly machineId: string;
        readonly sessionId: string;
        readonly uriScheme: string;
        readonly shell: string;
        readonly version: string;
    };
    readonly isDevelopment: boolean;
    /** #260: the editor's open documents (absolute paths) and its active editor when the host starts. */
    readonly documents: readonly { readonly path: string; readonly languageId: string; readonly version: number; readonly text: string }[];
    readonly activeEditor: EditorStateData | null;
}

export const HOST_METHODS = {
    /** (HostInitData) -> void */
    init: 'init',
    /** (event: string) -> void. Activates every extension listening for it; resolves once they have activated. */
    activateByEvent: 'activateByEvent',
    /** (id: string, args: unknown[]) -> unknown. A command an extension registered. */
    executeCommand: 'executeCommand',
    /** () -> string[]: the commands the extensions registered. */
    registeredCommands: 'registeredCommands',
    /** (values: Record<string, unknown>, changed: string[]) -> void */
    configurationChanged: 'configurationChanged',
    /** (trusted: boolean) -> void */
    trustChanged: 'trustChanged',
    /** () -> void. Deactivates every extension, then the host exits. */
    shutdown: 'shutdown',
    /** #260 (DocumentEvent[]) notification: the editor's documents and active editor changed (absolute paths). */
    documents: 'documents',
    /** #260 (ProvideRequest) -> the provider's answer as plain data (extensionLanguageProtocol.ts). */
    provide: 'provide',
    /** #261 (ViewRequest) -> answer (extensionViewsProtocol.ts); tree resources are absolute paths. */
    view: 'view',
    /** #261 (WebviewWorkbenchEvent) -> answer (extensionWebviewProtocol.ts). */
    webview: 'webview',
} as const;

/* ------------------------------------------------------------------ */
/* host -> main                                                         */
/* ------------------------------------------------------------------ */

export interface HostLogLine {
    readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
    /** The extension it is about, or null for the host itself. */
    readonly extensionId: ExtensionId | null;
    /** An output channel an extension created, if the line comes from one. */
    readonly channel?: string;
    readonly message: string;
}

export interface HostActivationEvent {
    readonly id: ExtensionId;
    readonly state: ExtensionActivation;
    readonly error?: string;
}

export const MAIN_METHODS = {
    /** (HostLogLine) notification */
    log: 'log',
    /** (HostActivationEvent) notification */
    activation: 'activation',
    /** (extensionId, apiName) notification: an extension used API the host does not implement (logged once). */
    notImplemented: 'notImplemented',
    /** (id, args) -> unknown: a command that no extension registered, for the workbench. */
    executeWorkbenchCommand: 'executeWorkbenchCommand',
    /** (key, value, target: 'user' | 'workspace') -> void */
    updateConfiguration: 'updateConfiguration',
    /** (extensionId, key) -> string | null */
    secretGet: 'secretGet',
    /** (extensionId, key, value) -> void */
    secretStore: 'secretStore',
    /** (extensionId, key) -> void */
    secretDelete: 'secretDelete',
    /** () -> string */
    clipboardRead: 'clipboardRead',
    /** (text) -> void */
    clipboardWrite: 'clipboardWrite',
    /** (url) -> boolean: opens it outside the IDE (http, https, mailto only). */
    openExternal: 'openExternal',
    /** (DialogRequest) -> string[] | null: a native open or save dialog; paths are absolute. */
    showDialog: 'showDialog',
    /** (UiRequest) -> unknown: something the workbench has to show (see UI_METHODS). */
    ui: 'ui',
    /** (UiNotification) notification: status bar items, progress, status messages. */
    uiNotify: 'uiNotify',
    /** #261 (WebviewHostEvent) notification: a webview was created, changed or disposed. */
    webview: 'webview',
    /** #260 (DiagnosticsUpdate) notification, absolute paths. */
    diagnostics: 'diagnostics',
    /** #260 (ProviderRegistration) notification. */
    registerProvider: 'registerProvider',
    /** #260 (handle) notification. */
    unregisterProvider: 'unregisterProvider',
} as const;

/* ------------------------------------------------------------------ */
/* main <-> renderer: what the host asks the workbench                  */
/* ------------------------------------------------------------------ */

export type MessageSeverity = 'info' | 'warning' | 'error';

export interface QuickPickItemData {
    readonly label: string;
    readonly description?: string;
    readonly detail?: string;
    readonly picked?: boolean;
    /** A separator row (`QuickPickItemKind.Separator`): shown, never picked. */
    readonly separator?: boolean;
}

export interface DialogRequest {
    readonly kind: 'open' | 'save';
    readonly title?: string;
    readonly defaultPath?: string;
    readonly openLabel?: string;
    readonly canSelectFiles?: boolean;
    readonly canSelectFolders?: boolean;
    readonly canSelectMany?: boolean;
    /** Name -> extensions without the dot, as `showOpenDialog`'s `filters`. */
    readonly filters?: Readonly<Record<string, readonly string[]>>;
}

/** A request from an extension that waits for the person; answered with the result. */
export type UiRequest =
    | { readonly kind: 'message'; readonly extensionId: ExtensionId; readonly severity: MessageSeverity; readonly message: string; readonly detail?: string; readonly modal?: boolean; readonly items: readonly string[] }
    | { readonly kind: 'quickPick'; readonly extensionId: ExtensionId; readonly items: readonly QuickPickItemData[]; readonly placeHolder?: string; readonly title?: string; readonly canPickMany: boolean }
    | { readonly kind: 'inputBox'; readonly extensionId: ExtensionId; readonly value?: string; readonly prompt?: string; readonly placeHolder?: string; readonly title?: string; readonly password: boolean }
    | { readonly kind: 'openFile'; readonly path: string; readonly line?: number; readonly column?: number; readonly preview: boolean }
    /** A command no extension registered: the workbench's own, or a built-in `vscode.*` one it maps. Args went through the host's wire format. */
    | { readonly kind: 'command'; readonly id: string; readonly args: readonly unknown[] }
    /** #260: text edits for the editor's models (opening the files that are not open); answered with true when all applied. */
    | { readonly kind: 'applyEdit'; readonly edit: WorkspaceEditData }
    /** #260: `TextDocument.save()` of a document the editor has open. */
    | { readonly kind: 'saveFile'; readonly path: string }
    /** #260: `TextEditor.insertSnippet` on the active editor, at its selections or at `ranges`. */
    | { readonly kind: 'insertSnippet'; readonly path: string; readonly snippet: string; readonly ranges?: readonly RangeData[] };

export interface StatusBarItemData {
    /** Unique per host: `<extension id>/<n>`. */
    readonly key: string;
    readonly extensionId: ExtensionId;
    readonly text: string;
    readonly tooltip?: string;
    readonly command?: string;
    readonly commandArgs?: readonly unknown[];
    readonly alignment: 'left' | 'right';
    readonly priority: number;
    readonly visible: boolean;
    readonly name?: string;
}

/** Fire-and-forget updates for the workbench. */
export type UiNotification =
    | { readonly kind: 'statusBarItem'; readonly item: StatusBarItemData }
    | { readonly kind: 'statusBarItemDispose'; readonly key: string }
    | { readonly kind: 'statusMessage'; readonly text: string; readonly timeoutMs: number }
    | { readonly kind: 'progress'; readonly key: string; readonly title: string; readonly message?: string; readonly percent?: number }
    | { readonly kind: 'progressEnd'; readonly key: string }
    | { readonly kind: 'contextKey'; readonly key: string; readonly value: unknown }
    | { readonly kind: 'hostStopped'; readonly reason: string }
    /** #260: language features. Paths are workspace paths by the time they reach the renderer. */
    | { readonly kind: 'diagnostics'; readonly update: DiagnosticsUpdate }
    | { readonly kind: 'providerRegistered'; readonly registration: ProviderRegistration }
    | { readonly kind: 'providerUnregistered'; readonly handle: number }
    /** A host started or stopped: every provider and diagnostic of the previous one is gone. */
    | { readonly kind: 'providersReset' }
    /** #261: the extensions' tree views (no paths). */
    | { readonly kind: 'view'; readonly notification: ViewNotification }
    /** #261: a webview was created, changed or disposed (the HTML stays in the main process). */
    | { readonly kind: 'webview'; readonly event: WebviewUiEvent };

/** Main -> renderer: one UI request of the host (answer with `extensionsHostReply`), or a notification. */
export type HostUiEvent =
    | { readonly type: 'request'; readonly id: number; readonly request: UiRequest }
    | { readonly type: 'notify'; readonly notification: UiNotification };

/**
 * The implicit activation events VS Code has added since 1.74: a contributed
 * command, view or language activates its extension without declaring it.
 */
export function activationEventsOf(declared: readonly string[], contributes: Readonly<Record<string, unknown>>): string[] {
    const events = new Set(declared.filter((event) => typeof event === 'string' && event.trim() !== ''));
    const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : []);
    for (const command of list(contributes['commands'])) {
        if (typeof command['command'] === 'string') {
            events.add(`onCommand:${command['command']}`);
        }
    }
    const views = contributes['views'];
    if (typeof views === 'object' && views !== null) {
        for (const container of Object.values(views as Record<string, unknown>)) {
            for (const view of list(container)) {
                if (typeof view['id'] === 'string') {
                    events.add(`onView:${view['id']}`);
                }
            }
        }
    }
    for (const language of list(contributes['languages'])) {
        if (typeof language['id'] === 'string') {
            events.add(`onLanguage:${language['id']}`);
        }
    }
    return [...events];
}

/** Whether `event` (as fired, e.g. `onLanguage:python`) wakes an extension that declared `declared`. */
export function activationMatches(declared: readonly string[], event: string): boolean {
    if (declared.includes('*') && event !== 'onStartupFinished') {
        return true;
    }
    if (declared.includes(event)) {
        return true;
    }
    // `onLanguage` alone (no id) fires on any language.
    return event.startsWith('onLanguage:') && declared.includes('onLanguage');
}
