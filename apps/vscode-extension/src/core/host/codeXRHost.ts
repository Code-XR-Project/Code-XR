/**
 * The host seam of the Code-XR core (#13).
 *
 * The core (analysis, Python runner, local servers, history) talks to the
 * application it runs in only through this interface, so the same core can
 * run inside the VS Code extension (`app/host/vscodeHost.ts`) and inside the
 * Code-XR IDE (an Electron host, epic #11).
 *
 * This file must never import `vscode`, directly or through another module:
 * `test/host/codeXRHost.test.cjs` checks it. The groups below come from the
 * inventory in docs/ide/vscode-api-inventory.md (§4.1); only what a core
 * module actually needs belongs here. UI that only the extension has (tree
 * views, webviews, quick picks, editors) stays out on purpose.
 */

/** Same shape as `vscode.Disposable`, so a VS Code subscription fits as it is. */
export interface HostDisposable {
    dispose(): void;
}

/** Same call shape as `vscode.Event<T>` (and `RegistryChangeEvent` in activeServerRegistry.ts). */
export type HostEvent<T> = (
    listener: (event: T) => unknown,
    thisArgs?: unknown,
    disposables?: HostDisposable[],
) => HostDisposable;

/** How the host was started. Decides, for example, where the Python backend is found. */
export type HostMode = 'production' | 'development' | 'test';

/** The paths the core needs, as plain file-system strings (never `vscode.Uri`). */
export interface HostPaths {
    /** Folder holding `templates/`, `resources/` and `dist/code_analysis/python` (the extension: `extensionPath`). */
    readonly installRoot: string;
    /** Per-user private storage (the extension: `globalStorageUri.fsPath`). */
    readonly globalStorageDir: string;
    /** Per-workspace private storage; undefined with no folder open (the extension: `storageUri?.fsPath`). */
    readonly workspaceStorageDir: string | undefined;
    readonly mode: HostMode;
}

/** The subset of `vscode.Memento` the core uses. */
export interface HostKeyValueStore {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface HostProgress {
    report(value: { message?: string; increment?: number }): void;
}

export interface HostCancellation {
    readonly isCancellationRequested: boolean;
    readonly onCancellationRequested: HostEvent<unknown>;
}

export type HostSeverity = 'info' | 'warning' | 'error';

export interface HostStatusIndicator {
    text: string;
    tooltip?: string | undefined;
    show(): void;
    hide(): void;
    dispose(): void;
}

export interface HostNotifier {
    /** Non-blocking notification; resolves with the action the person clicked, or undefined. */
    notify(severity: HostSeverity, message: string, ...actions: string[]): Promise<string | undefined>;
    /**
     * A question a person must answer (download consent, deleting an
     * environment). Project rule: no network access or download without
     * explicit consent, so no host and no test double may answer this on the
     * person's behalf by default.
     */
    confirm(message: string, options: { modal?: boolean; detail?: string; actions: readonly string[] }): Promise<string | undefined>;
    /** Transient status-line text. */
    status(message: string, timeoutMs?: number): HostDisposable;
    /** A long-lived status-line item. */
    createStatusIndicator(): HostStatusIndicator;
}

/** UI updates the core asks for, by meaning rather than by VS Code command id. */
export type HostSignal =
    | { readonly kind: 'refresh'; readonly view: 'servers' | 'activeServers' }
    | { readonly kind: 'state'; readonly key: 'pythonEnv.uiLocked' | 'pythonEnv.retryAvailable'; readonly value: boolean }
    | { readonly kind: 'revealSidebar' }
    | { readonly kind: 'openServerSettings' };

export interface CodeXRHost {
    readonly paths: HostPaths;
    readonly globalState: HostKeyValueStore;
    readonly notifier: HostNotifier;
    withProgress<T>(
        options: { title: string; cancellable?: boolean },
        task: (progress: HostProgress, cancellation: HostCancellation) => Promise<T>,
    ): Promise<T>;
    prompt(options: { prompt: string; placeHolder?: string; password?: boolean; value?: string }): Promise<string | undefined>;
    clipboardWrite(text: string): Promise<void>;
    /** Opens a URL in the system browser. Callers ask for consent first where the project rules require it. */
    openExternal(url: string): Promise<boolean>;
    /** Absolute paths of the open workspace folders. */
    workspaceFolders(): readonly string[];
    signal(signal: HostSignal): void;
}
