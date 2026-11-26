import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IDE_COMMANDS, IPC_CHANNELS, IPC_EVENTS, type CodeXRApi, type HostNotification, type IdeCommand, type PythonEnvStatus, type TerminalDataEvent, type TerminalExitEvent, type Unsubscribe, type WatchedEntry, type WorkspaceInfo } from '../shared/api.ts';

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(IDE_COMMANDS);

/**
 * The only bridge between the sandboxed renderer and the rest of the IDE.
 *
 * It exposes a frozen, typed object as `window.codexr`. It never exposes
 * `ipcRenderer` itself, a generic `invoke(channel)` or any Node API: each
 * member maps to exactly one allow-listed channel, so the renderer cannot
 * reach a channel that is not in `IPC_CHANNELS`. Event subscriptions hand the
 * listener the payload only, never the Electron event (which carries `sender`).
 *
 * Sandboxed preloads may only require('electron'); everything else this file
 * imports is bundled into it by scripts/build.mjs.
 */
/** Subscribes to a main-to-renderer event, handing the listener the payload only. */
function subscribe<T>(event: string, listener: (payload: T) => void): Unsubscribe {
    const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload);
    ipcRenderer.on(event, wrapped);
    return () => {
        ipcRenderer.removeListener(event, wrapped);
    };
}

const api: CodeXRApi = Object.freeze({
    app: Object.freeze({
        getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appGetInfo),
        onNotification: (listener: (notification: HostNotification) => void) => subscribe(IPC_EVENTS.hostNotification, listener),
    }),
    python: Object.freeze({
        status: () => ipcRenderer.invoke(IPC_CHANNELS.pythonStatus),
        setUp: () => ipcRenderer.invoke(IPC_CHANNELS.pythonSetUp),
        remove: () => ipcRenderer.invoke(IPC_CHANNELS.pythonRemove),
        onDidChangeStatus: (listener: (status: PythonEnvStatus) => void) => subscribe(IPC_EVENTS.pythonStatusChanged, listener),
    }),
    workspace: Object.freeze({
        openFolder: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenFolder),
        current: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceCurrent),
        listDirectory: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceListDirectory, path),
        readFile: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceReadFile, path),
        writeFile: (path: string, text: string, expectedMtimeMs?: number) =>
            ipcRenderer.invoke(IPC_CHANNELS.workspaceWriteFile, path, text, expectedMtimeMs),
        setWatched: (entries: readonly WatchedEntry[]) => ipcRenderer.invoke(IPC_CHANNELS.workspaceSetWatched, entries),
        onDidChangeFiles: (listener: (paths: readonly string[]) => void) => {
            const wrapped = (_event: IpcRendererEvent, paths: readonly string[]): void => listener(paths);
            ipcRenderer.on(IPC_EVENTS.workspaceFilesChanged, wrapped);
            return () => {
                ipcRenderer.removeListener(IPC_EVENTS.workspaceFilesChanged, wrapped);
            };
        },
        reportUnsaved: (count: number) => ipcRenderer.invoke(IPC_CHANNELS.workspaceReportUnsaved, count),
        createEntry: (parent: string, name: string, kind: 'file' | 'directory') =>
            ipcRenderer.invoke(IPC_CHANNELS.workspaceCreateEntry, parent, name, kind),
        rename: (path: string, newName: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceRename, path, newName),
        trash: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceTrash, path),
        recentFolders: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceRecentFolders),
        openRecent: (folder: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenRecent, folder),
        onDidChange: (listener: (workspace: WorkspaceInfo | null) => void) => {
            const wrapped = (_event: IpcRendererEvent, workspace: WorkspaceInfo | null): void => listener(workspace);
            ipcRenderer.on(IPC_EVENTS.workspaceChanged, wrapped);
            return () => {
                ipcRenderer.removeListener(IPC_EVENTS.workspaceChanged, wrapped);
            };
        },
    }),
    // #137: only profile ids cross this bridge, never an executable path or a pty handle.
    terminal: Object.freeze({
        profiles: () => ipcRenderer.invoke(IPC_CHANNELS.terminalProfiles),
        setDefaultProfile: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.terminalSetDefaultProfile, profileId),
        addCustomProfile: (args: string) => ipcRenderer.invoke(IPC_CHANNELS.terminalAddCustomProfile, args),
        removeCustomProfile: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.terminalRemoveCustomProfile, profileId),
        create: (profileId: string | null, cols: number, rows: number) => ipcRenderer.invoke(IPC_CHANNELS.terminalCreate, profileId, cols, rows),
        input: (id: number, data: string) => ipcRenderer.invoke(IPC_CHANNELS.terminalInput, id, data),
        resize: (id: number, cols: number, rows: number) => ipcRenderer.invoke(IPC_CHANNELS.terminalResize, id, cols, rows),
        kill: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.terminalKill, id),
        onData: (listener: (event: TerminalDataEvent) => void) => subscribe(IPC_EVENTS.terminalData, listener),
        onExit: (listener: (event: TerminalExitEvent) => void) => subscribe(IPC_EVENTS.terminalExit, listener),
    }),
    commands: Object.freeze({
        onCommand: (listener: (command: IdeCommand) => void) => {
            const wrapped = (_event: IpcRendererEvent, command: unknown): void => {
                if (typeof command === 'string' && KNOWN_COMMANDS.has(command)) {
                    listener(command as IdeCommand);
                }
            };
            ipcRenderer.on(IPC_EVENTS.command, wrapped);
            return () => {
                ipcRenderer.removeListener(IPC_EVENTS.command, wrapped);
            };
        },
    }),
});

contextBridge.exposeInMainWorld('codexr', api);
