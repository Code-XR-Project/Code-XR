import type * as Lsp from 'vscode-languageserver-types';

/**
 * LSP to Monaco shapes (#21), as plain objects: LSP positions are 0-based,
 * Monaco's 1-based; both count UTF-16 code units. No Monaco import, so the
 * conversions are unit-tested in Node; enums are passed by name or as the
 * numbers Monaco's API documents.
 */

export interface MonacoRange {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
}

export function toMonacoRange(range: Lsp.Range): MonacoRange {
    return {
        startLineNumber: range.start.line + 1,
        startColumn: range.start.character + 1,
        endLineNumber: range.end.line + 1,
        endColumn: range.end.character + 1,
    };
}

export function toLspPosition(position: { lineNumber: number; column: number }): Lsp.Position {
    return { line: position.lineNumber - 1, character: position.column - 1 };
}

/** LSP DiagnosticSeverity to monaco.MarkerSeverity (Hint 1, Info 2, Warning 4, Error 8); absent means error. */
export function markerSeverity(severity: number | undefined): 1 | 2 | 4 | 8 {
    switch (severity) {
        case 2: return 4;
        case 3: return 2;
        case 4: return 1;
        default: return 8;
    }
}

/** LSP CompletionItemKind (1-25) to the name of the matching monaco.languages.CompletionItemKind member. */
const COMPLETION_KIND_NAMES = [
    'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property',
    'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember',
    'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter',
] as const;
export type CompletionKindName = (typeof COMPLETION_KIND_NAMES)[number];

export function completionKindName(kind: number | undefined): CompletionKindName {
    return (kind !== undefined ? COMPLETION_KIND_NAMES[kind - 1] : undefined) ?? 'Text';
}

/** LSP SymbolKind (1-26) to monaco.languages.SymbolKind (the same list, from 0). */
export function symbolKind(kind: number): number {
    return Number.isInteger(kind) && kind >= 1 && kind <= 26 ? kind - 1 : 12; // Variable
}

/** Plain text shown as Markdown without being interpreted. */
export function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

/** Hover contents, documentation: every LSP form as Markdown strings. */
export function markdownOf(content: Lsp.MarkupContent | Lsp.MarkedString | readonly Lsp.MarkedString[] | undefined | null): string[] {
    if (content === undefined || content === null) {
        return [];
    }
    if (Array.isArray(content)) {
        return (content as readonly Lsp.MarkedString[]).flatMap((item) => markdownOf(item));
    }
    if (typeof content === 'string') {
        return content === '' ? [] : [content];
    }
    if ('kind' in content) {
        if (content.value === '') {
            return [];
        }
        return [content.kind === 'markdown' ? content.value : escapeMarkdown(content.value)];
    }
    const marked = content as { language: string; value: string };
    return marked.value === '' ? [] : [`\`\`\`${marked.language}\n${marked.value}\n\`\`\``];
}

export interface MonacoLocation {
    uri: string;
    range: MonacoRange;
    targetSelectionRange?: MonacoRange;
    originSelectionRange?: MonacoRange;
}

/** A definition answer (Location, Location[] or LocationLink[]) as locations; URIs stay strings. */
export function toLocations(result: Lsp.Location | readonly Lsp.Location[] | readonly Lsp.LocationLink[] | null | undefined): MonacoLocation[] {
    if (!result) {
        return [];
    }
    const items: readonly (Lsp.Location | Lsp.LocationLink)[] = Array.isArray(result) ? result : [result as Lsp.Location];
    return items.map((item) => {
        if ('targetUri' in item) {
            return {
                uri: item.targetUri,
                range: toMonacoRange(item.targetRange),
                targetSelectionRange: toMonacoRange(item.targetSelectionRange),
                ...(item.originSelectionRange ? { originSelectionRange: toMonacoRange(item.originSelectionRange) } : {}),
            };
        }
        return { uri: item.uri, range: toMonacoRange(item.range) };
    });
}

export interface MonacoSymbol {
    name: string;
    detail: string;
    kind: number;
    tags: number[];
    range: MonacoRange;
    selectionRange: MonacoRange;
    children: MonacoSymbol[];
}

/** Document symbols, hierarchical or flat (flat ones of other documents are left out). */
export function toSymbols(result: readonly (Lsp.DocumentSymbol | Lsp.SymbolInformation)[] | null | undefined, documentUri: string): MonacoSymbol[] {
    if (!Array.isArray(result)) {
        return [];
    }
    return result.flatMap((symbol): MonacoSymbol[] => {
        if ('location' in symbol) {
            if (symbol.location.uri !== documentUri) {
                return [];
            }
            const range = toMonacoRange(symbol.location.range);
            return [{ name: symbol.name, detail: symbol.containerName ?? '', kind: symbolKind(symbol.kind), tags: [...(symbol.tags ?? [])], range, selectionRange: range, children: [] }];
        }
        return [{
            name: symbol.name,
            detail: symbol.detail ?? '',
            kind: symbolKind(symbol.kind),
            tags: [...(symbol.tags ?? [])],
            range: toMonacoRange(symbol.range),
            selectionRange: toMonacoRange(symbol.selectionRange),
            children: toSymbols(symbol.children ?? [], documentUri),
        }];
    });
}

/** Where go to definition should land: a 1-based line and column, and the characters to select on that line. */
export function openTarget(selectionOrPosition: MonacoRange | { lineNumber: number; column: number } | undefined): { line: number; column: number; length: number } {
    if (!selectionOrPosition) {
        return { line: 1, column: 1, length: 0 };
    }
    if ('startLineNumber' in selectionOrPosition) {
        const r = selectionOrPosition;
        return { line: r.startLineNumber, column: r.startColumn, length: r.endLineNumber === r.startLineNumber ? Math.max(0, r.endColumn - r.startColumn) : 0 };
    }
    return { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column, length: 0 };
}

/** The workspace path of a `codexr-file:` URI's path (`/src/a.ts` -> `src/a.ts`). */
export function workspacePathOf(uriPath: string): string {
    return uriPath.replace(/^\/+/, '');
}

/** #287: Monaco's 1-based range as an LSP range. */
export function toLspRange(range: MonacoRange): Lsp.Range {
    return {
        start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
        end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
    };
}

/** LSP DocumentHighlightKind (Text 1, Read 2, Write 3) to monaco.languages.DocumentHighlightKind (Text 0, Read 1, Write 2). */
export function toHighlights(result: readonly Lsp.DocumentHighlight[] | null | undefined): { range: MonacoRange; kind: 0 | 1 | 2 }[] {
    if (!Array.isArray(result)) {
        return [];
    }
    return result.map((highlight) => ({
        range: toMonacoRange(highlight.range),
        kind: highlight.kind === 2 ? 1 : highlight.kind === 3 ? 2 : 0,
    }));
}

export interface MonacoSignatureHelp {
    signatures: {
        label: string;
        documentation?: { value: string };
        parameters: { label: string | [number, number]; documentation?: { value: string } }[];
        activeParameter?: number;
    }[];
    activeSignature: number;
    activeParameter: number;
}

function documentationOf(content: string | Lsp.MarkupContent | undefined): { value: string } | undefined {
    const value = markdownOf(content).join('\n\n');
    return value ? { value } : undefined;
}

/** #287: signature help as Monaco shows it; null when the server has none. */
export function toSignatureHelp(result: Lsp.SignatureHelp | null | undefined): MonacoSignatureHelp | null {
    if (!result || !Array.isArray(result.signatures) || result.signatures.length === 0) {
        return null;
    }
    const signatures = result.signatures.map((signature) => {
        const documentation = documentationOf(signature.documentation);
        const activeParameter = signature.activeParameter;
        return {
            label: signature.label,
            ...(documentation ? { documentation } : {}),
            parameters: (signature.parameters ?? []).map((parameter) => {
                const parameterDocumentation = documentationOf(parameter.documentation);
                const label: string | [number, number] = typeof parameter.label === 'string' ? parameter.label : [parameter.label[0], parameter.label[1]];
                return { label, ...(parameterDocumentation ? { documentation: parameterDocumentation } : {}) };
            }),
            ...(typeof activeParameter === 'number' ? { activeParameter } : {}),
        };
    });
    const activeSignature = Math.min(Math.max(0, result.activeSignature ?? 0), signatures.length - 1);
    return { signatures, activeSignature, activeParameter: typeof result.activeParameter === 'number' ? result.activeParameter : 0 };
}

/** #287: the three answers of `textDocument/prepareRename` (besides null). */
export type PrepareRenameAnswer = Lsp.Range | { range: Lsp.Range; placeholder: string } | { defaultBehavior: boolean };

/**
 * #287: what `textDocument/prepareRename` answered: the range to rename and
 * the name to start from, `default` to use the word at the cursor, or null
 * when the server says the symbol cannot be renamed.
 */
export function toRenameRange(result: PrepareRenameAnswer | null | undefined): { range: MonacoRange; placeholder?: string } | 'default' | null {
    if (!result) {
        return null;
    }
    if ('defaultBehavior' in result) {
        return result.defaultBehavior ? 'default' : null;
    }
    if ('placeholder' in result) {
        return { range: toMonacoRange(result.range), placeholder: result.placeholder };
    }
    return { range: toMonacoRange(result) };
}

/** A marker shown in the editor, as Monaco hands it to code action providers. */
export interface MarkerLike extends MonacoRange {
    readonly severity: number;
    readonly message: string;
    readonly source?: string | undefined;
    readonly code?: string | { readonly value: string } | undefined;
    readonly owner?: string | undefined;
}

/**
 * #287: a marker as the LSP diagnostic it came from, for a code action
 * request (servers key their fixes on its code: TypeScript's are numbers).
 */
export function toLspDiagnostic(marker: MarkerLike): Lsp.Diagnostic {
    const code = typeof marker.code === 'string' ? marker.code : marker.code?.value;
    const severity: Lsp.DiagnosticSeverity = marker.severity >= 8 ? 1 : marker.severity >= 4 ? 2 : marker.severity >= 2 ? 3 : 4;
    return {
        range: toLspRange(marker),
        message: marker.message,
        severity,
        ...(marker.source ? { source: marker.source } : {}),
        ...(code !== undefined && code !== '' ? { code: /^-?\d+$/.test(code) ? Number(code) : code } : {}),
    };
}

/** #287: a code action the main process let through (the shape of `ClientCodeAction` in main/lsp/lspResults.ts). */
export interface CodeActionItem {
    readonly title: string;
    readonly kind?: string;
    readonly isPreferred?: boolean;
    readonly disabled?: string;
    readonly edit?: unknown;
}

export function toCodeActions(result: unknown): CodeActionItem[] {
    if (!Array.isArray(result)) {
        return [];
    }
    return result.flatMap((item): CodeActionItem[] => {
        if (typeof item !== 'object' || item === null || typeof (item as { title?: unknown }).title !== 'string') {
            return [];
        }
        const action = item as Record<string, unknown>;
        return [{
            title: action['title'] as string,
            ...(typeof action['kind'] === 'string' ? { kind: action['kind'] } : {}),
            ...(action['isPreferred'] === true ? { isPreferred: true } : {}),
            ...(typeof action['disabled'] === 'string' ? { disabled: action['disabled'] } : {}),
            ...(action['edit'] !== undefined ? { edit: action['edit'] } : {}),
        }];
    });
}

/** #287: one symbol of the workspace, for quick open's "#". */
export interface WorkspaceSymbolItem {
    readonly name: string;
    /** monaco.languages.SymbolKind. */
    readonly kind: number;
    readonly container: string;
    /** Workspace path. */
    readonly path: string;
    /** 1-based. */
    readonly line: number;
    readonly column: number;
}

/**
 * #287: what `workspace/symbol` answered (already mapped and filtered by
 * the main process) as quick open items; an item whose URI `pathOf` refuses
 * is left out.
 */
export function toWorkspaceSymbolItems(result: unknown, pathOf: (uri: string) => string): WorkspaceSymbolItem[] {
    if (!Array.isArray(result)) {
        return [];
    }
    return result.flatMap((item): WorkspaceSymbolItem[] => {
        const symbol = item as Partial<Lsp.SymbolInformation> | null;
        const location = symbol?.location;
        if (!symbol || typeof symbol.name !== 'string' || !location || typeof location.uri !== 'string' || !location.range) {
            return [];
        }
        let path: string;
        try {
            path = pathOf(location.uri);
        } catch {
            return [];
        }
        return [{
            name: symbol.name,
            kind: symbolKind(symbol.kind ?? 13),
            container: typeof symbol.containerName === 'string' ? symbol.containerName : '',
            path,
            line: location.range.start.line + 1,
            column: location.range.start.character + 1,
        }];
    });
}
