import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { ALLOWED_IPC_CHANNELS, IPC_CHANNELS, type AppInfo } from '../shared/api.ts';
import { isTrustedIpcCall } from './security.ts';
import { log } from './log.ts';
import { currentWorkspaceInfo, pickAndOpenFolder, workspaceOf } from './workspace/workspaceWindows.ts';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/**
 * Registers the main-process side of `window.codexr`. Every handler goes
 * through `handle`, which refuses calls from frames outside the trusted
 * origins, so a handler never has to check its caller itself.
 */
export function registerIpcHandlers(origins: ReadonlySet<string>, isDevelopment: boolean): void {
    const registered = new Set<string>();
    const handle = (channel: string, handler: Handler): void => {
        if (!ALLOWED_IPC_CHANNELS.has(channel)) {
            throw new Error(`IPC channel ${channel} is not in IPC_CHANNELS.`);
        }
        ipcMain.handle(channel, (event, ...args) => {
            if (!isTrustedIpcCall(channel, event.senderFrame?.url, ALLOWED_IPC_CHANNELS, origins)) {
                log.warn(`Refused IPC ${channel} from ${event.senderFrame?.url ?? 'an unknown frame'}`);
                throw new Error('Refused.');
            }
            return handler(event, ...args);
        });
        registered.add(channel);
    };

    handle(IPC_CHANNELS.appGetInfo, (): AppInfo => ({
        name: 'Code-XR IDE',
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        versions: {
            electron: process.versions.electron ?? '',
            chrome: process.versions.chrome ?? '',
            node: process.versions.node,
        },
        isDevelopment,
    }));

    // #14: the folder open in the calling window. Paths are workspace-relative
    // and validated by Workspace; a window only ever reaches its own folder.
    handle(IPC_CHANNELS.workspaceOpenFolder, (event) => pickAndOpenFolder(event.sender));
    handle(IPC_CHANNELS.workspaceCurrent, (event) => currentWorkspaceInfo(event.sender));
    handle(IPC_CHANNELS.workspaceListDirectory, (event, path) => workspaceOf(event.sender).listDirectory(path));
    handle(IPC_CHANNELS.workspaceReadFile, (event, path) => workspaceOf(event.sender).readFile(path));

    // Every channel in the contract must have a handler: a missing one would
    // only surface as a rejected promise in the renderer.
    for (const channel of ALLOWED_IPC_CHANNELS) {
        if (!registered.has(channel)) {
            throw new Error(`IPC channel ${channel} has no handler.`);
        }
    }
}
