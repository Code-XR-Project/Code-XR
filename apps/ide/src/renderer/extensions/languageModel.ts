import type { ContributedLanguage, ContributedSnippet } from '../../shared/extensions.ts';

/**
 * Languages contributed by extensions (#258), as Monaco takes them: the
 * language entry, its `language-configuration.json` with VS Code's string
 * patterns turned into RegExps, and snippets. Pure (Monaco's IndentAction
 * values are passed in), unit-tested in Node.
 */

export interface MonacoLanguageEntry {
    id: string;
    extensions?: string[];
    filenames?: string[];
    filenamePatterns?: string[];
    firstLine?: string;
    aliases?: string[];
    mimetypes?: string[];
}

/** Merges the entries several extensions contribute for one language id. */
export function mergeLanguages(languages: readonly ContributedLanguage[]): { entry: MonacoLanguageEntry; configuration: unknown }[] {
    const byId = new Map<string, { entry: Required<Omit<MonacoLanguageEntry, 'firstLine'>> & { firstLine?: string }; configuration: unknown }>();
    for (const language of languages) {
        const current = byId.get(language.id) ?? { entry: { id: language.id, extensions: [], filenames: [], filenamePatterns: [], aliases: [], mimetypes: [] }, configuration: null };
        const add = (target: string[], values: readonly string[]): void => {
            for (const value of values) {
                if (!target.includes(value)) {
                    target.push(value);
                }
            }
        };
        add(current.entry.extensions, language.extensions);
        add(current.entry.filenames, language.filenames);
        add(current.entry.filenamePatterns, language.filenamePatterns);
        add(current.entry.aliases, language.aliases);
        add(current.entry.mimetypes, language.mimetypes);
        if (language.firstLine && current.entry.firstLine === undefined && safeRegExp(language.firstLine)) {
            current.entry.firstLine = language.firstLine;
        }
        if (current.configuration === null && language.configuration !== null) {
            current.configuration = language.configuration;
        }
        byId.set(language.id, current);
    }
    return [...byId.values()];
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A RegExp from VS Code's `"pattern"` or `{ "pattern", "flags" }`, or null when it does not compile. */
export function safeRegExp(value: unknown): RegExp | null {
    let pattern: unknown = value;
    let flags = '';
    if (typeof value === 'object' && value !== null) {
        pattern = record(value).pattern;
        flags = typeof record(value).flags === 'string' ? String(record(value).flags) : '';
    }
    if (typeof pattern !== 'string' || pattern.length > 10_000) {
        return null;
    }
    try {
        return new RegExp(pattern, flags.replace(/[^gimsuy]/g, ''));
    } catch {
        return null;
    }
}

function pair(value: unknown): [string, string] | null {
    return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string' ? [value[0], value[1]] : null;
}

/** Monaco's `IndentAction` values, passed in so this module needs no Monaco. */
export interface IndentActions {
    None: number;
    Indent: number;
    IndentOutdent: number;
    Outdent: number;
}

/** `language-configuration.json` as a Monaco `LanguageConfiguration` (unknown or invalid parts left out). */
export function toLanguageConfiguration(raw: unknown, indent: IndentActions): Record<string, unknown> {
    const config = record(raw);
    const out: Record<string, unknown> = {};
    const comments = record(config.comments);
    const lineComment = typeof comments.lineComment === 'string' ? comments.lineComment : undefined;
    const blockComment = pair(comments.blockComment);
    if (lineComment || blockComment) {
        out.comments = { ...(lineComment ? { lineComment } : {}), ...(blockComment ? { blockComment } : {}) };
    }
    if (Array.isArray(config.brackets)) {
        out.brackets = config.brackets.map(pair).filter((p): p is [string, string] => p !== null);
    }
    const pairs = (value: unknown): { open: string; close: string; notIn?: string[] }[] => (Array.isArray(value) ? value : []).flatMap((item) => {
        const asPair = pair(item);
        if (asPair) {
            return [{ open: asPair[0], close: asPair[1] }];
        }
        const r = record(item);
        if (typeof r.open === 'string' && typeof r.close === 'string') {
            const notIn = Array.isArray(r.notIn) ? r.notIn.filter((n): n is string => typeof n === 'string') : [];
            return [{ open: r.open, close: r.close, ...(notIn.length ? { notIn } : {}) }];
        }
        return [];
    });
    if (config.autoClosingPairs !== undefined) {
        out.autoClosingPairs = pairs(config.autoClosingPairs);
    }
    if (config.surroundingPairs !== undefined) {
        out.surroundingPairs = pairs(config.surroundingPairs).map(({ open, close }) => ({ open, close }));
    }
    if (typeof config.autoCloseBefore === 'string') {
        out.autoCloseBefore = config.autoCloseBefore;
    }
    const wordPattern = safeRegExp(config.wordPattern);
    if (wordPattern) {
        out.wordPattern = wordPattern;
    }
    const folding = record(config.folding);
    const markers = record(folding.markers);
    const start = safeRegExp(markers.start);
    const end = safeRegExp(markers.end);
    if (start && end || typeof folding.offSide === 'boolean') {
        out.folding = { ...(typeof folding.offSide === 'boolean' ? { offSide: folding.offSide } : {}), ...(start && end ? { markers: { start, end } } : {}) };
    }
    const rules = record(config.indentationRules);
    const increase = safeRegExp(rules.increaseIndentPattern);
    const decrease = safeRegExp(rules.decreaseIndentPattern);
    if (increase && decrease) {
        const next = safeRegExp(rules.indentNextLinePattern);
        const unindented = safeRegExp(rules.unIndentedLinePattern);
        out.indentationRules = {
            increaseIndentPattern: increase,
            decreaseIndentPattern: decrease,
            ...(next ? { indentNextLinePattern: next } : {}),
            ...(unindented ? { unIndentedLinePattern: unindented } : {}),
        };
    }
    if (Array.isArray(config.onEnterRules)) {
        const actions: Record<string, number> = { none: indent.None, indent: indent.Indent, indentOutdent: indent.IndentOutdent, outdent: indent.Outdent };
        out.onEnterRules = config.onEnterRules.flatMap((item) => {
            const rule = record(item);
            const beforeText = safeRegExp(rule.beforeText);
            const action = record(rule.action);
            const indentAction = typeof action.indent === 'string' ? actions[action.indent] : undefined;
            if (!beforeText || indentAction === undefined) {
                return [];
            }
            const afterText = safeRegExp(rule.afterText);
            const previousLineText = safeRegExp(rule.previousLineText);
            return [{
                beforeText,
                ...(afterText ? { afterText } : {}),
                ...(previousLineText ? { previousLineText } : {}),
                action: {
                    indentAction,
                    ...(typeof action.appendText === 'string' ? { appendText: action.appendText } : {}),
                    ...(typeof action.removeText === 'number' ? { removeText: action.removeText } : {}),
                },
            }];
        });
    }
    return out;
}

/** The language a file name belongs to among contributed entries: exact name, then the longest extension, then patterns. */
export function detectLanguage(fileName: string, entries: readonly MonacoLanguageEntry[]): string | null {
    const lower = fileName.toLowerCase();
    for (const entry of entries) {
        if (entry.filenames?.some((name) => name.toLowerCase() === lower)) {
            return entry.id;
        }
    }
    let best: { id: string; length: number } | null = null;
    for (const entry of entries) {
        for (const ext of entry.extensions ?? []) {
            if (lower.endsWith(ext.toLowerCase()) && (!best || ext.length > best.length)) {
                best = { id: entry.id, length: ext.length };
            }
        }
    }
    if (best) {
        return best.id;
    }
    for (const entry of entries) {
        if (entry.filenamePatterns?.some((pattern) => globToRegExp(pattern).test(lower))) {
            return entry.id;
        }
    }
    return null;
}

function globToRegExp(glob: string): RegExp {
    const name = glob.toLowerCase().split('/').pop() ?? '';
    const source = name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${source}$`);
}

/** The snippets of one language (and the `*` ones that apply to all). */
export function snippetsFor(snippets: readonly ContributedSnippet[], languageId: string): ContributedSnippet[] {
    return snippets.filter((snippet) => snippet.language === languageId || snippet.language === '*');
}
