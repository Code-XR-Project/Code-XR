import { URI, Utils } from 'vscode-uri';

/**
 * The classes and enums of the `vscode` module (#259), as plain values that
 * behave like VS Code's own: extensions construct them, compare them with
 * `instanceof` and read their fields. Enum values are VS Code's numbers,
 * since extensions sometimes store or compare them as numbers.
 */

/* ------------------------------ enums ------------------------------ */

type EnumKeys<T> = Exclude<keyof T, number>;

/**
 * A TypeScript-style numeric enum without the `enum` syntax (the build only
 * strips types): the names map to VS Code's numbers and the numbers back to
 * the names, as `DiagnosticSeverity[0] === 'Error'`.
 */
function numericEnum<const T extends Readonly<Record<string, number>>>(values: T): T & { readonly [value: number]: string } {
    const result: Record<string | number, string | number> = { ...values };
    for (const [name, value] of Object.entries(values)) {
        result[value] = name;
    }
    return Object.freeze(result) as T & { readonly [value: number]: string };
}

/* --------------------------------- Uri --------------------------------- */

type UriWithJoin = typeof URI & { joinPath(base: URI, ...segments: string[]): URI };
const uri = URI as UriWithJoin;
if (typeof uri.joinPath !== 'function') {
    uri.joinPath = (base: URI, ...segments: string[]) => Utils.joinPath(base, ...segments);
}
/** `vscode.Uri`: vscode-uri's URI, the same class VS Code itself uses, plus `Uri.joinPath`. */
export const Uri = uri;
export type Uri = URI;

/* ------------------------------ Disposable ------------------------------ */

export class Disposable {
    static from(...disposables: { dispose(): unknown }[]): Disposable {
        return new Disposable(() => {
            for (const disposable of disposables) {
                try {
                    disposable?.dispose();
                } catch {
                    // Keep disposing the others.
                }
            }
        });
    }

    private callOnDispose: (() => unknown) | undefined;

    constructor(callOnDispose: () => unknown) {
        this.callOnDispose = callOnDispose;
    }

    dispose(): unknown {
        const callback = this.callOnDispose;
        this.callOnDispose = undefined;
        return callback?.();
    }
}

/* ------------------------------ Events ------------------------------ */

export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: { dispose(): unknown }[]) => Disposable;

export class EventEmitter<T> {
    private listeners: { fn: (e: T) => unknown; thisArgs: unknown }[] = [];
    private disposed = false;
    private eventFn: Event<T> | undefined;

    get event(): Event<T> {
        this.eventFn ??= (listener, thisArgs, disposables) => {
            if (this.disposed) {
                return new Disposable(() => undefined);
            }
            const entry = { fn: listener, thisArgs };
            this.listeners.push(entry);
            const result = new Disposable(() => {
                this.listeners = this.listeners.filter((other) => other !== entry);
            });
            disposables?.push(result);
            return result;
        };
        return this.eventFn;
    }

    fire(data: T): void {
        for (const { fn, thisArgs } of [...this.listeners]) {
            try {
                fn.call(thisArgs, data);
            } catch (error) {
                // One listener's error never stops the others, as in VS Code.
                console.error(error);
            }
        }
    }

    dispose(): void {
        this.disposed = true;
        this.listeners = [];
    }
}

/* --------------------------- Cancellation --------------------------- */

export interface CancellationToken {
    readonly isCancellationRequested: boolean;
    readonly onCancellationRequested: Event<unknown>;
}

const NONE_EVENT: Event<unknown> = () => new Disposable(() => undefined);

export const CancellationTokenNone: CancellationToken = Object.freeze({ isCancellationRequested: false, onCancellationRequested: NONE_EVENT });

export class CancellationTokenSource {
    private emitter: EventEmitter<unknown> | undefined;
    private cancelled = false;
    private tokenValue: CancellationToken | undefined;

    get token(): CancellationToken {
        if (!this.tokenValue) {
            const source = this;
            this.tokenValue = {
                get isCancellationRequested() {
                    return source.cancelled;
                },
                get onCancellationRequested() {
                    source.emitter ??= new EventEmitter<unknown>();
                    return source.emitter.event;
                },
            };
        }
        return this.tokenValue;
    }

    cancel(): void {
        if (!this.cancelled) {
            this.cancelled = true;
            this.emitter?.fire(undefined);
        }
    }

    dispose(cancel = false): void {
        if (cancel) {
            this.cancel();
        }
        this.emitter?.dispose();
    }
}

export class CancellationError extends Error {
    constructor() {
        super('Canceled');
        this.name = 'Canceled';
    }
}

/* ------------------------------ Positions ------------------------------ */

function checkNumber(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`Illegal argument: ${name} must be a non-negative number`);
    }
    return value;
}

export class Position {
    readonly line: number;
    readonly character: number;

    static isPosition(other: unknown): other is Position {
        return other instanceof Position || (typeof other === 'object' && other !== null && typeof (other as Position).line === 'number' && typeof (other as Position).character === 'number');
    }

    constructor(line: number, character: number) {
        this.line = checkNumber(line, 'line');
        this.character = checkNumber(character, 'character');
    }

    isBefore(other: Position): boolean {
        return this.line < other.line || (this.line === other.line && this.character < other.character);
    }
    isBeforeOrEqual(other: Position): boolean {
        return this.isBefore(other) || this.isEqual(other);
    }
    isAfter(other: Position): boolean {
        return !this.isBeforeOrEqual(other);
    }
    isAfterOrEqual(other: Position): boolean {
        return !this.isBefore(other);
    }
    isEqual(other: Position): boolean {
        return this.line === other.line && this.character === other.character;
    }
    compareTo(other: Position): number {
        return this.isBefore(other) ? -1 : this.isEqual(other) ? 0 : 1;
    }
    translate(lineDeltaOrChange?: number | { lineDelta?: number; characterDelta?: number }, characterDelta = 0): Position {
        const change = typeof lineDeltaOrChange === 'object' ? lineDeltaOrChange : { lineDelta: lineDeltaOrChange ?? 0, characterDelta };
        return new Position(this.line + (change.lineDelta ?? 0), this.character + (change.characterDelta ?? 0));
    }
    with(lineOrChange?: number | { line?: number; character?: number }, character?: number): Position {
        const change = typeof lineOrChange === 'object' ? lineOrChange : { line: lineOrChange ?? this.line, character: character ?? this.character };
        return new Position(change.line ?? this.line, change.character ?? this.character);
    }
    toJSON(): { line: number; character: number } {
        return { line: this.line, character: this.character };
    }
}

export class Range {
    readonly start: Position;
    readonly end: Position;

    static isRange(other: unknown): other is Range {
        return other instanceof Range || (typeof other === 'object' && other !== null && Position.isPosition((other as Range).start) && Position.isPosition((other as Range).end));
    }

    constructor(startOrLine: Position | number, endOrCharacter: Position | number, endLine?: number, endCharacter?: number) {
        let start: Position;
        let end: Position;
        if (typeof startOrLine === 'number' && typeof endOrCharacter === 'number') {
            start = new Position(startOrLine, endOrCharacter);
            end = new Position(endLine ?? 0, endCharacter ?? 0);
        } else if (startOrLine instanceof Position && endOrCharacter instanceof Position) {
            start = startOrLine;
            end = endOrCharacter;
        } else if (Position.isPosition(startOrLine) && Position.isPosition(endOrCharacter)) {
            start = new Position(startOrLine.line, startOrLine.character);
            end = new Position(endOrCharacter.line, endOrCharacter.character);
        } else {
            throw new Error('Illegal arguments for Range');
        }
        [this.start, this.end] = start.isBefore(end) || start.isEqual(end) ? [start, end] : [end, start];
    }

    get isEmpty(): boolean {
        return this.start.isEqual(this.end);
    }
    get isSingleLine(): boolean {
        return this.start.line === this.end.line;
    }
    contains(positionOrRange: Position | Range): boolean {
        if (positionOrRange instanceof Range) {
            return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
        }
        return positionOrRange.isAfterOrEqual(this.start) && positionOrRange.isBeforeOrEqual(this.end);
    }
    isEqual(other: Range): boolean {
        return this.start.isEqual(other.start) && this.end.isEqual(other.end);
    }
    intersection(other: Range): Range | undefined {
        const start = other.start.isAfter(this.start) ? other.start : this.start;
        const end = other.end.isBefore(this.end) ? other.end : this.end;
        return start.isAfter(end) ? undefined : new Range(start, end);
    }
    union(other: Range): Range {
        return new Range(other.start.isBefore(this.start) ? other.start : this.start, other.end.isAfter(this.end) ? other.end : this.end);
    }
    with(startOrChange?: Position | { start?: Position; end?: Position }, end?: Position): Range {
        const change = startOrChange instanceof Position || startOrChange === undefined ? { start: startOrChange ?? this.start, end: end ?? this.end } : startOrChange;
        return new Range(change.start ?? this.start, change.end ?? this.end);
    }
    toJSON(): [Position, Position] {
        return [this.start, this.end];
    }
}

export class Selection extends Range {
    readonly anchor: Position;
    readonly active: Position;

    constructor(anchorOrLine: Position | number, activeOrCharacter: Position | number, activeLine?: number, activeCharacter?: number) {
        const anchor = typeof anchorOrLine === 'number' ? new Position(anchorOrLine, activeOrCharacter as number) : anchorOrLine;
        const active = typeof anchorOrLine === 'number' ? new Position(activeLine ?? 0, activeCharacter ?? 0) : activeOrCharacter as Position;
        super(anchor, active);
        this.anchor = anchor;
        this.active = active;
    }

    get isReversed(): boolean {
        return this.anchor === this.end && !this.isEmpty;
    }
}

export class Location {
    uri: Uri;
    range: Range;

    constructor(uriValue: Uri, rangeOrPosition: Range | Position) {
        this.uri = uriValue;
        this.range = rangeOrPosition instanceof Position ? new Range(rangeOrPosition, rangeOrPosition) : rangeOrPosition;
    }
}

/* ------------------------------ Text edits ------------------------------ */

export const EndOfLine = numericEnum({ LF: 1, CRLF: 2 } as const);
export type EndOfLine = (typeof EndOfLine)[EnumKeys<typeof EndOfLine>];

export class TextEdit {
    static replace(range: Range, newText: string): TextEdit {
        return new TextEdit(range, newText);
    }
    static insert(position: Position, newText: string): TextEdit {
        return new TextEdit(new Range(position, position), newText);
    }
    static delete(range: Range): TextEdit {
        return new TextEdit(range, '');
    }
    static setEndOfLine(eol: EndOfLine): TextEdit {
        const edit = new TextEdit(new Range(0, 0, 0, 0), '');
        edit.newEol = eol;
        return edit;
    }

    range: Range;
    newText: string;
    newEol?: EndOfLine;

    constructor(range: Range, newText: string) {
        this.range = range;
        this.newText = newText;
    }
}

export class SnippetString {
    value: string;

    constructor(value = '') {
        this.value = value;
    }

    private static escape(text: string): string {
        return text.replace(/[$}\\]/g, '\\$&');
    }

    private tabstop = 1;

    appendText(text: string): SnippetString {
        this.value += SnippetString.escape(text);
        return this;
    }
    appendTabstop(number = this.tabstop++): SnippetString {
        this.value += `$${number}`;
        return this;
    }
    appendPlaceholder(value: string | ((snippet: SnippetString) => unknown), number = this.tabstop++): SnippetString {
        if (typeof value === 'function') {
            const nested = new SnippetString();
            nested.tabstop = this.tabstop;
            value(nested);
            this.tabstop = nested.tabstop;
            this.value += `\${${number}:${nested.value}}`;
        } else {
            this.value += `\${${number}:${SnippetString.escape(value)}}`;
        }
        return this;
    }
    appendChoice(values: readonly string[], number = this.tabstop++): SnippetString {
        this.value += `\${${number}|${values.map((value) => value.replace(/[|,\\]/g, '\\$&')).join(',')}|}`;
        return this;
    }
    appendVariable(name: string, defaultValue: string | ((snippet: SnippetString) => unknown)): SnippetString {
        if (typeof defaultValue === 'function') {
            const nested = new SnippetString();
            nested.tabstop = this.tabstop;
            defaultValue(nested);
            this.tabstop = nested.tabstop;
            this.value += `\${${name}:${nested.value}}`;
        } else {
            this.value += `\${${name}:${SnippetString.escape(defaultValue)}}`;
        }
        return this;
    }
}

export class SnippetTextEdit {
    static replace(range: Range, snippet: SnippetString): SnippetTextEdit {
        return new SnippetTextEdit(range, snippet);
    }
    static insert(position: Position, snippet: SnippetString): SnippetTextEdit {
        return new SnippetTextEdit(new Range(position, position), snippet);
    }
    range: Range;
    snippet: SnippetString;
    constructor(range: Range, snippet: SnippetString) {
        this.range = range;
        this.snippet = snippet;
    }
}

export interface WorkspaceEditEntry {
    readonly kind: 'edit' | 'create' | 'delete' | 'rename';
    readonly uri: Uri;
    readonly edit?: TextEdit;
    readonly newUri?: Uri;
    readonly options?: Readonly<Record<string, unknown>>;
}

export class WorkspaceEdit {
    private readonly items: WorkspaceEditEntry[] = [];

    get size(): number {
        return new Set(this.items.map((entry) => entry.uri.toString())).size;
    }
    replace(target: Uri, range: Range, newText: string): void {
        this.items.push({ kind: 'edit', uri: target, edit: new TextEdit(range, newText) });
    }
    insert(target: Uri, position: Position, newText: string): void {
        this.replace(target, new Range(position, position), newText);
    }
    delete(target: Uri, range: Range): void {
        this.replace(target, range, '');
    }
    has(target: Uri): boolean {
        return this.items.some((entry) => entry.uri.toString() === target.toString());
    }
    set(target: Uri, edits: readonly (TextEdit | SnippetTextEdit | [TextEdit, unknown])[] | null | undefined): void {
        for (let index = this.items.length - 1; index >= 0; index--) {
            const entry = this.items[index];
            if (entry?.kind === 'edit' && entry.uri.toString() === target.toString()) {
                this.items.splice(index, 1);
            }
        }
        for (const item of edits ?? []) {
            const edit = Array.isArray(item) ? item[0] : item;
            this.items.push({ kind: 'edit', uri: target, edit: edit instanceof SnippetTextEdit ? new TextEdit(edit.range, edit.snippet.value) : edit });
        }
    }
    get(target: Uri): TextEdit[] {
        return this.items.filter((entry) => entry.kind === 'edit' && entry.uri.toString() === target.toString()).map((entry) => entry.edit as TextEdit);
    }
    createFile(target: Uri, options?: Record<string, unknown>): void {
        this.items.push({ kind: 'create', uri: target, ...(options ? { options } : {}) });
    }
    deleteFile(target: Uri, options?: Record<string, unknown>): void {
        this.items.push({ kind: 'delete', uri: target, ...(options ? { options } : {}) });
    }
    renameFile(oldUri: Uri, newUri: Uri, options?: Record<string, unknown>): void {
        this.items.push({ kind: 'rename', uri: oldUri, newUri, ...(options ? { options } : {}) });
    }
    /** Every operation in order, for applying the edit (not VS Code API). */
    operations(): readonly WorkspaceEditEntry[] {
        return this.items;
    }
    entries(): [Uri, TextEdit[]][] {
        const map = new Map<string, [Uri, TextEdit[]]>();
        for (const entry of this.items) {
            if (entry.kind === 'edit' && entry.edit) {
                const key = entry.uri.toString();
                const bucket = map.get(key) ?? [entry.uri, []];
                bucket[1].push(entry.edit);
                map.set(key, bucket);
            }
        }
        return [...map.values()];
    }
}

/* ------------------------------ Markdown, icons ------------------------------ */

export class MarkdownString {
    value: string;
    isTrusted?: boolean | { enabledCommands: readonly string[] };
    supportThemeIcons?: boolean;
    supportHtml?: boolean;
    baseUri?: Uri;

    constructor(value = '', supportThemeIcons = false) {
        this.value = value;
        this.supportThemeIcons = supportThemeIcons;
    }
    appendText(value: string): MarkdownString {
        this.value += value.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&').replace(/\n/g, '\n\n');
        return this;
    }
    appendMarkdown(value: string): MarkdownString {
        this.value += value;
        return this;
    }
    appendCodeblock(value: string, language = ''): MarkdownString {
        this.value += `\n\`\`\`${language}\n${value}\n\`\`\`\n`;
        return this;
    }
}

export class ThemeColor {
    readonly id: string;
    constructor(id: string) {
        this.id = id;
    }
}

export class ThemeIcon {
    static readonly File = new ThemeIcon('file');
    static readonly Folder = new ThemeIcon('folder');
    readonly id: string;
    readonly color?: ThemeColor;
    constructor(id: string, color?: ThemeColor) {
        this.id = id;
        if (color) {
            this.color = color;
        }
    }
}

/* ------------------------------ Diagnostics ------------------------------ */

export const DiagnosticSeverity = numericEnum({ Error: 0, Warning: 1, Information: 2, Hint: 3 } as const);
export type DiagnosticSeverity = (typeof DiagnosticSeverity)[EnumKeys<typeof DiagnosticSeverity>];
export const DiagnosticTag = numericEnum({ Unnecessary: 1, Deprecated: 2 } as const);
export type DiagnosticTag = (typeof DiagnosticTag)[EnumKeys<typeof DiagnosticTag>];

export class DiagnosticRelatedInformation {
    location: Location;
    message: string;
    constructor(location: Location, message: string) {
        this.location = location;
        this.message = message;
    }
}

export class Diagnostic {
    range: Range;
    message: string;
    severity: DiagnosticSeverity;
    source?: string;
    code?: string | number | { value: string | number; target: Uri };
    relatedInformation?: DiagnosticRelatedInformation[];
    tags?: DiagnosticTag[];
    constructor(range: Range, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error) {
        this.range = range;
        this.message = message;
        this.severity = severity;
    }
}

/* ------------------------------ Language features ------------------------------ */

export const CompletionItemKind = numericEnum({ Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17, Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22, Operator: 23, TypeParameter: 24, User: 25, Issue: 26 } as const);
export type CompletionItemKind = (typeof CompletionItemKind)[EnumKeys<typeof CompletionItemKind>];
export const CompletionItemTag = numericEnum({ Deprecated: 1 } as const);
export type CompletionItemTag = (typeof CompletionItemTag)[EnumKeys<typeof CompletionItemTag>];
export const CompletionTriggerKind = numericEnum({ Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 } as const);
export type CompletionTriggerKind = (typeof CompletionTriggerKind)[EnumKeys<typeof CompletionTriggerKind>];

export class CompletionItem {
    label: string | { label: string; detail?: string; description?: string };
    kind?: CompletionItemKind;
    tags?: CompletionItemTag[];
    detail?: string;
    documentation?: string | MarkdownString;
    sortText?: string;
    filterText?: string;
    preselect?: boolean;
    insertText?: string | SnippetString;
    range?: Range | { inserting: Range; replacing: Range };
    commitCharacters?: string[];
    keepWhitespace?: boolean;
    additionalTextEdits?: TextEdit[];
    command?: Command;
    constructor(label: string | { label: string; detail?: string; description?: string }, kind?: CompletionItemKind) {
        this.label = label;
        if (kind !== undefined) {
            this.kind = kind;
        }
    }
}

export class CompletionList {
    isIncomplete?: boolean;
    items: CompletionItem[];
    constructor(items: CompletionItem[] = [], isIncomplete = false) {
        this.items = items;
        this.isIncomplete = isIncomplete;
    }
}

export class Hover {
    contents: (MarkdownString | string | { language: string; value: string })[];
    range?: Range;
    constructor(contents: MarkdownString | string | { language: string; value: string } | (MarkdownString | string | { language: string; value: string })[], range?: Range) {
        this.contents = Array.isArray(contents) ? contents : [contents];
        if (range) {
            this.range = range;
        }
    }
}

export const SymbolKind = numericEnum({ File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25 } as const);
export type SymbolKind = (typeof SymbolKind)[EnumKeys<typeof SymbolKind>];
export const SymbolTag = numericEnum({ Deprecated: 1 } as const);
export type SymbolTag = (typeof SymbolTag)[EnumKeys<typeof SymbolTag>];

export class SymbolInformation {
    name: string;
    containerName: string;
    kind: SymbolKind;
    location: Location;
    tags?: SymbolTag[];
    constructor(name: string, kind: SymbolKind, rangeOrContainer: Range | string, locationOrUri?: Location | Uri, containerName?: string) {
        this.name = name;
        this.kind = kind;
        if (typeof rangeOrContainer === 'string') {
            this.containerName = rangeOrContainer;
            this.location = locationOrUri as Location;
        } else {
            this.containerName = containerName ?? '';
            this.location = new Location(locationOrUri as Uri, rangeOrContainer);
        }
    }
}

export class DocumentSymbol {
    name: string;
    detail: string;
    kind: SymbolKind;
    range: Range;
    selectionRange: Range;
    children: DocumentSymbol[] = [];
    tags?: SymbolTag[];
    constructor(name: string, detail: string, kind: SymbolKind, range: Range, selectionRange: Range) {
        this.name = name;
        this.detail = detail;
        this.kind = kind;
        this.range = range;
        this.selectionRange = selectionRange;
    }
}

export class CodeActionKind {
    static readonly Empty = new CodeActionKind('');
    static readonly QuickFix = new CodeActionKind('quickfix');
    static readonly Refactor = new CodeActionKind('refactor');
    static readonly RefactorExtract = new CodeActionKind('refactor.extract');
    static readonly RefactorInline = new CodeActionKind('refactor.inline');
    static readonly RefactorMove = new CodeActionKind('refactor.move');
    static readonly RefactorRewrite = new CodeActionKind('refactor.rewrite');
    static readonly Source = new CodeActionKind('source');
    static readonly SourceOrganizeImports = new CodeActionKind('source.organizeImports');
    static readonly SourceFixAll = new CodeActionKind('source.fixAll');
    static readonly Notebook = new CodeActionKind('notebook');
    readonly value: string;
    constructor(value: string) {
        this.value = value;
    }
    append(parts: string): CodeActionKind {
        return new CodeActionKind(this.value ? `${this.value}.${parts}` : parts);
    }
    intersects(other: CodeActionKind): boolean {
        return this.contains(other) || other.contains(this);
    }
    contains(other: CodeActionKind): boolean {
        return this.value === '' || other.value === this.value || other.value.startsWith(`${this.value}.`);
    }
}

export const CodeActionTriggerKind = numericEnum({ Invoke: 1, Automatic: 2 } as const);
export type CodeActionTriggerKind = (typeof CodeActionTriggerKind)[EnumKeys<typeof CodeActionTriggerKind>];

export class CodeAction {
    title: string;
    kind?: CodeActionKind;
    edit?: WorkspaceEdit;
    diagnostics?: Diagnostic[];
    command?: Command;
    isPreferred?: boolean;
    disabled?: { reason: string };
    constructor(title: string, kind?: CodeActionKind) {
        this.title = title;
        if (kind) {
            this.kind = kind;
        }
    }
}

export class CodeLens {
    range: Range;
    command?: Command;
    constructor(range: Range, command?: Command) {
        this.range = range;
        if (command) {
            this.command = command;
        }
    }
    get isResolved(): boolean {
        return !!this.command;
    }
}

export const DocumentHighlightKind = numericEnum({ Text: 0, Read: 1, Write: 2 } as const);
export type DocumentHighlightKind = (typeof DocumentHighlightKind)[EnumKeys<typeof DocumentHighlightKind>];
export class DocumentHighlight {
    range: Range;
    kind: DocumentHighlightKind;
    constructor(range: Range, kind = DocumentHighlightKind.Text) {
        this.range = range;
        this.kind = kind;
    }
}

export class FoldingRange {
    start: number;
    end: number;
    kind?: FoldingRangeKind;
    constructor(start: number, end: number, kind?: FoldingRangeKind) {
        this.start = start;
        this.end = end;
        if (kind !== undefined) {
            this.kind = kind;
        }
    }
}
export const FoldingRangeKind = numericEnum({ Comment: 1, Imports: 2, Region: 3 } as const);
export type FoldingRangeKind = (typeof FoldingRangeKind)[EnumKeys<typeof FoldingRangeKind>];

export class SignatureHelp {
    signatures: SignatureInformation[] = [];
    activeSignature = 0;
    activeParameter = 0;
}
export class SignatureInformation {
    label: string;
    documentation?: string | MarkdownString;
    parameters: ParameterInformation[] = [];
    activeParameter?: number;
    constructor(label: string, documentation?: string | MarkdownString) {
        this.label = label;
        if (documentation !== undefined) {
            this.documentation = documentation;
        }
    }
}
export class ParameterInformation {
    label: string | [number, number];
    documentation?: string | MarkdownString;
    constructor(label: string | [number, number], documentation?: string | MarkdownString) {
        this.label = label;
        if (documentation !== undefined) {
            this.documentation = documentation;
        }
    }
}
export const SignatureHelpTriggerKind = numericEnum({ Invoke: 1, TriggerCharacter: 2, ContentChange: 3 } as const);
export type SignatureHelpTriggerKind = (typeof SignatureHelpTriggerKind)[EnumKeys<typeof SignatureHelpTriggerKind>];

export class DocumentLink {
    range: Range;
    target?: Uri;
    tooltip?: string;
    constructor(range: Range, target?: Uri) {
        this.range = range;
        if (target) {
            this.target = target;
        }
    }
}

export class Color {
    readonly red: number;
    readonly green: number;
    readonly blue: number;
    readonly alpha: number;
    constructor(red: number, green: number, blue: number, alpha: number) {
        this.red = red;
        this.green = green;
        this.blue = blue;
        this.alpha = alpha;
    }
}
export class ColorInformation {
    range: Range;
    color: Color;
    constructor(range: Range, color: Color) {
        this.range = range;
        this.color = color;
    }
}
export class ColorPresentation {
    label: string;
    textEdit?: TextEdit;
    additionalTextEdits?: TextEdit[];
    constructor(label: string) {
        this.label = label;
    }
}

export class InlayHint {
    position: Position;
    label: string | InlayHintLabelPart[];
    kind?: InlayHintKind;
    tooltip?: string | MarkdownString;
    paddingLeft?: boolean;
    paddingRight?: boolean;
    constructor(position: Position, label: string | InlayHintLabelPart[], kind?: InlayHintKind) {
        this.position = position;
        this.label = label;
        if (kind !== undefined) {
            this.kind = kind;
        }
    }
}
export const InlayHintKind = numericEnum({ Type: 1, Parameter: 2 } as const);
export type InlayHintKind = (typeof InlayHintKind)[EnumKeys<typeof InlayHintKind>];

export class SelectionRange {
    range: Range;
    parent?: SelectionRange;
    constructor(range: Range, parent?: SelectionRange) {
        this.range = range;
        if (parent) {
            this.parent = parent;
        }
    }
}

/* ------- hierarchies, inline values and completions: the classes vscode-languageclient extends at load ------- */

export class CallHierarchyItem {
    kind: SymbolKind;
    name: string;
    detail?: string;
    uri: Uri;
    range: Range;
    selectionRange: Range;
    tags?: SymbolTag[];
    constructor(kind: SymbolKind, name: string, detail: string, uriValue: Uri, range: Range, selectionRange: Range) {
        this.kind = kind;
        this.name = name;
        this.detail = detail;
        this.uri = uriValue;
        this.range = range;
        this.selectionRange = selectionRange;
    }
}
export class CallHierarchyIncomingCall {
    from: CallHierarchyItem;
    fromRanges: Range[];
    constructor(from: CallHierarchyItem, fromRanges: Range[]) {
        this.from = from;
        this.fromRanges = fromRanges;
    }
}
export class CallHierarchyOutgoingCall {
    to: CallHierarchyItem;
    fromRanges: Range[];
    constructor(to: CallHierarchyItem, fromRanges: Range[]) {
        this.to = to;
        this.fromRanges = fromRanges;
    }
}
export class TypeHierarchyItem {
    kind: SymbolKind;
    name: string;
    detail?: string;
    uri: Uri;
    range: Range;
    selectionRange: Range;
    tags?: SymbolTag[];
    constructor(kind: SymbolKind, name: string, detail: string, uriValue: Uri, range: Range, selectionRange: Range) {
        this.kind = kind;
        this.name = name;
        this.detail = detail;
        this.uri = uriValue;
        this.range = range;
        this.selectionRange = selectionRange;
    }
}
export class InlayHintLabelPart {
    value: string;
    tooltip?: string | MarkdownString;
    location?: Location;
    command?: Command;
    constructor(value: string) {
        this.value = value;
    }
}
export class InlineCompletionItem {
    insertText: string | SnippetString;
    filterText?: string;
    range?: Range;
    command?: Command;
    constructor(insertText: string | SnippetString, range?: Range, command?: Command) {
        this.insertText = insertText;
        if (range) {
            this.range = range;
        }
        if (command) {
            this.command = command;
        }
    }
}
export class InlineCompletionList {
    items: InlineCompletionItem[];
    constructor(items: InlineCompletionItem[]) {
        this.items = items;
    }
}
export class InlineValueText {
    readonly range: Range;
    readonly text: string;
    constructor(range: Range, text: string) {
        this.range = range;
        this.text = text;
    }
}
export class InlineValueVariableLookup {
    readonly range: Range;
    readonly variableName?: string;
    readonly caseSensitiveLookup: boolean;
    constructor(range: Range, variableName?: string, caseSensitiveLookup = true) {
        this.range = range;
        if (variableName !== undefined) {
            this.variableName = variableName;
        }
        this.caseSensitiveLookup = caseSensitiveLookup;
    }
}
export class InlineValueEvaluatableExpression {
    readonly range: Range;
    readonly expression?: string;
    constructor(range: Range, expression?: string) {
        this.range = range;
        if (expression !== undefined) {
            this.expression = expression;
        }
    }
}
export class EvaluatableExpression {
    readonly range: Range;
    readonly expression?: string;
    constructor(range: Range, expression?: string) {
        this.range = range;
        if (expression !== undefined) {
            this.expression = expression;
        }
    }
}
export class LinkedEditingRanges {
    readonly ranges: Range[];
    readonly wordPattern?: RegExp;
    constructor(ranges: Range[], wordPattern?: RegExp) {
        this.ranges = ranges;
        if (wordPattern) {
            this.wordPattern = wordPattern;
        }
    }
}
export class SemanticTokensEdit {
    readonly start: number;
    readonly deleteCount: number;
    readonly data?: Uint32Array;
    constructor(start: number, deleteCount: number, data?: Uint32Array) {
        this.start = start;
        this.deleteCount = deleteCount;
        if (data) {
            this.data = data;
        }
    }
}
export class SemanticTokensEdits {
    readonly resultId?: string;
    readonly edits: SemanticTokensEdit[];
    constructor(edits: SemanticTokensEdit[], resultId?: string) {
        this.edits = edits;
        if (resultId !== undefined) {
            this.resultId = resultId;
        }
    }
}

/* ------------------------------ tabs (window.tabGroups) ------------------------------ */

export class TabInputText {
    readonly uri: Uri;
    constructor(uriValue: Uri) {
        this.uri = uriValue;
    }
}
export class TabInputTextDiff {
    readonly original: Uri;
    readonly modified: Uri;
    constructor(original: Uri, modified: Uri) {
        this.original = original;
        this.modified = modified;
    }
}
export class TabInputCustom {
    readonly uri: Uri;
    readonly viewType: string;
    constructor(uriValue: Uri, viewType: string) {
        this.uri = uriValue;
        this.viewType = viewType;
    }
}
export class TabInputWebview {
    readonly viewType: string;
    constructor(viewType: string) {
        this.viewType = viewType;
    }
}
export class TabInputNotebook {
    readonly uri: Uri;
    readonly notebookType: string;
    constructor(uriValue: Uri, notebookType: string) {
        this.uri = uriValue;
        this.notebookType = notebookType;
    }
}
export class TabInputTerminal {}

export class SemanticTokensLegend {
    readonly tokenTypes: string[];
    readonly tokenModifiers: string[];
    constructor(tokenTypes: string[], tokenModifiers: string[] = []) {
        this.tokenTypes = tokenTypes;
        this.tokenModifiers = tokenModifiers;
    }
}
export class SemanticTokens {
    readonly resultId?: string;
    readonly data: Uint32Array;
    constructor(data: Uint32Array, resultId?: string) {
        this.data = data;
        if (resultId !== undefined) {
            this.resultId = resultId;
        }
    }
}
export class SemanticTokensBuilder {
    private readonly data: number[] = [];
    private prevLine = 0;
    private prevChar = 0;
    private readonly legend: SemanticTokensLegend | undefined;
    constructor(legend?: SemanticTokensLegend) {
        this.legend = legend;
    }
    push(lineOrRange: number | Range, charOrType: number | string, lengthOrModifiers?: number | readonly string[], tokenType?: number, tokenModifiers = 0): void {
        if (typeof lineOrRange === 'number') {
            this.pushEncoded(lineOrRange, charOrType as number, lengthOrModifiers as number, tokenType ?? 0, tokenModifiers);
            return;
        }
        const typeIndex = this.legend?.tokenTypes.indexOf(charOrType as string) ?? -1;
        let modifiers = 0;
        for (const modifier of (lengthOrModifiers as readonly string[] | undefined) ?? []) {
            const index = this.legend?.tokenModifiers.indexOf(modifier) ?? -1;
            if (index >= 0) {
                modifiers |= 1 << index;
            }
        }
        if (typeIndex >= 0) {
            this.pushEncoded(lineOrRange.start.line, lineOrRange.start.character, lineOrRange.end.character - lineOrRange.start.character, typeIndex, modifiers);
        }
    }
    private pushEncoded(line: number, char: number, length: number, tokenType: number, modifiers: number): void {
        const deltaLine = line - this.prevLine;
        const deltaChar = deltaLine === 0 ? char - this.prevChar : char;
        this.data.push(deltaLine, deltaChar, length, tokenType, modifiers);
        this.prevLine = line;
        this.prevChar = char;
    }
    build(resultId?: string): SemanticTokens {
        return new SemanticTokens(new Uint32Array(this.data), resultId);
    }
}

/* ------------------------------ Commands, UI ------------------------------ */

export interface Command {
    title: string;
    command: string;
    tooltip?: string;
    arguments?: unknown[];
}

export const StatusBarAlignment = numericEnum({ Left: 1, Right: 2 } as const);
export type StatusBarAlignment = (typeof StatusBarAlignment)[EnumKeys<typeof StatusBarAlignment>];
export const ViewColumn = numericEnum({ Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 } as const);
export type ViewColumn = (typeof ViewColumn)[EnumKeys<typeof ViewColumn>];
export const ProgressLocation = numericEnum({ SourceControl: 1, Window: 10, Notification: 15 } as const);
export type ProgressLocation = (typeof ProgressLocation)[EnumKeys<typeof ProgressLocation>];
export const QuickPickItemKind = numericEnum({ Separator: -1, Default: 0 } as const);
export type QuickPickItemKind = (typeof QuickPickItemKind)[EnumKeys<typeof QuickPickItemKind>];
export const InputBoxValidationSeverity = numericEnum({ Info: 1, Warning: 2, Error: 3 } as const);
export type InputBoxValidationSeverity = (typeof InputBoxValidationSeverity)[EnumKeys<typeof InputBoxValidationSeverity>];
export const TextEditorRevealType = numericEnum({ Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 } as const);
export type TextEditorRevealType = (typeof TextEditorRevealType)[EnumKeys<typeof TextEditorRevealType>];
export const TextEditorCursorStyle = numericEnum({ Line: 1, Block: 2, Underline: 3, LineThin: 4, BlockOutline: 5, UnderlineThin: 6 } as const);
export type TextEditorCursorStyle = (typeof TextEditorCursorStyle)[EnumKeys<typeof TextEditorCursorStyle>];
export const TextEditorLineNumbersStyle = numericEnum({ Off: 0, On: 1, Relative: 2, Interval: 3 } as const);
export type TextEditorLineNumbersStyle = (typeof TextEditorLineNumbersStyle)[EnumKeys<typeof TextEditorLineNumbersStyle>];
export const TextEditorSelectionChangeKind = numericEnum({ Keyboard: 1, Mouse: 2, Command: 3 } as const);
export type TextEditorSelectionChangeKind = (typeof TextEditorSelectionChangeKind)[EnumKeys<typeof TextEditorSelectionChangeKind>];
export const DecorationRangeBehavior = numericEnum({ OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 } as const);
export type DecorationRangeBehavior = (typeof DecorationRangeBehavior)[EnumKeys<typeof DecorationRangeBehavior>];
export const OverviewRulerLane = numericEnum({ Left: 1, Center: 2, Right: 4, Full: 7 } as const);
export type OverviewRulerLane = (typeof OverviewRulerLane)[EnumKeys<typeof OverviewRulerLane>];
export const ColorThemeKind = numericEnum({ Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 } as const);
export type ColorThemeKind = (typeof ColorThemeKind)[EnumKeys<typeof ColorThemeKind>];
export const TreeItemCollapsibleState = numericEnum({ None: 0, Collapsed: 1, Expanded: 2 } as const);
export type TreeItemCollapsibleState = (typeof TreeItemCollapsibleState)[EnumKeys<typeof TreeItemCollapsibleState>];
export const TreeItemCheckboxState = numericEnum({ Unchecked: 0, Checked: 1 } as const);
export type TreeItemCheckboxState = (typeof TreeItemCheckboxState)[EnumKeys<typeof TreeItemCheckboxState>];

export class TreeItem {
    label?: string | { label: string; highlights?: [number, number][] };
    id?: string;
    iconPath?: string | Uri | ThemeIcon | { light: string | Uri; dark: string | Uri };
    description?: string | boolean;
    resourceUri?: Uri;
    tooltip?: string | MarkdownString;
    command?: Command;
    collapsibleState?: TreeItemCollapsibleState;
    contextValue?: string;
    checkboxState?: TreeItemCheckboxState;
    constructor(labelOrUri: string | { label: string } | Uri, collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {
        if (labelOrUri instanceof URI) {
            this.resourceUri = labelOrUri;
        } else {
            this.label = labelOrUri;
        }
        this.collapsibleState = collapsibleState;
    }
}

export class StatementCoverage {}

/* ------------------------------ Workspace, configuration ------------------------------ */

export const ConfigurationTarget = numericEnum({ Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const);
export type ConfigurationTarget = (typeof ConfigurationTarget)[EnumKeys<typeof ConfigurationTarget>];
export const FileType = numericEnum({ Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const);
export type FileType = (typeof FileType)[EnumKeys<typeof FileType>];
export const FilePermission = numericEnum({ Readonly: 1 } as const);
export type FilePermission = (typeof FilePermission)[EnumKeys<typeof FilePermission>];
export const FileChangeType = numericEnum({ Changed: 1, Created: 2, Deleted: 3 } as const);
export type FileChangeType = (typeof FileChangeType)[EnumKeys<typeof FileChangeType>];
export const TextDocumentSaveReason = numericEnum({ Manual: 1, AfterDelay: 2, FocusOut: 3 } as const);
export type TextDocumentSaveReason = (typeof TextDocumentSaveReason)[EnumKeys<typeof TextDocumentSaveReason>];
export const TextDocumentChangeReason = numericEnum({ Undo: 1, Redo: 2 } as const);
export type TextDocumentChangeReason = (typeof TextDocumentChangeReason)[EnumKeys<typeof TextDocumentChangeReason>];

export class FileSystemError extends Error {
    static FileNotFound(messageOrUri?: string | Uri): FileSystemError {
        return new FileSystemError(messageOrUri, 'FileNotFound');
    }
    static FileExists(messageOrUri?: string | Uri): FileSystemError {
        return new FileSystemError(messageOrUri, 'FileExists');
    }
    static FileNotADirectory(messageOrUri?: string | Uri): FileSystemError {
        return new FileSystemError(messageOrUri, 'FileNotADirectory');
    }
    static FileIsADirectory(messageOrUri?: string | Uri): FileSystemError {
        return new FileSystemError(messageOrUri, 'FileIsADirectory');
    }
    static NoPermissions(messageOrUri?: string | Uri): FileSystemError {
        return new FileSystemError(messageOrUri, 'NoPermissions');
    }
    static Unavailable(messageOrUri?: string | Uri): FileSystemError {
        return new FileSystemError(messageOrUri, 'Unavailable');
    }
    readonly code: string;
    constructor(messageOrUri?: string | Uri, code = 'Unknown') {
        super(typeof messageOrUri === 'string' ? messageOrUri : messageOrUri ? `${code}: ${messageOrUri.toString()}` : code);
        this.code = code;
        this.name = `${code} (FileSystemError)`;
    }
}

export class RelativePattern {
    baseUri: Uri;
    base: string;
    pattern: string;
    constructor(base: string | Uri | { uri: Uri }, pattern: string) {
        this.baseUri = typeof base === 'string' ? Uri.file(base) : base instanceof URI ? base : base.uri;
        this.base = this.baseUri.fsPath;
        this.pattern = pattern;
    }
}

/* ------------------------------ Extensions, env ------------------------------ */

export const ExtensionMode = numericEnum({ Production: 1, Development: 2, Test: 3 } as const);
export type ExtensionMode = (typeof ExtensionMode)[EnumKeys<typeof ExtensionMode>];
export const ExtensionKind = numericEnum({ UI: 1, Workspace: 2 } as const);
export type ExtensionKind = (typeof ExtensionKind)[EnumKeys<typeof ExtensionKind>];
export const UIKind = numericEnum({ Desktop: 1, Web: 2 } as const);
export type UIKind = (typeof UIKind)[EnumKeys<typeof UIKind>];
export const LogLevel = numericEnum({ Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 } as const);
export type LogLevel = (typeof LogLevel)[EnumKeys<typeof LogLevel>];
export const EnvironmentVariableMutatorType = numericEnum({ Replace: 1, Append: 2, Prepend: 3 } as const);
export type EnvironmentVariableMutatorType = (typeof EnvironmentVariableMutatorType)[EnumKeys<typeof EnvironmentVariableMutatorType>];

/* ------------------------------ Terminals, tasks, debug (shapes only) ------------------------------ */

export const TerminalLocation = numericEnum({ Panel: 1, Editor: 2 } as const);
export type TerminalLocation = (typeof TerminalLocation)[EnumKeys<typeof TerminalLocation>];
export const TerminalExitReason = numericEnum({ Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 } as const);
export type TerminalExitReason = (typeof TerminalExitReason)[EnumKeys<typeof TerminalExitReason>];
export const TaskScope = numericEnum({ Global: 1, Workspace: 2 } as const);
export type TaskScope = (typeof TaskScope)[EnumKeys<typeof TaskScope>];
export const TaskRevealKind = numericEnum({ Always: 1, Silent: 2, Never: 3 } as const);
export type TaskRevealKind = (typeof TaskRevealKind)[EnumKeys<typeof TaskRevealKind>];
export const TaskPanelKind = numericEnum({ Shared: 1, Dedicated: 2, New: 3 } as const);
export type TaskPanelKind = (typeof TaskPanelKind)[EnumKeys<typeof TaskPanelKind>];

export class TaskGroup {
    static readonly Clean = new TaskGroup('clean', 'Clean');
    static readonly Build = new TaskGroup('build', 'Build');
    static readonly Rebuild = new TaskGroup('rebuild', 'Rebuild');
    static readonly Test = new TaskGroup('test', 'Test');
    readonly id: string;
    readonly label: string;
    isDefault?: boolean;
    constructor(id: string, label: string) {
        this.id = id;
        this.label = label;
    }
}

export class ShellExecution {
    commandLine?: string;
    command?: string;
    args?: string[];
    options?: Record<string, unknown>;
    constructor(commandOrLine: string, argsOrOptions?: string[] | Record<string, unknown>, options?: Record<string, unknown>) {
        if (Array.isArray(argsOrOptions)) {
            this.command = commandOrLine;
            this.args = argsOrOptions;
            if (options) {
                this.options = options;
            }
        } else {
            this.commandLine = commandOrLine;
            if (argsOrOptions) {
                this.options = argsOrOptions;
            }
        }
    }
}

export class ProcessExecution {
    process: string;
    args: string[];
    options?: Record<string, unknown>;
    constructor(process: string, argsOrOptions?: string[] | Record<string, unknown>, options?: Record<string, unknown>) {
        this.process = process;
        this.args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
        const resolved = Array.isArray(argsOrOptions) ? options : argsOrOptions;
        if (resolved) {
            this.options = resolved;
        }
    }
}

export class Task {
    definition: Record<string, unknown>;
    scope: unknown;
    name: string;
    source: string;
    execution?: ShellExecution | ProcessExecution;
    problemMatchers: string[];
    group?: TaskGroup;
    isBackground = false;
    presentationOptions: Record<string, unknown> = {};
    constructor(definition: Record<string, unknown>, scope: unknown, name: string, source: string, execution?: ShellExecution | ProcessExecution, problemMatchers: string | string[] = []) {
        this.definition = definition;
        this.scope = scope;
        this.name = name;
        this.source = source;
        if (execution) {
            this.execution = execution;
        }
        this.problemMatchers = Array.isArray(problemMatchers) ? problemMatchers : [problemMatchers];
    }
}

export class Breakpoint {
    readonly id = `${Math.random()}`;
    readonly enabled: boolean;
    readonly condition?: string;
    constructor(enabled = true, condition?: string) {
        this.enabled = enabled;
        if (condition !== undefined) {
            this.condition = condition;
        }
    }
}
export class SourceBreakpoint extends Breakpoint {
    readonly location: Location;
    constructor(location: Location, enabled?: boolean, condition?: string) {
        super(enabled, condition);
        this.location = location;
    }
}

/* ------------------------------ Notebooks (shapes only) ------------------------------ */

export const NotebookCellKind = numericEnum({ Markup: 1, Code: 2 } as const);
export type NotebookCellKind = (typeof NotebookCellKind)[EnumKeys<typeof NotebookCellKind>];

/* ------------------------------ Language status, misc ------------------------------ */

export const LanguageStatusSeverity = numericEnum({ Information: 0, Warning: 1, Error: 2 } as const);
export type LanguageStatusSeverity = (typeof LanguageStatusSeverity)[EnumKeys<typeof LanguageStatusSeverity>];
export const CommentThreadCollapsibleState = numericEnum({ Collapsed: 0, Expanded: 1 } as const);
export type CommentThreadCollapsibleState = (typeof CommentThreadCollapsibleState)[EnumKeys<typeof CommentThreadCollapsibleState>];
export const IndentAction = numericEnum({ None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 } as const);
export type IndentAction = (typeof IndentAction)[EnumKeys<typeof IndentAction>];

export class Comment {}
