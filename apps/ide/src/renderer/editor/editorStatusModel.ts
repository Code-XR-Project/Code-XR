/**
 * What the status bar says about the active editor (#166), as data: the
 * cursor, the indentation, the encoding, the line endings and the language,
 * and the choices each picker offers. Pure module, unit-tested in Node;
 * editorStatus.ts draws it and editorGroup.ts applies a choice.
 */

export type EndOfLine = 'LF' | 'CRLF';

export interface EditorStatusState {
    readonly line: number;
    readonly column: number;
    /** Characters selected across every selection. */
    readonly selectedChars: number;
    /** Number of cursors / selections. */
    readonly selections: number;
    readonly insertSpaces: boolean;
    readonly tabSize: number;
    readonly eol: EndOfLine;
    /** The file started with a UTF-8 byte order mark (kept on save). */
    readonly bom: boolean;
    readonly languageId: string;
    readonly languageName: string;
}

export interface EditorStatusTexts {
    readonly position: string;
    readonly indentation: string;
    readonly encoding: string;
    readonly eol: string;
    readonly language: string;
}

export function editorStatusTexts(state: EditorStatusState): EditorStatusTexts {
    let position = `Ln ${state.line}, Col ${state.column}`;
    if (state.selections > 1) {
        position += ` (${state.selections} selections)`;
    } else if (state.selectedChars > 0) {
        position += ` (${state.selectedChars} selected)`;
    }
    return {
        position,
        indentation: `${state.insertSpaces ? 'Spaces' : 'Tab Size'}: ${state.tabSize}`,
        encoding: state.bom ? 'UTF-8 with BOM' : 'UTF-8',
        eol: state.eol,
        language: state.languageName,
    };
}

export interface Choice<T> {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly value: T;
}

export function eolChoices(current: EndOfLine): Choice<EndOfLine>[] {
    return (['LF', 'CRLF'] as const).map((eol) => ({
        id: eol,
        label: eol,
        description: (eol === 'LF' ? 'Linux and macOS' : 'Windows') + (eol === current ? ' (current)' : ''),
        value: eol,
    }));
}

export interface Indentation {
    readonly insertSpaces: boolean;
    readonly tabSize: number;
}

const TAB_SIZES = [2, 4, 8] as const;

export function indentationChoices(current: Indentation): Choice<Indentation>[] {
    return [true, false].flatMap((insertSpaces) => TAB_SIZES.map((tabSize) => {
        const isCurrent = current.insertSpaces === insertSpaces && current.tabSize === tabSize;
        return {
            id: `${insertSpaces ? 'spaces' : 'tabs'}-${tabSize}`,
            label: insertSpaces ? `Indent Using Spaces: ${tabSize}` : `Indent Using Tabs: ${tabSize}`,
            ...(isCurrent ? { description: '(current)' } : {}),
            value: { insertSpaces, tabSize },
        };
    }));
}

export interface LanguageInfo {
    readonly id: string;
    readonly aliases?: readonly string[];
    readonly extensions?: readonly string[];
}

/** The language's display name: its first alias, as VS Code shows it ("TypeScript", not "typescript"). */
export function languageName(language: LanguageInfo | undefined, id: string): string {
    return language?.aliases?.[0] ?? id;
}

/** Every language, sorted by name, the current one marked, its extensions as the description. */
export function languageChoices(languages: readonly LanguageInfo[], currentId: string): Choice<string>[] {
    return languages
        .map((language) => {
            const extensions = (language.extensions ?? []).slice(0, 4).join(', ');
            const current = language.id === currentId ? '(current)' : '';
            const description = [extensions, current].filter(Boolean).join(' ');
            return {
                id: language.id,
                label: languageName(language, language.id),
                ...(description ? { description } : {}),
                value: language.id,
            };
        })
        .sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
}
