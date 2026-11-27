import type * as Lsp from 'vscode-languageserver-types';
import { CLIENT_URI_SCHEME, isLspLanguage, LSP_MARKER_OWNER, type LspApi, type LspLanguage } from '../../shared/lsp.ts';
import { monaco } from '../editor/monaco.ts';
import { completionKindName, markdownOf, markerSeverity, openTarget, toCodeActions, toHighlights, toLocations, toLspDiagnostic, toLspPosition, toLspRange, toMonacoRange, toRenameRange, toSignatureHelp, toSymbols, workspacePathOf, type MarkerLike, type PrepareRenameAnswer } from './lspConvert.ts';
import { fileCount, refusalReason, workspaceEditFiles, type FileTextEdits, type WorkspaceEditOutcome } from './lspEdits.ts';

/**
 * The Monaco side of language intelligence (#21): a small bridge, not a
 * generic language client. It follows every Monaco model of a workspace file
 * (`codexr-file:` URIs) whose language has a server, syncs its text to the
 * main process, and registers hover, completion, go to definition and
 * document symbols providers that forward to `window.codexr.lsp`; #287 adds
 * references, rename, signature help, highlights and code actions, whose
 * edits the editor group applies (`LanguageClientHost.applyEdit`).
 * Diagnostics become markers of their own owner (`codexr-lsp`), which the
 * Problems panel lists like any other.
 *
 * Monaco's own TypeScript service sees one file at a time; the server sees
 * the project, so the features the server replaces are turned off in
 * Monaco's (formatting and the rest stay). This must run before the first
 * TypeScript model exists: Monaco reads that configuration once.
 */

export interface LanguageClientHost {
    /** Opens a workspace file at a 1-based line and column, selecting `length` characters (go to definition). */
    openAt(path: string, line: number, column: number, length: number): Promise<void>;
    /**
     * #287: applies a server's edit (rename, a code action): open files as one
     * undoable edit each, the others written through the workspace API.
     */
    applyEdit(files: readonly FileTextEdits[]): Promise<WorkspaceEditOutcome>;
    /** #287: the status bar line after an edit ("Renamed 'a' to 'b' in 2 files"). */
    setStatus(message: string): void;
}

/** #287: the Monaco command a code action runs to apply its edit (Monaco's own bulk edit cannot reach closed files). */
const APPLY_EDIT_COMMAND = 'codexr.lsp.applyWorkspaceEdit';

/** Changes are sent at most this often while typing; any request sends the pending one first. */
const CHANGE_DEBOUNCE_MS = 150;

const TS_TRIGGERS = ['.', '"', "'", '`', '/', '@', '<', '#'];
const PYTHON_TRIGGERS = ['.', '[', '"', "'"];
/** #287: signature help opens on these and is asked again on the retrigger ones. */
const TS_SIGNATURE_TRIGGERS = ['(', ',', '<'];
const PYTHON_SIGNATURE_TRIGGERS = ['(', ','];
const SIGNATURE_RETRIGGERS = [')'];

interface TrackedModel {
    readonly model: monaco.editor.ITextModel;
    readonly uri: string;
    sentVersion: number;
    timer: ReturnType<typeof setTimeout> | undefined;
    readonly subscription: monaco.IDisposable;
}

let installed = false;
/** #172: the server's document symbols of a model, for the Outline view; set once the client is installed. */
let symbolsOf: ((model: monaco.editor.ITextModel) => Promise<monaco.languages.DocumentSymbol[]>) | null = null;

/**
 * #172: what the language server says the model's symbols are, for the
 * Outline view and the breadcrumbs: empty when the model's language has no
 * server running (none installed for Python) or the server found none.
 */
export function languageServerSymbols(model: monaco.editor.ITextModel): Promise<monaco.languages.DocumentSymbol[]> {
    return symbolsOf ? symbolsOf(model) : Promise.resolve([]);
}

let reopenAll: (() => void) | null = null;

/**
 * #177: sends every followed document again (close, then open). The main
 * process stops a window's language servers when its trust changes; the next
 * open starts the ones the new trust allows.
 */
export function reopenLanguageDocuments(): void {
    reopenAll?.();
}

export function installLanguageClient(api: LspApi, host: LanguageClientHost): void {
    if (installed) {
        return;
    }
    installed = true;
    for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
        defaults.setModeConfiguration({
            ...defaults.modeConfiguration,
            completionItems: false, hovers: false, definitions: false, documentSymbols: false, diagnostics: false,
            // #287: the server's answers cover the files that are not open.
            references: false, rename: false, signatureHelp: false, documentHighlights: false, codeActions: false,
        });
    }

    const tracked = new Map<string, TrackedModel>();

    function flush(entry: TrackedModel): void {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        const version = entry.model.getVersionId();
        if (version !== entry.sentVersion && !entry.model.isDisposed()) {
            entry.sentVersion = version;
            void api.didChange(entry.uri, version, entry.model.getValue()).catch(warn);
        }
    }

    function track(model: monaco.editor.ITextModel): void {
        const language = model.getLanguageId();
        if (model.uri.scheme !== CLIENT_URI_SCHEME || !isLspLanguage(language)) {
            return;
        }
        const uri = model.uri.toString();
        if (tracked.has(uri)) {
            return;
        }
        const entry: TrackedModel = {
            model,
            uri,
            sentVersion: model.getVersionId(),
            timer: undefined,
            subscription: model.onDidChangeContent(() => {
                clearTimeout(entry.timer);
                entry.timer = setTimeout(() => flush(entry), CHANGE_DEBOUNCE_MS);
            }),
        };
        tracked.set(uri, entry);
        void api.didOpen(uri, language as LspLanguage, entry.sentVersion, model.getValue()).catch(warn);
    }

    function untrack(model: monaco.editor.ITextModel): void {
        const uri = model.uri.toString();
        const entry = tracked.get(uri);
        if (!entry) {
            return;
        }
        clearTimeout(entry.timer);
        entry.subscription.dispose();
        tracked.delete(uri);
        monaco.editor.setModelMarkers(model, LSP_MARKER_OWNER, []);
        void api.didClose(uri).catch(warn);
    }

    reopenAll = () => {
        for (const entry of [...tracked.values()]) {
            untrack(entry.model);
            track(entry.model);
        }
    };
    monaco.editor.getModels().forEach(track);
    monaco.editor.onDidCreateModel(track);
    monaco.editor.onWillDisposeModel(untrack);
    monaco.editor.onDidChangeModelLanguage(({ model }) => {
        untrack(model);
        track(model);
    });

    /** The model's URI with its latest text sent, or null when it is not followed. */
    function synced(model: monaco.editor.ITextModel): string | null {
        const entry = tracked.get(model.uri.toString());
        if (!entry) {
            return null;
        }
        flush(entry);
        return entry.uri;
    }

    async function request<T>(method: Parameters<LspApi['request']>[0], params: unknown): Promise<T | null> {
        try {
            return (await api.request(method, params)) as T | null;
        } catch (error) {
            warn(error);
            return null;
        }
    }

    api.onDiagnostics(({ uri, diagnostics }) => {
        const model = monaco.editor.getModel(monaco.Uri.parse(uri));
        if (!model || !tracked.has(model.uri.toString())) {
            return;
        }
        monaco.editor.setModelMarkers(model, LSP_MARKER_OWNER, (diagnostics as Lsp.Diagnostic[]).map(toMarker));
    });

    const selector = (languages: readonly LspLanguage[]): monaco.languages.LanguageFilter[] =>
        languages.map((language) => ({ language, scheme: CLIENT_URI_SCHEME }));
    const all = selector(['typescript', 'javascript', 'python']);

    monaco.languages.registerHoverProvider(all, {
        async provideHover(model, position) {
            const uri = synced(model);
            if (!uri) {
                return null;
            }
            const hover = await request<Lsp.Hover>('textDocument/hover', { textDocument: { uri }, position: toLspPosition(position) });
            const contents = markdownOf(hover?.contents);
            if (!hover || contents.length === 0) {
                return null;
            }
            return { contents: contents.map((value) => ({ value })), ...(hover.range ? { range: toMonacoRange(hover.range) } : {}) };
        },
    });

    const lspItems = new WeakMap<monaco.languages.CompletionItem, Lsp.CompletionItem>();
    const completionProvider = (triggerCharacters: string[]): monaco.languages.CompletionItemProvider => ({
        triggerCharacters,
        async provideCompletionItems(model, position, context) {
            const uri = synced(model);
            if (!uri) {
                return { suggestions: [] };
            }
            const result = await request<Lsp.CompletionItem[] | Lsp.CompletionList>('textDocument/completion', {
                textDocument: { uri },
                position: toLspPosition(position),
                context: { triggerKind: context.triggerKind + 1, ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}) },
            });
            const items = Array.isArray(result) ? result : result?.items ?? [];
            const word = model.getWordUntilPosition(position);
            const wordRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
            const suggestions = items.map((item) => {
                const suggestion = toSuggestion(item, wordRange);
                lspItems.set(suggestion, item);
                return suggestion;
            });
            return { suggestions, incomplete: !Array.isArray(result) && result?.isIncomplete === true };
        },
        async resolveCompletionItem(suggestion) {
            const item = lspItems.get(suggestion);
            if (!item) {
                return suggestion;
            }
            const resolved = await request<Lsp.CompletionItem>('completionItem/resolve', item);
            if (!resolved) {
                return suggestion;
            }
            const documentation = markdownOf(resolved.documentation).join('\n\n');
            return {
                ...suggestion,
                ...(resolved.detail ? { detail: resolved.detail } : {}),
                ...(documentation ? { documentation: { value: documentation } } : {}),
                ...(resolved.additionalTextEdits ? { additionalTextEdits: resolved.additionalTextEdits.map((edit) => ({ range: toMonacoRange(edit.range), text: edit.newText })) } : {}),
            };
        },
    });
    monaco.languages.registerCompletionItemProvider(selector(['typescript', 'javascript']), completionProvider(TS_TRIGGERS));
    monaco.languages.registerCompletionItemProvider(selector(['python']), completionProvider(PYTHON_TRIGGERS));

    monaco.languages.registerDefinitionProvider(all, {
        async provideDefinition(model, position) {
            const uri = synced(model);
            if (!uri) {
                return null;
            }
            const result = await request<Lsp.Location | Lsp.Location[] | Lsp.LocationLink[]>('textDocument/definition', { textDocument: { uri }, position: toLspPosition(position) });
            return toLocations(result).map((location) => ({ ...location, uri: monaco.Uri.parse(location.uri) }));
        },
    });

    async function documentSymbols(model: monaco.editor.ITextModel): Promise<monaco.languages.DocumentSymbol[]> {
        const uri = synced(model);
        if (!uri) {
            return [];
        }
        const result = await request<(Lsp.DocumentSymbol | Lsp.SymbolInformation)[]>('textDocument/documentSymbol', { textDocument: { uri } });
        return toSymbols(result, uri) as monaco.languages.DocumentSymbol[];
    }
    symbolsOf = documentSymbols;
    monaco.languages.registerDocumentSymbolProvider(all, {
        displayName: 'Language server',
        provideDocumentSymbols: (model) => documentSymbols(model),
    });

    // #287: references, highlights and signature help.
    monaco.languages.registerReferenceProvider(all, {
        async provideReferences(model, position, context) {
            const uri = synced(model);
            if (!uri) {
                return null;
            }
            const result = await request<Lsp.Location[]>('textDocument/references', { textDocument: { uri }, position: toLspPosition(position), context: { includeDeclaration: context.includeDeclaration } });
            return toLocations(result).map((location) => ({ uri: monaco.Uri.parse(location.uri), range: location.range }));
        },
    });

    monaco.languages.registerDocumentHighlightProvider(all, {
        async provideDocumentHighlights(model, position) {
            const uri = synced(model);
            if (!uri) {
                return null;
            }
            return toHighlights(await request<Lsp.DocumentHighlight[]>('textDocument/documentHighlight', { textDocument: { uri }, position: toLspPosition(position) }));
        },
    });

    const signatureProvider = (triggers: string[]): monaco.languages.SignatureHelpProvider => ({
        signatureHelpTriggerCharacters: triggers,
        signatureHelpRetriggerCharacters: SIGNATURE_RETRIGGERS,
        async provideSignatureHelp(model, position, _token, context) {
            const uri = synced(model);
            if (!uri) {
                return null;
            }
            const result = await request<Lsp.SignatureHelp>('textDocument/signatureHelp', {
                textDocument: { uri },
                position: toLspPosition(position),
                context: { triggerKind: context.triggerKind, isRetrigger: context.isRetrigger, ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}) },
            });
            const value = toSignatureHelp(result);
            return value ? { value, dispose: () => undefined } : null;
        },
    });
    monaco.languages.registerSignatureHelpProvider(selector(['typescript', 'javascript']), signatureProvider(TS_SIGNATURE_TRIGGERS));
    monaco.languages.registerSignatureHelpProvider(selector(['python']), signatureProvider(PYTHON_SIGNATURE_TRIGGERS));

    /** #287: applies a server edit through the editor group: how many files changed, or why none did. */
    async function applyServerEdit(edit: unknown): Promise<{ readonly files: number } | { readonly error: string }> {
        let files: FileTextEdits[];
        try {
            files = workspaceEditFiles(edit);
        } catch (error) {
            return { error: refusalReason(error) };
        }
        if (files.length === 0) {
            return { files: 0 };
        }
        const outcome = await host.applyEdit(files).catch((error: unknown): WorkspaceEditOutcome => ({ applied: [], error: String(error) }));
        return outcome.error !== undefined ? { error: outcome.error } : { files: outcome.applied.length };
    }

    // #287: rename. The server answers for the whole project and the editor group applies the edit, so Monaco gets none to apply.
    monaco.languages.registerRenameProvider(all, {
        async resolveRenameLocation(model, position) {
            const uri = synced(model);
            if (!uri) {
                return null;
            }
            let result: unknown;
            try {
                result = await api.request('textDocument/prepareRename', { textDocument: { uri }, position: toLspPosition(position) });
            } catch (error) {
                warn(error);
                return null; // a server without prepareRename: Monaco starts from the word at the cursor
            }
            const location = toRenameRange(result as PrepareRenameAnswer | null);
            if (location === 'default') {
                return null;
            }
            if (!location) {
                return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '', rejectReason: 'This element cannot be renamed.' };
            }
            return { range: location.range, text: location.placeholder ?? model.getValueInRange(location.range) };
        },
        async provideRenameEdits(model, position, newName) {
            const uri = synced(model);
            if (!uri) {
                return { edits: [], rejectReason: 'This file has no language server.' };
            }
            const oldName = model.getWordAtPosition(position)?.word;
            let result: unknown;
            try {
                result = await api.request('textDocument/rename', { textDocument: { uri }, position: toLspPosition(position), newName });
            } catch (error) {
                const reason = `Rename failed: ${refusalReason(error)}`;
                host.setStatus(reason);
                return { edits: [], rejectReason: reason };
            }
            if (!result) {
                return { edits: [], rejectReason: 'The language server found nothing to rename here.' };
            }
            const applied = await applyServerEdit(result);
            if ('error' in applied) {
                const reason = `Rename failed: ${applied.error}`;
                host.setStatus(reason);
                return { edits: [], rejectReason: reason };
            }
            host.setStatus(`Renamed ${oldName ? `'${oldName}' ` : ''}to '${newName}' in ${fileCount(applied.files)}`);
            return { edits: [] };
        },
    });

    // #287: quick fixes and the other code actions (Ctrl+., the lightbulb); each runs this command with its edit.
    monaco.editor.registerCommand(APPLY_EDIT_COMMAND, (_accessor: unknown, edit: unknown, title: unknown) => {
        void applyServerEdit(edit).then((applied) => {
            const label = typeof title === 'string' ? title : 'Code action';
            host.setStatus('error' in applied ? `${label} failed: ${applied.error}` : `${label}: changed ${fileCount(applied.files)}`);
        });
    });
    monaco.languages.registerCodeActionProvider(all, {
        async provideCodeActions(model, range, context) {
            const uri = synced(model);
            if (!uri) {
                return { actions: [], dispose: () => undefined };
            }
            // Only the server's own diagnostics: the metric checks and the other owners have no fixes there.
            const diagnostics = (context.markers as MarkerLike[])
                .filter((marker) => marker.owner === undefined || marker.owner === LSP_MARKER_OWNER)
                .map(toLspDiagnostic);
            const result = await request<unknown>('textDocument/codeAction', {
                textDocument: { uri },
                range: toLspRange(range),
                context: { diagnostics, triggerKind: context.trigger, ...(context.only ? { only: [context.only] } : {}) },
            });
            const actions = toCodeActions(result).map((action): monaco.languages.CodeAction => ({
                title: action.title,
                ...(action.kind !== undefined ? { kind: action.kind } : {}),
                ...(action.isPreferred ? { isPreferred: true } : {}),
                ...(action.disabled !== undefined ? { disabled: action.disabled } : {}),
                ...(action.edit !== undefined ? { command: { id: APPLY_EDIT_COMMAND, title: action.title, arguments: [action.edit, action.title] } } : {}),
            }));
            return { actions, dispose: () => undefined };
        },
    });

    // Go to definition into another file: Monaco has one editor, so the editor group opens the tab.
    monaco.editor.registerEditorOpener({
        openCodeEditor(_source, resource, selectionOrPosition) {
            if (resource.scheme !== CLIENT_URI_SCHEME) {
                return false;
            }
            const target = openTarget(selectionOrPosition);
            void host.openAt(workspacePathOf(resource.path), target.line, target.column, target.length).catch(warn);
            return true;
        },
    });
}

function toSuggestion(item: Lsp.CompletionItem, wordRange: monaco.IRange): monaco.languages.CompletionItem {
    const edit = item.textEdit;
    const range = !edit ? wordRange
        : 'range' in edit ? toMonacoRange(edit.range)
            : { insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace) };
    const documentation = markdownOf(item.documentation).join('\n\n');
    const deprecated = item.deprecated === true || (item.tags ?? []).includes(1);
    return {
        label: item.labelDetails ? { label: item.label, ...(item.labelDetails.detail ? { detail: item.labelDetails.detail } : {}), ...(item.labelDetails.description ? { description: item.labelDetails.description } : {}) } : item.label,
        kind: monaco.languages.CompletionItemKind[completionKindName(item.kind)],
        insertText: edit?.newText ?? item.insertText ?? item.label,
        range,
        ...(item.insertTextFormat === 2 ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
        ...(item.detail ? { detail: item.detail } : {}),
        ...(documentation ? { documentation: { value: documentation } } : {}),
        ...(item.sortText ? { sortText: item.sortText } : {}),
        ...(item.filterText ? { filterText: item.filterText } : {}),
        ...(item.preselect ? { preselect: true } : {}),
        ...(item.commitCharacters ? { commitCharacters: item.commitCharacters } : {}),
        ...(deprecated ? { tags: [monaco.languages.CompletionItemTag.Deprecated] } : {}),
        ...(item.additionalTextEdits ? { additionalTextEdits: item.additionalTextEdits.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })) } : {}),
    };
}

function toMarker(diagnostic: Lsp.Diagnostic): monaco.editor.IMarkerData {
    const tags = (diagnostic.tags ?? []).filter((tag) => tag === 1 || tag === 2) as monaco.MarkerTag[];
    return {
        ...toMonacoRange(diagnostic.range),
        severity: markerSeverity(diagnostic.severity) as monaco.MarkerSeverity,
        // LSP 3.18 allows a MarkupContent message; markers show plain text.
        message: typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value,
        ...(diagnostic.source ? { source: diagnostic.source } : {}),
        ...(diagnostic.code !== undefined ? { code: String(diagnostic.code) } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(diagnostic.relatedInformation ? {
            relatedInformation: diagnostic.relatedInformation.map((info) => ({
                resource: monaco.Uri.parse(info.location.uri),
                message: info.message,
                ...toMonacoRange(info.location.range),
            })),
        } : {}),
    };
}

function warn(error: unknown): void {
    console.warn('[code-xr-ide] language client:', error);
}
