/**
 * Language intelligence (#21): the contract between the renderer's Monaco
 * bridge and the language servers the main process runs.
 *
 * The renderer names documents by their Monaco URI (`codexr-file:/<path>`,
 * the path relative to the open folder) and never by a file path; the main
 * process maps them to `file://` URIs inside the folder and back. It can only
 * open, change and close documents, send requests whose method is listed in
 * `LSP_REQUEST_METHODS`, and hear diagnostics. It never names an executable,
 * a server or a command line.
 *
 * Shared by main, preload and renderer: no imports.
 */

/** The Monaco URI scheme of a workspace file (renderer/editor/editorGroup.ts). */
export const CLIENT_URI_SCHEME = 'codexr-file';

/** Monaco languages that have a language server. */
export const LSP_LANGUAGES = ['typescript', 'javascript', 'python'] as const;
export type LspLanguage = (typeof LSP_LANGUAGES)[number];

export function isLspLanguage(value: unknown): value is LspLanguage {
    return typeof value === 'string' && (LSP_LANGUAGES as readonly string[]).includes(value);
}

/** The servers, one per language family: TypeScript also serves JavaScript. */
export type LspServerId = 'typescript' | 'python';

export function serverIdOf(language: LspLanguage): LspServerId {
    return language === 'python' ? 'python' : 'typescript';
}

/**
 * The only requests the renderer may send. Everything else (commands,
 * `workspace/executeCommand`, file operations, anything a server could run)
 * is refused before it reaches a server. Rename and code actions only
 * compute edits: the server's `WorkspaceEdit` comes back mapped to workspace
 * URIs (refused whole when it names a file outside the folder or creates,
 * renames or deletes one), and the renderer applies it through the editor
 * group (#287).
 */
export const LSP_REQUEST_METHODS = [
    'textDocument/hover',
    'textDocument/completion',
    'completionItem/resolve',
    'textDocument/definition',
    'textDocument/documentSymbol',
    // #287: references, rename, signature help, highlights, quick fixes, workspace symbols.
    'textDocument/references',
    'textDocument/prepareRename',
    'textDocument/rename',
    'textDocument/signatureHelp',
    'textDocument/documentHighlight',
    'textDocument/codeAction',
    'workspace/symbol',
] as const;
export type LspRequestMethod = (typeof LSP_REQUEST_METHODS)[number];

export function isLspRequestMethod(value: unknown): value is LspRequestMethod {
    return typeof value === 'string' && (LSP_REQUEST_METHODS as readonly string[]).includes(value);
}

/** A server's diagnostics for one document, its URI already the renderer's. */
export interface LspDiagnosticsEvent {
    readonly uri: string;
    /** LSP `Diagnostic` objects (vscode-languageserver-types), with the URIs inside mapped too. */
    readonly diagnostics: readonly unknown[];
}

/** Unsubscribes an `on...` listener (same shape as api.ts's `Unsubscribe`). */
export type LspUnsubscribe = () => void;

export interface LspApi {
    /** A document opened in the editor; starts its language's server on first use. */
    didOpen(uri: string, languageId: LspLanguage, version: number, text: string): Promise<void>;
    /** The document's whole new text (full sync). */
    didChange(uri: string, version: number, text: string): Promise<void>;
    didClose(uri: string): Promise<void>;
    /** A request from the allowlist; resolves with the server's result, URIs mapped, or null. */
    request(method: LspRequestMethod, params: unknown): Promise<unknown>;
    onDiagnostics(listener: (event: LspDiagnosticsEvent) => void): LspUnsubscribe;
}

/** Channels of the language client; api.ts merges them into IPC_CHANNELS. */
export const LSP_IPC_CHANNELS = {
    lspDidOpen: 'codexr:lsp:did-open',
    lspDidChange: 'codexr:lsp:did-change',
    lspDidClose: 'codexr:lsp:did-close',
    lspRequest: 'codexr:lsp:request',
} as const;

/** Main -> renderer events of the language client; api.ts merges them into IPC_EVENTS. */
export const LSP_IPC_EVENTS = {
    lspDiagnostics: 'codexr:lsp:diagnostics',
} as const;

/**
 * #287: the start of the error message of an edit the main process refused
 * (a file outside the folder, a file created, renamed or deleted); the
 * renderer shows the message rather than applying part of the edit.
 */
export const LSP_EDIT_REFUSED = 'Refused workspace edit';

/** The marker owner of language-server diagnostics in Monaco (the Problems panel lists it). */
export const LSP_MARKER_OWNER = 'codexr-lsp';
