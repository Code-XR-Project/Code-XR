/**
 * #172: the structure of a file (classes and their functions) for the
 * Outline view and the breadcrumbs, where the editor has no language service
 * to ask. It is built from the functions the backend measured (the shared
 * core's functionMetrics.ts, so every language the analysis reads gets an
 * outline) plus a cheap scan of the text for the declarations that hold
 * them: indentation for Python, braces for the C family, Java, C#, Kotlin,
 * Swift, Go, Rust, PHP and the like.
 *
 * It lives in the IDE, not in the shared core: the VS Code extension needs
 * none of it, because VS Code has its own Outline and breadcrumbs. Pure, so
 * the renderer can load it and the node tests can run it.
 */

export type OutlineKind =
    | 'class' | 'interface' | 'struct' | 'enum' | 'namespace' | 'module' | 'type'
    | 'function' | 'method' | 'constructor' | 'property' | 'field' | 'variable' | 'constant' | 'other';

export interface OutlineSymbol {
    readonly name: string;
    readonly kind: OutlineKind;
    /** 1-based lines the symbol covers. */
    readonly startLine: number;
    readonly endLine: number;
    /** The line its name is on (where a click puts the cursor). */
    readonly line: number;
    readonly children: readonly OutlineSymbol[];
}

export type OutlineSort = 'position' | 'name';

interface Node {
    name: string;
    kind: OutlineKind;
    startLine: number;
    endLine: number;
    line: number;
    children: Node[];
    /** Containers come before what they hold when two start on the same line. */
    container: boolean;
}

const CONTAINER_KINDS: Readonly<Record<string, OutlineKind>> = {
    class: 'class', interface: 'interface', struct: 'struct', enum: 'enum', record: 'class',
    trait: 'interface', protocol: 'interface', object: 'class', impl: 'class', extension: 'class',
    namespace: 'namespace', module: 'module',
};
const BRACE_DECLARATION = /(?:^|[^\w$.])(class|interface|struct|enum|record|trait|protocol|object|impl|extension|namespace|module)\s+([A-Za-z_$][\w$]*)/;
const PYTHON_CLASS = /^(\s*)class\s+([A-Za-z_]\w*)/;
const MAX_SCAN_LINES = 50_000;
/** How far after its keyword a declaration's opening brace may be. */
const BRACE_LOOKAHEAD_LINES = 5;

function isPython(languageId: string): boolean {
    return languageId.toLowerCase() === 'python';
}

function indentOf(line: string): number {
    return line.length - line.trimStart().length;
}

function pythonClasses(lines: readonly string[]): Node[] {
    const classes: Node[] = [];
    lines.forEach((text, index) => {
        const match = PYTHON_CLASS.exec(text);
        if (!match) {
            return;
        }
        const indent = (match[1] ?? '').length;
        let end = index;
        for (let next = index + 1; next < lines.length; next++) {
            const body = lines[next] ?? '';
            const trimmed = body.trim();
            if (trimmed === '' || trimmed.startsWith('#')) {
                continue;
            }
            if (indentOf(body) <= indent) {
                break;
            }
            end = next;
        }
        classes.push({ name: match[2] ?? 'class', kind: 'class', startLine: index + 1, endLine: end + 1, line: index + 1, children: [], container: true });
    });
    return classes;
}

interface ScanState {
    inBlockComment: boolean;
    quote: string;
}

/** How many characters at `i` belong to a string or a comment (0: code), updating the state. */
function skipped(line: string, i: number, state: ScanState): number {
    const char = line[i] ?? '';
    const pair = line.slice(i, i + 2);
    if (state.inBlockComment) {
        state.inBlockComment = pair !== '*/';
        return state.inBlockComment ? 1 : 2;
    }
    if (state.quote) {
        if (char === state.quote) { state.quote = ''; }
        return char === '\\' ? 2 : 1;
    }
    if (pair === '//') { return line.length - i; }
    if (pair === '/*') { state.inBlockComment = true; return 2; }
    if (char === '"' || char === '\'' || char === '`') { state.quote = char; return 1; }
    return 0;
}

/** The text of a line with its strings and comments blanked, so braces inside them do not count. */
function codeOf(line: string, state: ScanState): string {
    let code = '';
    state.quote = '';
    for (let i = 0; i < line.length;) {
        const skip = skipped(line, i, state);
        if (skip === 0) {
            code += line[i];
            i++;
        } else {
            i += skip;
        }
    }
    return code;
}

/** The brace depth after `text`, or 'declaration' when a `;` ends it before any brace opened. */
function depthAfter(text: string, depth: number, opened: boolean): { depth: number; opened: boolean; closedAt: boolean } | 'declaration' {
    let next = depth;
    let isOpen = opened;
    for (const char of text) {
        if (char === ';' && !isOpen) { return 'declaration'; }
        if (char === '{') { next++; isOpen = true; }
        if (char === '}') { next--; }
        if (isOpen && next === 0) { return { depth: 0, opened: true, closedAt: true }; }
    }
    return { depth: next, opened: isOpen, closedAt: false };
}

/** The line (0-based) of the brace closing the block that opens on or after `from`, or null when there is none. */
function blockEnd(code: readonly string[], from: number, column: number): number | null {
    let state = { depth: 0, opened: false };
    for (let index = from; index < code.length; index++) {
        const text = code[index] ?? '';
        const after = depthAfter(index === from ? text.slice(column) : text, state.depth, state.opened);
        if (after === 'declaration' || (!after.opened && index - from >= BRACE_LOOKAHEAD_LINES)) {
            return null;
        }
        if (after.closedAt) {
            return index;
        }
        state = after;
    }
    return null;
}

function braceContainers(lines: readonly string[]): Node[] {
    const state: ScanState = { inBlockComment: false, quote: '' };
    const code = lines.map((line) => codeOf(line, state));
    const containers: Node[] = [];
    code.forEach((text, index) => {
        const match = BRACE_DECLARATION.exec(text);
        if (!match) {
            return;
        }
        const end = blockEnd(code, index, match.index + match[0].length);
        if (end !== null) {
            containers.push({ name: match[2] ?? 'class', kind: CONTAINER_KINDS[match[1] ?? ''] ?? 'class', startLine: index + 1, endLine: end + 1, line: index + 1, children: [], container: true });
        }
    });
    return containers;
}

/** "A::B::run" or "area.inner": the enclosing names, then the function's own. */
function nameParts(name: string): { readonly prefix: readonly string[]; readonly own: string } {
    const parts = name.split(/::|\./).filter(Boolean);
    const own = parts.pop() ?? name;
    return { prefix: parts, own };
}

function contains(outer: Node, inner: Node): boolean {
    return outer !== inner && outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
}

/**
 * A function qualified with a name that holds no other symbol around it (a
 * C++ `Shape::area` defined outside its class) is grouped under a container
 * of that name, spanning its functions.
 */
function groupQualified(functions: readonly Node[], prefixes: ReadonlyMap<Node, readonly string[]>, scanned: readonly Node[]): Node[] {
    const synthetic = new Map<string, Node>();
    for (const fn of functions) {
        const prefix = prefixes.get(fn) ?? [];
        const owner = prefix.at(-1);
        if (owner === undefined) {
            continue;
        }
        const enclosed = [...scanned, ...functions].some((other) => other.name === owner && contains(other, fn));
        if (enclosed) {
            continue;
        }
        const key = prefix.join('::');
        const group = synthetic.get(key);
        if (group) {
            group.startLine = Math.min(group.startLine, fn.startLine);
            group.endLine = Math.max(group.endLine, fn.endLine);
            group.line = group.startLine;
        } else {
            synthetic.set(key, { name: key, kind: 'class', startLine: fn.startLine, endLine: fn.endLine, line: fn.startLine, children: [], container: true });
        }
    }
    return [...synthetic.values()];
}

/** Nests each symbol in the smallest one that holds it. */
function nest(nodes: Node[]): Node[] {
    const sorted = [...nodes].sort((a, b) =>
        a.startLine - b.startLine || b.endLine - a.endLine || Number(b.container) - Number(a.container));
    const roots: Node[] = [];
    const stack: Node[] = [];
    for (const node of sorted) {
        for (let top = stack.at(-1); top && !contains(top, node); top = stack.at(-1)) {
            stack.pop();
        }
        const parent = stack.at(-1);
        if (parent) {
            parent.children.push(node);
            if (parent.container && node.kind === 'function') {
                node.kind = node.name === parent.name ? 'constructor' : 'method';
            }
        } else {
            roots.push(node);
        }
        stack.push(node);
    }
    return roots;
}

function freeze(nodes: readonly Node[]): OutlineSymbol[] {
    return nodes.map((node) => ({
        name: node.name, kind: node.kind, startLine: node.startLine, endLine: node.endLine, line: node.line, children: freeze(node.children),
    }));
}

/**
 * The outline of a file from its measured functions and its text. `languageId`
 * picks the declaration scan ("python" reads indentation, anything else braces).
 */
export function outlineFromFunctions(
    functions: readonly { readonly name: string; readonly lineStart: number; readonly lineEnd: number }[],
    text: string,
    languageId: string,
): OutlineSymbol[] {
    const lines = text.split(/\r\n|\r|\n/).slice(0, MAX_SCAN_LINES);
    const scanned = isPython(languageId) ? pythonClasses(lines) : braceContainers(lines);
    const prefixes = new Map<Node, readonly string[]>();
    const nodes = functions.map((fn): Node => {
        const { prefix, own } = nameParts(fn.name);
        const node: Node = { name: own, kind: 'function', startLine: fn.lineStart, endLine: Math.max(fn.lineStart, fn.lineEnd), line: fn.lineStart, children: [], container: false };
        prefixes.set(node, prefix);
        return node;
    });
    // A declaration holding no measured function is left out: the outline is about where the code is.
    const holding = scanned.filter((container) => nodes.some((fn) => contains(container, fn)));
    return freeze(nest([...holding, ...groupQualified(nodes, prefixes, holding), ...nodes]));
}

/** The chain of symbols around `line`, outermost first (empty outside every symbol). */
export function symbolPathAt(symbols: readonly OutlineSymbol[], line: number): OutlineSymbol[] {
    const path: OutlineSymbol[] = [];
    let level = symbols;
    for (;;) {
        const hit = level.find((symbol) => symbol.startLine <= line && symbol.endLine >= line);
        if (!hit) {
            return path;
        }
        path.push(hit);
        level = hit.children;
    }
}

/** The symbols in source order or by name, at every level. */
export function sortOutline(symbols: readonly OutlineSymbol[], by: OutlineSort): OutlineSymbol[] {
    const compare = by === 'name'
        ? (a: OutlineSymbol, b: OutlineSymbol): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.line - b.line
        : (a: OutlineSymbol, b: OutlineSymbol): number => a.startLine - b.startLine || a.line - b.line;
    return [...symbols].sort(compare).map((symbol) => ({ ...symbol, children: sortOutline(symbol.children, by) }));
}

/** Symbols in the outline, at every level. */
export function countSymbols(symbols: readonly OutlineSymbol[]): number {
    return symbols.reduce((total, symbol) => total + 1 + countSymbols(symbol.children), 0);
}

const TYPESCRIPT_KINDS: ReadonlyMap<string, OutlineKind> = new Map<string, OutlineKind>([
    ['class', 'class'], ['local class', 'class'], ['interface', 'interface'], ['enum', 'enum'], ['module', 'module'],
    ['type', 'type'], ['alias', 'type'], ['function', 'function'], ['local function', 'function'],
    ['method', 'method'], ['getter', 'method'], ['setter', 'method'], ['call', 'method'], ['construct', 'method'], ['index', 'method'],
    ['constructor', 'constructor'], ['property', 'property'], ['enum member', 'property'], ['const', 'constant'],
    ['var', 'variable'], ['let', 'variable'], ['local var', 'variable'], ['parameter', 'variable'],
]);

/** The kind of an item of TypeScript's navigation tree (`ScriptElementKind`). */
export function outlineKindOfTypeScript(kind: string): OutlineKind {
    return TYPESCRIPT_KINDS.get(kind) ?? 'other';
}
