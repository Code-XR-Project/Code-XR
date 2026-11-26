/**
 * Fuzzy matching for the command palette and quick open (#18, #164): the
 * query's characters must appear in order in the text, case-insensitively.
 * The score rewards consecutive characters and matches at word starts
 * (after a space, `/`, `.`, `_`, `-`, `:` or a lower-to-upper case change),
 * so "edgrp" ranks "editor/editorGroup.ts" high and "sv al" finds
 * "File: Save All". Pure module, unit-tested in Node.
 */

export interface FuzzyMatch {
    readonly score: number;
    /** Indexes of the matched characters in the text, ascending. */
    readonly positions: readonly number[];
}

const SEPARATORS = new Set([' ', '/', '\\', '.', '_', '-', ':']);

function isWordStart(text: string, index: number): boolean {
    if (index === 0) {
        return true;
    }
    const previous = text[index - 1] ?? '';
    const current = text[index] ?? '';
    if (SEPARATORS.has(previous)) {
        return true;
    }
    return previous === previous.toLowerCase() && previous !== previous.toUpperCase()
        && current === current.toUpperCase() && current !== current.toLowerCase();
}

/**
 * Matches `query` against `text`. Spaces in the query are ignored (they only
 * help people type), so "sv al" matches like "sval". Returns null when the
 * text does not contain the query's characters in order. An empty query
 * matches everything with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
    const needle = query.replace(/\s+/g, '').toLowerCase();
    if (needle === '') {
        return { score: 0, positions: [] };
    }
    const haystack = text.toLowerCase();
    // Greedy pass from each candidate start, keeping the best-scoring run.
    // Texts are short (labels, paths), so trying each start is cheap.
    let best: FuzzyMatch | null = null;
    let start = haystack.indexOf(needle[0] ?? '');
    while (start !== -1) {
        const match = matchFrom(needle, haystack, text, start);
        if (!match) {
            break; // A later start cannot fit the query either.
        }
        if (!best || match.score > best.score) {
            best = match;
        }
        start = haystack.indexOf(needle[0] ?? '', start + 1);
    }
    return best;
}

function matchFrom(needle: string, haystack: string, text: string, start: number): FuzzyMatch | null {
    const positions: number[] = [];
    let score = 0;
    let textIndex = start;
    let previous = -2;
    for (let n = 0; n < needle.length; n++) {
        const char = needle[n] ?? '';
        // Prefer the next word start that holds this character, as long as
        // the rest of the query still fits after it.
        let index = haystack.indexOf(char, textIndex);
        if (index === -1) {
            return null;
        }
        if (index !== previous + 1) {
            for (let probe = index; probe !== -1; probe = haystack.indexOf(char, probe + 1)) {
                if (isWordStart(text, probe) && fits(needle, n + 1, haystack, probe + 1)) {
                    index = probe;
                    break;
                }
            }
        }
        let charScore = 1;
        if (index === previous + 1) {
            charScore += 5;
        }
        if (isWordStart(text, index)) {
            charScore += 8;
        }
        score += charScore;
        positions.push(index);
        previous = index;
        textIndex = index + 1;
    }
    // Shorter texts and earlier matches win ties.
    score -= Math.min(positions[0] ?? 0, 20) * 0.1;
    score -= text.length * 0.01;
    return { score, positions };
}

function fits(needle: string, from: number, haystack: string, at: number): boolean {
    let position = at;
    for (let n = from; n < needle.length; n++) {
        position = haystack.indexOf(needle[n] ?? '', position);
        if (position === -1) {
            return false;
        }
        position++;
    }
    return true;
}

/** Splits `text` into runs for display, marking the matched characters. */
export function highlightRuns(text: string, positions: readonly number[]): { text: string; matched: boolean }[] {
    const marked = new Set(positions);
    const runs: { text: string; matched: boolean }[] = [];
    for (let index = 0; index < text.length; index++) {
        const matched = marked.has(index);
        const last = runs.at(-1);
        if (last && last.matched === matched) {
            last.text += text[index];
        } else {
            runs.push({ text: text[index] ?? '', matched });
        }
    }
    return runs;
}
