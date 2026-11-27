import { CLIENT_URI_SCHEME, LSP_EDIT_REFUSED } from '../../shared/lsp.ts';

/**
 * #287: a language server's `WorkspaceEdit` (rename, a code action) as the
 * text edits of each workspace file, and those edits applied to a file's
 * text. The main process already rebuilt the edit with renderer URIs and
 * refused anything outside the folder; this checks again on this side, so
 * the editor group never receives a path it would not open itself, and
 * refuses the whole edit rather than applying part of it. The writes go
 * through the workspace API, which checks the real path once more.
 * Pure (no Monaco), so it is unit-tested in Node.
 */

export interface LspRange {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
}

export interface FileTextEdit {
    readonly range: LspRange;
    readonly newText: string;
}

/** The edits of one file, by workspace path, with LSP's 0-based positions. */
export interface FileTextEdits {
    readonly path: string;
    readonly edits: readonly FileTextEdit[];
}

/** What applying an edit did: the files it changed, or why it changed none. */
export interface WorkspaceEditOutcome {
    readonly applied: readonly string[];
    readonly error?: string;
}

const CLIENT_PREFIX = `${CLIENT_URI_SCHEME}:/`;

function refuse(reason: string): never {
    throw new Error(`${LSP_EDIT_REFUSED}: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The workspace path a `codexr-file:` URI names (`codexr-file:/src/a%20b.ts`
 * -> `src/a b.ts`); throws for another scheme, an authority, a query, and any
 * path that could leave the folder (`..`, absolute, drive letters, `\`, NUL).
 */
export function clientUriPath(uri: unknown): string {
    if (typeof uri !== 'string' || !uri.startsWith(CLIENT_PREFIX)) {
        refuse('it names something that is not a file of the open folder.');
    }
    let encoded = uri.slice(CLIENT_PREFIX.length);
    if (encoded.startsWith('/')) {
        if (!encoded.startsWith('//')) {
            refuse('it names a file on another host.');
        }
        encoded = encoded.slice(2);
    }
    if (encoded.includes('?') || encoded.includes('#')) {
        refuse('it names something that is not a file of the open folder.');
    }
    let decoded: string;
    try {
        decoded = decodeURIComponent(encoded);
    } catch {
        refuse('it names a file with an invalid name.');
    }
    const segments = decoded.split('/');
    if (decoded === '' || segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0'))
        || /^[A-Za-z]:/.test(decoded)) {
        refuse('it changes a file outside the open folder.');
    }
    return segments.join('/');
}

function validPosition(value: unknown): { line: number; character: number } {
    if (!isRecord(value)) {
        refuse('a text change has an invalid range.');
    }
    const { line, character } = value;
    if (typeof line !== 'number' || typeof character !== 'number' || !Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) {
        refuse('a text change has an invalid range.');
    }
    return { line, character };
}

function textEdits(value: unknown): FileTextEdit[] {
    if (!Array.isArray(value)) {
        refuse('a file has no text changes.');
    }
    return value.map((edit): FileTextEdit => {
        if (!isRecord(edit) || typeof edit['newText'] !== 'string' || !isRecord(edit['range'])) {
            refuse('a text change is malformed.');
        }
        const range = edit['range'];
        return { range: { start: validPosition(range['start']), end: validPosition(range['end']) }, newText: edit['newText'] };
    });
}

/**
 * The files an edit changes, in the order it names them, each with its text
 * edits. Accepts `changes` and `documentChanges`; any create, rename or
 * delete of a file refuses the whole edit (the IDE does not let a server
 * touch files themselves), as does any URI outside the folder.
 */
export function workspaceEditFiles(edit: unknown): FileTextEdits[] {
    if (!isRecord(edit)) {
        refuse('the server sent something that is not an edit.');
    }
    const files = new Map<string, FileTextEdit[]>();
    const add = (uri: unknown, edits: unknown): void => {
        const path = clientUriPath(uri);
        const list = files.get(path) ?? [];
        list.push(...textEdits(edits));
        files.set(path, list);
    };
    const { changes, documentChanges } = edit;
    if (Array.isArray(documentChanges)) {
        for (const change of documentChanges) {
            if (!isRecord(change) || 'kind' in change) {
                refuse('it creates, renames or deletes files, which the Code-XR IDE does not let a language server do.');
            }
            add(isRecord(change['textDocument']) ? change['textDocument']['uri'] : undefined, change['edits']);
        }
    } else if (isRecord(changes)) {
        for (const [uri, edits] of Object.entries(changes)) {
            add(uri, edits);
        }
    } else if (changes !== undefined || documentChanges !== undefined) {
        refuse('its changes are malformed.');
    }
    return [...files].filter(([, edits]) => edits.length > 0).map(([path, edits]) => ({ path, edits }));
}

/** Offsets where each line of `text` starts; lines end at `\r\n`, `\n` or `\r`, as LSP counts them. */
function lineStarts(text: string): number[] {
    const starts = [0];
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code === 13 /* \r */) {
            if (text.charCodeAt(index + 1) === 10) {
                index++;
            }
            starts.push(index + 1);
        } else if (code === 10 /* \n */) {
            starts.push(index + 1);
        }
    }
    return starts;
}

/**
 * Applies LSP text edits to a file's text (a file that is not open): every
 * position is read against the original text, as LSP says, and overlapping
 * edits are refused. A position past the end of its line is the line's end,
 * and a line past the last is the end of the text, as servers expect.
 */
export function applyTextEdits(text: string, edits: readonly FileTextEdit[]): string {
    const starts = lineStarts(text);
    const offsetOf = (position: { line: number; character: number }): number => {
        const start = starts[position.line];
        if (start === undefined) {
            return text.length;
        }
        const next = starts[position.line + 1];
        let lineEnd = next === undefined ? text.length : next;
        // The line's own text stops before its line break.
        while (lineEnd > start && (text.charCodeAt(lineEnd - 1) === 10 || text.charCodeAt(lineEnd - 1) === 13)) {
            lineEnd--;
        }
        return Math.min(start + position.character, lineEnd);
    };
    const resolved = edits
        .map((edit, order) => ({ start: offsetOf(edit.range.start), end: offsetOf(edit.range.end), newText: edit.newText, order }))
        .sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order);
    let result = '';
    let cursor = 0;
    for (const edit of resolved) {
        if (edit.end < edit.start || edit.start < cursor) {
            refuse('two of its text changes overlap.');
        }
        result += text.slice(cursor, edit.start) + edit.newText;
        cursor = edit.end;
    }
    return result + text.slice(cursor);
}

/** "1 file" / "3 files". */
export function fileCount(count: number): string {
    return `${count} ${count === 1 ? 'file' : 'files'}`;
}

/** The reason an edit or a request was refused, without Electron's "Error invoking remote method" wrapping. */
export function refusalReason(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    const at = text.indexOf(LSP_EDIT_REFUSED);
    return at >= 0 ? text.slice(at) : text;
}
