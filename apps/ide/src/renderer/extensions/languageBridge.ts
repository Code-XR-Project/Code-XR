import type {
    CodeActionData, CodeLensListData, CommandData, CompletionItemData, CompletionListData, DiagnosticData, DiagnosticsUpdate, DocumentLinkData, DocumentSymbolData, FoldingRangeData,
    HoverData, InlayHintData, LocationData, ProvideRequest, ProviderRegistration, RangeData, RenameLocationData, SignatureHelpData, TextChangeData, WorkspaceEditData,
} from '../../shared/extensionLanguageProtocol.ts';
import { selectorMatches } from '../../shared/extensionLanguageProtocol.ts';
import type { ExtensionsApi } from '../../shared/extensions.ts';
import { monaco } from '../editor/monaco.ts';
import { FILE_SCHEME, type DocumentSync } from './documentSync.ts';
import { completionKindName, diagnosticSeverity, foldingKind, fromMonacoPosition, fromMonacoRange, markerSeverity, monacoLanguages, toMonacoPosition, toMonacoRange } from './languageBridgeModel.ts';

/**
 * The Monaco side of the extensions' language features (#260). For each
 * provider an extension registers, a Monaco provider of the same kind asks
 * the host with the document's path; diagnostics become markers (owner
 * `ext:<extension>:<collection>`, listed by the Problems panel like the
 * others); and the host's edits are applied to the editor's models as one
 * undoable step each.
 *
 * Text from an extension reaches Monaco as Markdown or plain strings, which
 * Monaco renders without HTML (its Markdown renderer is sanitized).
 */

export interface LanguageBridgeDeps {
    readonly extensions: ExtensionsApi;
    readonly sync: DocumentSync;
    openFile(path: string, line?: number, column?: number): Promise<void>;
    saveFile(path: string): Promise<boolean>;
    runCommand(id: string, args: readonly unknown[]): void;
}

export interface LanguageBridge {
    registered(registration: ProviderRegistration): void;
    unregistered(handle: number): void;
    diagnostics(update: DiagnosticsUpdate): void;
    /** A host started or stopped: drops every provider and marker of extensions. */
    reset(): void;
    applyEdit(edit: WorkspaceEditData): Promise<boolean>;
    saveFile(path: string): Promise<boolean>;
    insertSnippet(path: string, snippet: string, ranges?: readonly RangeData[]): boolean;
    dispose(): void;
}

const RUN_COMMAND = 'codexr.extensions.runCommand';
const MARKER_PREFIX = 'ext:';

const uriOf = (path: string): monaco.Uri => monaco.Uri.from({ scheme: FILE_SCHEME, path: `/${path}` });
const range = (data: RangeData): monaco.IRange => toMonacoRange(data);

function warn(error: unknown): void {
    console.warn('[code-xr-ide] extension language feature:', error);
}

export function createLanguageBridge(deps: LanguageBridgeDeps): LanguageBridge {
    const { extensions, sync } = deps;
    const providers = new Map<number, monaco.IDisposable[]>();
    /** owner -> path -> markers */
    const markers = new Map<string, Map<string, monaco.editor.IMarkerData[]>>();
    const completionOrigins = new WeakMap<monaco.languages.CompletionItem, { handle: number; path: string; cacheId: number; index: number }>();
    const lensOrigins = new WeakMap<monaco.languages.CodeLens, { handle: number; path: string; cacheId: number; index: number }>();

    const toCommand = (command: CommandData | undefined): monaco.languages.Command | undefined => (command ? {
        id: RUN_COMMAND, title: command.title, ...(command.tooltip ? { tooltip: command.tooltip } : {}), arguments: [command.id, command.args ?? []],
    } : undefined);

    const disposables: monaco.IDisposable[] = [
        monaco.editor.registerCommand(RUN_COMMAND, (_accessor: unknown, id: unknown, args: unknown) => {
            if (typeof id === 'string') {
                deps.runCommand(id, Array.isArray(args) ? args : []);
            }
        }),
        monaco.editor.onDidCreateModel((model) => applyMarkers(model)),
        // Go to definition into another file: Monaco has one editor per group, so the workbench opens the tab.
        monaco.editor.registerEditorOpener({
            openCodeEditor(_source, resource, selectionOrPosition) {
                if (resource.scheme !== FILE_SCHEME) {
                    return false;
                }
                const start = selectionOrPosition && 'startLineNumber' in selectionOrPosition ? { line: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
                    : selectionOrPosition ? { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column } : { line: 1, column: 1 };
                void deps.openFile(decodeURIComponent(resource.path.replace(/^\//, '')), start.line, start.column).catch(warn);
                return true;
            },
        }),
    ];

    /* ------------------------------ asking the host ------------------------------ */

    async function ask<T>(registration: ProviderRegistration, model: monaco.editor.ITextModel, kind: ProvideRequest['kind'], args: ProvideRequest['args']): Promise<T | null> {
        const path = sync.pathOf(model);
        if (!path || !selectorMatches(registration.selector, { languageId: model.getLanguageId(), path })) {
            return null;
        }
        sync.flush();
        try {
            return (await extensions.provide({ handle: registration.handle, kind, path, args })) as T | null;
        } catch (error) {
            warn(error);
            return null;
        }
    }

    async function resolve<T>(origin: { handle: number; path: string; cacheId: number; index: number }, kind: ProvideRequest['kind']): Promise<T | null> {
        try {
            return (await extensions.provide({ handle: origin.handle, kind, path: origin.path, args: { cacheId: origin.cacheId, index: origin.index } })) as T | null;
        } catch (error) {
            warn(error);
            return null;
        }
    }

    const toLocations = (locations: readonly LocationData[] | null): monaco.languages.LocationLink[] => (locations ?? []).map((location) => ({
        uri: uriOf(location.path),
        range: range(location.range),
        ...(location.targetSelectionRange ? { targetSelectionRange: range(location.targetSelectionRange) } : {}),
        ...(location.originRange ? { originSelectionRange: range(location.originRange) } : {}),
    }));

    const toTextEdits = (edits: readonly TextChangeData[] | null): monaco.languages.TextEdit[] => (edits ?? []).map((edit) => ({ range: range(edit.range), text: edit.text }));

    const toWorkspaceEdit = (edit: WorkspaceEditData | null | undefined): monaco.languages.WorkspaceEdit => ({
        edits: (edit?.edits ?? []).flatMap((entry) => entry.edits.map((textEdit) => ({ resource: uriOf(entry.path), textEdit: { range: range(textEdit.range), text: textEdit.text }, versionId: undefined }))),
    });

    const toMarkerData = (diagnostic: DiagnosticData): monaco.editor.IMarkerData => ({
        ...range(diagnostic.range),
        severity: markerSeverity(diagnostic.severity) as monaco.MarkerSeverity,
        message: diagnostic.message,
        ...(diagnostic.source ? { source: diagnostic.source } : {}),
        ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
        ...(diagnostic.tags ? { tags: diagnostic.tags.filter((tag) => tag === 1 || tag === 2) as monaco.MarkerTag[] } : {}),
        ...(diagnostic.relatedInformation ? { relatedInformation: diagnostic.relatedInformation.map((info) => ({ resource: uriOf(info.path), message: info.message, ...range(info.range) })) } : {}),
    });

    const fromMarker = (marker: monaco.editor.IMarkerData): DiagnosticData => ({
        range: fromMonacoRange(marker),
        message: marker.message,
        severity: diagnosticSeverity(marker.severity),
        ...(marker.source ? { source: marker.source } : {}),
        ...(typeof marker.code === 'string' ? { code: marker.code } : {}),
    });

    const toSuggestion = (item: CompletionItemData, model: monaco.editor.ITextModel, position: monaco.Position): monaco.languages.CompletionItem => {
        const word = model.getWordUntilPosition(position);
        const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const itemRange = !item.range ? fallback : Array.isArray(item.range) ? range(item.range as RangeData)
            : { insert: range((item.range as { inserting: RangeData }).inserting), replace: range((item.range as { replacing: RangeData }).replacing) };
        const label = typeof item.label === 'string' ? item.label : { label: item.label.label, ...(item.label.detail ? { detail: item.label.detail } : {}), ...(item.label.description ? { description: item.label.description } : {}) };
        const command = toCommand(item.command);
        return {
            label,
            kind: monaco.languages.CompletionItemKind[completionKindName(item.kind)],
            insertText: item.insertText ?? (typeof item.label === 'string' ? item.label : item.label.label),
            range: itemRange,
            ...(item.isSnippet ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
            ...(item.detail ? { detail: item.detail } : {}),
            ...(item.documentation ? { documentation: { value: item.documentation } } : {}),
            ...(item.sortText ? { sortText: item.sortText } : {}),
            ...(item.filterText ? { filterText: item.filterText } : {}),
            ...(item.preselect ? { preselect: true } : {}),
            ...(item.commitCharacters ? { commitCharacters: [...item.commitCharacters] } : {}),
            ...(item.tags?.includes(1) ? { tags: [monaco.languages.CompletionItemTag.Deprecated] } : {}),
            ...(item.additionalTextEdits ? { additionalTextEdits: toTextEdits(item.additionalTextEdits) } : {}),
            ...(command ? { command } : {}),
        };
    };

    const toSymbols = (symbols: readonly DocumentSymbolData[]): monaco.languages.DocumentSymbol[] => symbols.map((symbol) => ({
        name: symbol.name,
        detail: symbol.detail,
        kind: symbol.kind as monaco.languages.SymbolKind,
        tags: (symbol.tags ?? []) as monaco.languages.SymbolTag[],
        range: range(symbol.range),
        selectionRange: range(symbol.selectionRange),
        children: toSymbols(symbol.children),
        ...(symbol.containerName ? { containerName: symbol.containerName } : {}),
    }));

    /* ------------------------------ one Monaco provider per registration ------------------------------ */

    function register(registration: ProviderRegistration): monaco.IDisposable[] {
        const languages = monacoLanguages(registration.selector);
        if (languages !== null && languages.length === 0) {
            return [];
        }
        const selector: monaco.languages.LanguageSelector = languages === null ? [{ scheme: FILE_SCHEME }] : languages.map((language) => ({ language, scheme: FILE_SCHEME }));
        const r = registration;
        const L = monaco.languages;
        switch (registration.kind) {
            case 'hover':
                return [L.registerHoverProvider(selector, {
                    async provideHover(model, position) {
                        const hover = await ask<HoverData>(r, model, 'hover', { position: fromMonacoPosition(position) });
                        return hover ? { contents: hover.contents.map((value) => ({ value })), ...(hover.range ? { range: range(hover.range) } : {}) } : null;
                    },
                })];
            case 'completion':
                return [L.registerCompletionItemProvider(selector, {
                    triggerCharacters: [...(r.triggerCharacters ?? [])],
                    async provideCompletionItems(model, position, context) {
                        const list = await ask<CompletionListData>(r, model, 'completion', {
                            position: fromMonacoPosition(position),
                            // Monaco: Invoke 0, TriggerCharacter 1, TriggerForIncompleteCompletions 2, as in VS Code.
                            triggerKind: context.triggerKind,
                            ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
                        });
                        const path = sync.pathOf(model);
                        const suggestions = (list?.items ?? []).map((item, index) => {
                            const suggestion = toSuggestion(item, model, position);
                            if (list?.cacheId !== undefined && path) {
                                completionOrigins.set(suggestion, { handle: r.handle, path, cacheId: list.cacheId, index });
                            }
                            return suggestion;
                        });
                        return { suggestions, incomplete: list?.incomplete === true };
                    },
                    ...(r.resolves ? {
                        async resolveCompletionItem(suggestion: monaco.languages.CompletionItem) {
                            const origin = completionOrigins.get(suggestion);
                            const resolved = origin ? await resolve<CompletionItemData>(origin, 'resolveCompletion') : null;
                            if (!resolved) {
                                return suggestion;
                            }
                            const command = toCommand(resolved.command);
                            return {
                                ...suggestion,
                                ...(resolved.detail ? { detail: resolved.detail } : {}),
                                ...(resolved.documentation ? { documentation: { value: resolved.documentation } } : {}),
                                ...(resolved.additionalTextEdits ? { additionalTextEdits: toTextEdits(resolved.additionalTextEdits) } : {}),
                                ...(command ? { command } : {}),
                            };
                        },
                    } : {}),
                })];
            case 'definition':
                return [L.registerDefinitionProvider(selector, { provideDefinition: async (model, position) => toLocations(await ask<LocationData[]>(r, model, 'definition', { position: fromMonacoPosition(position) })) })];
            case 'declaration':
                return [L.registerDeclarationProvider(selector, { provideDeclaration: async (model, position) => toLocations(await ask<LocationData[]>(r, model, 'declaration', { position: fromMonacoPosition(position) })) })];
            case 'typeDefinition':
                return [L.registerTypeDefinitionProvider(selector, { provideTypeDefinition: async (model, position) => toLocations(await ask<LocationData[]>(r, model, 'typeDefinition', { position: fromMonacoPosition(position) })) })];
            case 'implementation':
                return [L.registerImplementationProvider(selector, { provideImplementation: async (model, position) => toLocations(await ask<LocationData[]>(r, model, 'implementation', { position: fromMonacoPosition(position) })) })];
            case 'references':
                return [L.registerReferenceProvider(selector, {
                    provideReferences: async (model, position, context) => toLocations(await ask<LocationData[]>(r, model, 'references', { position: fromMonacoPosition(position), includeDeclaration: context.includeDeclaration })),
                })];
            case 'documentSymbol':
                return [L.registerDocumentSymbolProvider(selector, {
                    displayName: r.label ?? r.extensionId,
                    provideDocumentSymbols: async (model) => toSymbols(await ask<DocumentSymbolData[]>(r, model, 'documentSymbol', {}) ?? []),
                })];
            case 'documentHighlight':
                return [L.registerDocumentHighlightProvider(selector, {
                    async provideDocumentHighlights(model, position) {
                        const highlights = await ask<{ range: RangeData; kind: number }[]>(r, model, 'documentHighlight', { position: fromMonacoPosition(position) });
                        return (highlights ?? []).map((highlight) => ({ range: range(highlight.range), kind: highlight.kind as monaco.languages.DocumentHighlightKind }));
                    },
                })];
            case 'signatureHelp':
                return [L.registerSignatureHelpProvider(selector, {
                    signatureHelpTriggerCharacters: [...(r.triggerCharacters ?? [])],
                    signatureHelpRetriggerCharacters: [...(r.retriggerCharacters ?? [])],
                    async provideSignatureHelp(model, position, _token, context) {
                        const help = await ask<SignatureHelpData>(r, model, 'signatureHelp', {
                            position: fromMonacoPosition(position), triggerKind: context.triggerKind, isRetrigger: context.isRetrigger,
                            ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
                        });
                        if (!help || help.signatures.length === 0) {
                            return null;
                        }
                        return {
                            value: {
                                signatures: help.signatures.map((signature) => ({
                                    label: signature.label,
                                    ...(signature.documentation ? { documentation: { value: signature.documentation } } : {}),
                                    parameters: signature.parameters.map((parameter) => ({
                                        label: typeof parameter.label === 'string' ? parameter.label : [parameter.label[0], parameter.label[1]] as [number, number],
                                        ...(parameter.documentation ? { documentation: { value: parameter.documentation } } : {}),
                                    })),
                                    ...(signature.activeParameter !== undefined ? { activeParameter: signature.activeParameter } : {}),
                                })),
                                activeSignature: help.activeSignature,
                                activeParameter: help.activeParameter,
                            },
                            dispose: () => undefined,
                        };
                    },
                })];
            case 'formatting':
                return [L.registerDocumentFormattingEditProvider(selector, {
                    displayName: r.extensionId,
                    provideDocumentFormattingEdits: async (model, options) => toTextEdits(await ask<TextChangeData[]>(r, model, 'formatting', { options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } })),
                })];
            case 'rangeFormatting':
                return [L.registerDocumentRangeFormattingEditProvider(selector, {
                    displayName: r.extensionId,
                    provideDocumentRangeFormattingEdits: async (model, formatRange, options) => toTextEdits(await ask<TextChangeData[]>(r, model, 'rangeFormatting', {
                        range: fromMonacoRange(formatRange), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
                    })),
                })];
            case 'onTypeFormatting':
                return (r.triggerCharacters ?? []).length === 0 ? [] : [L.registerOnTypeFormattingEditProvider(selector, {
                    autoFormatTriggerCharacters: [...(r.triggerCharacters ?? [])],
                    provideOnTypeFormattingEdits: async (model, position, ch, options) => toTextEdits(await ask<TextChangeData[]>(r, model, 'onTypeFormatting', {
                        position: fromMonacoPosition(position), triggerCharacter: ch, options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
                    })),
                })];
            case 'codeAction':
                return [L.registerCodeActionProvider(selector, {
                    async provideCodeActions(model, actionRange, context) {
                        const actions = await ask<CodeActionData[]>(r, model, 'codeAction', {
                            range: fromMonacoRange(actionRange),
                            diagnostics: context.markers.map(fromMarker),
                            triggerKind: context.trigger,
                            ...(context.only ? { only: context.only } : {}),
                        });
                        return {
                            actions: (actions ?? []).map((action) => {
                                const command = toCommand(action.command);
                                return {
                                    title: action.title,
                                    ...(action.kind !== undefined ? { kind: action.kind } : {}),
                                    ...(action.isPreferred ? { isPreferred: true } : {}),
                                    ...(action.diagnostics ? { diagnostics: action.diagnostics.map(toMarkerData) } : {}),
                                    ...(action.edit ? { edit: toWorkspaceEdit(action.edit) } : {}),
                                    ...(command ? { command } : {}),
                                    ...(action.disabled ? { disabled: action.disabled } : {}),
                                };
                            }),
                            dispose: () => undefined,
                        };
                    },
                }, { providedCodeActionKinds: [...(r.providedCodeActionKinds ?? [])].filter((kind) => kind !== '') })];
            case 'codeLens':
                return [L.registerCodeLensProvider(selector, {
                    async provideCodeLenses(model) {
                        const list = await ask<CodeLensListData>(r, model, 'codeLens', {});
                        const path = sync.pathOf(model);
                        const lenses = (list?.lenses ?? []).map((lens, index) => {
                            const command = toCommand(lens.command);
                            const result: monaco.languages.CodeLens = { range: range(lens.range), ...(command ? { command } : {}) };
                            if (list?.cacheId !== undefined && path) {
                                lensOrigins.set(result, { handle: r.handle, path, cacheId: list.cacheId, index });
                            }
                            return result;
                        });
                        return { lenses, dispose: () => undefined };
                    },
                    ...(r.resolves ? {
                        async resolveCodeLens(_model: monaco.editor.ITextModel, lens: monaco.languages.CodeLens) {
                            const origin = lensOrigins.get(lens);
                            const resolved = origin ? await resolve<{ range: RangeData; command?: CommandData }>(origin, 'resolveCodeLens') : null;
                            const command = toCommand(resolved?.command);
                            return command ? { ...lens, command } : lens;
                        },
                    } : {}),
                })];
            case 'rename':
                return [L.registerRenameProvider(selector, {
                    provideRenameEdits: async (model, position, newName) => toWorkspaceEdit(await ask<WorkspaceEditData>(r, model, 'rename', { position: fromMonacoPosition(position), newName })),
                    async resolveRenameLocation(model, position) {
                        const location = await ask<RenameLocationData>(r, model, 'prepareRename', { position: fromMonacoPosition(position) });
                        return location ? { range: range(location.range), text: location.text } : { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '', rejectReason: 'This element cannot be renamed.' };
                    },
                })];
            case 'foldingRange':
                return [L.registerFoldingRangeProvider(selector, {
                    async provideFoldingRanges(model) {
                        const ranges = await ask<FoldingRangeData[]>(r, model, 'foldingRange', {});
                        return (ranges ?? []).map((fold) => {
                            const kind = foldingKind(fold.kind);
                            return { start: fold.start + 1, end: fold.end + 1, ...(kind ? { kind: new L.FoldingRangeKind(kind) } : {}) };
                        });
                    },
                })];
            case 'inlayHints':
                return [L.registerInlayHintsProvider(selector, {
                    async provideInlayHints(model, hintRange) {
                        const hints = await ask<InlayHintData[]>(r, model, 'inlayHints', { range: fromMonacoRange(hintRange) });
                        return {
                            hints: (hints ?? []).map((hint) => ({
                                position: toMonacoPosition(hint.position),
                                label: hint.label,
                                ...(hint.kind !== undefined ? { kind: hint.kind as monaco.languages.InlayHintKind } : {}),
                                ...(hint.tooltip ? { tooltip: { value: hint.tooltip } } : {}),
                                ...(hint.paddingLeft ? { paddingLeft: true } : {}),
                                ...(hint.paddingRight ? { paddingRight: true } : {}),
                            })),
                            dispose: () => undefined,
                        };
                    },
                })];
            case 'documentLink':
                return [L.registerLinkProvider(selector, {
                    async provideLinks(model) {
                        const links = await ask<DocumentLinkData[]>(r, model, 'documentLink', {});
                        return { links: (links ?? []).flatMap((link) => (link.url ? [{ range: range(link.range), url: link.url, ...(link.tooltip ? { tooltip: link.tooltip } : {}) }] : [])) };
                    },
                })];
        }
        return [];
    }

    /* ------------------------------ diagnostics ------------------------------ */

    function applyMarkers(model: monaco.editor.ITextModel): void {
        if (model.uri.scheme !== FILE_SCHEME) {
            return;
        }
        const path = decodeURIComponent(model.uri.path.replace(/^\//, ''));
        for (const [owner, byPath] of markers) {
            const list = byPath.get(path);
            if (list) {
                monaco.editor.setModelMarkers(model, owner, list);
            }
        }
    }

    function clearOwner(owner: string): void {
        const byPath = markers.get(owner);
        if (!byPath) {
            return;
        }
        for (const path of byPath.keys()) {
            const model = monaco.editor.getModel(uriOf(path));
            if (model) {
                monaco.editor.setModelMarkers(model, owner, []);
            }
        }
        markers.delete(owner);
    }

    /* ------------------------------ edits from the host ------------------------------ */

    async function modelFor(path: string): Promise<monaco.editor.ITextModel | null> {
        const uri = uriOf(path);
        let model = monaco.editor.getModel(uri);
        if (!model) {
            await deps.openFile(path);
            model = monaco.editor.getModel(uri);
        }
        return model;
    }

    return {
        registered(registration) {
            if (providers.has(registration.handle)) {
                return;
            }
            try {
                providers.set(registration.handle, register(registration));
            } catch (error) {
                warn(error);
            }
        },
        unregistered(handle) {
            providers.get(handle)?.forEach((disposable) => disposable.dispose());
            providers.delete(handle);
        },
        diagnostics(update) {
            const owner = `${MARKER_PREFIX}${update.owner}`;
            if (update.clear) {
                clearOwner(owner);
            }
            let byPath = markers.get(owner);
            if (!byPath) {
                byPath = new Map();
                markers.set(owner, byPath);
            }
            for (const entry of update.entries) {
                const list = entry.diagnostics.map(toMarkerData);
                if (list.length === 0) {
                    byPath.delete(entry.path);
                } else {
                    byPath.set(entry.path, list);
                }
                const model = monaco.editor.getModel(uriOf(entry.path));
                if (model) {
                    monaco.editor.setModelMarkers(model, owner, list);
                }
            }
        },
        reset() {
            for (const handle of [...providers.keys()]) {
                providers.get(handle)?.forEach((disposable) => disposable.dispose());
            }
            providers.clear();
            for (const owner of [...markers.keys()]) {
                clearOwner(owner);
            }
        },
        async applyEdit(edit) {
            for (const entry of edit.edits) {
                const model = await modelFor(entry.path);
                if (!model) {
                    return false;
                }
                const operations = entry.edits.map((change) => ({ range: range(change.range), text: change.text, forceMoveMarkers: true }));
                model.pushStackElement();
                model.pushEditOperations([], operations, () => null);
                model.pushStackElement();
            }
            // The changes are queued for the host; send them before the answer, so they arrive first.
            sync.flush();
            return true;
        },
        async saveFile(path) {
            return deps.saveFile(path);
        },
        insertSnippet(path, snippet, ranges) {
            const editor = sync.activeEditor();
            const model = editor?.getModel();
            if (!editor || !model || sync.pathOf(model) !== path) {
                return false;
            }
            if (ranges && ranges.length > 0) {
                editor.setSelections(ranges.map((item) => {
                    const r = range(item);
                    return new monaco.Selection(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn);
                }));
            }
            const controller = editor.getContribution('snippetController2') as { insert(template: string): void } | null;
            if (!controller) {
                return false;
            }
            controller.insert(snippet);
            sync.flush();
            return true;
        },
        dispose() {
            this.reset();
            disposables.forEach((disposable) => disposable.dispose());
        },
    };
}
