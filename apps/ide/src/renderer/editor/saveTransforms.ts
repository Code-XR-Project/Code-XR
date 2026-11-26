import type { EditorConfigProperties } from './editorConfig.ts';

/**
 * What happens to a file as it is saved (#170): the settings, overridden per
 * file by `.editorconfig`, turned into text edits. Pure, unit-tested in Node;
 * the editor group applies the edits to the Monaco model, so they are one
 * undoable step and the saved text is what the editor shows.
 */

export type AutoSave = 'off' | 'afterDelay' | 'onFocusChange';

/** Why a file is being saved. An auto save after a delay happens while the person types. */
export type SaveReason = 'explicit' | 'afterDelay' | 'focusChange';

export interface SaveRules {
    readonly trimTrailingWhitespace: boolean;
    readonly insertFinalNewline: boolean;
    readonly formatOnSave: boolean;
    /** Line endings to write, when `.editorconfig` asks for them. */
    readonly endOfLine?: 'lf' | 'crlf';
    /** Whether to write a byte order mark, when `.editorconfig` asks. */
    readonly bom?: boolean;
}

export interface FileSettings {
    readonly trimTrailingWhitespace: boolean;
    readonly insertFinalNewline: boolean;
    readonly formatOnSave: boolean;
}

/** The rules for one file: `.editorconfig` wins over the settings, as in VS Code. */
export function saveRules(settings: FileSettings, config: EditorConfigProperties): SaveRules {
    return {
        trimTrailingWhitespace: config.trimTrailingWhitespace ?? settings.trimTrailingWhitespace,
        insertFinalNewline: config.insertFinalNewline ?? settings.insertFinalNewline,
        formatOnSave: settings.formatOnSave,
        ...(config.endOfLine ? { endOfLine: config.endOfLine } : {}),
        ...(config.bom === undefined ? {} : { bom: config.bom }),
    };
}

/** Indentation for a file from `.editorconfig`, or null to leave Monaco's (settings or detection). */
export function indentationOf(config: EditorConfigProperties): { tabSize?: number; indentSize?: number; insertSpaces?: boolean } | null {
    const result: { tabSize?: number; indentSize?: number; insertSpaces?: boolean } = {};
    if (config.insertSpaces !== undefined) { result.insertSpaces = config.insertSpaces; }
    if (config.tabWidth !== undefined) { result.tabSize = config.tabWidth; }
    if (config.indentSize !== undefined) { result.indentSize = config.indentSize; }
    return Object.keys(result).length === 0 ? null : result;
}

/** A replacement within one line (1-based, end exclusive), as Monaco ranges count. */
export interface LineEdit {
    readonly line: number;
    readonly startColumn: number;
    readonly endColumn: number;
    readonly text: string;
}

/**
 * The edits a save makes, before formatting is taken into account. During an
 * auto save after a delay the lines holding a cursor keep their trailing
 * whitespace and no final newline is added under a cursor on the last line,
 * so the text does not move while the person types.
 */
export function whitespaceEdits(lines: readonly string[], rules: Pick<SaveRules, 'trimTrailingWhitespace' | 'insertFinalNewline'>, eol: string, cursorLines: ReadonlySet<number> = new Set()): LineEdit[] {
    const edits: LineEdit[] = [];
    if (rules.trimTrailingWhitespace) {
        lines.forEach((text, index) => {
            const line = index + 1;
            const match = /[ \t]+$/.exec(text);
            if (match && !cursorLines.has(line)) {
                edits.push({ line, startColumn: match.index + 1, endColumn: text.length + 1, text: '' });
            }
        });
    }
    const lastLine = lines.length;
    const last = lines[lastLine - 1] ?? '';
    if (rules.insertFinalNewline && lastLine > 0 && last !== '' && !cursorLines.has(lastLine)) {
        // Inserted at the end of the line as it was: a trim on the same line ends there too, and the ranges do not overlap.
        const trimmedEnd = rules.trimTrailingWhitespace && !cursorLines.has(lastLine) ? last.replace(/[ \t]+$/, '').length : last.length;
        if (trimmedEnd > 0 || !rules.trimTrailingWhitespace) {
            edits.push({ line: lastLine, startColumn: last.length + 1, endColumn: last.length + 1, text: eol });
        }
    }
    return edits;
}

/** How long a formatter may run before the save goes ahead without it. */
export const FORMAT_TIMEOUT_MS = 1500;

/** The auto-save delay limits, in milliseconds. */
export const AUTO_SAVE_DELAY = { min: 100, max: 60000, default: 1000 } as const;
