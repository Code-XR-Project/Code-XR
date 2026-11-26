import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IDE_COMMANDS, IPC_CHANNELS, IPC_EVENTS, type CodeXRApi, type IdeCommand, type WatchedEntry, type WorkspaceInfo } from '../shared/api.ts';

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
const api: CodeXRApi = Object.freeze({
    app: Object.freeze({
        getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appGetInfo),
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
        onDidChange: (listener: (workspace: WorkspaceInfo | null) => void) => {
            const wrapped = (_event: IpcRendererEvent, workspace: WorkspaceInfo | null): void => listener(workspace);
            ipcRenderer.on(IPC_EVENTS.workspaceChanged, wrapped);
            return () => {
                ipcRenderer.removeListener(IPC_EVENTS.workspaceChanged, wrapped);
            };
        },
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
