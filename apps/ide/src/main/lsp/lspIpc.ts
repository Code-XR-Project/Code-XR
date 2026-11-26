import type { IpcMainInvokeEvent } from 'electron';
import { LSP_IPC_CHANNELS } from '../../shared/lsp.ts';
import type { LspHost } from './lspHost.ts';

type Handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

/**
 * The main-process side of `window.codexr.lsp` (#21), registered through
 * ipc.ts's `handle` so the trusted-frame check applies. The host validates
 * every argument: URIs inside the calling window's folder, allow-listed
 * request methods, rebuilt parameters.
 */
export function registerLspHandlers(handle: Handle, lsp: LspHost): void {
    handle(LSP_IPC_CHANNELS.lspDidOpen, (event, uri, languageId, version, text) => lsp.didOpen(event.sender, uri, languageId, version, text));
    handle(LSP_IPC_CHANNELS.lspDidChange, (event, uri, version, text) => lsp.didChange(event.sender, uri, version, text));
    handle(LSP_IPC_CHANNELS.lspDidClose, (event, uri) => lsp.didClose(event.sender, uri));
    handle(LSP_IPC_CHANNELS.lspRequest, (event, method, params) => lsp.request(event.sender, method, params));
}
