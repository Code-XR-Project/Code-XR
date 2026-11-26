/**
 * Line diff for agent edits (epic #189, A8): the hunks a proposed change is
 * made of, so the person can accept or reject each one. Pure, used by the
 * renderer's review and by tests.
 */

export interface Hunk {
    /** First replaced line of the original, 0-based. */
    readonly originalStart: number;
    /** How many original lines the hunk replaces (0 for a pure insertion). */
    readonly originalCount: number;
    /** First line of the hunk in the proposed text, 0-based. */
    readonly modifiedStart: number;
    /** The lines that take their place (empty for a pure deletion). */
    readonly lines: readonly string[];
}

/** Above this many cells the middle part is one hunk instead of an exact diff. */
const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
    return text.split('\n');
}

/** The hunks that turn `original` into `proposed`, in order. */
export function diffLines(original: string, proposed: string): Hunk[] {
    const a = splitLines(original);
    const b = splitLines(proposed);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) {
        start += 1;
    }
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA -= 1;
        endB -= 1;
    }
    const n = endA - start;
    const m = endB - start;
    if (n === 0 && m === 0) {
        return [];
    }
    if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) {
        return [{ originalStart: start, originalCount: n, modifiedStart: start, lines: b.slice(start, endB) }];
    }
    // Longest common subsequence over the middle, from the end so the walk goes forwards.
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            table[i * width + j] = a[start + i] === b[start + j]
                ? (table[(i + 1) * width + j + 1] ?? 0) + 1
                : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
        }
    }
    const hunks: Hunk[] = [];
    let i = 0;
    let j = 0;
    let open: { originalStart: number; modifiedStart: number; originalCount: number; lines: string[] } | null = null;
    const close = (): void => {
        if (open) {
            hunks.push(open);
            open = null;
        }
    };
    while (i < n || j < m) {
        if (i < n && j < m && a[start + i] === b[start + j]) {
            close();
            i += 1;
            j += 1;
            continue;
        }
        open ??= { originalStart: start + i, modifiedStart: start + j, originalCount: 0, lines: [] };
        if (j < m && (i >= n || (table[i * width + j + 1] ?? 0) >= (table[(i + 1) * width + j] ?? 0))) {
            open.lines.push(b[start + j] ?? '');
            j += 1;
        } else {
            open.originalCount += 1;
            i += 1;
        }
    }
    close();
    return hunks;
}

/** The original with only the `accepted` hunks (by index) applied. */
export function applyHunks(original: string, hunks: readonly Hunk[], accepted: ReadonlySet<number>): string {
    const lines = splitLines(original);
    const out: string[] = [];
    let cursor = 0;
    hunks.forEach((hunk, index) => {
        out.push(...lines.slice(cursor, hunk.originalStart));
        if (accepted.has(index)) {
            out.push(...hunk.lines);
        } else {
            out.push(...lines.slice(hunk.originalStart, hunk.originalStart + hunk.originalCount));
        }
        cursor = hunk.originalStart + hunk.originalCount;
    });
    out.push(...lines.slice(cursor));
    return out.join('\n');
}

/** Gives `proposed` the original's line endings, so a CRLF file stays CRLF. */
export function matchLineEndings(original: string, proposed: string): string {
    const lf = proposed.replace(/\r\n/g, '\n');
    return original.includes('\r\n') ? lf.replace(/\n/g, '\r\n') : lf;
}
