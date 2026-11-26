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
export const IDE_COMMANDS = ['workspace.openFolder', 'file.newFile', 'file.newFolder', 'file.save', 'file.saveAll', 'editor.close'] as const;
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
    readonly app: {
        getInfo(): Promise<AppInfo>;
        /** Messages from the core (environment set up, a server stopped ...). */
        onNotification(listener: (notification: HostNotification) => void): Unsubscribe;
    };
    readonly python: {
        /** Checks the environment again (runs Python, never downloads). */
        status(): Promise<PythonEnvStatus>;
        /**
         * Sets up or repairs the environment. The main process first asks in a
         * native dialog that lists what will be downloaded; resolves with the
         * new status, unchanged when the person declines.
         */
        setUp(): Promise<PythonEnvStatus>;
        /** Deletes the environment after a native confirmation. */
        remove(): Promise<PythonEnvStatus>;
        onDidChangeStatus(listener: (status: PythonEnvStatus) => void): Unsubscribe;
    };
    readonly workspace: {
        /** Shows the folder picker; resolves with the new workspace, or null when cancelled. */
        openFolder(): Promise<WorkspaceInfo | null>;
        /** The workspace open in this window, if any. */
        current(): Promise<WorkspaceInfo | null>;
        /** The children of a workspace folder, folders first, then by name. */
        listDirectory(path: string): Promise<readonly DirEntry[]>;
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
        /** Recently opened folders, most recent first (absolute paths, for display and `openRecent`). */
        recentFolders(): Promise<readonly string[]>;
        /** Opens a folder from `recentFolders()`; any other path is refused. */
        openRecent(folder: string): Promise<WorkspaceInfo>;
        /** Fires when the workspace changes from outside the renderer (`--folder=` at startup, File > Open Recent). */
        onDidChange(listener: (workspace: WorkspaceInfo | null) => void): Unsubscribe;
    };
    readonly commands: {
        /** Menu commands for the renderer to run (Open Folder…, Save, Save All, Close Editor). */
        onCommand(listener: (command: IdeCommand) => void): Unsubscribe;
    };
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
    workspaceReadFile: 'codexr:workspace:read-file',
    workspaceWriteFile: 'codexr:workspace:write-file',
    workspaceSetWatched: 'codexr:workspace:set-watched',
    workspaceReportUnsaved: 'codexr:workspace:report-unsaved',
    workspaceCreateEntry: 'codexr:workspace:create-entry',
    workspaceRename: 'codexr:workspace:rename',
    workspaceTrash: 'codexr:workspace:trash',
    workspaceRecentFolders: 'codexr:workspace:recent-folders',
    workspaceOpenRecent: 'codexr:workspace:open-recent',
    pythonStatus: 'codexr:python:status',
    pythonSetUp: 'codexr:python:set-up',
    pythonRemove: 'codexr:python:remove',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const ALLOWED_IPC_CHANNELS: ReadonlySet<string> = new Set(Object.values(IPC_CHANNELS));

/** Events the main process sends to the renderer (main -> renderer only, never invoked). */
export const IPC_EVENTS = {
    workspaceChanged: 'codexr:workspace:changed',
    command: 'codexr:command',
    workspaceFilesChanged: 'codexr:workspace:files-changed',
    pythonStatusChanged: 'codexr:python:status-changed',
    hostNotification: 'codexr:host:notification',
} as const;

/** The error message a refused `writeFile` carries when the file changed on disk. */
export const MODIFIED_ON_DISK = 'CODEXR_MODIFIED_ON_DISK';
