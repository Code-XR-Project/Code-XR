/**
 * The Search view's summary line (#165), as data. Pure, unit-tested in Node.
 */

export interface SearchSummaryInput {
    readonly hasQuery: boolean;
    readonly files: number;
    readonly matches: number;
    readonly done: boolean;
    readonly limitHit: boolean;
    readonly error: string | null;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

export function searchSummary(input: SearchSummaryInput): string {
    if (input.error) {
        return input.error;
    }
    if (!input.hasQuery) {
        return '';
    }
    if (input.matches === 0) {
        return input.done ? 'No results found. Check the include and exclude fields and your ignore files.' : 'Searching…';
    }
    const found = `${plural(input.matches, 'result')} in ${plural(input.files, 'file')}`;
    if (!input.done) {
        return `${found}, searching…`;
    }
    return input.limitHit ? `${found}. The search stopped at its limit: narrow the query to see everything.` : found;
}
