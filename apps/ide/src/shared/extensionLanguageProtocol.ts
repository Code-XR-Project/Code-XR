/**
 * The editor's documents and the language features of extensions (#260):
 * what the renderer tells the extension host about the open files and the
 * active editor, and what crosses back from the providers extensions
 * register (hover, completion, definitions, diagnostics, edits...).
 *
 * Positions and ranges are 0-based (VS Code's), never Monaco's 1-based ones:
 * the renderer converts at its edge. A `path` field names a file: a
 * workspace path (`src/a.ts`) between the renderer and the main process, an
 * absolute path between the main process and the host. The main process
 * rewrites every `path` field on the way through (`rewritePaths`) and drops
 * whatever names a file outside the open folder, so the renderer never sees
 * an absolute path and the host never gets one it did not ask about.
 *
 * Shared by main, the host and the renderer: no Node, Electron or DOM import.
 */

import type { ExtensionId } from './extensions.ts';

/** `[line, character]`, 0-based. */
export type PositionData = readonly [number, number];
/** `[startLine, startCharacter, endLine, endCharacter]`, 0-based. */
export type RangeData = readonly [number, number, number, number];

export interface TextChangeData {
    readonly range: RangeData;
    readonly text: string;
}

export interface SelectionData {
    readonly anchor: PositionData;
    readonly active: PositionData;
}

export interface EditorStateData {
    readonly path: string;
    readonly selections: readonly SelectionData[];
    readonly visibleRanges: readonly RangeData[];
    readonly tabSize: number;
    readonly insertSpaces: boolean;
}

/** What happened to a document of the editor, or to the active editor. */
export type DocumentEvent =
    | { readonly kind: 'open'; readonly path: string; readonly languageId: string; readonly version: number; readonly text: string }
    /** The changes apply one after the other, each to the text the previous one left. */
    | { readonly kind: 'change'; readonly path: string; readonly version: number; readonly changes: readonly TextChangeData[] }
    | { readonly kind: 'language'; readonly path: string; readonly languageId: string }
    | { readonly kind: 'save'; readonly path: string }
    | { readonly kind: 'close'; readonly path: string }
    /** The active text editor (null: none, or not a file of the folder). */
    | { readonly kind: 'editor'; readonly editor: EditorStateData | null };

/** The most documents (and the largest text) the editor tells the host about, as VS Code's own limit does. */
export const MAX_SYNCED_DOCUMENT_LENGTH = 50 * 1024 * 1024;
export const MAX_DOCUMENT_EVENTS = 5000;

/* ------------------------------ diagnostics ------------------------------ */

/** VS Code's `DiagnosticSeverity`: Error 0, Warning 1, Information 2, Hint 3. */
export interface DiagnosticData {
    readonly range: RangeData;
    readonly message: string;
    readonly severity: number;
    readonly source?: string;
    readonly code?: string;
    /** 1 unnecessary, 2 deprecated. */
    readonly tags?: readonly number[];
    readonly relatedInformation?: readonly { readonly path: string; readonly range: RangeData; readonly message: string }[];
}

export interface DiagnosticsUpdate {
    /** The collection's owner: `<extension id>:<collection name>`. */
    readonly owner: string;
    /** Files whose list changed; an empty list clears the file. */
    readonly entries: readonly { readonly path: string; readonly diagnostics: readonly DiagnosticData[] }[];
    /** The whole collection was cleared first (`clear()` or `dispose()`). */
    readonly clear?: boolean;
}

/* ------------------------------ providers ------------------------------ */

export const PROVIDER_KINDS = [
    'hover', 'completion', 'definition', 'declaration', 'typeDefinition', 'implementation', 'references',
    'documentSymbol', 'documentHighlight', 'signatureHelp', 'formatting', 'rangeFormatting', 'onTypeFormatting',
    'codeAction', 'codeLens', 'rename', 'foldingRange', 'inlayHints', 'documentLink',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function isProviderKind(value: unknown): value is ProviderKind {
    return typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value);
}

/** A `DocumentFilter`; `pattern` is a glob over the workspace path (`**` and `*`). */
export interface DocumentFilterData {
    readonly language?: string;
    readonly scheme?: string;
    readonly pattern?: string;
}

export interface ProviderRegistration {
    /** Unique per host. */
    readonly handle: number;
    readonly kind: ProviderKind;
    readonly extensionId: ExtensionId;
    readonly selector: readonly DocumentFilterData[];
    readonly triggerCharacters?: readonly string[];
    readonly retriggerCharacters?: readonly string[];
    /** The display name (document symbols, code actions). */
    readonly label?: string;
    /** Code actions: the kinds the provider offers. */
    readonly providedCodeActionKinds?: readonly string[];
    /** The provider resolves items lazily (completion items, code lenses). */
    readonly resolves?: boolean;
}

/** The renderer asks a provider. `args` depend on the kind (see `ProvideArgs`). */
export interface ProvideRequest {
    readonly handle: number;
    readonly kind: ProviderKind | 'resolveCompletion' | 'resolveCodeLens' | 'prepareRename';
    readonly path: string;
    readonly args: ProvideArgs;
}

export interface FormattingOptionsData {
    readonly tabSize: number;
    readonly insertSpaces: boolean;
}

export interface ProvideArgs {
    readonly position?: PositionData;
    readonly range?: RangeData;
    readonly triggerKind?: number;
    readonly triggerCharacter?: string;
    readonly options?: FormattingOptionsData;
    readonly newName?: string;
    readonly includeDeclaration?: boolean;
    readonly only?: string;
    readonly diagnostics?: readonly DiagnosticData[];
    /** A completion item or a code lens to resolve: from a previous result. */
    readonly cacheId?: number;
    readonly index?: number;
    readonly isRetrigger?: boolean;
}

export interface CommandData {
    readonly id: string;
    readonly title: string;
    readonly tooltip?: string;
    /** In the host's wire format. */
    readonly args?: readonly unknown[];
}

export interface LocationData {
    readonly path: string;
    readonly range: RangeData;
    /** A `LocationLink`'s origin. */
    readonly originRange?: RangeData;
    readonly targetSelectionRange?: RangeData;
}

export interface WorkspaceEditData {
    readonly edits: readonly { readonly path: string; readonly edits: readonly TextChangeData[] }[];
}

export interface HoverData {
    readonly contents: readonly string[];
    readonly range?: RangeData;
}

export interface CompletionItemData {
    readonly label: string | { readonly label: string; readonly detail?: string; readonly description?: string };
    /** VS Code's `CompletionItemKind`. */
    readonly kind?: number;
    readonly tags?: readonly number[];
    readonly detail?: string;
    readonly documentation?: string;
    readonly sortText?: string;
    readonly filterText?: string;
    readonly preselect?: boolean;
    readonly insertText?: string;
    readonly isSnippet?: boolean;
    readonly range?: RangeData | { readonly inserting: RangeData; readonly replacing: RangeData };
    readonly commitCharacters?: readonly string[];
    readonly additionalTextEdits?: readonly TextChangeData[];
    readonly command?: CommandData;
}

export interface CompletionListData {
    readonly items: readonly CompletionItemData[];
    readonly incomplete: boolean;
    /** Resolve an item with this id and its index. */
    readonly cacheId?: number;
}

export interface DocumentSymbolData {
    readonly name: string;
    readonly detail: string;
    /** VS Code's `SymbolKind` (Monaco's has the same numbers). */
    readonly kind: number;
    readonly range: RangeData;
    readonly selectionRange: RangeData;
    readonly children: readonly DocumentSymbolData[];
    readonly containerName?: string;
    readonly tags?: readonly number[];
}

export interface SignatureHelpData {
    readonly signatures: readonly {
        readonly label: string;
        readonly documentation?: string;
        readonly parameters: readonly { readonly label: string | readonly [number, number]; readonly documentation?: string }[];
        readonly activeParameter?: number;
    }[];
    readonly activeSignature: number;
    readonly activeParameter: number;
}

export interface CodeActionData {
    readonly title: string;
    readonly kind?: string;
    readonly isPreferred?: boolean;
    readonly diagnostics?: readonly DiagnosticData[];
    readonly edit?: WorkspaceEditData;
    readonly command?: CommandData;
    readonly disabled?: string;
}

export interface CodeLensData {
    readonly range: RangeData;
    readonly command?: CommandData;
}

export interface CodeLensListData {
    readonly lenses: readonly CodeLensData[];
    readonly cacheId?: number;
}

export interface FoldingRangeData {
    readonly start: number;
    readonly end: number;
    /** VS Code's `FoldingRangeKind`: 1 comment, 2 imports, 3 region. */
    readonly kind?: number;
}

export interface InlayHintData {
    readonly position: PositionData;
    readonly label: string;
    readonly kind?: number;
    readonly tooltip?: string;
    readonly paddingLeft?: boolean;
    readonly paddingRight?: boolean;
}

export interface DocumentLinkData {
    readonly range: RangeData;
    /** http, https or mailto only. */
    readonly url?: string;
    readonly tooltip?: string;
}

export interface RenameLocationData {
    readonly range: RangeData;
    readonly text: string;
}

/* ------------------------------ helpers ------------------------------ */

/** `*` and `**` globs over a workspace path, as `DocumentFilter.pattern`; `{a,b}` alternatives too. */
export function documentGlob(pattern: string): RegExp {
    let source = '';
    for (let index = 0; index < pattern.length; index++) {
        const char = pattern[index] as string;
        if (char === '*') {
            if (pattern[index + 1] === '*') {
                index++;
                if (pattern[index + 1] === '/') {
                    index++;
                    source += '(?:.*/)?';
                } else {
                    source += '.*';
                }
            } else {
                source += '[^/]*';
            }
        } else if (char === '?') {
            source += '[^/]';
        } else if (char === '{') {
            const close = pattern.indexOf('}', index);
            if (close === -1) {
                source += '\\{';
            } else {
                source += `(?:${pattern.slice(index + 1, close).split(',').map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
                index = close;
            }
        } else {
            source += char.replace(/[.+^$()|[\]\\}]/g, '\\$&');
        }
    }
    return new RegExp(`^${source}$`);
}

/**
 * Whether a document matches a provider's selector, VS Code's way: a filter
 * matches when every field it has matches. The renderer only follows files
 * of the folder, whose scheme is `file`.
 */
export function selectorMatches(selector: readonly DocumentFilterData[], document: { readonly languageId: string; readonly path: string }): boolean {
    return selector.some((filter) => {
        if (filter.language !== undefined && filter.language !== '*' && filter.language !== document.languageId) {
            return false;
        }
        if (filter.scheme !== undefined && filter.scheme !== '*' && filter.scheme !== 'file') {
            return false;
        }
        if (filter.pattern !== undefined) {
            const regex = documentGlob(filter.pattern);
            if (!regex.test(document.path) && !documentGlob(`**/${filter.pattern}`).test(document.path)) {
                return false;
            }
        }
        return filter.language !== undefined || filter.scheme !== undefined || filter.pattern !== undefined;
    });
}

/** Keys whose values are an extension's own data, never rewritten (command arguments). */
const OPAQUE_KEYS = new Set(['args', 'command']);

/**
 * Rewrites every `path` field of `value` with `convert` (see the file's
 * comment). An object whose path `convert` refuses (null) is dropped: from
 * an array it is removed, elsewhere it becomes null. Command arguments are
 * left alone.
 */
export function rewritePaths(value: unknown, convert: (path: string) => string | null): unknown {
    if (Array.isArray(value)) {
        const result: unknown[] = [];
        for (const item of value) {
            const rewritten = rewriteObject(item, convert);
            if (rewritten !== DROPPED) {
                result.push(rewritten);
            }
        }
        return result;
    }
    const rewritten = rewriteObject(value, convert);
    return rewritten === DROPPED ? null : rewritten;
}

const DROPPED = Symbol('dropped');

function rewriteObject(value: unknown, convert: (path: string) => string | null): unknown {
    if (Array.isArray(value)) {
        return rewritePaths(value, convert);
    }
    if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) {
        return value;
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'path' && typeof item === 'string') {
            const converted = convert(item);
            if (converted === null) {
                return DROPPED;
            }
            result[key] = converted;
        } else if (OPAQUE_KEYS.has(key)) {
            result[key] = item;
        } else {
            const rewritten = rewriteObject(item, convert);
            result[key] = rewritten === DROPPED ? null : rewritten;
        }
    }
    return result;
}

/**
 * The completion kind's name in VS Code's enum, which Monaco also has (in a
 * different order): the renderer maps through the name.
 */
export const COMPLETION_KIND_NAMES = [
    'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum',
    'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter', 'User', 'Issue',
] as const;
