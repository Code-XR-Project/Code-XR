import { isLspLanguage, isLspRequestMethod, type LspLanguage, type LspRequestMethod, type LspServerId } from '../../shared/lsp.ts';

/**
 * What the renderer may ask a language server (#21), checked and rebuilt in
 * the main process. Nothing the page sends reaches a server as it came: a
 * request is refused unless its method is in `LSP_REQUEST_METHODS`, and its
 * parameters are rebuilt from validated fields, with the document URI mapped
 * by the caller (which refuses anything outside the folder). Pure, so it is
 * unit-tested in Node.
 */

/** Largest document the client syncs (the editor refuses files above 5 MB anyway). */
export const MAX_DOCUMENT_CHARS = 10 * 1024 * 1024;
const MAX_POSITION = 10_000_000;
/** A completion item sent back for resolving, as JSON. */
const MAX_RESOLVE_ITEM_CHARS = 200_000;

export interface DocumentRequest {
    readonly method: Exclude<LspRequestMethod, 'completionItem/resolve'>;
    readonly params: Record<string, unknown>;
    /** The server URI of the document the request is about. */
    readonly serverUri: string;
}

export function assertRequestMethod(method: unknown): LspRequestMethod {
    if (!isLspRequestMethod(method)) {
        throw new Error(`Refused language server request: ${typeof method === 'string' ? method.slice(0, 80) : typeof method}`);
    }
    return method;
}

export function assertLanguage(language: unknown): LspLanguage {
    if (!isLspLanguage(language)) {
        throw new Error('No language server for this language.');
    }
    return language;
}

export function assertVersion(version: unknown): number {
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
        throw new Error('Invalid document version.');
    }
    return version;
}

export function assertText(text: unknown): string {
    if (typeof text !== 'string' || text.length > MAX_DOCUMENT_CHARS) {
        throw new Error('Invalid document text.');
    }
    return text;
}

function record(value: unknown, what: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`Invalid ${what}.`);
    }
    return value as Record<string, unknown>;
}

function position(value: unknown): { line: number; character: number } {
    const { line, character } = record(value, 'position');
    for (const n of [line, character]) {
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_POSITION) {
            throw new Error('Invalid position.');
        }
    }
    return { line: line as number, character: character as number };
}

function completionContext(value: unknown): { triggerKind: number; triggerCharacter?: string } | undefined {
    if (value === undefined) {
        return undefined;
    }
    const { triggerKind, triggerCharacter } = record(value, 'completion context');
    if (triggerKind !== 1 && triggerKind !== 2 && triggerKind !== 3) {
        throw new Error('Invalid completion trigger.');
    }
    if (triggerCharacter === undefined) {
        return { triggerKind };
    }
    if (typeof triggerCharacter !== 'string' || triggerCharacter.length === 0 || triggerCharacter.length > 4) {
        throw new Error('Invalid completion trigger character.');
    }
    return { triggerKind, triggerCharacter };
}

/**
 * Rebuilds the parameters of a request about one document. `toServerUri`
 * maps the renderer's URI and throws outside the workspace.
 */
export function buildDocumentRequest(method: Exclude<LspRequestMethod, 'completionItem/resolve'>, params: unknown, toServerUri: (clientUri: unknown) => string): DocumentRequest {
    const input = record(params, 'request parameters');
    const serverUri = toServerUri(record(input['textDocument'], 'document').uri);
    const textDocument = { uri: serverUri };
    switch (method) {
        case 'textDocument/documentSymbol':
            return { method, params: { textDocument }, serverUri };
        case 'textDocument/completion': {
            const context = completionContext(input['context']);
            return { method, params: { textDocument, position: position(input['position']), ...(context ? { context } : {}) }, serverUri };
        }
        case 'textDocument/hover':
        case 'textDocument/definition':
            return { method, params: { textDocument, position: position(input['position']) }, serverUri };
    }
}

/**
 * Completion items carry server data back for `completionItem/resolve`
 * (typescript-language-server puts absolute file paths in it). The renderer
 * gets an opaque token instead, and a resolve is sent with the data the
 * server gave, to the server that gave it, so the page can neither read nor
 * forge it. Only the latest completion list of a window is kept.
 */
export class CompletionDataStore {
    private entries = new Map<number, { readonly server: LspServerId; readonly data: unknown }>();
    private next = 1;

    /** Replaces each item's `data` with a token; returns the result changed in place. */
    tokenize(result: unknown, server: LspServerId): unknown {
        this.entries = new Map();
        const items = Array.isArray(result) ? result : isRecord(result) && Array.isArray(result['items']) ? result['items'] : [];
        for (const item of items) {
            if (isRecord(item) && 'data' in item) {
                const id = this.next++;
                this.entries.set(id, { server, data: item['data'] });
                item['data'] = { codexrCompletion: id };
            }
        }
        return result;
    }

    /** The item to resolve with its server data restored, and the token to put back; null when unknown. */
    restore(item: unknown): { readonly server: LspServerId; readonly item: Record<string, unknown>; readonly token: unknown } | null {
        if (!isRecord(item) || JSON.stringify(item).length > MAX_RESOLVE_ITEM_CHARS) {
            return null;
        }
        const token = item['data'];
        const id = isRecord(token) ? token['codexrCompletion'] : undefined;
        const entry = typeof id === 'number' ? this.entries.get(id) : undefined;
        if (!entry) {
            return null;
        }
        return { server: entry.server, item: { ...item, data: entry.data }, token };
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * How many times a crashed server is restarted: at most `max` within
 * `windowMs`; past that it stays down and the Output panel says so.
 */
export class RestartBudget {
    private readonly max: number;
    private readonly windowMs: number;
    private readonly restarts: number[] = [];

    constructor(max = 3, windowMs = 3 * 60_000) {
        this.max = max;
        this.windowMs = windowMs;
    }

    /** Records a crash at `now`; true when the server may be restarted. */
    allow(now: number): boolean {
        while (this.restarts.length > 0 && now - (this.restarts[0] ?? 0) > this.windowMs) {
            this.restarts.shift();
        }
        if (this.restarts.length >= this.max) {
            return false;
        }
        this.restarts.push(now);
        return true;
    }
}

/** The LSP language id of a document, from its path (TypeScript tells JSX from plain files by it). */
export function lspLanguageId(language: LspLanguage, workspacePath: string): string {
    const lower = workspacePath.toLowerCase();
    if (language === 'typescript') {
        return lower.endsWith('.tsx') ? 'typescriptreact' : 'typescript';
    }
    if (language === 'javascript') {
        return lower.endsWith('.jsx') ? 'javascriptreact' : 'javascript';
    }
    return 'python';
}
