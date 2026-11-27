/**
 * Glob patterns as VS Code's `findFiles`, file watchers and document
 * selectors take them (#259): `*`, `?`, `**`, `{a,b}` and `[...]`, matched
 * against a path relative to a base with `/` separators. Pure.
 */

const cache = new Map<string, RegExp>();

function escapeRegExp(text: string): string {
    return text.replace(/[.+^$()|\\]/g, '\\$&');
}

function translate(glob: string): string {
    let out = '';
    let index = 0;
    let braces = 0;
    while (index < glob.length) {
        const char = glob[index] ?? '';
        if (char === '*') {
            if (glob[index + 1] === '*') {
                // `**/` matches any number of folders (none included); a trailing `**` anything.
                const slash = glob[index + 2] === '/';
                out += slash ? '(?:[^/]*/)*' : '.*';
                index += slash ? 3 : 2;
                continue;
            }
            out += '[^/]*';
        } else if (char === '?') {
            out += '[^/]';
        } else if (char === '{') {
            braces++;
            out += '(?:';
        } else if (char === '}' && braces > 0) {
            braces--;
            out += ')';
        } else if (char === ',' && braces > 0) {
            out += '|';
        } else if (char === '[') {
            const close = glob.indexOf(']', index + 1);
            if (close > index + 1) {
                const body = glob.slice(index + 1, close).replace(/\\/g, '\\\\');
                out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
                index = close + 1;
                continue;
            }
            out += '\\[';
        } else {
            out += escapeRegExp(char);
        }
        index++;
    }
    return out;
}

export function globToRegExp(glob: string): RegExp {
    let regexp = cache.get(glob);
    if (!regexp) {
        regexp = new RegExp(`^${translate(glob.replace(/\\/g, '/').replace(/^\.\//, ''))}$`);
        if (cache.size > 500) {
            cache.clear();
        }
        cache.set(glob, regexp);
    }
    return regexp;
}

// Whether `relativePath` (with `/`) matches `glob` as a whole: `*.ts` is a file at the base, `**/*.ts` one at any depth.
export function matchGlob(glob: string, relativePath: string): boolean {
    return globToRegExp(glob).test(relativePath.replace(/\\/g, '/'));
}
