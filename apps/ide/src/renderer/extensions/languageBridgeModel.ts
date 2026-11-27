import { COMPLETION_KIND_NAMES, type DocumentFilterData, type PositionData, type RangeData, type TextChangeData } from '../../shared/extensionLanguageProtocol.ts';

/**
 * Pure parts of the language bridge (#260), unit-tested in Node: Monaco's
 * 1-based positions against VS Code's 0-based ones, kinds and severities
 * between the two enums, and which Monaco languages a selector needs.
 */

export interface MonacoRangeLike {
    readonly startLineNumber: number;
    readonly startColumn: number;
    readonly endLineNumber: number;
    readonly endColumn: number;
}

export function toMonacoRange(range: RangeData): MonacoRangeLike {
    return { startLineNumber: range[0] + 1, startColumn: range[1] + 1, endLineNumber: range[2] + 1, endColumn: range[3] + 1 };
}

export function fromMonacoRange(range: MonacoRangeLike): RangeData {
    return [range.startLineNumber - 1, range.startColumn - 1, range.endLineNumber - 1, range.endColumn - 1];
}

export function fromMonacoPosition(position: { readonly lineNumber: number; readonly column: number }): PositionData {
    return [position.lineNumber - 1, position.column - 1];
}

export function toMonacoPosition(position: PositionData): { lineNumber: number; column: number } {
    return { lineNumber: position[0] + 1, column: position[1] + 1 };
}

/** A Monaco content change event's changes, in VS Code's form (applied in order, as Monaco emits them). */
export function changesOf(changes: readonly { readonly range: MonacoRangeLike; readonly text: string }[]): TextChangeData[] {
    return changes.map((change) => ({ range: fromMonacoRange(change.range), text: change.text }));
}

/** VS Code's `CompletionItemKind` as the name Monaco's enum also has. */
export function completionKindName(kind: number | undefined): (typeof COMPLETION_KIND_NAMES)[number] {
    return (kind !== undefined ? COMPLETION_KIND_NAMES[kind] : undefined) ?? 'Text';
}

/** VS Code's `DiagnosticSeverity` (Error 0 ... Hint 3) as Monaco's `MarkerSeverity` (Error 8 ... Hint 1). */
export function markerSeverity(severity: number): 1 | 2 | 4 | 8 {
    switch (severity) {
        case 0: return 8;
        case 1: return 4;
        case 2: return 2;
        default: return 1;
    }
}

/** Monaco's `MarkerSeverity` back to VS Code's `DiagnosticSeverity`. */
export function diagnosticSeverity(severity: number): number {
    return severity >= 8 ? 0 : severity >= 4 ? 1 : severity >= 2 ? 2 : 3;
}

/** VS Code's `FoldingRangeKind` (1 comment, 2 imports, 3 region) as Monaco's kind value. */
export function foldingKind(kind: number | undefined): 'comment' | 'imports' | 'region' | undefined {
    return kind === 1 ? 'comment' : kind === 2 ? 'imports' : kind === 3 ? 'region' : undefined;
}

/**
 * The Monaco languages to register a provider for: the selector's named
 * languages, or null when a filter matches any language (pattern or scheme
 * only, or `*`). The provider still checks the full selector on each call.
 */
export function monacoLanguages(selector: readonly DocumentFilterData[]): string[] | null {
    const languages = new Set<string>();
    for (const filter of selector) {
        if (filter.language === undefined || filter.language === '*') {
            if (filter.scheme !== undefined && filter.scheme !== '*' && filter.scheme !== 'file') {
                continue; // matches none of the editor's files
            }
            return null;
        }
        languages.add(filter.language);
    }
    return [...languages];
}
