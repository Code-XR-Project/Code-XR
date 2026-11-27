import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DocumentEvent, EditorStateData, RangeData, SelectionData } from '../shared/extensionLanguageProtocol.ts';
import { MAX_DOCUMENT_EVENTS } from '../shared/extensionLanguageProtocol.ts';
import type { ExtensionHost } from './host.ts';
import { TextDocumentModel } from './textDocument.ts';
import { EventEmitter, Position, Range, Selection, SnippetString, TabInputText, TextEdit, TextEditorSelectionChangeKind, Uri, WorkspaceEdit } from './types.ts';

/**
 * The editor's documents and its active editor as extensions see them
 * (#260): `workspace.textDocuments` and its events, `window.activeTextEditor`
 * and its events. The renderer reports every change (documentSync.ts); this
 * keeps one `TextDocument` per open file, shared by every extension, and
 * applies each change in order, so a document's text is the editor's.
 *
 * Edits go the other way through the workbench (`applyEdit`), never to disk
 * directly, so unsaved text and undo stay right; the change then comes back
 * as an ordinary change event before `applyEdit` resolves.
 */

export interface TextDocumentChangeEvent {
    readonly document: TextDocumentModel;
    readonly contentChanges: readonly { readonly range: Range; readonly rangeOffset: number; readonly rangeLength: number; readonly text: string }[];
    readonly reason: undefined;
}

const toRange = (data: RangeData): Range => new Range(data[0], data[1], data[2], data[3]);
const toSelection = (data: SelectionData): Selection => new Selection(data.anchor[0], data.anchor[1], data.active[0], data.active[1]);
export const rangeData = (range: Range): RangeData => [range.start.line, range.start.character, range.end.line, range.end.character];

/** `TextEditor.edit`'s builder: collects the edits, applied together once the callback returns. */
class EditBuilder {
    readonly edits: TextEdit[] = [];

    replace(location: Position | Range | Selection, value: string): void {
        const range = location instanceof Position ? new Range(location, location) : location;
        this.edits.push(new TextEdit(range, String(value)));
    }
    insert(location: Position, value: string): void {
        this.edits.push(new TextEdit(new Range(location, location), String(value)));
    }
    delete(location: Range | Selection): void {
        this.edits.push(new TextEdit(location, ''));
    }
    setEndOfLine(): void {
        // The workbench changes line endings from its status bar; an extension cannot yet.
    }
}

export class TextEditorImpl {
    readonly document: TextDocumentModel;
    selections: Selection[];
    visibleRanges: Range[];
    options: { tabSize: number; insertSpaces: boolean };
    readonly viewColumn = 1;
    private readonly host: ExtensionHost;

    constructor(host: ExtensionHost, document: TextDocumentModel, state: EditorStateData | null) {
        this.host = host;
        this.document = document;
        this.selections = state && state.selections.length > 0 ? state.selections.map(toSelection) : [new Selection(0, 0, 0, 0)];
        this.visibleRanges = state ? state.visibleRanges.map(toRange) : [];
        this.options = { tabSize: state?.tabSize ?? 4, insertSpaces: state?.insertSpaces ?? true };
    }

    get selection(): Selection {
        return this.selections[0] as Selection;
    }
    set selection(value: Selection) {
        this.selections = [value];
    }

    async edit(callback: (builder: EditBuilder) => void): Promise<boolean> {
        const builder = new EditBuilder();
        callback(builder);
        if (builder.edits.length === 0) {
            return true;
        }
        const edit = new WorkspaceEdit();
        edit.set(this.document.uri, builder.edits);
        return this.host.documentsAndEditors.applyEdit(edit);
    }

    async insertSnippet(snippet: SnippetString | string, location?: Position | Range | readonly (Position | Range)[]): Promise<boolean> {
        const value = snippet instanceof SnippetString ? snippet.value : String(snippet);
        const locations = location === undefined ? undefined : Array.isArray(location) ? location : [location];
        const ranges = locations?.map((item) => rangeData(item instanceof Position ? new Range(item, item) : item as Range));
        if (this.document.uri.scheme !== 'file') {
            return false;
        }
        const answer = await this.host.ui({ kind: 'insertSnippet', path: this.document.uri.fsPath, snippet: value, ...(ranges ? { ranges } : {}) });
        return answer === true;
    }

    setDecorations(): void {
        // Decorations need styles the renderer does not take from extensions yet (#260 follow-up).
    }

    revealRange(range: Range): void {
        if (this.document.uri.scheme === 'file') {
            void this.host.ui({ kind: 'openFile', path: this.document.uri.fsPath, preview: false, line: range.start.line + 1, column: range.start.character + 1 }).catch(() => undefined);
        }
    }

    show(): void {
        this.revealRange(this.selection);
    }

    hide(): void {
        // The workbench owns its tabs.
    }
}

export class DocumentsAndEditors {
    readonly onDidOpenTextDocument = new EventEmitter<TextDocumentModel>();
    readonly onDidCloseTextDocument = new EventEmitter<TextDocumentModel>();
    readonly onDidChangeTextDocument = new EventEmitter<TextDocumentChangeEvent>();
    readonly onDidSaveTextDocument = new EventEmitter<TextDocumentModel>();
    readonly onDidChangeActiveTextEditor = new EventEmitter<TextEditorImpl | undefined>();
    readonly onDidChangeVisibleTextEditors = new EventEmitter<readonly TextEditorImpl[]>();
    readonly onDidChangeTextEditorSelection = new EventEmitter<{ textEditor: TextEditorImpl; selections: readonly Selection[]; kind: number | undefined }>();
    readonly onDidChangeTextEditorVisibleRanges = new EventEmitter<{ textEditor: TextEditorImpl; visibleRanges: readonly Range[] }>();
    readonly onDidChangeTabs = new EventEmitter<{ opened: readonly unknown[]; closed: readonly unknown[]; changed: readonly unknown[] }>();
    readonly onDidChangeTabGroups = new EventEmitter<{ opened: readonly unknown[]; closed: readonly unknown[]; changed: readonly unknown[] }>();
    /** Uris (as strings) of the documents the editor has open. */
    private readonly editorDocuments = new Set<string>();
    /**
     * `window.tabGroups`: one group whose tabs are the editor's open
     * documents (each tab has a model). Language clients use it to know which
     * documents are visible (pull diagnostics).
     */
    readonly tabGroups = this.createTabGroups();
    private active: TextEditorImpl | undefined;
    private readonly host: ExtensionHost;

    constructor(host: ExtensionHost) {
        this.host = host;
    }

    private tabOf(key: string, group: unknown): Record<string, unknown> | null {
        const document = this.host.documents.get(key);
        if (!document) {
            return null;
        }
        const owner = this;
        return {
            label: document.uri.path.split('/').pop() ?? '',
            group,
            input: new TabInputText(document.uri),
            get isActive() {
                return owner.active?.document === document;
            },
            get isDirty() {
                return document.isDirty;
            },
            isPinned: false,
            isPreview: false,
        };
    }

    private createTabGroups(): unknown {
        const owner = this;
        const group = {
            isActive: true,
            viewColumn: 1,
            get tabs() {
                return [...owner.editorDocuments].map((key) => owner.tabOf(key, group)).filter((tab) => tab !== null);
            },
            get activeTab() {
                const document = owner.active?.document;
                return document ? owner.tabOf(document.uri.toString(), group) ?? undefined : undefined;
            },
        };
        return {
            get all() {
                return [group];
            },
            activeTabGroup: group,
            onDidChangeTabs: this.onDidChangeTabs.event,
            onDidChangeTabGroups: this.onDidChangeTabGroups.event,
            close: () => Promise.resolve(false),
        };
    }

    get activeTextEditor(): TextEditorImpl | undefined {
        return this.active;
    }

    get visibleTextEditors(): TextEditorImpl[] {
        return this.active ? [this.active] : [];
    }

    /** A document the editor has open (by absolute path), if any. */
    editorDocument(file: string): TextDocumentModel | undefined {
        const key = Uri.file(file).toString();
        return this.editorDocuments.has(key) ? this.host.documents.get(key) : undefined;
    }

    accept(events: readonly DocumentEvent[]): void {
        for (const event of events.slice(0, MAX_DOCUMENT_EVENTS)) {
            try {
                this.acceptOne(event);
            } catch (error) {
                this.host.log({ level: 'warn', extensionId: null, message: `A document event could not be applied: ${error instanceof Error ? error.message : String(error)}` });
            }
        }
    }

    private acceptOne(event: DocumentEvent): void {
        if (event.kind === 'editor') {
            this.setActiveEditor(event.editor);
            return;
        }
        const uri = Uri.file(event.path);
        const key = uri.toString();
        const document = this.host.documents.get(key);
        switch (event.kind) {
            case 'open': {
                this.editorDocuments.add(key);
                if (document && !document.isClosed) {
                    // An extension had read it from disk: the editor's text wins, the object stays the same.
                    document.setText(event.text);
                    document.version = event.version;
                    document.languageId = event.languageId;
                    return;
                }
                const opened = new TextDocumentModel(uri, event.languageId, event.version, event.text, (doc) => this.save(doc));
                this.host.documents.set(key, opened);
                this.onDidOpenTextDocument.fire(opened);
                this.onDidChangeTabs.fire({ opened: [this.tabOf(key, undefined)], closed: [], changed: [] });
                return;
            }
            case 'change': {
                if (!document || !this.editorDocuments.has(key)) {
                    return;
                }
                const contentChanges = event.changes.map((change) => {
                    const range = document.validateRange(toRange(change.range));
                    const rangeOffset = document.offsetAt(range.start);
                    const rangeLength = document.offsetAt(range.end) - rangeOffset;
                    document.applyChange(range, change.text);
                    return { range, rangeOffset, rangeLength, text: change.text };
                });
                document.version = event.version;
                document.isDirty = true;
                this.onDidChangeTextDocument.fire({ document, contentChanges, reason: undefined });
                return;
            }
            case 'language': {
                if (document && document.languageId !== event.languageId) {
                    // VS Code closes and reopens a document whose language changes.
                    this.onDidCloseTextDocument.fire(document);
                    document.languageId = event.languageId;
                    this.onDidOpenTextDocument.fire(document);
                }
                return;
            }
            case 'save': {
                if (document) {
                    document.isDirty = false;
                    this.onDidSaveTextDocument.fire(document);
                }
                return;
            }
            case 'close': {
                this.editorDocuments.delete(key);
                if (document) {
                    document.isClosed = true;
                    this.host.documents.delete(key);
                    if (this.active?.document === document) {
                        this.setActiveEditor(null);
                    }
                    this.onDidCloseTextDocument.fire(document);
                    this.onDidChangeTabs.fire({ opened: [], closed: [{ label: '', input: new TabInputText(uri) }], changed: [] });
                }
                return;
            }
        }
    }

    private setActiveEditor(state: EditorStateData | null): void {
        const document = state ? this.host.documents.get(Uri.file(state.path).toString()) : undefined;
        if (!state || !document) {
            if (this.active) {
                this.active = undefined;
                this.onDidChangeActiveTextEditor.fire(undefined);
                this.onDidChangeVisibleTextEditors.fire([]);
            }
            return;
        }
        if (this.active?.document === document) {
            const editor = this.active;
            const selections = state.selections.map(toSelection);
            const selectionChanged = selections.length !== editor.selections.length || selections.some((selection, index) => {
                const previous = editor.selections[index] as Selection;
                return !selection.anchor.isEqual(previous.anchor) || !selection.active.isEqual(previous.active);
            });
            const visibleRanges = state.visibleRanges.map(toRange);
            const visibleChanged = visibleRanges.length !== editor.visibleRanges.length || visibleRanges.some((range, index) => !range.isEqual(editor.visibleRanges[index] as Range));
            editor.options = { tabSize: state.tabSize, insertSpaces: state.insertSpaces };
            if (selections.length > 0 && selectionChanged) {
                editor.selections = selections;
                this.onDidChangeTextEditorSelection.fire({ textEditor: editor, selections, kind: TextEditorSelectionChangeKind.Keyboard });
            }
            if (visibleChanged) {
                editor.visibleRanges = visibleRanges;
                this.onDidChangeTextEditorVisibleRanges.fire({ textEditor: editor, visibleRanges });
            }
            return;
        }
        this.active = new TextEditorImpl(this.host, document, state);
        this.onDidChangeActiveTextEditor.fire(this.active);
        this.onDidChangeVisibleTextEditors.fire([this.active]);
    }

    private async save(document: TextDocumentModel): Promise<boolean> {
        if (!this.editorDocuments.has(document.uri.toString())) {
            return false;
        }
        const saved = await this.host.ui({ kind: 'saveFile', path: document.uri.fsPath });
        return saved === true;
    }

    /**
     * `workspace.applyEdit`: file operations first (on disk, in order), then
     * the text edits through the workbench. Text edits of documents only an
     * extension opened (untitled, or read from disk and not in the editor)
     * are applied to those documents here.
     */
    async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
        try {
            for (const operation of edit.operations()) {
                if (operation.kind === 'create') {
                    await createFile(operation.uri, operation.options);
                } else if (operation.kind === 'delete') {
                    await deleteFile(operation.uri, operation.options);
                } else if (operation.kind === 'rename' && operation.newUri) {
                    await renameFile(operation.uri, operation.newUri, operation.options);
                }
            }
        } catch (error) {
            this.host.log({ level: 'warn', extensionId: null, message: `workspace.applyEdit: ${error instanceof Error ? error.message : String(error)}` });
            return false;
        }
        const forEditor: { path: string; edits: { range: RangeData; text: string }[] }[] = [];
        for (const [uri, edits] of edit.entries()) {
            const local = this.host.documents.get(uri.toString());
            if (uri.scheme === 'file' && (!local || this.editorDocuments.has(uri.toString()))) {
                forEditor.push({ path: uri.fsPath, edits: edits.map((item) => ({ range: rangeData(item.range), text: item.newText })) });
            } else if (local) {
                applyLocally(local, edits);
            } else {
                return false;
            }
        }
        if (forEditor.length === 0) {
            return true;
        }
        const answer = await this.host.ui({ kind: 'applyEdit', edit: { edits: forEditor } });
        return answer === true;
    }
}

/** Applies edits to a document the editor does not have, last first so earlier ranges stay valid. */
function applyLocally(document: TextDocumentModel, edits: readonly TextEdit[]): void {
    const sorted = [...edits].sort((a, b) => b.range.start.compareTo(a.range.start));
    for (const edit of sorted) {
        document.applyChange(edit.range, edit.newText);
    }
    document.version++;
    document.isDirty = true;
}

interface FileOptions {
    overwrite?: boolean;
    ignoreIfExists?: boolean;
    ignoreIfNotExists?: boolean;
    recursive?: boolean;
    contents?: Uint8Array;
}

async function exists(file: string): Promise<boolean> {
    return fsp.stat(file).then(() => true, () => false);
}

async function createFile(uri: Uri, options: Readonly<Record<string, unknown>> = {}): Promise<void> {
    const { overwrite, ignoreIfExists, contents } = options as FileOptions;
    if (uri.scheme !== 'file') {
        throw new Error(`cannot create ${uri.toString()}`);
    }
    if (await exists(uri.fsPath)) {
        if (ignoreIfExists && !overwrite) {
            return;
        }
        if (!overwrite) {
            throw new Error(`${uri.fsPath} already exists`);
        }
    }
    await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fsp.writeFile(uri.fsPath, contents ?? new Uint8Array());
}

async function deleteFile(uri: Uri, options: Readonly<Record<string, unknown>> = {}): Promise<void> {
    const { ignoreIfNotExists, recursive } = options as FileOptions;
    if (!(await exists(uri.fsPath))) {
        if (ignoreIfNotExists) {
            return;
        }
        throw new Error(`${uri.fsPath} does not exist`);
    }
    await fsp.rm(uri.fsPath, { recursive: recursive === true });
}

async function renameFile(from: Uri, to: Uri, options: Readonly<Record<string, unknown>> = {}): Promise<void> {
    const { overwrite, ignoreIfExists } = options as FileOptions;
    if (await exists(to.fsPath)) {
        if (ignoreIfExists && !overwrite) {
            return;
        }
        if (!overwrite) {
            throw new Error(`${to.fsPath} already exists`);
        }
    }
    await fsp.mkdir(path.dirname(to.fsPath), { recursive: true });
    await fsp.rename(from.fsPath, to.fsPath);
}
