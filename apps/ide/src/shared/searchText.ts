import type { SearchMatch, SearchQuery } from './api.ts';

/**
 * The text side of workspace search (#165), shared by the main process (which
 * searches and replaces files on disk) and the renderer (which replaces in
 * open editors, so the change is undoable and unsaved text is not bypassed).
 * Pure functions, unit-tested in Node.
 */

/** Matches kept per file; the rest are counted but not listed. */
export const MAX_MATCHES_PER_FILE = 1_000;
/** Characters of the line shown before and after the match. */
const PREVIEW_BEFORE = 40;
const PREVIEW_AFTER = 160;

export interface CompiledQuery {
    readonly regex: RegExp;
}

/** The query as a global regular expression, or the reason it is not one. */
export function compileQuery(query: SearchQuery): CompiledQuery | { readonly error: string } {
    if (query.pattern === '') {
        return { error: 'Type something to search for.' };
    }
    let source = query.isRegex ? query.pattern : query.pattern.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    if (query.wholeWord) {
        source = `\\b(?:${source})\\b`;
    }
    try {
        return { regex: new RegExp(source, query.matchCase ? 'g' : 'gi') };
    } catch (error) {
        return { error: `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}` };
    }
}

/** Every match of `regex` in `text`, line by line, at most `limit`. Columns are 1-based. */
export function findInText(text: string, regex: RegExp, limit = MAX_MATCHES_PER_FILE): { matches: SearchMatch[]; total: number } {
    const matches: SearchMatch[] = [];
    let total = 0;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
        const line = (lines[index] ?? '').replace(/\r$/, '');
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
            const length = match[0].length;
            if (length === 0) {
                // An empty match ("a*", "^") finds nothing to show; step past it.
                regex.lastIndex++;
                if (regex.lastIndex > line.length) { break; }
                continue;
            }
            total++;
            if (matches.length < limit) {
                matches.push(preview(line, index + 1, match.index, length));
            }
        }
    }
    return { matches, total };
}

function preview(line: string, lineNumber: number, start: number, length: number): SearchMatch {
    const from = Math.max(0, start - PREVIEW_BEFORE);
    // Do not cut a line just before the match when only a few characters precede it.
    const cutStart = from <= 8 ? 0 : from;
    const to = Math.min(line.length, start + length + PREVIEW_AFTER);
    const text = (cutStart > 0 ? '…' : '') + line.slice(cutStart, to).replace(/\t/g, ' ');
    const offset = cutStart > 0 ? 1 - cutStart : 0;
    return {
        line: lineNumber,
        column: start + 1,
        length,
        preview: text.trimEnd(),
        previewStart: start + offset,
    };
}

/**
 * Replaces every match in `text`. A literal search replaces with the literal
 * text; a regular expression may use `$1`, `$&`… as in JavaScript.
 */
export function replaceInText(text: string, regex: RegExp, replacement: string, isRegex: boolean): { text: string; count: number } {
    let count = 0;
    const replaced = text.split('\n').map((line) => {
        const carriage = line.endsWith('\r');
        const body = carriage ? line.slice(0, -1) : line;
        regex.lastIndex = 0;
        const result = body.replace(regex, (...args: unknown[]) => {
            const whole = String(args[0]);
            if (whole === '') {
                return whole; // Empty matches are not listed, so they are not replaced either.
            }
            count++;
            return isRegex ? expandReplacement(replacement, args) : replacement;
        });
        return carriage ? `${result}\r` : result;
    }).join('\n');
    return { text: replaced, count };
}

/**
 * Expands `$$`, `$&`, `$1`..`$99` and `$<name>` for one match, from the
 * arguments String.prototype.replace hands its callback:
 * (match, p1..pn, offset, string, groups?).
 */
export function expandReplacement(replacement: string, args: readonly unknown[]): string {
    const last = args[args.length - 1];
    const hasGroups = typeof last === 'object' && last !== null;
    const groups = hasGroups ? last as Record<string, string | undefined> : undefined;
    const captures = args.slice(1, args.length - (hasGroups ? 3 : 2)).map((value) => (value === undefined ? '' : String(value)));
    return replacement.replace(/\$(\$|&|<([^>]*)>|(\d{1,2}))/g, (token: string, kind: string, name: string | undefined, digits: string | undefined) => {
        if (kind === '$') { return '$'; }
        if (kind === '&') { return String(args[0]); }
        if (name !== undefined) { return groups ? groups[name] ?? '' : token; }
        if (digits !== undefined) {
            const two = Number(digits);
            if (two >= 1 && two <= captures.length) { return captures[two - 1] ?? ''; }
            const one = Number(digits[0]);
            if (digits.length === 2 && one >= 1 && one <= captures.length) { return (captures[one - 1] ?? '') + digits[1]; }
        }
        return token;
    });
}
