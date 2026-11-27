/**
 * `.editorconfig` support (#170), as https://editorconfig.org specifies it:
 * the files from the folder root down to the file's own directory are read
 * (stopping above at the closest one marked `root = true`), sections whose
 * glob matches the file apply in order, and a closer file wins. Only the
 * properties the editor can honour are kept: indentation, tab width, line
 * endings, charset (UTF-8 with or without a byte order mark), trailing
 * whitespace and the final newline. Pure, unit-tested in Node.
 */

export const EDITORCONFIG_NAME = '.editorconfig';

export interface EditorConfigSection {
    readonly glob: string;
    readonly properties: Readonly<Record<string, string>>;
}

export interface EditorConfigFile {
    readonly root: boolean;
    readonly sections: readonly EditorConfigSection[];
}

/** What a file gets from its `.editorconfig` files; absent means "not set" (the settings apply). */
export interface EditorConfigProperties {
    readonly insertSpaces?: boolean;
    readonly indentSize?: number;
    readonly tabWidth?: number;
    readonly endOfLine?: 'lf' | 'crlf';
    readonly bom?: boolean;
    readonly trimTrailingWhitespace?: boolean;
    readonly insertFinalNewline?: boolean;
}

const MAX_SECTIONS = 500;

export function parseEditorConfig(text: string): EditorConfigFile {
    let root = false;
    const sections: EditorConfigSection[] = [];
    let current: { glob: string; properties: Record<string, string> } | null = null;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#') || line.startsWith(';')) {
            continue;
        }
        const section = /^\[(.+)\]$/.exec(line);
        if (section?.[1] !== undefined) {
            if (sections.length >= MAX_SECTIONS) {
                break;
            }
            current = { glob: section[1], properties: {} };
            sections.push(current);
            continue;
        }
        const equals = line.indexOf('=');
        if (equals <= 0) {
            continue;
        }
        const key = line.slice(0, equals).trim().toLowerCase();
        const value = line.slice(equals + 1).trim();
        if (current) {
            current.properties[key] = value;
        } else if (key === 'root') {
            root = value.toLowerCase() === 'true';
        }
    }
    return { root, sections };
}

/** A section glob as a regular expression over a path relative to the `.editorconfig`'s folder. */
export function globToRegExp(glob: string): RegExp {
    let pattern = glob;
    let anchored = pattern.includes('/');
    if (pattern.startsWith('/')) {
        pattern = pattern.slice(1);
        anchored = true;
    }
    let source = '';
    let braceDepth = 0;
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern.charAt(i);
        switch (char) {
            case '\\':
                source += escape(pattern.charAt(i + 1));
                i++;
                break;
            case '*':
                if (pattern.charAt(i + 1) === '*') {
                    // "**/" also matches no folder at all.
                    if (pattern.charAt(i + 2) === '/') {
                        source += '(?:.*/)?';
                        i += 2;
                    } else {
                        source += '.*';
                        i++;
                    }
                } else {
                    source += '[^/]*';
                }
                break;
            case '?':
                source += '[^/]';
                break;
            case '[': {
                const end = pattern.indexOf(']', i + 1);
                if (end < 0) {
                    source += '\\[';
                    break;
                }
                let body = pattern.slice(i + 1, end);
                const negated = body.startsWith('!') || body.startsWith('^');
                if (negated) { body = body.slice(1); }
                source += `[${negated ? '^/' : ''}${body.replace(/[\\\]]/g, '\\$&')}]`;
                i = end;
                break;
            }
            case '{': {
                const end = matchingBrace(pattern, i);
                const body = end < 0 ? null : pattern.slice(i + 1, end);
                const range = body === null ? null : /^(-?\d+)\.\.(-?\d+)$/.exec(body);
                if (range?.[1] !== undefined && range[2] !== undefined) {
                    const low = Math.min(Number(range[1]), Number(range[2]));
                    const high = Math.max(Number(range[1]), Number(range[2]));
                    source += `(?:${rangeAlternatives(low, high)})`;
                    i = end;
                } else if (body !== null && body.includes(',')) {
                    source += '(?:';
                    braceDepth++;
                } else {
                    source += '\\{';
                }
                break;
            }
            case ',':
                source += braceDepth > 0 ? '|' : ',';
                break;
            case '}':
                if (braceDepth > 0) {
                    source += ')';
                    braceDepth--;
                } else {
                    source += '\\}';
                }
                break;
            default:
                source += escape(char);
        }
    }
    return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${source}$`);
}

function escape(char: string): string {
    return char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function matchingBrace(text: string, open: number): number {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '\\') { i++; continue; }
        if (text[i] === '{') { depth++; }
        if (text[i] === '}' && --depth === 0) { return i; }
    }
    return -1;
}

function rangeAlternatives(low: number, high: number): string {
    // Long ranges would build a huge expression; past a few thousand numbers, any integer is close enough.
    if (high - low > 5000) {
        return '-?\\d+';
    }
    const values: number[] = [];
    for (let value = low; value <= high; value++) { values.push(value); }
    return values.join('|');
}

/** The folders whose `.editorconfig` may apply to `path` (workspace-relative), the root first. */
export function editorConfigFolders(path: string): string[] {
    const parts = path.split('/').slice(0, -1);
    const folders = [''];
    for (let i = 1; i <= parts.length; i++) {
        folders.push(parts.slice(0, i).join('/'));
    }
    return folders;
}

/**
 * The properties for `path` from the `.editorconfig` files found, each with
 * the folder it sits in (any order). The closest `root = true` hides the
 * files above it; a later section and a closer file win.
 */
export function resolveEditorConfig(found: readonly { readonly folder: string; readonly file: EditorConfigFile }[], path: string): EditorConfigProperties {
    const ordered = [...found]
        .filter(({ folder }) => folder === '' || path.startsWith(`${folder}/`))
        .sort((a, b) => depth(a.folder) - depth(b.folder));
    const rootIndex = ordered.map((entry) => entry.file.root).lastIndexOf(true);
    const merged: Record<string, string> = {};
    for (const { folder, file } of ordered.slice(Math.max(rootIndex, 0))) {
        const relative = folder === '' ? path : path.slice(folder.length + 1);
        for (const section of file.sections) {
            let matches = false;
            try {
                matches = globToRegExp(section.glob).test(relative);
            } catch {
                matches = false; // a glob the expression engine refuses matches nothing
            }
            if (!matches) {
                continue;
            }
            for (const [key, value] of Object.entries(section.properties)) {
                merged[key] = value.toLowerCase();
            }
        }
    }
    return toProperties(merged);
}

function depth(folder: string): number {
    return folder === '' ? 0 : folder.split('/').length;
}

function toProperties(raw: Readonly<Record<string, string>>): EditorConfigProperties {
    const value = (key: string): string | undefined => {
        const found = raw[key];
        return found === undefined || found === 'unset' ? undefined : found;
    };
    const flag = (key: string): boolean | undefined => {
        const found = value(key);
        return found === 'true' ? true : found === 'false' ? false : undefined;
    };
    const size = (text: string | undefined): number | undefined => {
        const parsed = text !== undefined && /^\d+$/.test(text) ? Number(text) : Number.NaN;
        return parsed >= 1 && parsed <= 32 ? parsed : undefined;
    };
    const style = value('indent_style');
    const insertSpaces = style === 'space' ? true : style === 'tab' ? false : undefined;
    const rawSize = value('indent_size');
    let tabWidth = size(value('tab_width'));
    let indentSize = rawSize === 'tab' ? tabWidth : size(rawSize);
    // As the specification says: each defaults to the other.
    if (tabWidth === undefined && indentSize !== undefined) { tabWidth = indentSize; }
    if (indentSize === undefined && rawSize === undefined && style === 'tab') { indentSize = tabWidth; }
    const eol = value('end_of_line');
    const charset = value('charset');
    const trim = flag('trim_trailing_whitespace');
    const finalNewline = flag('insert_final_newline');
    return {
        ...(insertSpaces === undefined ? {} : { insertSpaces }),
        ...(indentSize === undefined ? {} : { indentSize }),
        ...(tabWidth === undefined ? {} : { tabWidth }),
        ...(eol === 'lf' || eol === 'crlf' ? { endOfLine: eol } : {}),
        ...(charset === 'utf-8' ? { bom: false } : charset === 'utf-8-bom' ? { bom: true } : {}),
        ...(trim === undefined ? {} : { trimTrailingWhitespace: trim }),
        ...(finalNewline === undefined ? {} : { insertFinalNewline: finalNewline }),
    };
}
