import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type CodeXRApi } from '../shared/api.ts';

/**
 * The only bridge between the sandboxed renderer and the rest of the IDE.
 *
 * It exposes a frozen, typed object as `window.codexr`. It never exposes
 * `ipcRenderer` itself, a generic `invoke(channel)` or any Node API: each
 * member maps to exactly one allow-listed channel, so the renderer cannot
 * reach a channel that is not in `IPC_CHANNELS`.
 *
 * Sandboxed preloads may only require('electron'); everything else this file
 * imports is bundled into it by scripts/build.mjs.
 */
const api: CodeXRApi = Object.freeze({
    app: Object.freeze({
        getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appGetInfo),
    }),
});

contextBridge.exposeInMainWorld('codexr', api);
