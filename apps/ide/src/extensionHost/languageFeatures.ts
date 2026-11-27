import path from 'node:path';
import {
    type CodeActionData, type CodeLensData, type CommandData, type CompletionItemData, type DiagnosticData, type DiagnosticsUpdate, type DocumentFilterData, type DocumentSymbolData,
    type LocationData, type ProvideRequest, type ProviderKind, type ProviderRegistration, type RangeData, type TextChangeData, type WorkspaceEditData,
} from '../shared/extensionLanguageProtocol.ts';
import { MAIN_METHODS } from '../shared/extensionHostProtocol.ts';
import type { ExtensionId } from '../shared/extensions.ts';
import { rangeData } from './documents.ts';
import type { ExtensionHost } from './host.ts';
import type { TextDocumentModel } from './textDocument.ts';
import {
    CancellationTokenSource, CodeActionKind, Diagnostic, DiagnosticSeverity, Disposable, EventEmitter, Location, Position, Range, SnippetString, Uri, WorkspaceEdit,
} from './types.ts';
import { toWire } from './wire.ts';

/**
 * The language features of extensions (#260): the providers they register
 * with `vscode.languages.register*Provider` and their diagnostic
 * collections, shared by every extension of the host.
 *
 * A registration is announced to the workbench, which registers a Monaco
 * provider of the same kind that asks back through `provide` with the
 * document's path and a position; the answer travels as plain data
 * (extensionLanguageProtocol.ts). Lists whose items resolve later
 * (completion items, code lenses) are kept for a while under a cache id.
 */

interface ProviderEntry {
    readonly kind: ProviderKind;
    readonly extensionId: ExtensionId;
    readonly provider: Record<string, ((...args: unknown[]) => unknown) | undefined>;
}

const MAX_CACHED_LISTS = 20;
const MAX_DIAGNOSTICS_PER_FILE = 1000;

type Markdownish = string | { value?: unknown; language?: unknown } | null | undefined;

function markdown(value: Markdownish): string {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'object' && value !== null && typeof value.value === 'string') {
        return typeof value.language === 'string' ? `\`\`\`${value.language}\n${value.value}\n\`\`\`` : value.value;
    }
    return '';
}

function isRange(value: unknown): value is Range {
    return Range.isRange(value);
}

function asRange(value: unknown): RangeData | undefined {
    return isRange(value) ? rangeData(value as Range) : undefined;
}

function commandData(command: unknown): CommandData | undefined {
    if (typeof command !== 'object' || command === null) {
        return undefined;
    }
    const { command: id, title, tooltip, arguments: args } = command as { command?: unknown; title?: unknown; tooltip?: unknown; arguments?: unknown };
    if (typeof id !== 'string' || id === '') {
        return undefined;
    }
    return {
        id,
        title: typeof title === 'string' ? title : '',
        ...(typeof tooltip === 'string' ? { tooltip } : {}),
        ...(Array.isArray(args) ? { args: toWire(args) as unknown[] } : {}),
    };
}

function textChanges(edits: unknown): TextChangeData[] {
    if (!Array.isArray(edits)) {
        return [];
    }
    const result: TextChangeData[] = [];
    for (const edit of edits as { range?: unknown; newText?: unknown }[]) {
        const range = asRange(edit?.range);
        if (range && typeof edit.newText === 'string') {
            result.push({ range, text: edit.newText });
        }
    }
    return result;
}

export function workspaceEditData(edit: unknown): WorkspaceEditData | undefined {
    if (!(edit instanceof WorkspaceEdit) && !(typeof edit === 'object' && edit !== null && typeof (edit as { entries?: unknown }).entries === 'function')) {
        return undefined;
    }
    const entries = (edit as WorkspaceEdit).entries();
    return {
        edits: entries.filter(([uri]) => uri.scheme === 'file').map(([uri, edits]) => ({ path: uri.fsPath, edits: textChanges(edits) })),
    };
}

/** `Location`, `LocationLink` or a list of either, as plain data (file URIs only). */
export function locationData(value: unknown): LocationData[] {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    const result: LocationData[] = [];
    for (const item of list as Record<string, unknown>[]) {
        if (typeof item !== 'object' || item === null) {
            continue;
        }
        if (item['targetUri'] instanceof Uri || typeof item['targetUri'] === 'object') {
            const uri = item['targetUri'] as Uri;
            const range = asRange(item['targetRange']);
            if (uri?.scheme === 'file' && range) {
                const selection = asRange(item['targetSelectionRange']);
                const origin = asRange(item['originSelectionRange']);
                result.push({ path: uri.fsPath, range, ...(selection ? { targetSelectionRange: selection } : {}), ...(origin ? { originRange: origin } : {}) });
            }
            continue;
        }
        const uri = item['uri'] as Uri | undefined;
        const range = asRange(item['range']);
        if (uri?.scheme === 'file' && range) {
            result.push({ path: uri.fsPath, range });
        }
    }
    return result;
}

export function diagnosticData(diagnostic: Diagnostic): DiagnosticData | null {
    const range = asRange(diagnostic?.range);
    if (!range) {
        return null;
    }
    const code = diagnostic.code;
    const codeText = typeof code === 'string' || typeof code === 'number' ? String(code) : typeof code === 'object' && code !== null ? String(code.value) : undefined;
    const related = (diagnostic.relatedInformation ?? []).flatMap((info) => {
        const location = info?.location;
        const relatedRange = asRange(location?.range);
        return location?.uri?.scheme === 'file' && relatedRange ? [{ path: location.uri.fsPath, range: relatedRange, message: String(info.message) }] : [];
    });
    return {
        range,
        message: typeof diagnostic.message === 'string' ? diagnostic.message : String(diagnostic.message),
        severity: typeof diagnostic.severity === 'number' ? diagnostic.severity : DiagnosticSeverity.Error,
        ...(diagnostic.source ? { source: String(diagnostic.source) } : {}),
        ...(codeText !== undefined ? { code: codeText } : {}),
        ...(diagnostic.tags && diagnostic.tags.length > 0 ? { tags: [...diagnostic.tags] } : {}),
        ...(related.length > 0 ? { relatedInformation: related } : {}),
    };
}

function fromDiagnosticData(data: DiagnosticData): Diagnostic {
    const diagnostic = new Diagnostic(new Range(data.range[0], data.range[1], data.range[2], data.range[3]), data.message, data.severity as DiagnosticSeverity);
    if (data.source) {
        diagnostic.source = data.source;
    }
    if (data.code !== undefined) {
        diagnostic.code = data.code;
    }
    return diagnostic;
}

export function completionItemData(item: Record<string, unknown>): CompletionItemData {
    const label = item['label'];
    const insert = item['insertText'];
    const range = item['range'];
    const command = commandData(item['command']);
    const documentation = markdown(item['documentation'] as Markdownish);
    let rangeValue: CompletionItemData['range'];
    if (isRange(range)) {
        rangeValue = rangeData(range);
    } else if (typeof range === 'object' && range !== null && isRange((range as { inserting?: unknown }).inserting) && isRange((range as { replacing?: unknown }).replacing)) {
        rangeValue = { inserting: rangeData((range as { inserting: Range }).inserting), replacing: rangeData((range as { replacing: Range }).replacing) };
    }
    const additional = textChanges(item['additionalTextEdits']);
    const labelValue = typeof label === 'string' ? label : typeof label === 'object' && label !== null
        ? {
            label: String((label as { label?: unknown }).label ?? ''),
            ...(typeof (label as { detail?: unknown }).detail === 'string' ? { detail: (label as { detail: string }).detail } : {}),
            ...(typeof (label as { description?: unknown }).description === 'string' ? { description: (label as { description: string }).description } : {}),
        }
        : String(label);
    return {
        label: labelValue,
        ...(typeof item['kind'] === 'number' ? { kind: item['kind'] } : {}),
        ...(Array.isArray(item['tags']) && item['tags'].length > 0 ? { tags: (item['tags'] as unknown[]).filter((tag): tag is number => typeof tag === 'number') } : {}),
        ...(typeof item['detail'] === 'string' ? { detail: item['detail'] } : {}),
        ...(documentation ? { documentation } : {}),
        ...(typeof item['sortText'] === 'string' ? { sortText: item['sortText'] } : {}),
        ...(typeof item['filterText'] === 'string' ? { filterText: item['filterText'] } : {}),
        ...(item['preselect'] === true ? { preselect: true } : {}),
        ...(insert instanceof SnippetString ? { insertText: insert.value, isSnippet: true } : typeof insert === 'string' ? { insertText: insert } : {}),
        ...(rangeValue ? { range: rangeValue } : {}),
        ...(Array.isArray(item['commitCharacters']) ? { commitCharacters: (item['commitCharacters'] as unknown[]).map(String) } : {}),
        ...(additional.length > 0 ? { additionalTextEdits: additional } : {}),
        ...(command ? { command } : {}),
    };
}

function symbolData(items: unknown): DocumentSymbolData[] {
    if (!Array.isArray(items)) {
        return [];
    }
    return (items as Record<string, unknown>[]).flatMap((item): DocumentSymbolData[] => {
        if (typeof item !== 'object' || item === null) {
            return [];
        }
        const tags = Array.isArray(item['tags']) && item['tags'].length > 0 ? { tags: item['tags'] as number[] } : {};
        if (item['location'] instanceof Location || (typeof item['location'] === 'object' && item['location'] !== null)) {
            // SymbolInformation: flat, with a container name.
            const range = asRange((item['location'] as Location).range);
            return range ? [{ name: String(item['name']), detail: '', kind: Number(item['kind'] ?? 0), range, selectionRange: range, children: [], ...(typeof item['containerName'] === 'string' && item['containerName'] ? { containerName: item['containerName'] } : {}), ...tags }] : [];
        }
        const range = asRange(item['range']);
        const selectionRange = asRange(item['selectionRange']) ?? range;
        return range && selectionRange ? [{ name: String(item['name']), detail: typeof item['detail'] === 'string' ? item['detail'] : '', kind: Number(item['kind'] ?? 0), range, selectionRange, children: symbolData(item['children']), ...tags }] : [];
    });
}

function codeActionData(item: Record<string, unknown>): CodeActionData | null {
    if (typeof item !== 'object' || item === null || typeof item['title'] !== 'string') {
        return null;
    }
    if (typeof item['command'] === 'string') {
        // A bare Command.
        const command = commandData(item);
        return command ? { title: item['title'], command } : null;
    }
    const kind = item['kind'] instanceof CodeActionKind ? item['kind'].value : typeof (item['kind'] as { value?: unknown } | undefined)?.value === 'string' ? (item['kind'] as { value: string }).value : undefined;
    const edit = workspaceEditData(item['edit']);
    const command = commandData(item['command']);
    const diagnostics = Array.isArray(item['diagnostics']) ? (item['diagnostics'] as Diagnostic[]).map(diagnosticData).filter((d): d is DiagnosticData => d !== null) : [];
    const disabled = item['disabled'] as { reason?: unknown } | undefined;
    return {
        title: item['title'],
        ...(kind !== undefined ? { kind } : {}),
        ...(item['isPreferred'] === true ? { isPreferred: true } : {}),
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
        ...(edit ? { edit } : {}),
        ...(command ? { command } : {}),
        ...(disabled && typeof disabled.reason === 'string' ? { disabled: disabled.reason } : {}),
    };
}

function lensData(lens: Record<string, unknown>): CodeLensData | null {
    const range = asRange(lens?.['range']);
    if (!range) {
        return null;
    }
    const command = commandData(lens['command']);
    return { range, ...(command ? { command } : {}) };
}

/** A `DocumentSelector` as plain filters (patterns become globs over the workspace path). */
export function selectorData(selector: unknown, rawRoot: string | null): DocumentFilterData[] {
    // Compared in `Uri.fsPath`'s spelling (a lower-case drive letter on Windows), the one of the bases.
    const workspaceRoot = rawRoot ? Uri.file(rawRoot).fsPath : null;
    const list = Array.isArray(selector) ? selector as unknown[] : [selector];
    const result: DocumentFilterData[] = [];
    for (const item of list) {
        if (typeof item === 'string') {
            result.push({ language: item });
            continue;
        }
        if (typeof item !== 'object' || item === null) {
            continue;
        }
        const filter = item as { language?: unknown; scheme?: unknown; pattern?: unknown; notebookType?: unknown };
        if (filter.notebookType !== undefined) {
            continue; // Notebooks are not supported: the filter matches nothing.
        }
        let pattern: string | undefined;
        if (typeof filter.pattern === 'string') {
            pattern = filter.pattern.split(path.sep).join('/');
        } else if (typeof filter.pattern === 'object' && filter.pattern !== null) {
            const relative = filter.pattern as { baseUri?: Uri; base?: string; pattern?: unknown };
            const base = relative.baseUri?.fsPath ?? relative.base;
            const glob = typeof relative.pattern === 'string' ? relative.pattern : '**';
            if (base && workspaceRoot && (base === workspaceRoot || base.startsWith(workspaceRoot + path.sep))) {
                const prefix = path.relative(workspaceRoot, base).split(path.sep).join('/');
                pattern = prefix ? `${prefix}/${glob}` : glob;
            } else {
                continue; // A base outside the folder matches none of its files.
            }
        }
        const data: DocumentFilterData = {
            ...(typeof filter.language === 'string' ? { language: filter.language } : {}),
            ...(typeof filter.scheme === 'string' ? { scheme: filter.scheme } : {}),
            ...(pattern !== undefined ? { pattern } : {}),
        };
        if (Object.keys(data).length > 0) {
            result.push(data);
        }
    }
    return result;
}

interface CollectionState {
    readonly owner: string;
    readonly entries: Map<string, [Uri, Diagnostic[]]>;
    pending: Set<string>;
    cleared: boolean;
    scheduled: boolean;
}

export class LanguageFeatures {
    readonly onDidChangeDiagnostics = new EventEmitter<{ readonly uris: readonly Uri[] }>();
    private readonly host: ExtensionHost;
    private readonly providers = new Map<number, ProviderEntry>();
    private readonly caches = new Map<number, unknown[]>();
    private readonly collections = new Set<CollectionState>();
    private readonly owners = new Set<string>();
    private nextHandle = 1;
    private nextCache = 1;

    constructor(host: ExtensionHost) {
        this.host = host;
    }

    /* ------------------------------ providers ------------------------------ */

    register(extensionId: ExtensionId, kind: ProviderKind, selector: unknown, provider: unknown, extra: Omit<Partial<ProviderRegistration>, 'handle' | 'kind' | 'extensionId' | 'selector'> = {}): Disposable {
        if (typeof provider !== 'object' || provider === null) {
            throw new Error(`Invalid ${kind} provider`);
        }
        const handle = this.nextHandle++;
        this.providers.set(handle, { kind, extensionId, provider: provider as ProviderEntry['provider'] });
        const registration: ProviderRegistration = { handle, kind, extensionId, selector: selectorData(selector, this.host.data.workspaceFolder ? Uri.file(this.host.data.workspaceFolder).fsPath : null), ...extra };
        this.host.rpc.notify(MAIN_METHODS.registerProvider, registration);
        return new Disposable(() => {
            if (this.providers.delete(handle)) {
                this.host.rpc.notify(MAIN_METHODS.unregisterProvider, handle);
            }
        });
    }

    private cache(items: unknown[]): number {
        const id = this.nextCache++;
        this.caches.set(id, items);
        if (this.caches.size > MAX_CACHED_LISTS) {
            const oldest = this.caches.keys().next().value;
            if (oldest !== undefined) {
                this.caches.delete(oldest);
            }
        }
        return id;
    }

    private document(file: string): TextDocumentModel | undefined {
        return this.host.documentsAndEditors.editorDocument(file) ?? this.host.documents.get(Uri.file(file).toString());
    }

    async provide(request: ProvideRequest): Promise<unknown> {
        const entry = this.providers.get(request.handle);
        if (!entry) {
            return null;
        }
        const { provider } = entry;
        const call = async (method: string, ...args: unknown[]): Promise<unknown> => {
            const fn = provider[method];
            return typeof fn === 'function' ? fn.apply(provider, args) : undefined;
        };
        const token = new CancellationTokenSource().token;
        const { args } = request;
        const cached = (): unknown => (args.cacheId !== undefined && args.index !== undefined ? this.caches.get(args.cacheId)?.[args.index] : undefined);
        if (request.kind === 'resolveCompletion') {
            const item = cached();
            if (!item) {
                return null;
            }
            const resolved = (await call('resolveCompletionItem', item, token)) ?? item;
            return completionItemData(resolved as Record<string, unknown>);
        }
        if (request.kind === 'resolveCodeLens') {
            const lens = cached();
            if (!lens) {
                return null;
            }
            const resolved = (await call('resolveCodeLens', lens, token)) ?? lens;
            return lensData(resolved as Record<string, unknown>);
        }
        const document = this.document(request.path);
        if (!document) {
            return null;
        }
        const position = args.position ? new Position(args.position[0], args.position[1]) : new Position(0, 0);
        const range = args.range ? new Range(args.range[0], args.range[1], args.range[2], args.range[3]) : new Range(0, 0, 0, 0);
        const options = { tabSize: args.options?.tabSize ?? 4, insertSpaces: args.options?.insertSpaces ?? true };
        switch (request.kind) {
            case 'hover': {
                const hover = await call('provideHover', document, position, token) as { contents?: unknown; range?: unknown } | null | undefined;
                if (!hover) {
                    return null;
                }
                const contents = (Array.isArray(hover.contents) ? hover.contents : [hover.contents]).map((item) => markdown(item as Markdownish)).filter((text) => text !== '');
                const hoverRange = asRange(hover.range);
                return contents.length > 0 ? { contents, ...(hoverRange ? { range: hoverRange } : {}) } : null;
            }
            case 'completion': {
                const result = await call('provideCompletionItems', document, position, token, { triggerKind: args.triggerKind ?? 0, triggerCharacter: args.triggerCharacter });
                const items = (Array.isArray(result) ? result : (result as { items?: unknown } | null)?.items ?? []) as Record<string, unknown>[];
                const incomplete = !Array.isArray(result) && (result as { isIncomplete?: unknown } | null)?.isIncomplete === true;
                const resolves = typeof provider['resolveCompletionItem'] === 'function';
                return { items: items.filter((item) => typeof item === 'object' && item !== null).map(completionItemData), incomplete, ...(resolves ? { cacheId: this.cache(items) } : {}) };
            }
            case 'definition':
                return locationData(await call('provideDefinition', document, position, token));
            case 'declaration':
                return locationData(await call('provideDeclaration', document, position, token));
            case 'typeDefinition':
                return locationData(await call('provideTypeDefinition', document, position, token));
            case 'implementation':
                return locationData(await call('provideImplementation', document, position, token));
            case 'references':
                return locationData(await call('provideReferences', document, position, { includeDeclaration: args.includeDeclaration !== false }, token));
            case 'documentSymbol':
                return symbolData(await call('provideDocumentSymbols', document, token));
            case 'documentHighlight': {
                const highlights = await call('provideDocumentHighlights', document, position, token);
                return Array.isArray(highlights) ? highlights.flatMap((item: { range?: unknown; kind?: unknown }) => {
                    const highlightRange = asRange(item?.range);
                    return highlightRange ? [{ range: highlightRange, kind: typeof item.kind === 'number' ? item.kind : 0 }] : [];
                }) : [];
            }
            case 'signatureHelp': {
                const help = await call('provideSignatureHelp', document, position, token, {
                    triggerKind: args.triggerKind ?? 1, triggerCharacter: args.triggerCharacter, isRetrigger: args.isRetrigger === true, activeSignatureHelp: undefined,
                }) as { signatures?: unknown; activeSignature?: unknown; activeParameter?: unknown } | null | undefined;
                if (!help || !Array.isArray(help.signatures)) {
                    return null;
                }
                return {
                    signatures: (help.signatures as Record<string, unknown>[]).map((signature) => ({
                        label: String(signature['label'] ?? ''),
                        ...(markdown(signature['documentation'] as Markdownish) ? { documentation: markdown(signature['documentation'] as Markdownish) } : {}),
                        parameters: (Array.isArray(signature['parameters']) ? signature['parameters'] as Record<string, unknown>[] : []).map((parameter) => ({
                            label: Array.isArray(parameter['label']) ? [Number(parameter['label'][0]), Number(parameter['label'][1])] as const : String(parameter['label'] ?? ''),
                            ...(markdown(parameter['documentation'] as Markdownish) ? { documentation: markdown(parameter['documentation'] as Markdownish) } : {}),
                        })),
                        ...(typeof signature['activeParameter'] === 'number' ? { activeParameter: signature['activeParameter'] } : {}),
                    })),
                    activeSignature: typeof help.activeSignature === 'number' ? help.activeSignature : 0,
                    activeParameter: typeof help.activeParameter === 'number' ? help.activeParameter : 0,
                };
            }
            case 'formatting':
                return textChanges(await call('provideDocumentFormattingEdits', document, options, token));
            case 'rangeFormatting':
                return textChanges(await call('provideDocumentRangeFormattingEdits', document, range, options, token));
            case 'onTypeFormatting':
                return textChanges(await call('provideOnTypeFormattingEdits', document, position, args.triggerCharacter ?? '', options, token));
            case 'codeAction': {
                const diagnostics = (args.diagnostics ?? []).map(fromDiagnosticData);
                const actions = await call('provideCodeActions', document, range, {
                    diagnostics, only: args.only ? new CodeActionKind(args.only) : undefined, triggerKind: args.triggerKind ?? 1,
                }, token);
                return Array.isArray(actions) ? (actions as Record<string, unknown>[]).map(codeActionData).filter((action): action is CodeActionData => action !== null) : [];
            }
            case 'codeLens': {
                const lenses = await call('provideCodeLenses', document, token);
                if (!Array.isArray(lenses)) {
                    return { lenses: [] };
                }
                const resolves = typeof provider['resolveCodeLens'] === 'function';
                return { lenses: (lenses as Record<string, unknown>[]).map(lensData).map((lens) => lens ?? { range: [0, 0, 0, 0] }), ...(resolves ? { cacheId: this.cache(lenses) } : {}) };
            }
            case 'prepareRename': {
                if (typeof provider['prepareRename'] !== 'function') {
                    const word = document.getWordRangeAtPosition(position);
                    return word ? { range: rangeData(word), text: document.getText(word) } : null;
                }
                const prepared = await call('prepareRename', document, position, token) as Range | { range?: unknown; placeholder?: unknown } | null | undefined;
                if (!prepared) {
                    return null;
                }
                if (isRange(prepared)) {
                    return { range: rangeData(prepared), text: document.getText(prepared) };
                }
                const preparedRange = asRange(prepared.range);
                return preparedRange ? { range: preparedRange, text: String(prepared.placeholder ?? '') } : null;
            }
            case 'rename':
                return workspaceEditData(await call('provideRenameEdits', document, position, args.newName ?? '', token)) ?? null;
            case 'foldingRange': {
                const ranges = await call('provideFoldingRanges', document, {}, token);
                return Array.isArray(ranges) ? ranges.flatMap((item: { start?: unknown; end?: unknown; kind?: unknown }) => (typeof item?.start === 'number' && typeof item.end === 'number' ? [{ start: item.start, end: item.end, ...(typeof item.kind === 'number' ? { kind: item.kind } : {}) }] : [])) : [];
            }
            case 'inlayHints': {
                const hints = await call('provideInlayHints', document, range, token);
                return Array.isArray(hints) ? hints.flatMap((hint: { position?: unknown; label?: unknown; kind?: unknown; tooltip?: unknown; paddingLeft?: unknown; paddingRight?: unknown }) => {
                    if (!(hint?.position instanceof Position)) {
                        return [];
                    }
                    const label = typeof hint.label === 'string' ? hint.label : Array.isArray(hint.label) ? hint.label.map((part: { value?: unknown }) => String(part?.value ?? '')).join('') : '';
                    const tooltip = markdown(hint.tooltip as Markdownish);
                    return [{
                        position: [hint.position.line, hint.position.character] as const, label,
                        ...(typeof hint.kind === 'number' ? { kind: hint.kind } : {}),
                        ...(tooltip ? { tooltip } : {}),
                        ...(hint.paddingLeft === true ? { paddingLeft: true } : {}),
                        ...(hint.paddingRight === true ? { paddingRight: true } : {}),
                    }];
                }) : [];
            }
            case 'documentLink': {
                const links = await call('provideDocumentLinks', document, token);
                return Array.isArray(links) ? links.flatMap((link: { range?: unknown; target?: unknown; tooltip?: unknown }) => {
                    const linkRange = asRange(link?.range);
                    const target = link?.target as Uri | undefined;
                    const url = target && ['http', 'https', 'mailto'].includes(target.scheme) ? target.toString(true) : undefined;
                    return linkRange && url ? [{ range: linkRange, url, ...(typeof link.tooltip === 'string' ? { tooltip: link.tooltip } : {}) }] : [];
                }) : [];
            }
        }
        return null;
    }

    /* ------------------------------ diagnostics ------------------------------ */

    createDiagnosticCollection(extensionId: ExtensionId, name: string): unknown {
        let owner = `${extensionId}:${name}`;
        for (let index = 2; this.owners.has(owner); index++) {
            owner = `${extensionId}:${name}#${index}`;
        }
        this.owners.add(owner);
        const state: CollectionState = { owner, entries: new Map(), pending: new Set(), cleared: false, scheduled: false };
        this.collections.add(state);
        const changed = (keys: readonly string[], cleared = false): void => {
            if (cleared) {
                state.cleared = true;
                state.pending.clear();
            }
            for (const key of keys) {
                state.pending.add(key);
            }
            this.schedule(state);
        };
        let disposed = false;
        const collection = {
            name,
            set: (uriOrEntries: Uri | readonly [Uri, readonly Diagnostic[] | undefined][], diagnostics?: readonly Diagnostic[]): void => {
                if (disposed) {
                    return;
                }
                if (Array.isArray(uriOrEntries)) {
                    // Entries for the same file add up, as in VS Code; an undefined list clears what came before it.
                    const merged = new Map<string, [Uri, Diagnostic[]]>();
                    for (const [uri, list] of uriOrEntries as [Uri, readonly Diagnostic[] | undefined][]) {
                        const key = uri.toString();
                        if (!list) {
                            merged.set(key, [uri, []]);
                        } else {
                            const bucket = merged.get(key) ?? [uri, []];
                            bucket[1].push(...list);
                            merged.set(key, bucket);
                        }
                    }
                    for (const [key, [uri, list]] of merged) {
                        this.setEntry(state, key, uri, list);
                    }
                    changed([...merged.keys()]);
                    return;
                }
                const uri = uriOrEntries as Uri;
                this.setEntry(state, uri.toString(), uri, diagnostics ? [...diagnostics] : []);
                changed([uri.toString()]);
            },
            delete: (uri: Uri): void => {
                if (state.entries.delete(uri.toString())) {
                    changed([uri.toString()]);
                }
            },
            clear: (): void => {
                const keys = [...state.entries.keys()];
                state.entries.clear();
                changed(keys, true);
            },
            forEach: (callback: (uri: Uri, diagnostics: readonly Diagnostic[], collection: unknown) => void, thisArg?: unknown): void => {
                for (const [uri, list] of [...state.entries.values()]) {
                    callback.call(thisArg, uri, list, collection);
                }
            },
            get: (uri: Uri): readonly Diagnostic[] | undefined => {
                const list = state.entries.get(uri.toString())?.[1];
                return list ? Object.freeze([...list]) : undefined;
            },
            has: (uri: Uri): boolean => state.entries.has(uri.toString()),
            dispose: (): void => {
                if (!disposed) {
                    collection.clear();
                    disposed = true;
                    this.owners.delete(owner);
                    this.collections.delete(state);
                }
            },
            [Symbol.iterator]: function* iterate(): Generator<[Uri, readonly Diagnostic[]]> {
                yield* [...state.entries.values()];
            },
        };
        return collection;
    }

    private setEntry(state: CollectionState, key: string, uri: Uri, list: Diagnostic[]): void {
        if (list.length === 0) {
            state.entries.delete(key);
        } else {
            state.entries.set(key, [uri, list.slice(0, MAX_DIAGNOSTICS_PER_FILE)]);
        }
    }

    private schedule(state: CollectionState): void {
        if (state.scheduled) {
            return;
        }
        state.scheduled = true;
        // Many `set` calls in one turn (a linter going over a folder) go out as one update.
        setTimeout(() => this.flush(state), 0);
    }

    private flush(state: CollectionState): void {
        state.scheduled = false;
        const keys = [...state.pending];
        const clear = state.cleared;
        state.pending.clear();
        state.cleared = false;
        const uris: Uri[] = [];
        const entries: { path: string; diagnostics: DiagnosticData[] }[] = [];
        for (const key of keys) {
            const uri = Uri.parse(key);
            uris.push(uri);
            if (uri.scheme !== 'file') {
                continue;
            }
            const list = state.entries.get(key)?.[1] ?? [];
            entries.push({ path: uri.fsPath, diagnostics: list.map(diagnosticData).filter((item): item is DiagnosticData => item !== null) });
        }
        if (entries.length > 0 || clear) {
            const update: DiagnosticsUpdate = { owner: state.owner, entries, ...(clear ? { clear: true } : {}) };
            this.host.rpc.notify(MAIN_METHODS.diagnostics, update);
        }
        if (uris.length > 0) {
            this.onDidChangeDiagnostics.fire({ uris });
        }
    }

    /** `languages.getDiagnostics`: every collection's, for one file or all. */
    getDiagnostics(uri?: Uri): unknown {
        if (uri) {
            const key = uri.toString();
            return [...this.collections].flatMap((state) => state.entries.get(key)?.[1] ?? []);
        }
        const byFile = new Map<string, [Uri, Diagnostic[]]>();
        for (const state of this.collections) {
            for (const [key, [entryUri, list]] of state.entries) {
                const bucket = byFile.get(key) ?? [entryUri, []];
                bucket[1].push(...list);
                byFile.set(key, bucket);
            }
        }
        return [...byFile.values()];
    }
}
