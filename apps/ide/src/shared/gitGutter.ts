/**
 * #175: Git in the editor and the explorer, the pure half. Which lines of a
 * buffer differ from HEAD (the gutter markers), the edit that puts one
 * change back, the inline blame text of a line, and the letter and colour
 * each explorer row gets from the status. Unit-tested in Node; the Monaco
 * and DOM side is renderer/editor/gitDecorations.ts.
 */
import { diffLines, type Hunk } from './lineDiff.ts';
import type { GitChangeLetter, GitStatus } from './git.ts';

export type LineChangeKind = 'added' | 'modified' | 'deleted';

export interface LineChange {
    readonly kind: LineChangeKind;
    /** 1-based lines of the buffer the marker covers; a deletion marks the line above the gap (line 1 when it is at the top). */
    readonly startLine: number;
    readonly endLine: number;
    /** The lines HEAD has in their place (empty for an addition). */
    readonly originalLines: readonly string[];
    readonly hunk: Hunk;
}

/** Above this size (characters, either side) the gutter shows nothing rather than diffing. */
export const MAX_GUTTER_TEXT = 2_000_000;

/** Both texts with `\n` line ends, as `diffLines` compares them. */
export function lineChanges(head: string, buffer: string): LineChange[] {
    if (head.length > MAX_GUTTER_TEXT || buffer.length > MAX_GUTTER_TEXT) {
        return [];
    }
    const original = head.replace(/\r\n?/g, '\n');
    const current = buffer.replace(/\r\n?/g, '\n');
    if (original === current) {
        return [];
    }
    const originalLines = original.split('\n');
    return diffLines(original, current).map((hunk): LineChange => {
        const removed = originalLines.slice(hunk.originalStart, hunk.originalStart + hunk.originalCount);
        if (hunk.lines.length === 0) {
            const line = Math.max(1, hunk.modifiedStart);
            return { kind: 'deleted', startLine: line, endLine: line, originalLines: removed, hunk };
        }
        return {
            kind: hunk.originalCount === 0 ? 'added' : 'modified',
            startLine: hunk.modifiedStart + 1,
            endLine: hunk.modifiedStart + hunk.lines.length,
            originalLines: removed,
            hunk,
        };
    });
}

/** The change whose marker is on `line`, if any. */
export function changeAtLine(changes: readonly LineChange[], line: number): LineChange | undefined {
    return changes.find((change) => line >= change.startLine && line <= change.endLine);
}

export interface TextEdit {
    /** 1-based, Monaco's positions. */
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;
    readonly text: string;
}

/**
 * The edit that gives one change its HEAD lines back, computed on the
 * buffer's lines (`\n`-split). Columns are character counts, the same
 * whatever the model's line ends.
 */
export function revertEdit(bufferLines: readonly string[], change: LineChange): TextEdit {
    const { hunk } = change;
    const lineLength = (line: number): number => (bufferLines[line - 1] ?? '').length;
    const count = bufferLines.length;
    const restored = change.originalLines.join('\n');
    if (hunk.lines.length === 0) {
        // A deletion: insert the HEAD lines at the gap.
        if (hunk.modifiedStart >= count) {
            return { startLine: count, startColumn: lineLength(count) + 1, endLine: count, endColumn: lineLength(count) + 1, text: `\n${restored}` };
        }
        const line = hunk.modifiedStart + 1;
        return { startLine: line, startColumn: 1, endLine: line, endColumn: 1, text: `${restored}\n` };
    }
    const first = hunk.modifiedStart + 1;
    const last = hunk.modifiedStart + hunk.lines.length;
    if (change.originalLines.length > 0) {
        return { startLine: first, startColumn: 1, endLine: last, endColumn: lineLength(last) + 1, text: restored };
    }
    // An addition: remove its lines together with one line break.
    if (last < count) {
        return { startLine: first, startColumn: 1, endLine: last + 1, endColumn: 1, text: '' };
    }
    if (first > 1) {
        return { startLine: first - 1, startColumn: lineLength(first - 1) + 1, endLine: last, endColumn: lineLength(last) + 1, text: '' };
    }
    return { startLine: first, startColumn: 1, endLine: last, endColumn: lineLength(last) + 1, text: '' };
}

// ---------------------------------------------------------------- blame

/** One line of `git blame`, as the renderer gets it. */
export interface GitBlameLine {
    /** 1-based line of the text that was blamed. */
    readonly line: number;
    readonly hash: string;
    readonly author: string;
    readonly authorMail: string;
    /** Seconds since the epoch. */
    readonly authorTime: number;
    readonly summary: string;
    readonly uncommitted: boolean;
}

const UNITS: readonly [number, string][] = [
    [365 * 24 * 3600, 'year'],
    [30 * 24 * 3600, 'month'],
    [7 * 24 * 3600, 'week'],
    [24 * 3600, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
];

/** "3 days ago", "1 hour ago", "just now". */
export function relativeTime(seconds: number, nowMs: number): string {
    const elapsed = Math.max(0, Math.floor(nowMs / 1000) - seconds);
    for (const [size, unit] of UNITS) {
        const count = Math.floor(elapsed / size);
        if (count >= 1) {
            return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
        }
    }
    return 'just now';
}

/** The text after the cursor line: "Ada Lovelace, 3 days ago - Fix the parser". */
export function blameText(line: GitBlameLine, nowMs: number): string {
    if (line.uncommitted) {
        return 'You, uncommitted changes';
    }
    const summary = line.summary.length > 80 ? `${line.summary.slice(0, 79)}...` : line.summary;
    return `${line.author}, ${relativeTime(line.authorTime, nowMs)} - ${summary}`;
}

// ---------------------------------------------------------------- explorer

export type ExplorerGitState = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'conflict';

export interface ExplorerGitDecoration {
    readonly state: ExplorerGitState;
    /** The letter at the end of the row; folders get none, only the colour. */
    readonly letter: string;
}

const STATE_OF: Record<GitChangeLetter, ExplorerGitState> = {
    M: 'modified', T: 'modified', A: 'added', C: 'added', D: 'deleted', U: 'untracked', R: 'renamed', '!': 'conflict',
};
/** When a file is both staged and changed, the stronger one shows. */
const WEIGHT: Record<ExplorerGitState, number> = { conflict: 6, deleted: 5, modified: 4, renamed: 3, added: 2, untracked: 1 };

/**
 * The decoration of every changed file and of each folder above it, from a
 * status. A folder takes the strongest state below it, without a letter.
 */
export function explorerDecorations(status: GitStatus): Map<string, ExplorerGitDecoration> {
    const result = new Map<string, ExplorerGitDecoration>();
    if (status.state !== 'ok') {
        return result;
    }
    const put = (path: string, decoration: ExplorerGitDecoration): void => {
        const existing = result.get(path);
        if (!existing || WEIGHT[decoration.state] > WEIGHT[existing.state]) {
            result.set(path, decoration);
        }
    };
    for (const change of [...status.untracked, ...status.staged, ...status.changes]) {
        const state = STATE_OF[change.letter];
        put(change.path, { state, letter: change.letter });
        const parts = change.path.split('/');
        for (let depth = parts.length - 1; depth > 0; depth -= 1) {
            const folder = parts.slice(0, depth).join('/');
            const existing = result.get(folder);
            if (!existing || (existing.letter === '' && WEIGHT[state] > WEIGHT[existing.state])) {
                result.set(folder, { state, letter: '' });
            }
        }
    }
    return result;
}
