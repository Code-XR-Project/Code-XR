/**
 * File links in the terminal (#286): which parts of a line of output name a
 * file of the open folder, and where in it. Pure and DOM-free, unit-tested
 * in Node (`test/terminalLinks.test.ts`); `xtermView.ts` feeds it the lines
 * and turns what it finds into xterm.js links.
 *
 * Recognised, with an optional line and column:
 *
 * - `src/a.ts`, `./a.py`, `../x/b.js` (relative to the open folder, where the
 *   terminal starts), `src/a.ts:12`, `src/a.ts:12:5`;
 * - `a.ts(12,5)` and `a.ts(12)` (tsc, MSBuild);
 * - Python tracebacks: `File "/abs/path/x.py", line 12`;
 * - Node stack frames: `at fn (/abs/path/x.js:12:5)`, `at /abs/x.js:12:5`,
 *   `at file:///abs/x.mjs:12:5`;
 * - on Windows, `C:\dir\a.ts`, `C:/dir/a.ts` and backslashes in relative paths.
 *
 * An absolute path is a link only inside the open folder, and becomes a
 * workspace path (relative, `/`-separated); anything outside it, a `~/`
 * path, or a `..` that climbs out of the folder is not a link. URLs are left
 * to the web-links addon. Whether the file exists is checked afterwards,
 * through the workspace API (`createWorkspaceFileChecker`).
 */

export interface TerminalLinkContext {
    /** The open folder, absolute, as `WorkspaceInfo.root` gives it. */
    readonly root: string;
    /** The OS the paths come from: `win32` turns on drive letters and backslashes. */
    readonly platform: string;
}

export interface TerminalFileLink {
    /** UTF-16 index of the link's first character in the line. */
    readonly start: number;
    /** UTF-16 index just after the link's last character. */
    readonly end: number;
    /** The text the link covers, as it appears in the line. */
    readonly text: string;
    /** Workspace path: relative to the folder, `/`-separated. */
    readonly path: string;
    readonly line?: number;
    readonly column?: number;
}

/** Characters that never belong to a path segment in terminal output. */
const SEGMENT = String.raw`[^\s"'\x60()<>\[\]{}:,;|*?=\\/]+`;
/** Optional drive (`C:` then a separator), then an optional leading `/`, `./`, `../` or `~/`. */
const PATH = String.raw`(?:[A-Za-z]:[\\/])?(?:~[\\/]|\.{1,2}[\\/]|[\\/])?(?:${SEGMENT}[\\/])*${SEGMENT}`;
/** `:12`, `:12:5`, `(12)`, `(12,5)` or `(12, 5)` right after the path. */
const LOCATION = String.raw`(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\))?`;
/** `file://` before a path; on Windows `file:///C:/...`, whose third slash belongs to the scheme. */
const PATH_LINK = new RegExp(String.raw`(file:\/\/(?:\/(?=[A-Za-z]:\/))?)?(${PATH})${LOCATION}`, 'g');
/** Python: `File "<path>", line <n>`. */
const PYTHON_FRAME = /File "([^"]+)", line (\d+)/g;
/**
 * Anything with a scheme (`https://`, `vscode://` ...) except `file://` is a
 * URL, not a path; so is a Node built-in module's frame (`node:internal/...`).
 */
const URL_PATTERN = /\b(?!file:\/\/)[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]*|\bnode:[^\s"'<>()]+/g;
/** A basename that looks like a file name: a name and an extension. */
const FILE_NAME = /[^.]\.(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9_-]{0,11}$/;
const MAX_LINE_NUMBER = 10_000_000;

/** Finds every file link in one line of terminal output, left to right. */
export function findFileLinks(text: string, context: TerminalLinkContext): TerminalFileLink[] {
    const links: TerminalFileLink[] = [];
    const taken: Array<readonly [number, number]> = [];
    for (const match of text.matchAll(URL_PATTERN)) {
        taken.push([match.index, match.index + match[0].length]);
    }
    const overlaps = (start: number, end: number): boolean => taken.some(([from, to]) => start < to && end > from);
    const add = (link: TerminalFileLink): void => {
        links.push(link);
        taken.push([link.start, link.end]);
    };

    for (const match of text.matchAll(PYTHON_FRAME)) {
        const raw = match[1] ?? '';
        const start = match.index + 'File "'.length;
        const end = start + raw.length;
        const path = toWorkspacePath(raw, context);
        if (path !== null && !overlaps(start, end)) {
            add({ start, end, text: raw, path, ...location(match[2], undefined) });
        }
    }

    for (const match of text.matchAll(PATH_LINK)) {
        const scheme = match[1] ?? '';
        let raw = match[2] ?? '';
        const hasLocation = match[3] !== undefined || match[5] !== undefined;
        // A sentence's full stop is not part of the name: `see src/a.ts.`.
        if (!hasLocation) {
            raw = raw.replace(/\.+$/, '');
        }
        const start = match.index;
        const end = hasLocation ? start + match[0].length : start + scheme.length + raw.length;
        if (raw === '' || overlaps(start, end) || !looksLikeFile(raw, scheme !== '')) {
            continue;
        }
        const path = toWorkspacePath(scheme ? fileUrlPath(raw) : raw, context);
        if (path === null) {
            continue;
        }
        add({ start, end, text: text.slice(start, end), path, ...location(match[3] ?? match[5], match[4] ?? match[6]) });
    }
    return links.sort((a, b) => a.start - b.start);
}

/** A token names a file when it has a separator or a file name with an extension. */
function looksLikeFile(raw: string, fromFileUrl: boolean): boolean {
    if (fromFileUrl) {
        return true;
    }
    if (/^\.+$/.test(raw)) {
        return false;
    }
    return /[\\/]/.test(raw) || FILE_NAME.test(raw);
}

function location(lineText: string | undefined, columnText: string | undefined): { line?: number; column?: number } {
    const line = lineText === undefined ? NaN : Number(lineText);
    if (!Number.isInteger(line) || line < 1 || line > MAX_LINE_NUMBER) {
        return {};
    }
    const column = columnText === undefined ? NaN : Number(columnText);
    return Number.isInteger(column) && column >= 1 && column <= MAX_LINE_NUMBER ? { line, column } : { line };
}

/** The path of a `file://` URL, percent-decoded (`m%20n.mjs` is `m n.mjs`). */
function fileUrlPath(rest: string): string {
    try {
        return decodeURIComponent(rest);
    } catch {
        return '';
    }
}

/**
 * A path from terminal output as a workspace path, or null when it is not
 * inside the open folder. Relative paths are taken from the folder (where a
 * terminal starts).
 */
export function toWorkspacePath(raw: string, context: TerminalLinkContext): string | null {
    const windows = context.platform === 'win32';
    if (raw === '' || raw.includes('\0')) {
        return null;
    }
    if (!windows && (raw.includes('\\') || /^[A-Za-z]:/.test(raw))) {
        return null;
    }
    const candidate = windows ? raw.replace(/\\/g, '/') : raw;
    if (candidate.startsWith('~/') || candidate.startsWith('//')) {
        return null;
    }
    const absolute = windows ? /^[A-Za-z]:\//.test(candidate) : candidate.startsWith('/');
    if (windows && !absolute && candidate.startsWith('/')) {
        return null; // Rooted on the current drive: which drive is unknown.
    }
    if (!absolute) {
        return joinInside([], candidate.split('/'));
    }
    const root = normalizeRoot(context.root, windows);
    if (root === null) {
        return null;
    }
    const segments = resolveSegments(candidate.split('/').slice(windows ? 1 : 0));
    if (segments === null) {
        return null;
    }
    const drive = windows ? candidate.slice(0, 2) : '';
    if (windows && drive.toLowerCase() !== root.drive.toLowerCase()) {
        return null;
    }
    if (segments.length <= root.segments.length) {
        return null;
    }
    const same = (a: string, b: string): boolean => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (!root.segments.every((segment, index) => same(segment, segments[index] ?? ''))) {
        return null;
    }
    return segments.slice(root.segments.length).join('/');
}

function normalizeRoot(root: string, windows: boolean): { drive: string; segments: string[] } | null {
    const path = windows ? root.replace(/\\/g, '/') : root;
    if (windows ? !/^[A-Za-z]:(\/|$)/.test(path) : !path.startsWith('/')) {
        return null;
    }
    const segments = resolveSegments(path.split('/').slice(windows ? 1 : 0));
    return segments === null ? null : { drive: windows ? path.slice(0, 2) : '', segments };
}

/** Applies `.` and `..`; null when `..` climbs above the start. */
function resolveSegments(parts: readonly string[]): string[] | null {
    const out: string[] = [];
    for (const part of parts) {
        if (part === '' || part === '.') {
            continue;
        }
        if (part === '..') {
            if (out.length === 0) {
                return null;
            }
            out.pop();
        } else {
            out.push(part);
        }
    }
    return out;
}

function joinInside(base: readonly string[], parts: readonly string[]): string | null {
    const segments = resolveSegments([...base, ...parts]);
    return segments === null || segments.length === 0 ? null : segments.join('/');
}

/**
 * The minimal view of an xterm.js buffer the line reader needs, so it is
 * testable without xterm (structurally compatible with `IBuffer`).
 */
export interface BufferLike {
    readonly length: number;
    getLine(y: number): BufferLineLike | undefined;
}
export interface BufferLineLike {
    readonly isWrapped: boolean;
    readonly length: number;
    getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
}

/** A logical line (a row and the rows wrapped onto it) and the cell of each of its characters. */
export interface LogicalLine {
    readonly text: string;
    /** For each UTF-16 index of `text`, the 0-based buffer cell (x, y) it is drawn in. */
    readonly cells: ReadonlyArray<{ readonly x: number; readonly y: number }>;
}

/**
 * Reads the logical line containing buffer row `y` (0-based): long paths
 * wrap in a narrow terminal, and a link must survive that. Wide characters
 * take two cells and one index, so indices and cells are mapped one by one.
 */
export function readLogicalLine(buffer: BufferLike, y: number, maxRows = 20): LogicalLine {
    let first = y;
    while (first > 0 && y - first < maxRows && buffer.getLine(first)?.isWrapped) {
        first--;
    }
    let last = y;
    while (last + 1 < buffer.length && last - first < maxRows && buffer.getLine(last + 1)?.isWrapped) {
        last++;
    }
    let text = '';
    const cells: Array<{ x: number; y: number }> = [];
    for (let row = first; row <= last; row++) {
        const line = buffer.getLine(row);
        if (!line) {
            break;
        }
        let rowText = '';
        const rowCells: Array<{ x: number; y: number }> = [];
        for (let x = 0; x < line.length; x++) {
            const cell = line.getCell(x);
            if (!cell || cell.getWidth() === 0) {
                continue; // The second half of a wide character.
            }
            const chars = cell.getChars() || ' ';
            rowText += chars;
            for (let i = 0; i < chars.length; i++) {
                rowCells.push({ x, y: row });
            }
        }
        if (row === last) {
            // The last row's trailing blanks are padding, not output.
            const trimmed = rowText.replace(/ +$/, '');
            rowCells.length = trimmed.length;
            rowText = trimmed;
        }
        text += rowText;
        cells.push(...rowCells);
    }
    return { text, cells };
}

/** A directory listing, as `workspace.listDirectory` answers it. */
export type DirectoryEntries = ReadonlyArray<{ readonly path: string; readonly kind: 'file' | 'directory' }>;
export type ListDirectory = (path: string) => Promise<DirectoryEntries>;

/**
 * Checks link targets against the folder through the workspace API (the main
 * process confines it to the folder). Resolves with the file's own workspace
 * path, which differs in case from the link's on Windows and macOS, or null
 * when there is no such file. Listings are reused for a few seconds, since
 * the mouse moving over a stack trace asks about the same folders again.
 */
export function createWorkspaceFileChecker(list: ListDirectory, platform: string, ttlMs = 3000, now: () => number = Date.now): (path: string) => Promise<string | null> {
    const cache = new Map<string, { at: number; entries: Promise<DirectoryEntries> }>();
    const caseInsensitive = platform === 'win32' || platform === 'darwin';
    return async (path) => {
        const slash = path.lastIndexOf('/');
        const parent = slash < 0 ? '' : path.slice(0, slash);
        let cached = cache.get(parent);
        if (!cached || now() - cached.at > ttlMs) {
            cached = { at: now(), entries: list(parent) };
            cache.set(parent, cached);
            if (cache.size > 64) {
                const oldest = cache.keys().next().value;
                if (oldest !== undefined) { cache.delete(oldest); }
            }
        }
        let entries: DirectoryEntries;
        try {
            entries = await cached.entries;
        } catch {
            return null;
        }
        const files = entries.filter((entry) => entry.kind === 'file');
        const exact = files.find((entry) => entry.path === path);
        if (exact) {
            return exact.path;
        }
        if (caseInsensitive) {
            const lower = path.toLowerCase();
            return files.find((entry) => entry.path.toLowerCase() === lower)?.path ?? null;
        }
        return null;
    };
}
