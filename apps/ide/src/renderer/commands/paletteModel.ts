import { commandLabel, type CommandDefinition } from './commandRegistry.ts';
import { fuzzyMatch } from './fuzzy.ts';

/**
 * What the quick-input box shows for a given text (#18, #164), as data:
 * - `>` then a filter: the commands, recently used first while the filter is empty;
 * - `:` then `line[:column]`: go to that place in the active editor;
 * - anything else: a hint, until quick open (#164) lists files here.
 * Pure module, unit-tested in Node; quickInput.ts draws it.
 */

export const COMMAND_PREFIX = '>';
export const LINE_PREFIX = ':';

export interface PaletteEntry {
    readonly id: string;
    readonly label: string;
    /** Indexes of `label`'s matched characters. */
    readonly highlights: readonly number[];
    readonly description?: string;
    readonly keybinding?: string;
    /** "recently used" for the first group while the filter is empty. */
    readonly group?: string;
    /** False for a hint row, which runs nothing on Enter. */
    readonly runnable: boolean;
    /** A hint row's text to put in the field on Enter (its prefix). */
    readonly fill?: string;
}

export type PaletteAction =
    | { readonly kind: 'command'; readonly id: string }
    | { readonly kind: 'line'; readonly line: number; readonly column?: number }
    | { readonly kind: 'pick'; readonly id: string }
    | { readonly kind: 'none' };

export interface PaletteContext {
    readonly commands: readonly CommandDefinition[];
    readonly isEnabled: (id: string) => boolean;
    readonly recent: readonly string[];
    readonly formatKey: (binding: string) => string;
    /** Lines of the active editor, or null without one. */
    readonly lineCount: number | null;
}

export interface PaletteView {
    readonly entries: readonly PaletteEntry[];
    readonly action: (entry: PaletteEntry) => PaletteAction;
    /** Shown when `entries` is empty. */
    readonly empty: string;
}

export function paletteView(value: string, context: PaletteContext): PaletteView {
    if (value.startsWith(COMMAND_PREFIX)) {
        return commandView(value.slice(COMMAND_PREFIX.length), context);
    }
    if (value.startsWith(LINE_PREFIX)) {
        return lineView(value.slice(LINE_PREFIX.length), context.lineCount);
    }
    return {
        entries: [
            hint('help.commands', 'Show and run commands', COMMAND_PREFIX),
            hint('help.line', 'Go to a line', LINE_PREFIX),
        ],
        action: () => ({ kind: 'none' }),
        empty: '',
    };
}

function hint(id: string, label: string, prefix: string): PaletteEntry {
    return { id, label, highlights: [], description: `type ${prefix}`, runnable: false, fill: prefix };
}

function commandView(filter: string, context: PaletteContext): PaletteView {
    const query = filter.trim();
    const available = context.commands.filter((command) => context.isEnabled(command.id));
    const toEntry = (command: CommandDefinition, highlights: readonly number[], group?: string): PaletteEntry => ({
        id: command.id,
        label: commandLabel(command),
        highlights,
        ...(command.keybinding ? { keybinding: context.formatKey(command.keybinding) } : {}),
        ...(group ? { group } : {}),
        runnable: true,
    });
    let entries: PaletteEntry[];
    if (query === '') {
        const byId = new Map(available.map((command) => [command.id, command]));
        const recent = context.recent.flatMap((id) => {
            const command = byId.get(id);
            return command ? [command] : [];
        });
        const recentIds = new Set(recent.map((command) => command.id));
        const rest = available
            .filter((command) => !recentIds.has(command.id))
            .sort((a, b) => commandLabel(a).localeCompare(commandLabel(b)));
        entries = [
            ...recent.map((command, index) => toEntry(command, [], index === 0 ? 'recently used' : undefined)),
            ...rest.map((command, index) => toEntry(command, [], index === 0 && recent.length > 0 ? 'other commands' : undefined)),
        ];
    } else {
        entries = available
            .flatMap((command) => {
                const label = commandLabel(command);
                const match = fuzzyMatch(query, label) ?? fuzzyMatch(query, command.id);
                if (!match) {
                    return [];
                }
                // A match on the ID is real but shows no highlights in the label.
                const highlights = fuzzyMatch(query, label)?.positions ?? [];
                return [{ command, score: match.score, highlights }];
            })
            .sort((a, b) => b.score - a.score || commandLabel(a.command).localeCompare(commandLabel(b.command)))
            .map(({ command, highlights }) => toEntry(command, highlights));
    }
    return {
        entries,
        action: (entry) => (entry.runnable ? { kind: 'command', id: entry.id } : { kind: 'none' }),
        empty: 'No matching commands',
    };
}

/** Parses "120", "120:5", "120,5"; null when it is not a position. */
export function parseLinePosition(text: string): { line: number; column?: number } | null {
    const match = /^\s*(\d+)\s*(?:[:,]\s*(\d+)\s*)?$/.exec(text);
    if (!match) {
        return null;
    }
    const line = Number(match[1]);
    const column = match[2] !== undefined ? Number(match[2]) : undefined;
    if (line < 1 || (column !== undefined && column < 1)) {
        return null;
    }
    return column !== undefined ? { line, column } : { line };
}

function lineView(text: string, lineCount: number | null): PaletteView {
    if (lineCount === null) {
        return { entries: [], action: () => ({ kind: 'none' }), empty: 'Open a file first to go to a line.' };
    }
    const position = parseLinePosition(text);
    if (!position) {
        return {
            entries: [],
            action: () => ({ kind: 'none' }),
            empty: `Type a line number between 1 and ${lineCount}, optionally followed by :column.`,
        };
    }
    const line = Math.min(position.line, lineCount);
    const label = position.column !== undefined ? `Go to line ${line}, column ${position.column}` : `Go to line ${line}`;
    return {
        entries: [{ id: 'goto.line', label, highlights: [], runnable: true }],
        action: () => (position.column !== undefined ? { kind: 'line', line, column: position.column } : { kind: 'line', line }),
        empty: '',
    };
}

/** One choice of a picker (#166: language mode, line endings, indentation). */
export interface PickItem {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}

/**
 * A picker's view: the items matching the text (fuzzy, best first), or all of
 * them in their own order while the text is empty. Enter picks the item.
 */
export function pickListView(items: readonly PickItem[], value: string, empty = 'No matching items'): PaletteView {
    const query = value.trim();
    const entries: PaletteEntry[] = query === ''
        ? items.map((item) => ({ id: item.id, label: item.label, highlights: [], ...(item.description ? { description: item.description } : {}), runnable: true }))
        : items
            .flatMap((item, order) => {
                const match = fuzzyMatch(query, item.label);
                return match ? [{ item, order, match }] : [];
            })
            .sort((a, b) => b.match.score - a.match.score || a.order - b.order)
            .map(({ item, match }) => ({
                id: item.id,
                label: item.label,
                highlights: match.positions,
                ...(item.description ? { description: item.description } : {}),
                runnable: true,
            }));
    return { entries, action: (entry) => ({ kind: 'pick', id: entry.id }), empty };
}
