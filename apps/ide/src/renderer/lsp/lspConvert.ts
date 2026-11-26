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
