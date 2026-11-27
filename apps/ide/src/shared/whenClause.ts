/**
 * #261: VS Code's `when` clauses, for the menus, views and welcome content
 * extensions contribute. A clause is parsed once into a small tree and
 * evaluated against a lookup of context keys (`view`, `viewItem`,
 * `resourceLangId`, what extensions set with `setContext`, ...). The grammar
 * is VS Code's: `!`, `&&`, `||`, parentheses, `==`/`!=` (and `===`/`!==`),
 * `<`, `<=`, `>`, `>=`, `=~ /regex/flags`, `in` and `not in`; values are
 * bare words or quoted strings, `true` and `false` are booleans.
 *
 * Evaluation never throws: an unparsable clause is false (the item stays
 * hidden), as an unknown key is undefined (falsy). Pure: shared by main, the
 * renderer and the unit tests.
 */

export type WhenNode =
    | { readonly kind: 'true' }
    | { readonly kind: 'false' }
    | { readonly kind: 'key'; readonly key: string }
    | { readonly kind: 'not'; readonly operand: WhenNode }
    | { readonly kind: 'and'; readonly operands: readonly WhenNode[] }
    | { readonly kind: 'or'; readonly operands: readonly WhenNode[] }
    | { readonly kind: 'compare'; readonly key: string; readonly op: '==' | '!=' | '<' | '<=' | '>' | '>='; readonly value: string | boolean | number }
    | { readonly kind: 'regex'; readonly key: string; readonly regex: RegExp | null }
    | { readonly kind: 'in'; readonly key: string; readonly container: string; readonly negated: boolean };

type Token =
    | { readonly type: 'op'; readonly value: string }
    | { readonly type: 'word'; readonly value: string }
    | { readonly type: 'string'; readonly value: string }
    | { readonly type: 'regex'; readonly value: string; readonly flags: string };

const OPERATORS = ['===', '!==', '==', '!=', '<=', '>=', '=~', '&&', '||', '<', '>', '!', '(', ')'];

function tokenize(text: string): Token[] | null {
    const tokens: Token[] = [];
    let i = 0;
    while (i < text.length) {
        const char = text[i] as string;
        if (/\s/.test(char)) {
            i++;
            continue;
        }
        if (char === "'" || char === '"') {
            const end = text.indexOf(char, i + 1);
            if (end < 0) {
                return null;
            }
            tokens.push({ type: 'string', value: text.slice(i + 1, end) });
            i = end + 1;
            continue;
        }
        // A regex only follows `=~`.
        const previous = tokens[tokens.length - 1];
        if (char === '/' && previous?.type === 'op' && previous.value === '=~') {
            let j = i + 1;
            let inClass = false;
            while (j < text.length) {
                const c = text[j];
                if (c === '\\') {
                    j += 2;
                    continue;
                }
                if (c === '[') {
                    inClass = true;
                } else if (c === ']') {
                    inClass = false;
                } else if (c === '/' && !inClass) {
                    break;
                }
                j++;
            }
            if (j >= text.length) {
                return null;
            }
            const flags = /^[a-z]*/.exec(text.slice(j + 1))?.[0] ?? '';
            tokens.push({ type: 'regex', value: text.slice(i + 1, j), flags });
            i = j + 1 + flags.length;
            continue;
        }
        const op = OPERATORS.find((candidate) => text.startsWith(candidate, i));
        if (op) {
            tokens.push({ type: 'op', value: op });
            i += op.length;
            continue;
        }
        let j = i;
        while (j < text.length && !/\s/.test(text[j] as string) && !OPERATORS.some((candidate) => text.startsWith(candidate, j) && candidate !== '!' ) && text[j] !== "'" && text[j] !== '"') {
            j++;
        }
        // `!` inside a word (`a!b`) is not an operator, but `!` at its start is handled above.
        if (j === i) {
            return null;
        }
        tokens.push({ type: 'word', value: text.slice(i, j) });
        i = j;
    }
    return tokens;
}

function literal(token: Token): string | boolean | number {
    if (token.type === 'word') {
        if (token.value === 'true') {
            return true;
        }
        if (token.value === 'false') {
            return false;
        }
    }
    return token.value;
}

/** Parses a clause; null when it does not parse. An empty clause is `true`. */
export function parseWhen(text: string): WhenNode | null {
    const tokenized = tokenize(text);
    if (!tokenized) {
        return null;
    }
    const tokens: Token[] = tokenized;
    if (tokens.length === 0) {
        return { kind: 'true' };
    }
    let position = 0;
    const peek = (): Token | undefined => tokens[position];
    const isOp = (value: string): boolean => {
        const token = peek();
        return token?.type === 'op' && token.value === value;
    };

    function parseOr(): WhenNode | null {
        const operands: WhenNode[] = [];
        const first = parseAnd();
        if (!first) {
            return null;
        }
        operands.push(first);
        while (isOp('||')) {
            position++;
            const next = parseAnd();
            if (!next) {
                return null;
            }
            operands.push(next);
        }
        return operands.length === 1 ? operands[0] as WhenNode : { kind: 'or', operands };
    }

    function parseAnd(): WhenNode | null {
        const operands: WhenNode[] = [];
        const first = parseUnary();
        if (!first) {
            return null;
        }
        operands.push(first);
        while (isOp('&&')) {
            position++;
            const next = parseUnary();
            if (!next) {
                return null;
            }
            operands.push(next);
        }
        return operands.length === 1 ? operands[0] as WhenNode : { kind: 'and', operands };
    }

    function parseUnary(): WhenNode | null {
        if (isOp('!')) {
            position++;
            const operand = parseUnary();
            return operand ? { kind: 'not', operand } : null;
        }
        return parsePrimary();
    }

    function parsePrimary(): WhenNode | null {
        if (isOp('(')) {
            position++;
            const inner = parseOr();
            if (!inner || !isOp(')')) {
                return null;
            }
            position++;
            return inner;
        }
        const token = peek();
        if (!token || (token.type !== 'word' && token.type !== 'string')) {
            return null;
        }
        position++;
        if (token.type === 'word' && token.value === 'true') {
            return { kind: 'true' };
        }
        if (token.type === 'word' && token.value === 'false') {
            return { kind: 'false' };
        }
        const key = token.value;
        const next = peek();
        if (next?.type === 'op') {
            switch (next.value) {
                case '==': case '===': case '!=': case '!==': case '<': case '<=': case '>': case '>=': {
                    position++;
                    const value = peek();
                    if (!value || value.type === 'op' || value.type === 'regex') {
                        return null;
                    }
                    position++;
                    const op = next.value === '===' ? '==' : next.value === '!==' ? '!=' : next.value;
                    return { kind: 'compare', key, op, value: literal(value) };
                }
                case '=~': {
                    position++;
                    const value = peek();
                    if (!value) {
                        return null;
                    }
                    position++;
                    let regex: RegExp | null = null;
                    try {
                        regex = value.type === 'regex' ? new RegExp(value.value, value.flags.replace(/[^imsu]/g, '')) : new RegExp(value.value);
                    } catch {
                        regex = null;
                    }
                    return { kind: 'regex', key, regex };
                }
                default:
                    break;
            }
        }
        if (next?.type === 'word' && next.value === 'in') {
            position++;
            const container = peek();
            if (!container || container.type === 'op' || container.type === 'regex') {
                return null;
            }
            position++;
            return { kind: 'in', key, container: container.value, negated: false };
        }
        if (next?.type === 'word' && next.value === 'not' && tokens[position + 1]?.type === 'word' && tokens[position + 1]?.value === 'in') {
            position += 2;
            const container = peek();
            if (!container || container.type === 'op' || container.type === 'regex') {
                return null;
            }
            position++;
            return { kind: 'in', key, container: container.value, negated: true };
        }
        return { kind: 'key', key };
    }

    const node = parseOr();
    return node && position === tokens.length ? node : null;
}

export type ContextLookup = (key: string) => unknown;

function loosely(actual: unknown, expected: string | boolean | number): boolean {
    if (typeof expected === 'boolean') {
        return actual === expected || (typeof actual === 'string' && actual === String(expected));
    }
    // eslint-disable-next-line eqeqeq -- VS Code compares context values loosely (a number key equals its string).
    return actual == expected;
}

export function evaluateWhen(node: WhenNode, lookup: ContextLookup): boolean {
    switch (node.kind) {
        case 'true':
            return true;
        case 'false':
            return false;
        case 'key':
            return !!lookup(node.key);
        case 'not':
            return !evaluateWhen(node.operand, lookup);
        case 'and':
            return node.operands.every((operand) => evaluateWhen(operand, lookup));
        case 'or':
            return node.operands.some((operand) => evaluateWhen(operand, lookup));
        case 'compare': {
            const actual = lookup(node.key);
            switch (node.op) {
                case '==':
                    return loosely(actual, node.value);
                case '!=':
                    return !loosely(actual, node.value);
                default: {
                    const left = typeof actual === 'number' ? actual : Number.parseFloat(String(actual));
                    const right = typeof node.value === 'number' ? node.value : Number.parseFloat(String(node.value));
                    if (Number.isNaN(left) || Number.isNaN(right)) {
                        return false;
                    }
                    return node.op === '<' ? left < right : node.op === '<=' ? left <= right : node.op === '>' ? left > right : left >= right;
                }
            }
        }
        case 'regex': {
            const actual = lookup(node.key);
            return !!node.regex && actual !== undefined && actual !== null && node.regex.test(String(actual));
        }
        case 'in': {
            const item = lookup(node.key);
            const container = lookup(node.container);
            let found = false;
            if (Array.isArray(container)) {
                found = container.includes(item);
            } else if (typeof container === 'object' && container !== null && typeof item === 'string') {
                found = Object.prototype.hasOwnProperty.call(container, item);
            }
            return node.negated ? !found : found;
        }
    }
}

const cache = new Map<string, WhenNode | null>();

/** Whether `clause` holds; no clause holds, a clause that does not parse does not. */
export function whenHolds(clause: string | null | undefined, lookup: ContextLookup): boolean {
    if (clause === null || clause === undefined || clause.trim() === '') {
        return true;
    }
    let node = cache.get(clause);
    if (node === undefined) {
        node = parseWhen(clause);
        if (cache.size > 2000) {
            cache.clear();
        }
        cache.set(clause, node);
    }
    return node ? evaluateWhen(node, lookup) : false;
}
