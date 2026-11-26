import { commandLabel, type CommandDefinition } from './commandRegistry.ts';
import { fuzzyMatch } from './fuzzy.ts';

/**
 * What the quick-input box shows for a given text (#18, #164), as data:
 * - `>` then a filter: the commands, recently used first while the filter is empty;
 * - `:` then `line[:column]`: go to that place in the active editor;
 * - `@`: the symbols of the active editor (handed to Monaco's own outline);
 * - anything else: quick open (#164), the workspace's files by fuzzy name,
 *   recently opened first while the text is empty.
 * Pure module, unit-tested in Node; quickInput.ts draws it.
 */

export const COMMAND_PREFIX = '>';
export const LINE_PREFIX = ':';
export const SYMBOL_PREFIX = '@';
/** Quick open shows at most this many matches; the box is not a file browser. */
export const MAX_FILE_RESULTS = 200;

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
    /** A file row: the name its icon is picked from. */
    readonly fileIcon?: string;
}

export type PaletteAction =
    | { readonly kind: 'command'; readonly id: string }
    | { readonly kind: 'line'; readonly line: number; readonly column?: number }
    | { readonly kind: 'pick'; readonly id: string }
    | { readonly kind: 'file'; readonly path: string }
    | { readonly kind: 'symbols' }
    | { readonly kind: 'none' };

export interface PaletteContext {
    readonly commands: readonly CommandDefinition[];
    readonly isEnabled: (id: string) => boolean;
    readonly recent: readonly string[];
    readonly formatKey: (binding: string) => string;
    /** Lines of the active editor, or null without one. */
    readonly lineCount: number | null;
    /** #164: the workspace's files; null while they are being listed or without a folder. */
    readonly files?: readonly string[] | null;
    /** The walk stopped at its limit (shown as a note). */
    readonly filesTruncated?: boolean;
    /** Files opened recently, newest first. */
    readonly recentFiles?: readonly string[];
    /** The file of the active editor (left out of the recent list). */
    readonly activeFile?: string | null;
    readonly hasFolder?: boolean;
}

export interface PaletteView {
    readonly entries: readonly PaletteEntry[];
    readonly action: (entry: PaletteEntry) => PaletteAction;
    /** Shown when `entries` is empty. */
    readonly empty: string;
    /** Run at once, without waiting for Enter (the `@` hand-over to Monaco). */
    readonly immediate?: PaletteAction;
}

export function paletteView(value: string, context: PaletteContext): PaletteView {
    if (value.startsWith(COMMAND_PREFIX)) {
        return commandView(value.slice(COMMAND_PREFIX.length), context);
    }
    if (value.startsWith(LINE_PREFIX)) {
        return lineView(value.slice(LINE_PREFIX.length), context.lineCount);
    }
    if (value.startsWith(SYMBOL_PREFIX)) {
        return context.lineCount === null
            ? { entries: [], action: () => ({ kind: 'none' }), empty: 'Open a file first to see its symbols.' }
            : { entries: [], action: () => ({ kind: 'none' }), empty: '', immediate: { kind: 'symbols' } };
    }
    return fileView(value, context);
}

const HINTS: readonly PaletteEntry[] = [
    hint('help.commands', 'Show and run commands', COMMAND_PREFIX),
    hint('help.line', 'Go to a line', LINE_PREFIX),
    hint('help.symbols', 'Go to a symbol in the editor', SYMBOL_PREFIX),
];

function baseName(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

function dirName(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash < 0 ? '' : path.slice(0, slash);
}

function fileEntry(path: string, highlights: readonly number[], group?: string): PaletteEntry {
    const name = baseName(path);
    const folder = dirName(path);
    return {
        id: path,
        label: name,
        highlights,
        ...(folder ? { description: folder } : {}),
        ...(group ? { group } : {}),
        runnable: true,
        fileIcon: name,
    };
}

/**
 * Scores a file for quick open: a match inside the file name counts far more
 * than one spread over the folders, so "edgrp" finds `editorGroup.ts` before
 * a long path that happens to contain the letters. Returns the score and the
 * highlights in the name (none when only the path matched).
 */
export function scoreFile(query: string, path: string): { score: number; highlights: readonly number[] } | null {
    const name = baseName(path);
    // The query typed as is, inside the name ("test" in "smoke.test.ts"),
    // beats letters picked across word starts ("terminalService").
    const needle = query.replace(/\s+/g, '').toLowerCase();
    const at = name.toLowerCase().indexOf(needle);
    if (needle !== '' && at >= 0) {
        const positions = Array.from({ length: needle.length }, (_, index) => at + index);
        return { score: 200 + needle.length * 2 + (at === 0 ? 20 : 0) - name.length * 0.01, highlights: positions };
    }
    const inName = fuzzyMatch(query, name);
    if (inName) {
        return { score: inName.score + 100, highlights: inName.positions };
    }
    // "src/edgrp" or "renderer edgrp": the query may name folders too.
    const inPath = fuzzyMatch(query, path);
    return inPath ? { score: inPath.score, highlights: [] } : null;
}

function fileView(value: string, context: PaletteContext): PaletteView {
    const query = value.trim();
    const action = (entry: PaletteEntry): PaletteAction => (entry.runnable ? { kind: 'file', path: entry.id } : { kind: 'none' });
    if (!context.hasFolder) {
        return { entries: query === '' ? HINTS : [], action, empty: 'Open a folder to search its files.' };
    }
    if (query === '') {
        const recent = (context.recentFiles ?? []).filter((path) => path !== context.activeFile);
        const entries = recent.map((path, index) => fileEntry(path, [], index === 0 ? 'recently opened' : undefined));
        return { entries: [...entries, ...HINTS], action, empty: '' };
    }
    const files = context.files;
    if (!files) {
        return { entries: [], action, empty: 'Listing the files of the folder…' };
    }
    const recentRank = new Map((context.recentFiles ?? []).map((path, index) => [path, index]));
    const matches: { path: string; score: number; highlights: readonly number[] }[] = [];
    for (const path of files) {
        const match = scoreFile(query, path);
        if (match) {
            // A recently opened file wins a close call.
            const rank = recentRank.get(path);
            matches.push({ path, score: match.score + (rank === undefined ? 0 : 5 - Math.min(rank, 5) * 0.5), highlights: match.highlights });
        }
    }
    matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
    const entries = matches.slice(0, MAX_FILE_RESULTS).map((match) => fileEntry(match.path, match.highlights));
    const note = context.filesTruncated ? ' (only the first files of this very large folder were searched)' : '';
    return { entries, action, empty: `No matching files${note}` };
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
