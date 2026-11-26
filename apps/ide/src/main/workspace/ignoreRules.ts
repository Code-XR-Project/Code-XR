/**
 * Which explorer entries are hidden or dimmed (#14).
 *
 * Two lists: names that are never listed at all (`.git`, `node_modules`:
 * huge and not something to browse), and the patterns of the workspace's root
 * `.gitignore`, whose matches are listed dimmed, as VS Code does. Nested
 * `.gitignore` files are not read yet.
 *
 * The `.gitignore` subset implemented: comments, blank lines, `!` negation
 * (last matching rule wins), a trailing `/` for folders only, a leading or
 * inner `/` anchoring the pattern to the root, `*`, `?`, `[...]` and `**`.
 * Escaped characters (`\#`, `\!`, `\ `) are honoured.
 */

/** Never listed in the explorer. */
export const EXCLUDED_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules', '.DS_Store']);

export interface IgnoreRule {
    readonly negated: boolean;
    readonly directoryOnly: boolean;
    readonly regex: RegExp;
}

export function parseGitignore(text: string): readonly IgnoreRule[] {
    const rules: IgnoreRule[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        let line = rawLine.replace(/(?<!\\)\s+$/, '');
        if (line === '' || line.startsWith('#')) {
            continue;
        }
        let negated = false;
        if (line.startsWith('!')) {
            negated = true;
            line = line.slice(1);
        }
        let directoryOnly = false;
        if (line.endsWith('/')) {
            directoryOnly = true;
            line = line.slice(0, -1);
        }
        if (line === '') {
            continue;
        }
        // A slash at the start or in the middle anchors the pattern to the root;
        // without one it matches a name at any depth.
        const anchored = line.includes('/');
        if (line.startsWith('/')) {
            line = line.slice(1);
        }
        const body = globToRegex(line);
        const regex = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
        rules.push({ negated, directoryOnly, regex });
    }
    return rules;
}

function globToRegex(glob: string): string {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i] as string;
        if (char === '\\' && i + 1 < glob.length) {
            out += escapeRegex(glob[++i] as string);
        } else if (char === '*') {
            if (glob[i + 1] === '*') {
                const atSegmentStart = i === 0 || glob[i - 1] === '/';
                const atSegmentEnd = i + 2 === glob.length || glob[i + 2] === '/';
                if (atSegmentStart && atSegmentEnd) {
                    // `**/` matches zero or more folders; a trailing `**` matches everything below.
                    if (glob[i + 2] === '/') {
                        out += '(?:.*/)?';
                        i += 2;
                    } else {
                        out += '.*';
                        i += 1;
                    }
                    continue;
                }
                i += 1;
            }
            out += '[^/]*';
        } else if (char === '?') {
            out += '[^/]';
        } else if (char === '[') {
            const close = glob.indexOf(']', i + 2);
            if (close === -1) {
                out += '\\[';
            } else {
                let set = glob.slice(i + 1, close).replace(/\\/g, '\\\\');
                if (set.startsWith('!')) {
                    set = `^${set.slice(1)}`;
                }
                out += `[${set}]`;
                i = close;
            }
        } else {
            out += escapeRegex(char);
        }
    }
    return out;
}

function escapeRegex(char: string): string {
    return /[.*+?^${}()|[\]\\/]/.test(char) ? `\\${char}` : char;
}

/**
 * Whether a workspace-relative path is ignored by the rules. Callers list one
 * folder at a time, so an entry under an ignored folder is dimmed because its
 * parent was: the check here is per entry, as git applies it.
 */
export function isIgnored(relativePath: string, isDirectory: boolean, rules: readonly IgnoreRule[]): boolean {
    let ignored = false;
    for (const rule of rules) {
        if (rule.directoryOnly && !isDirectory) {
            continue;
        }
        if (rule.regex.test(relativePath)) {
            ignored = !rule.negated;
        }
    }
    return ignored;
}
