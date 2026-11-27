import type { ColorTheme, SettingScope, SettingsSnapshot, SettingValue } from './settings.ts';
import type { UserKeybinding } from './keybindings.ts';
import type { OutputChannelId } from './output.ts';
import type { FileFunctionMetrics, FunctionMetricsSnapshot } from './problems.ts';
/**
 * The contract between the renderer and the rest of the IDE.
 *
 * The renderer never touches Node or Electron directly: everything it can do
 * is listed here, exposed by the preload script as `window.codexr`, and served
 * by an allow-listed IPC handler in the main process. Adding a capability means
 * adding it to all three places (this file, `IPC_CHANNELS`, the handler).
 *
 * This module is shared by main, preload and renderer, so it must stay free of
 * any Node, Electron or DOM import.
 */

import { AGENT_IPC_CHANNELS, AGENT_IPC_EVENTS, type AgentsApi } from './agents.ts';
import { GIT_IPC_CHANNELS, GIT_IPC_EVENTS, type GitApi } from './git.ts';
import { LSP_IPC_CHANNELS, LSP_IPC_EVENTS, type LspApi } from './lsp.ts';
import { TASK_IPC_CHANNELS, TASK_IPC_EVENTS, type TasksApi } from './tasks.ts';
import { EXTENSION_IPC_CHANNELS, EXTENSION_IPC_EVENTS, type ExtensionsApi } from './extensions.ts';

/** Facts about the running IDE, shown on the welcome screen and in About. */
export interface AppInfo {
    readonly name: string;
    readonly version: string;
    readonly platform: string;
    readonly arch: string;
    readonly versions: {
        readonly electron: string;
        readonly chrome: string;
        readonly node: string;
    };
    /** True when the renderer is served by the Vite dev server. */
    readonly isDevelopment: boolean;
}

/** The project folder open in a window (#14). */
export interface WorkspaceInfo {
    /** Absolute path, for display only: the renderer addresses files by workspace-relative path. */
    readonly root: string;
    /** The folder's own name, shown as the explorer title. */
    readonly name: string;
}

/**
 * One child of a folder in the explorer. `path` is relative to the workspace
 * root, `/`-separated on every OS; `''` is the root itself.
 */
/** #165: a search across the workspace, as the Search view sends it. */
export interface SearchQuery {
    readonly pattern: string;
    readonly isRegex: boolean;
    readonly matchCase: boolean;
    readonly wholeWord: boolean;
    /** Comma-separated globs ("src, *.ts"); empty for every file. */
    readonly include: string;
    readonly exclude: string;
}

/** One match: 1-based line and column, and the line's text around it for display. */
export interface SearchMatch {
    readonly line: number;
    readonly column: number;
    readonly length: number;
    readonly preview: string;
    /** Where the match starts inside `preview`. */
    readonly previewStart: number;
}

/** A file with matches, sent as soon as it is read. `total` counts matches beyond the listed ones. */
export interface SearchFileEvent {
    readonly searchId: number;
    readonly path: string;
    readonly matches: readonly SearchMatch[];
    readonly total: number;
}

export interface SearchDoneEvent {
    readonly searchId: number;
    readonly files: number;
    readonly matches: number;
    /** The search stopped at its match limit. */
    readonly limitHit: boolean;
    readonly cancelled: boolean;
    /** The query could not run (invalid regular expression...). */
    readonly error?: string;
}

export interface ReplaceResult {
    readonly files: number;
    readonly replacements: number;
    readonly failed: readonly { readonly path: string; readonly message: string }[];
}

/** #164: the workspace's files for quick open; `truncated` when the walk stopped at its limit. */
export interface WorkspaceFileList {
    readonly files: readonly string[];
    readonly truncated: boolean;
}

export interface DirEntry {
    readonly name: string;
    readonly path: string;
    readonly kind: 'file' | 'directory';
    /** Matched by the root `.gitignore`: still listed, shown dimmed. */
    readonly ignored: boolean;
}

/** Something the window shows that should follow the disk: an expanded folder or an open file. */
export interface WatchedEntry {
    readonly path: string;
    readonly kind: 'file' | 'directory';
}

/** A file read for the editor. Binary and oversized files are reported, not sent. */
/** #177: whether the open folder may run what it defines (Git, language servers it configures, tasks). */
export type WorkspaceTrustState = 'trusted' | 'restricted' | 'unknown';

export interface WorkspaceTrustInfo {
    /** `unknown` until the person answers; the IDE treats it as restricted. */
    readonly state: WorkspaceTrustState;
    /** The open folder (absolute), or null without one. */
    readonly folder: string | null;
    /** The folder whose trust covers this one (itself or a parent), when trusted. */
    readonly trustedThrough: string | null;
    /** The parent folder, offered as "trust all folders in ..."; null at a drive or file-system root. */
    readonly parent: string | null;
}

export type FileContent =
    | { readonly kind: 'text'; readonly path: string; readonly text: string; readonly mtimeMs: number }
    | { readonly kind: 'binary' | 'too-large'; readonly path: string; readonly size: number };

/** The result of a save: the file's new modification time, to detect later external changes. */
export interface SaveResult {
    readonly mtimeMs: number;
}

/**
 * Commands the main process asks the renderer to run, from the application
 * menu and its accelerators (#14). A closed list, so the renderer can ignore
 * anything else.
 */
export const IDE_COMMANDS = [
    'workspace.openFolder', 'file.newFile', 'file.newFolder', 'file.save', 'file.saveAll', 'editor.close',
    // #137: the terminal panel (View menu, Ctrl+` and Ctrl+Shift+`).
    'terminal.toggle', 'terminal.new', 'terminal.closePanel',
    // #18: the command palette (View menu, Ctrl/Cmd+Shift+P) and go to line (Go menu, Ctrl+G).
    'workbench.commandPalette', 'editor.goToLine',
    // #164: quick open (Go > Go to File..., Ctrl/Cmd+P) and the active editor's symbols (Ctrl/Cmd+Shift+O).
    'workbench.quickOpen', 'editor.goToSymbol',
    // #169: the layout (View > Appearance, Ctrl/Cmd+B and Ctrl/Cmd+J).
    'view.toggleSideBar', 'view.togglePanel', 'view.toggleMaximizedPanel', 'view.toggleZenMode', 'view.resetLayout',
    // #18: settings (File > Preferences > Settings, Ctrl/Cmd+,).
    'workbench.openSettings',
    // #18, part 3: File > Preferences > Keyboard Shortcuts (its Ctrl/Cmd+K S chord is the workbench's).
    'workbench.openKeybindings',
    // #171: File > Preferences > Color Theme (its Ctrl/Cmd+K Ctrl/Cmd+T chord is the workbench's).
    'workbench.selectTheme',
] as const;
export type IdeCommand = (typeof IDE_COMMANDS)[number];

/**
 * The Python environment the analyses run in (#15), as the Analysis view and
 * the status bar show it.
 * - `missing-python`: no system Python answered; `detail` says how to install one.
 * - `not-installed`: Python found, the environment was never set up.
 * - `installing`: a set-up or repair is running (`progress` 0-100).
 * - `ready`: the environment exists and every analysis package imports.
 * - `broken`: it exists but is damaged or incomplete, or the last set-up failed.
 */
export type PythonEnvState = 'missing-python' | 'not-installed' | 'installing' | 'ready' | 'broken';

export interface PythonPackageInfo {
    readonly name: string;
    readonly version: string;
    readonly purpose: string;
}

export interface PythonEnvStatus {
    readonly state: PythonEnvState;
    readonly message: string;
    readonly detail?: string | undefined;
    /** The Python the environment runs (ready) or would be created from (not-installed). */
    readonly pythonVersion?: string | undefined;
    readonly progress?: number | undefined;
    /** Where the environment lives (inside the IDE's user-data folder). */
    readonly venvPath: string;
    /** What setting up installs, from the core's pinned manifest. */
    readonly packages: readonly PythonPackageInfo[];
}

/** A message from the core for the status bar (`HostNotifier.notify` without choices). */
export interface HostNotification {
    readonly severity: 'info' | 'warning' | 'error';
    readonly message: string;
}

/** A long task of the core or the main process (#153), shown as a progress notification. */
export interface ProgressEvent {
    readonly id: number;
    readonly title: string;
    readonly message?: string | undefined;
    /** 0-100, absent while unknown. */
    readonly percent?: number | undefined;
    readonly done: boolean;
}

/** The analyses of the whole open folder the IDE can start (#16). */
export const PROJECT_ANALYSIS_KINDS = ['xr-deep', 'livepanel-deep'] as const;
export type ProjectAnalysisKind = (typeof PROJECT_ANALYSIS_KINDS)[number];
/** The analyses of one file of the open folder (#16), as the extension's explorer menu offers them. */
export const FILE_ANALYSIS_KINDS = ['xr-file', 'livepanel-file'] as const;
export type FileAnalysisKind = (typeof FILE_ANALYSIS_KINDS)[number];
/** Every analysis the IDE can start (#16). */
export const ANALYSIS_KINDS = [...PROJECT_ANALYSIS_KINDS, ...FILE_ANALYSIS_KINDS] as const;
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];

/** What runs when a folder opens (#139): nothing, or the whole project in XR (deep). */
export const AUTO_START_MODES = ['off', 'xr-deep'] as const;
export type AutoStartMode = (typeof AUTO_START_MODES)[number];

/** Why an analysis did not start; `message` is for display. */
export type AnalysisStartResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: 'no-workspace' | 'python-not-ready' | 'failed'; readonly message: string };

/**
 * Whether a scene is shared beyond this machine through a Cloudflare quick
 * tunnel (#155), as the scene's header shows it.
 * - `stopped`: only reachable on this machine.
 * - `starting`: cloudflared is starting (or being downloaded, after consent).
 * - `shared`: reachable at `publicUrl`; guests join through an invitation link
 *   and a pairing code the IDE shows.
 * - `error`: the last attempt failed or the tunnel closed; `error` says why.
 */
export type SceneShareStatus = 'stopped' | 'starting' | 'shared' | 'error';

export interface SceneShareState {
    readonly status: SceneShareStatus;
    /** `https://<name>.trycloudflare.com`, only while shared. */
    readonly publicUrl?: string | undefined;
    readonly error?: string | undefined;
}

/** What the scene's header can copy (#155); the main process copies from its own state, never text from the page. */
export const SCENE_ADDRESSES = ['local', 'invitation'] as const;
export type SceneAddress = (typeof SCENE_ADDRESSES)[number];

/** An analysis scene served by Code-XR's local server, shown beside the code. */
export interface SceneInfo {
    /** The local address the scene is served at (`http://127.0.0.1:<port>/`). */
    readonly url: string;
    readonly title: string;
    /** #155: what ran, for the header. */
    readonly kind: AnalysisKind;
    /** The analysed folder or file's own name. */
    readonly target: string;
    /** Its absolute path, for the header's tooltip only. */
    readonly targetPath: string;
    /** #203: how many files the analysis took (its own records), when known. */
    readonly files?: number | undefined;
    readonly share: SceneShareState;
}

/**
 * #19: entering the scene in XR from the IDE. `unsupported` means no headset
 * reached Electron's Chromium here; `message` says what to do instead.
 */
export type EnterXrResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: 'unsupported' | 'failed'; readonly message: string };

/** A change of the sharing state of the calling window's scene (#155). `url` names the scene it belongs to. */
export interface SceneShareEvent {
    readonly url: string;
    readonly share: SceneShareState;
}

/** #16: the analysis behind the scene `url` was re-run and now takes `files` files. */
export interface SceneFilesEvent {
    readonly url: string;
    readonly files: number;
}

/** #16: the scene asked to open a file of the open folder in the editor. */
export interface SceneOpenInEditorEvent {
    /** Workspace-relative, already checked by the main process. */
    readonly path: string;
    /** 1-based. */
    readonly line?: number | undefined;
}

/** Where the scene is drawn, in CSS pixels of the window's content. */
export interface SceneBounds {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/**
 * A shell the terminal panel can start (#137). Profiles are detected by the
 * main process per OS, or saved by the person through a native file dialog;
 * the renderer only ever names one by `id`, so it cannot start any other
 * executable. `path` and `args` are for display.
 */
export interface TerminalProfile {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly args: readonly string[];
    readonly source: 'detected' | 'custom';
}

export interface TerminalProfileList {
    /** Detected profiles in preference order (Git Bash first on Windows, `$SHELL` first elsewhere), then custom ones. */
    readonly profiles: readonly TerminalProfile[];
    /** What a new terminal runs: the saved choice when it still exists, otherwise the first detected profile. */
    readonly defaultProfileId: string | null;
}

/** A terminal the main process started. `id` addresses it in every later call and event. */
export interface TerminalCreated {
    readonly id: number;
    readonly profile: TerminalProfile;
    /** Where the shell started: the open folder, or the home folder when none is open. */
    readonly cwd: string;
}

export interface TerminalDataEvent {
    readonly id: number;
    readonly data: string;
}

export interface TerminalExitEvent {
    readonly id: number;
    readonly exitCode: number;
}

/** Unsubscribes a listener registered with an `on…` member. */
export type Unsubscribe = () => void;

/**
 * What `window.codexr` offers the renderer. Every member returns a promise,
 * except the `on…` subscriptions, which return their `Unsubscribe`.
 */
export interface CodeXRApi {
    /** The AI agent hub: providers, keys, chats (contract in agents.ts). */
    readonly agents: AgentsApi;
    /** #17: Source Control for the open folder (contract in git.ts). */
    readonly git: GitApi;
    /** #176: the folder's tasks and Run Current File; command lines are built in the main process. */
    readonly tasks: TasksApi;
    /** #21: language servers for Monaco (contract in lsp.ts). */
    readonly lsp: LspApi;
    /** #251: VS Code extensions (shared/extensions.ts). */
    readonly extensions: ExtensionsApi;
    readonly app: {
        getInfo(): Promise<AppInfo>;
        /** Messages from the core (environment set up, a server stopped ...). */
        onNotification(listener: (notification: HostNotification) => void): Unsubscribe;
        /** Progress of long tasks (#153): the Python set-up steps, the language parsers... */
        onProgress(listener: (progress: ProgressEvent) => void): Unsubscribe;
    };
    readonly python: {
        /** Checks the environment again (runs Python, never downloads). */
        status(): Promise<PythonEnvStatus>;
        /**
         * Sets up or repairs the environment (#154: the IDE installs its own
         * dependencies, with no question; the README lists what is fetched); resolves with the
         * new status, unchanged when the person declines.
         */
        setUp(): Promise<PythonEnvStatus>;
        /** Deletes the environment after a native confirmation. */
        remove(): Promise<PythonEnvStatus>;
        onDidChangeStatus(listener: (status: PythonEnvStatus) => void): Unsubscribe;
    };
    readonly analysis: {
        /**
         * Analyses the whole open folder (#16). Refused, not queued, when no
         * folder is open or the Python environment is not ready: nothing is
         * ever downloaded from here.
         */
        analyseProject(kind: ProjectAnalysisKind, options?: { readonly auto?: boolean }): Promise<AnalysisStartResult>;
        /** Analyses one file of the open folder (#16), named by its workspace path; refused as `analyseProject` is. */
        analyseFile(kind: FileAnalysisKind, path: string): Promise<AnalysisStartResult>;
        /** What runs when a folder opens (#139); `xr-deep` unless the person turned it off. */
        autoStart(): Promise<AutoStartMode>;
        setAutoStart(mode: AutoStartMode): Promise<AutoStartMode>;
        /** Where to draw the scene; null hides it (the slot is not visible). */
        setSceneBounds(bounds: SceneBounds | null): Promise<void>;
        /** Closes the scene (its server keeps running, as in the extension). */
        closeScene(): Promise<void>;
        /** A scene is ready to show; the renderer opens its slot and reports bounds. */
        onDidOpenScene(listener: (scene: SceneInfo) => void): Unsubscribe;
        /** #16: the scene's analysis re-ran (a save) and its file count changed. */
        onDidChangeSceneFiles(listener: (event: SceneFilesEvent) => void): Unsubscribe;
        /**
         * #178: marks a file of the open folder (a workspace path) in this
         * window's scene. Resolves false when no scene shows it.
         */
        revealInScene(path: string): Promise<boolean>;
        /** #16: the scene asked to open a file ("Open in editor", a LivePanel row). */
        onDidRequestOpenInEditor(listener: (event: SceneOpenInEditorEvent) => void): Unsubscribe;
        /**
         * Shares this window's scene through a Cloudflare quick tunnel (#155).
         * Downloading cloudflared, the first time, asks in a native dialog in
         * the main process. Resolves with the new state (`stopped` when the
         * download was declined); rejects when there is no scene or the tunnel
         * failed.
         */
        shareScene(): Promise<SceneShareState>;
        /** Stops sharing this window's scene and revokes its remote sessions. */
        stopSharingScene(): Promise<SceneShareState>;
        /** Copies the window's scene address (local, or the tunnel's invitation link) to the clipboard. */
        copySceneAddress(which: SceneAddress): Promise<void>;
        onDidChangeSceneShare(listener: (event: SceneShareEvent) => void): Unsubscribe;
        /** #19: enters this window's scene in XR on a headset tethered to this computer, or says why not. */
        enterXr(): Promise<EnterXrResult>;
        /** #19: opens this window's scene in the system browser (its local address). */
        openSceneInBrowser(): Promise<void>;
        /**
         * #19: the address a standalone headset opens to join this window's
         * scene (the tunnel's invitation link), or null while it is not shared.
         */
        headsetLink(): Promise<string | null>;
    };
    readonly workspace: {
        /** Shows the folder picker; resolves with the new workspace, or null when cancelled. */
        openFolder(): Promise<WorkspaceInfo | null>;
        /** The workspace open in this window, if any. */
        current(): Promise<WorkspaceInfo | null>;
        /** The children of a workspace folder, folders first, then by name. */
        listDirectory(path: string): Promise<readonly DirEntry[]>;
        /** #164: every file of the workspace for quick open (gitignored ones left out), up to a limit. */
        listFiles(): Promise<WorkspaceFileList>;
        /**
         * #165: starts a search (a previous one of this window is cancelled);
         * results come as `onSearchResult` events tagged with `searchId`, then `onSearchDone`.
         */
        search(searchId: number, query: SearchQuery): Promise<void>;
        cancelSearch(searchId: number): Promise<void>;
        onSearchResult(listener: (event: SearchFileEvent) => void): Unsubscribe;
        onSearchDone(listener: (event: SearchDoneEvent) => void): Unsubscribe;
        /** Replaces every match of `query` in `paths` on disk (files open in an editor are replaced there instead). */
        replaceInFiles(query: SearchQuery, replacement: string, paths: readonly string[]): Promise<ReplaceResult>;
        readFile(path: string): Promise<FileContent>;
        /**
         * Writes an existing workspace file. With `expectedMtimeMs` the write is
         * refused when the file changed on disk since it was read, so a save
         * never silently overwrites someone else's edit.
         */
        writeFile(path: string, text: string, expectedMtimeMs?: number): Promise<SaveResult>;
        /**
         * Watches the folders behind these entries and replaces the previous
         * set; changes arrive through `onDidChangeFiles`.
         */
        setWatched(entries: readonly WatchedEntry[]): Promise<void>;
        /** Workspace paths that changed on disk: the entries themselves and the folders listing them. */
        onDidChangeFiles(listener: (paths: readonly string[]) => void): Unsubscribe;
        /** How many open files have unsaved changes; closing the window asks first while it is above 0. */
        reportUnsaved(count: number): Promise<void>;
        /**
         * Creates an empty file or a folder named `name` inside the folder
         * `parent` and resolves with its workspace path. Never overwrites.
         */
        createEntry(parent: string, name: string, kind: 'file' | 'directory'): Promise<string>;
        /** Renames an entry within its folder; resolves with the new workspace path. */
        rename(path: string, newName: string): Promise<string>;
        /** Moves an entry to the operating system's trash (never deletes outright). */
        trash(path: string): Promise<void>;
        /** #167: copies an entry's path to the clipboard, absolute or relative to the folder, with the OS's separators. */
        copyPath(path: string, kind: 'absolute' | 'relative'): Promise<void>;
        /**
         * #179: an image of the open folder as a `data:` URL, for the Markdown
         * preview (the CSP lets the window load nothing else). Null for a file
         * that is not a PNG, JPEG, GIF, WebP or BMP image, or over 8 MB.
         */
        readImage(path: string): Promise<string | null>;
        /** #179: opens an http(s) or mailto link in the system's browser or mail app; any other URL is refused. */
        openExternalLink(url: string): Promise<void>;
        /** Recently opened folders, most recent first (absolute paths, for display and `openRecent`). */
        recentFolders(): Promise<readonly string[]>;
        /** Opens a folder from `recentFolders()`; any other path is refused. */
        openRecent(folder: string): Promise<WorkspaceInfo>;
        /** Fires when the workspace changes from outside the renderer (`--folder=` at startup, File > Open Recent). */
        onDidChange(listener: (workspace: WorkspaceInfo | null) => void): Unsubscribe;
        /** #177: the open folder's trust. */
        trust(): Promise<WorkspaceTrustInfo>;
        /**
         * #177: trusts the open folder (`folder`), every folder in its parent
         * (`parent`), or puts it in Restricted Mode (`restrict`). Remembered.
         */
        setTrust(choice: 'folder' | 'parent' | 'restrict'): Promise<WorkspaceTrustInfo>;
        /** #177: the open folder's trust changed (this window or another). */
        onDidChangeTrust(listener: (trust: WorkspaceTrustInfo) => void): Unsubscribe;
    };
    /**
     * The integrated terminal (#137). The pty lives in the main process; the
     * renderer sends keystrokes and sizes and receives output, for terminals
     * of its own window only.
     */
    readonly terminal: {
        profiles(): Promise<TerminalProfileList>;
        /** Saves the default for new terminals (a listed profile id); survives restarts. */
        setDefaultProfile(profileId: string): Promise<TerminalProfileList>;
        /**
         * Adds a custom profile. The executable is picked in a native file
         * dialog and the command line is confirmed in a native message box,
         * both in the main process; `args` is only a proposal shown there.
         * Resolves with the list, unchanged when the person cancels.
         */
        addCustomProfile(args: string): Promise<TerminalProfileList>;
        removeCustomProfile(profileId: string): Promise<TerminalProfileList>;
        /** Starts a terminal from a listed profile (null: the default) in the open folder. */
        create(profileId: string | null, cols: number, rows: number): Promise<TerminalCreated>;
        input(id: number, data: string): Promise<void>;
        resize(id: number, cols: number, rows: number): Promise<void>;
        kill(id: number): Promise<void>;
        onData(listener: (event: TerminalDataEvent) => void): Unsubscribe;
        onExit(listener: (event: TerminalExitEvent) => void): Unsubscribe;
    };
    readonly commands: {
        /** Menu commands for the renderer to run (Open Folder…, Save, Save All, Close Editor). */
        onCommand(listener: (command: IdeCommand) => void): Unsubscribe;
    };
    /** #18: the user's and the open folder's settings (shared/settings.ts holds the schema). */
    readonly settings: {
        get(): Promise<SettingsReport>;
        /** Sets `key` in a scope (null removes it, back to the next level); rejects a value the schema refuses. */
        update(scope: SettingScope, key: string, value: SettingValue | null): Promise<SettingsReport>;
        /** Creates `.codexr/settings.json` if needed and resolves with its workspace path, to open in the editor. */
        folderFile(): Promise<string>;
        /** #171: shows a colour theme without storing it (null: back to the stored one). */
        previewTheme(theme: ColorTheme | null): Promise<void>;
        /** The settings changed (in this window, or the user's in another one). */
        onDidChange(listener: (report: SettingsReport) => void): Unsubscribe;
    };
    /** #174: the Output panel's channels (shared/output.ts lists them). */
    readonly output: {
        /** The lines a channel holds now (at most MAX_OUTPUT_LINES). */
        lines(channel: OutputChannelId): Promise<readonly string[]>;
        clear(channel: OutputChannelId): Promise<void>;
        /** New lines, in batches, or a channel cleared. */
        onAppended(listener: (event: OutputAppended) => void): Unsubscribe;
    };
    /** #173: the per-function metrics behind the Problems panel (shared/problems.ts). */
    readonly problems: {
        /** The window's latest metrics, or null before an analysis of its folder. */
        functionMetrics(): Promise<FunctionMetricsSnapshot | null>;
        /**
         * #172: the functions of one file of the folder, for its outline: the
         * window's metrics when an analysis measured it, otherwise measured
         * now (null when the backend cannot read it or Python is not set up).
         */
        fileFunctions(path: string): Promise<FileFunctionMetrics | null>;
        /** An analysis or a save measured the functions again (null: the folder changed). */
        onMetricsChanged(listener: (snapshot: FunctionMetricsSnapshot | null) => void): Unsubscribe;
    };
    /** #18, part 3: the user's keybinding rules (shared/keybindings.ts holds the format). */
    readonly keybindings: {
        get(): Promise<KeybindingsReport>;
        /** Replaces the rules; rejects a malformed one. Every window hears the change. */
        update(entries: readonly UserKeybinding[]): Promise<KeybindingsReport>;
        /**
         * The application menu's accelerators, by command ID (null: none), as
         * the renderer resolved them; the main process rebuilds the menu.
         */
        setMenuAccelerators(accelerators: Readonly<Record<string, string | null>>): Promise<void>;
        onDidChange(listener: (report: KeybindingsReport) => void): Unsubscribe;
    };
}

/** #174: lines added to a channel, or the channel cleared (`cleared`, with no lines). */
export interface OutputAppended {
    readonly channel: OutputChannelId;
    readonly lines: readonly string[];
    readonly cleared: boolean;
}

/** The user's keybinding rules, where they live and why some could not be read. */
export interface KeybindingsReport {
    readonly entries: readonly UserKeybinding[];
    readonly errors: readonly string[];
    /** The file's absolute path, to show (null in the smoke run, which keeps them in memory). */
    readonly file: string | null;
}

/** The settings in force, both files, and why a file could not be read. */
export interface SettingsReport extends SettingsSnapshot {
    readonly errors: readonly string[];
}

/**
 * Every IPC channel the main process answers. The preload may only invoke
 * these, and the main process registers a handler for exactly these.
 */
export const IPC_CHANNELS = {
    appGetInfo: 'codexr:app:get-info',
    workspaceOpenFolder: 'codexr:workspace:open-folder',
    workspaceCurrent: 'codexr:workspace:current',
    workspaceListDirectory: 'codexr:workspace:list-directory',
    workspaceListFiles: 'codexr:workspace:list-files',
    workspaceSearch: 'codexr:workspace:search',
    workspaceCancelSearch: 'codexr:workspace:cancel-search',
    workspaceReplaceInFiles: 'codexr:workspace:replace-in-files',
    workspaceReadFile: 'codexr:workspace:read-file',
    workspaceWriteFile: 'codexr:workspace:write-file',
    workspaceSetWatched: 'codexr:workspace:set-watched',
    workspaceReportUnsaved: 'codexr:workspace:report-unsaved',
    workspaceCreateEntry: 'codexr:workspace:create-entry',
    workspaceRename: 'codexr:workspace:rename',
    workspaceCopyPath: 'codexr:workspace:copy-path',
    workspaceReadImage: 'codexr:workspace:read-image',
    workspaceTrust: 'codexr:workspace:trust',
    workspaceSetTrust: 'codexr:workspace:set-trust',
    workspaceOpenExternalLink: 'codexr:workspace:open-external-link',
    settingsGet: 'codexr:settings:get',
    settingsUpdate: 'codexr:settings:update',
    settingsFolderFile: 'codexr:settings:folder-file',
    settingsPreviewTheme: 'codexr:settings:preview-theme',
    outputLines: 'codexr:output:lines',
    outputClear: 'codexr:output:clear',
    problemsFunctionMetrics: 'codexr:problems:function-metrics',
    problemsFileFunctions: 'codexr:problems:file-functions',
    keybindingsGet: 'codexr:keybindings:get',
    keybindingsUpdate: 'codexr:keybindings:update',
    keybindingsSetMenu: 'codexr:keybindings:set-menu',
    workspaceTrash: 'codexr:workspace:trash',
    workspaceRecentFolders: 'codexr:workspace:recent-folders',
    workspaceOpenRecent: 'codexr:workspace:open-recent',
    pythonStatus: 'codexr:python:status',
    pythonSetUp: 'codexr:python:set-up',
    pythonRemove: 'codexr:python:remove',
    analysisAnalyseProject: 'codexr:analysis:analyse-project',
    analysisAnalyseFile: 'codexr:analysis:analyse-file',
    analysisSetSceneBounds: 'codexr:analysis:set-scene-bounds',
    analysisCloseScene: 'codexr:analysis:close-scene',
    analysisGetAutoStart: 'codexr:analysis:get-auto-start',
    analysisSetAutoStart: 'codexr:analysis:set-auto-start',
    analysisShareScene: 'codexr:analysis:share-scene',
    analysisStopSharingScene: 'codexr:analysis:stop-sharing-scene',
    analysisCopySceneAddress: 'codexr:analysis:copy-scene-address',
    analysisRevealInScene: 'codexr:analysis:reveal-in-scene',
    analysisEnterXr: 'codexr:analysis:enter-xr',
    analysisOpenSceneInBrowser: 'codexr:analysis:open-scene-in-browser',
    analysisHeadsetLink: 'codexr:analysis:headset-link',
    terminalProfiles: 'codexr:terminal:profiles',
    terminalSetDefaultProfile: 'codexr:terminal:set-default-profile',
    terminalAddCustomProfile: 'codexr:terminal:add-custom-profile',
    terminalRemoveCustomProfile: 'codexr:terminal:remove-custom-profile',
    terminalCreate: 'codexr:terminal:create',
    terminalInput: 'codexr:terminal:input',
    terminalResize: 'codexr:terminal:resize',
    terminalKill: 'codexr:terminal:kill',
    // The AI agent hub keeps its own channel list in agents.ts.
    ...AGENT_IPC_CHANNELS,
    // #17: Source Control keeps its own channel list in git.ts.
    ...GIT_IPC_CHANNELS,
    // #21: the language client keeps its own channel list in lsp.ts.
    ...LSP_IPC_CHANNELS,
    // #176: tasks keep their own channel list in tasks.ts.
    ...TASK_IPC_CHANNELS,
    ...EXTENSION_IPC_CHANNELS,
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const ALLOWED_IPC_CHANNELS: ReadonlySet<string> = new Set(Object.values(IPC_CHANNELS));

/** Events the main process sends to the renderer (main -> renderer only, never invoked). */
export const IPC_EVENTS = {
    workspaceChanged: 'codexr:workspace:changed',
    command: 'codexr:command',
    workspaceFilesChanged: 'codexr:workspace:files-changed',
    workspaceTrustChanged: 'codexr:workspace:trust-changed',
    workspaceSearchResult: 'codexr:workspace:search-result',
    workspaceSearchDone: 'codexr:workspace:search-done',
    pythonStatusChanged: 'codexr:python:status-changed',
    hostNotification: 'codexr:host:notification',
    progress: 'codexr:progress',
    analysisSceneOpened: 'codexr:analysis:scene-opened',
    analysisSceneShareChanged: 'codexr:analysis:scene-share-changed',
    analysisSceneFilesChanged: 'codexr:analysis:scene-files-changed',
    analysisOpenInEditor: 'codexr:analysis:open-in-editor',
    terminalData: 'codexr:terminal:data',
    terminalExit: 'codexr:terminal:exit',
    settingsChanged: 'codexr:settings:changed',
    keybindingsChanged: 'codexr:keybindings:changed',
    outputAppended: 'codexr:output:appended',
    metricsChanged: 'codexr:problems:metrics-changed',
    ...AGENT_IPC_EVENTS,
    ...GIT_IPC_EVENTS,
    ...LSP_IPC_EVENTS,
    ...TASK_IPC_EVENTS,
    ...EXTENSION_IPC_EVENTS,
} as const;

/** The error message a refused `writeFile` carries when the file changed on disk. */
export const MODIFIED_ON_DISK = 'CODEXR_MODIFIED_ON_DISK';
