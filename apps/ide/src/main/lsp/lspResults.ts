import { LSP_EDIT_REFUSED } from '../../shared/lsp.ts';
import type { DocumentRequestMethod } from './lspProtocol.ts';
import { validRange } from './lspProtocol.ts';
import { mapServerUris } from './lspUri.ts';

/**
 * What a language server answers, made safe for the renderer (#21, #287).
 * Locations go through `mapServerUris` (anything outside the folder is
 * dropped). Edits are stricter: a `WorkspaceEdit` from rename or a code
 * action is rebuilt as plain text edits per renderer URI, and refused whole
 * when one file it touches is outside the folder or when it creates, renames
 * or deletes a file, because half a rename leaves code that does not build.
 * Code actions keep their edit only: their commands (which would need
 * `workspace/executeCommand`, refused) and their server data are dropped.
 * Pure, so it is unit-tested in Node.
 */

/** A rebuilt edit: the text edits of each file, by renderer URI. */
export interface ClientWorkspaceEdit {
    readonly changes: Record<string, ClientTextEdit[]>;
}

export interface ClientTextEdit {
    readonly range: { start: { line: number; character: number }; end: { line: number; character: number } };
    readonly newText: string;
}

/** A code action the renderer may apply: its edit, or the reason it cannot. */
export interface ClientCodeAction {
    readonly title: string;
    readonly kind?: string;
    readonly isPreferred?: boolean;
    readonly disabled?: string;
    readonly edit?: ClientWorkspaceEdit;
}

const MAX_EDIT_FILES = 2_000;
const MAX_TEXT_EDITS = 100_000;
const MAX_EDIT_CHARS = 20 * 1024 * 1024;
const MAX_CODE_ACTIONS = 200;
const MAX_WORKSPACE_SYMBOLS = 1_000;
const MAX_TITLE_CHARS = 1_000;

type ToClient = (serverUri: string) => string | null;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuse(reason: string): never {
    throw new Error(`${LSP_EDIT_REFUSED}: ${reason}`);
}

/**
 * A server's `WorkspaceEdit` (`changes` or `documentChanges`) as text edits
 * per renderer URI; null for no edit. Throws `LSP_EDIT_REFUSED` when it
 * leaves the folder, operates on files, or is malformed.
 */
export function mapWorkspaceEdit(edit: unknown, toClient: ToClient): ClientWorkspaceEdit | null {
    if (edit === null || edit === undefined) {
        return null;
    }
    if (!isRecord(edit)) {
        refuse('the server sent something that is not an edit.');
    }
    const files = new Map<string, ClientTextEdit[]>();
    let count = 0;
    let chars = 0;
    const add = (serverUri: unknown, edits: unknown): void => {
        if (typeof serverUri !== 'string') {
            refuse('an edit names no file.');
        }
        const uri = toClient(serverUri);
        if (uri === null) {
            refuse('it changes a file outside the open folder.');
        }
        if (!Array.isArray(edits)) {
            refuse('an edit has no text changes.');
        }
        const list = files.get(uri) ?? [];
        if (!files.has(uri)) {
            if (files.size >= MAX_EDIT_FILES) {
                refuse('it changes too many files.');
            }
            files.set(uri, list);
        }
        for (const textEdit of edits) {
            if (!isRecord(textEdit) || typeof textEdit['newText'] !== 'string') {
                refuse('a text change is malformed.');
            }
            let range;
            try {
                range = validRange(textEdit['range']);
            } catch {
                refuse('a text change has an invalid range.');
            }
            count++;
            chars += textEdit['newText'].length;
            if (count > MAX_TEXT_EDITS || chars > MAX_EDIT_CHARS) {
                refuse('it is too large.');
            }
            list.push({ range, newText: textEdit['newText'] });
        }
    };
    const documentChanges = edit['documentChanges'];
    if (documentChanges !== undefined && documentChanges !== null) {
        if (!Array.isArray(documentChanges)) {
            refuse('its document changes are malformed.');
        }
        for (const change of documentChanges) {
            if (!isRecord(change)) {
                refuse('a document change is malformed.');
            }
            if ('kind' in change) {
                // CreateFile, RenameFile, DeleteFile: the IDE does not let a server touch files themselves.
                refuse('it creates, renames or deletes files, which the Code-XR IDE does not let a language server do.');
            }
            add(isRecord(change['textDocument']) ? change['textDocument']['uri'] : undefined, change['edits']);
        }
    } else if (edit['changes'] !== undefined && edit['changes'] !== null) {
        if (!isRecord(edit['changes'])) {
            refuse('its changes are malformed.');
        }
        for (const [serverUri, edits] of Object.entries(edit['changes'])) {
            add(serverUri, edits);
        }
    }
    return { changes: Object.fromEntries(files) };
}

/**
 * A code action answer as actions with their edit. Bare commands and actions
 * that only run a command are left out (`workspace/executeCommand` is
 * refused); an action whose edit is refused stays, disabled, with the reason.
 */
export function mapCodeActions(result: unknown, toClient: ToClient): ClientCodeAction[] {
    if (!Array.isArray(result)) {
        return [];
    }
    const actions: ClientCodeAction[] = [];
    for (const item of result.slice(0, MAX_CODE_ACTIONS)) {
        if (!isRecord(item) || typeof item['title'] !== 'string' || typeof item['command'] === 'string' || item['edit'] === undefined) {
            continue;
        }
        const title = item['title'].slice(0, MAX_TITLE_CHARS);
        const kind = typeof item['kind'] === 'string' && item['kind'].length <= 200 ? item['kind'] : undefined;
        const serverDisabled = isRecord(item['disabled']) && typeof item['disabled']['reason'] === 'string' ? item['disabled']['reason'].slice(0, MAX_TITLE_CHARS) : undefined;
        const base = { title, ...(kind !== undefined ? { kind } : {}), ...(item['isPreferred'] === true ? { isPreferred: true } : {}) };
        let edit: ClientWorkspaceEdit | null;
        try {
            edit = mapWorkspaceEdit(item['edit'], toClient);
        } catch (error) {
            actions.push({ ...base, disabled: error instanceof Error ? error.message : String(error) });
            continue;
        }
        if (!edit) {
            continue;
        }
        actions.push({ ...base, ...(serverDisabled !== undefined ? { disabled: serverDisabled } : {}), edit });
    }
    return actions;
}

/** One workspace symbol for quick open's "#": a name and a place inside the folder. */
export interface ClientWorkspaceSymbol {
    readonly name: string;
    readonly kind: number;
    readonly containerName?: string;
    readonly location: { readonly uri: string; readonly range: ClientTextEdit['range'] };
}

/**
 * `workspace/symbol` answers (SymbolInformation or WorkspaceSymbol) as
 * symbols with a range inside the folder; those outside it (libraries), or
 * without a range (they would need a resolve), are left out, and so is any
 * server data.
 */
export function mapWorkspaceSymbols(result: unknown, toClient: ToClient): ClientWorkspaceSymbol[] {
    if (!Array.isArray(result)) {
        return [];
    }
    const symbols: ClientWorkspaceSymbol[] = [];
    for (const item of result) {
        if (symbols.length >= MAX_WORKSPACE_SYMBOLS) {
            break;
        }
        if (!isRecord(item) || typeof item['name'] !== 'string' || typeof item['kind'] !== 'number' || !isRecord(item['location'])) {
            continue;
        }
        const location = item['location'];
        const uri = typeof location['uri'] === 'string' ? toClient(location['uri']) : null;
        if (uri === null) {
            continue;
        }
        let range;
        try {
            range = validRange(location['range']);
        } catch {
            continue;
        }
        const container = item['containerName'];
        symbols.push({
            name: item['name'].slice(0, MAX_TITLE_CHARS),
            kind: item['kind'],
            ...(typeof container === 'string' && container !== '' ? { containerName: container.slice(0, MAX_TITLE_CHARS) } : {}),
            location: { uri, range },
        });
    }
    return symbols;
}

/** A document request's answer, mapped for the renderer (completion tokens are handled by the caller). */
export function mapDocumentResult(method: DocumentRequestMethod, result: unknown, toClient: ToClient): unknown {
    switch (method) {
        case 'textDocument/rename':
            return mapWorkspaceEdit(result, toClient);
        case 'textDocument/codeAction':
            return mapCodeActions(result, toClient);
        default:
            return mapServerUris(result, toClient);
    }
}
