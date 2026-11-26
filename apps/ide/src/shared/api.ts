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

/** A file read for the editor. Binary and oversized files are reported, not sent. */
export type FileContent =
    | { readonly kind: 'text'; readonly path: string; readonly text: string; readonly mtimeMs: number }
    | { readonly kind: 'binary' | 'too-large'; readonly path: string; readonly size: number };

/** Unsubscribes a listener registered with an `on…` member. */
export type Unsubscribe = () => void;

/**
 * What `window.codexr` offers the renderer. Every member returns a promise,
 * except the `on…` subscriptions, which return their `Unsubscribe`.
 */
export interface CodeXRApi {
    readonly app: {
        getInfo(): Promise<AppInfo>;
    };
    readonly workspace: {
        /** Shows the folder picker; resolves with the new workspace, or null when cancelled. */
        openFolder(): Promise<WorkspaceInfo | null>;
        /** The workspace open in this window, if any. */
        current(): Promise<WorkspaceInfo | null>;
        /** The children of a workspace folder, folders first, then by name. */
        listDirectory(path: string): Promise<readonly DirEntry[]>;
        readFile(path: string): Promise<FileContent>;
        /** Fires when the workspace changes from outside the renderer (File > Open Folder…). */
        onDidChange(listener: (workspace: WorkspaceInfo | null) => void): Unsubscribe;
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
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const ALLOWED_IPC_CHANNELS: ReadonlySet<string> = new Set(Object.values(IPC_CHANNELS));

/** Events the main process sends to the renderer (main -> renderer only, never invoked). */
export const IPC_EVENTS = {
    workspaceChanged: 'codexr:workspace:changed',
} as const;
