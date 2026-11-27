import type { AgentSessionState, PromptAttachment, SlashCommandView, TranscriptItem } from '../../shared/agentSession.ts';
import { diffLines, splitLines } from '../../shared/lineDiff.ts';

/**
 * Pure helpers of the agent-first chat (AF3): what the composer suggests,
 * how a tool card summarises itself, how a diff is drawn as lines. No DOM, so
 * they are unit-tested in Node and the chat view stays a thin renderer.
 */

/** The slash commands that match what the person typed (`/` at the start of the message). */
export function slashSuggestions(text: string, commands: readonly SlashCommandView[], limit = 8): SlashCommandView[] {
    const match = /^\/([\w:.-]*)$/.exec(text);
    if (!match) {
        return [];
    }
    const typed = (match[1] ?? '').toLowerCase();
    return commands
        .filter((command) => command.name.toLowerCase().startsWith(typed))
        .slice(0, limit);
}

/** A tool card's one-line status for screen readers and the collapsed card. */
export function toolStatusLabel(status: Extract<TranscriptItem, { kind: 'tool' }>['status']): string {
    switch (status) {
        case 'pending':
            return 'Waiting';
        case 'in_progress':
            return 'Running';
        case 'completed':
            return 'Done';
        case 'failed':
            return 'Failed';
    }
}

/** SVG path data (24x24) per tool kind. */
export const TOOL_ICONS: Readonly<Record<Extract<TranscriptItem, { kind: 'tool' }>['toolKind'], string>> = {
    read: 'M4 4h11l5 5v11H4zM14 4v6h6',
    edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
    delete: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    move: 'M4 12h14M13 6l6 6-6 6',
    search: 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM15.5 15.5L21 21',
    execute: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
    think: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5V16h8v-2.5A6 6 0 0 0 12 3z',
    fetch: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
    switch_mode: 'M7 7h13M17 4l3 3-3 3M17 17H4M7 14l-3 3 3 3',
    other: 'M12 8v4M12 16h.01M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z',
};

export type DiffLine = { readonly kind: 'context' | 'add' | 'remove' | 'gap'; readonly text: string };

/**
 * The lines of a compact unified diff: changed lines with `context` lines
 * around them, and a `gap` line where unchanged lines are skipped. Capped so
 * a rewritten 5,000-line file does not freeze the chat.
 */
export function diffLinesForCard(oldText: string | null, newText: string, context = 2, maxLines = 400): DiffLine[] {
    const before = oldText ?? '';
    const lines: DiffLine[] = [];
    if (oldText === null) {
        for (const text of splitLines(newText)) {
            lines.push({ kind: 'add', text });
        }
        return cap(lines, maxLines);
    }
    const original = splitLines(before);
    const hunks = diffLines(before, newText);
    let cursor = 0;
    for (const hunk of hunks) {
        const start = Math.max(cursor, hunk.originalStart - context);
        if (start > cursor && lines.length > 0) {
            lines.push({ kind: 'gap', text: '' });
        } else if (start > 0 && lines.length === 0) {
            lines.push({ kind: 'gap', text: '' });
        }
        for (let index = start; index < hunk.originalStart; index += 1) {
            lines.push({ kind: 'context', text: original[index] ?? '' });
        }
        for (const text of original.slice(hunk.originalStart, hunk.originalStart + hunk.originalCount)) {
            lines.push({ kind: 'remove', text });
        }
        for (const text of hunk.lines) {
            lines.push({ kind: 'add', text });
        }
        const after = hunk.originalStart + hunk.originalCount;
        const end = Math.min(original.length, after + context);
        for (let index = after; index < end; index += 1) {
            lines.push({ kind: 'context', text: original[index] ?? '' });
        }
        cursor = end;
    }
    if (cursor < original.length && lines.length > 0) {
        lines.push({ kind: 'gap', text: '' });
    }
    return cap(lines, maxLines);
}

function cap(lines: DiffLine[], maxLines: number): DiffLine[] {
    if (lines.length <= maxLines) {
        return lines;
    }
    return [...lines.slice(0, maxLines), { kind: 'gap', text: `${lines.length - maxLines} more lines` }];
}

/** Added and removed line counts of a change, for the "+3 -1" labels. */
export function changeCounts(oldText: string | null, newText: string): { readonly added: number; readonly removed: number } {
    if (oldText === null) {
        return { added: splitLines(newText).length, removed: 0 };
    }
    let added = 0;
    let removed = 0;
    for (const hunk of diffLines(oldText, newText)) {
        added += hunk.lines.length;
        removed += hunk.originalCount;
    }
    return { added, removed };
}

/** A path for display: relative to the project when it is inside it, with forward slashes. */
export function displayPath(path: string, root: string | null): string {
    const normalized = path.replace(/\\/g, '/');
    if (!root) {
        return normalized;
    }
    const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? normalized.slice(base.length + 1) : normalized;
}

/** What the composer's send button does right now. */
export function composerAction(state: Pick<AgentSessionState, 'status'>, text: string): 'send' | 'queue' | 'stop' | 'none' {
    const running = state.status === 'running' || state.status === 'awaiting';
    if (text.trim()) {
        return running ? 'queue' : 'send';
    }
    return running ? 'stop' : 'none';
}

/** The files a turn changed, from its tool cards' diffs, newest version of each file last wins. */
export function turnChanges(items: readonly TranscriptItem[], fromIndex: number): { readonly path: string; readonly oldText: string | null; readonly newText: string }[] {
    const byPath = new Map<string, { path: string; oldText: string | null; newText: string }>();
    for (const item of items.slice(fromIndex)) {
        if (item.kind !== 'tool') {
            continue;
        }
        for (const block of item.content) {
            if (block.type !== 'diff') {
                continue;
            }
            const previous = byPath.get(block.path);
            byPath.set(block.path, { path: block.path, oldText: previous ? previous.oldText : block.oldText, newText: block.newText });
        }
    }
    return [...byPath.values()];
}

/** Index of the last user message (the start of the current turn), or -1. */
export function lastUserIndex(items: readonly TranscriptItem[]): number {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        if (items[index]?.kind === 'user') {
            return index;
        }
    }
    return -1;
}

/** The label of an attachment chip. */
export function attachmentLabel(item: PromptAttachment): string {
    return item.kind === 'selection' && item.startLine !== undefined ? `${item.path}:${item.startLine}-${item.endLine ?? item.startLine}` : item.path;
}

/** "12k / 200k" for the context meter. */
export function formatTokens(used: number, size: number): string {
    const short = (value: number): string => (value >= 1_000_000 ? `${Math.round(value / 100_000) / 10}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value));
    return `${short(used)} / ${short(size)}`;
}
