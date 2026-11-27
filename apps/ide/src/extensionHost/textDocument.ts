import type { Uri } from './types.ts';
import { EndOfLine, Position, Range } from './types.ts';

/**
 * `vscode.TextDocument` (#259, #260): the text of a file as extensions read
 * it, with VS Code's line, offset and word helpers. The host keeps one per
 * open document and applies the editor's changes to it (#260); documents an
 * extension opens itself are read from disk.
 */

const DEFAULT_WORD = /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g;

export interface TextLine {
    readonly lineNumber: number;
    readonly text: string;
    readonly range: Range;
    readonly rangeIncludingLineBreak: Range;
    readonly firstNonWhitespaceCharacterIndex: number;
    readonly isEmptyOrWhitespace: boolean;
}

export class TextDocumentModel {
    readonly uri: Uri;
    languageId: string;
    version: number;
    isDirty = false;
    isClosed = false;
    private text = '';
    private lineStarts: number[] = [0];
    private eolValue: EndOfLine = EndOfLine.LF;
    private readonly saveImpl: (document: TextDocumentModel) => Promise<boolean>;

    constructor(uri: Uri, languageId: string, version: number, text: string, save: (document: TextDocumentModel) => Promise<boolean> = () => Promise.resolve(false)) {
        this.uri = uri;
        this.languageId = languageId;
        this.version = version;
        this.saveImpl = save;
        this.setText(text);
    }

    get fileName(): string {
        return this.uri.fsPath;
    }
    get isUntitled(): boolean {
        return this.uri.scheme === 'untitled';
    }
    get eol(): EndOfLine {
        return this.eolValue;
    }
    get lineCount(): number {
        return this.lineStarts.length;
    }
    get encoding(): string {
        return 'utf8';
    }

    setText(text: string): void {
        this.text = text;
        this.lineStarts = [0];
        for (let index = 0; index < text.length; index++) {
            const char = text.charCodeAt(index);
            if (char === 13 /* \r */) {
                if (text.charCodeAt(index + 1) === 10) {
                    index++;
                }
                this.lineStarts.push(index + 1);
            } else if (char === 10 /* \n */) {
                this.lineStarts.push(index + 1);
            }
        }
        this.eolValue = text.includes('\r\n') ? EndOfLine.CRLF : EndOfLine.LF;
    }

    /** Replaces `range` with `text` (an edit of the editor, #260). */
    applyChange(range: Range, text: string): void {
        const start = this.offsetAt(range.start);
        const end = this.offsetAt(range.end);
        this.setText(this.text.slice(0, start) + text + this.text.slice(end));
    }

    save(): Promise<boolean> {
        return this.saveImpl(this);
    }

    private lineText(line: number): string {
        const start = this.lineStarts[line] ?? this.text.length;
        const next = this.lineStarts[line + 1];
        const raw = next === undefined ? this.text.slice(start) : this.text.slice(start, next);
        return raw.replace(/\r?\n$|\r$/, '');
    }

    lineAt(lineOrPosition: number | Position): TextLine {
        const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
        if (line < 0 || line >= this.lineCount || !Number.isInteger(line)) {
            throw new Error('Illegal value for `line`');
        }
        const text = this.lineText(line);
        const firstNonWhitespace = text.search(/\S/);
        const nextStart = line + 1 < this.lineCount ? new Position(line + 1, 0) : new Position(line, text.length);
        return {
            lineNumber: line,
            text,
            range: new Range(line, 0, line, text.length),
            rangeIncludingLineBreak: new Range(new Position(line, 0), nextStart),
            firstNonWhitespaceCharacterIndex: firstNonWhitespace === -1 ? text.length : firstNonWhitespace,
            isEmptyOrWhitespace: firstNonWhitespace === -1,
        };
    }

    offsetAt(position: Position): number {
        const valid = this.validatePosition(position);
        return (this.lineStarts[valid.line] ?? 0) + valid.character;
    }

    positionAt(offset: number): Position {
        const clamped = Math.max(0, Math.min(Math.floor(offset), this.text.length));
        let low = 0;
        let high = this.lineStarts.length - 1;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if ((this.lineStarts[middle] ?? 0) <= clamped) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        const character = Math.min(clamped - (this.lineStarts[low] ?? 0), this.lineText(low).length);
        return new Position(low, character);
    }

    getText(range?: Range): string {
        if (!range) {
            return this.text;
        }
        const valid = this.validateRange(range);
        return this.text.slice(this.offsetAt(valid.start), this.offsetAt(valid.end));
    }

    validatePosition(position: Position): Position {
        if (this.lineCount === 0) {
            return new Position(0, 0);
        }
        if (position.line < 0) {
            return new Position(0, 0);
        }
        if (position.line >= this.lineCount) {
            const last = this.lineCount - 1;
            return new Position(last, this.lineText(last).length);
        }
        const length = this.lineText(position.line).length;
        return position.character > length ? new Position(position.line, length) : position.character < 0 ? new Position(position.line, 0) : position;
    }

    validateRange(range: Range): Range {
        const start = this.validatePosition(range.start);
        const end = this.validatePosition(range.end);
        return start === range.start && end === range.end ? range : new Range(start, end);
    }

    getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined {
        const valid = this.validatePosition(position);
        const text = this.lineText(valid.line);
        const pattern = new RegExp((regex ?? DEFAULT_WORD).source, (regex?.flags ?? 'g').includes('g') ? regex?.flags ?? 'g' : `${regex?.flags ?? ''}g`);
        for (const match of text.matchAll(pattern)) {
            const start = match.index;
            const end = start + match[0].length;
            if (match[0].length > 0 && start <= valid.character && valid.character <= end) {
                return new Range(valid.line, start, valid.line, end);
            }
        }
        return undefined;
    }
}

/** Language ids by file extension, for documents the editor has not opened (the extensions' own languages are added on top). */
export const BUILTIN_LANGUAGES: Readonly<Record<string, string>> = {
    '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact',
    '.json': 'json', '.jsonc': 'jsonc', '.md': 'markdown', '.py': 'python', '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less', '.xml': 'xml',
    '.yml': 'yaml', '.yaml': 'yaml', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
    '.php': 'php', '.sh': 'shellscript', '.bash': 'shellscript', '.ps1': 'powershell', '.sql': 'sql', '.swift': 'swift', '.kt': 'kotlin', '.lua': 'lua', '.r': 'r', '.dart': 'dart',
    '.vue': 'vue', '.txt': 'plaintext', '.ini': 'ini', '.toml': 'toml', '.dockerfile': 'dockerfile',
};
