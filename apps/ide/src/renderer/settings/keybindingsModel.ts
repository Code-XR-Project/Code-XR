import { canonicalKeybinding, keysChanged, menuAccelerator, MENU_KEYBINDINGS } from '../../shared/keybindings.ts';

/**
 * The Keyboard Shortcuts view (#18, part 3) as data: which commands a filter
 * shows, what keys each has and whether the user changed them, which other
 * commands a new key would take from, and what a key recorder has captured.
 * Pure, unit-tested in Node.
 */

export interface KeybindingCommand {
    readonly id: string;
    readonly title: string;
    readonly category?: string;
}

/** What the view needs from the command registry. */
export interface KeybindingSource {
    list(): readonly KeybindingCommand[];
    keybindings(id: string): readonly string[];
    defaultKeybindings(id: string): readonly string[];
}

export interface KeybindingRow {
    readonly id: string;
    readonly label: string;
    readonly category: string;
    readonly title: string;
    /** The keys in force, raw (accelerators). */
    readonly keys: readonly string[];
    /** The same keys as the user reads them ("Ctrl+Shift+P"). */
    readonly labels: readonly string[];
    readonly defaults: readonly string[];
    /** The keys differ from the built-in ones (the row can be reset). */
    readonly modified: boolean;
}

/**
 * Every row whose label, ID or keys hold every word of the filter, sorted by
 * label. Keys match as written or as shown, so `ctrl+s` finds Save.
 */
export function keybindingRows(source: KeybindingSource, filter: string, formatKey: (key: string) => string): KeybindingRow[] {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const rows: KeybindingRow[] = [];
    for (const command of source.list()) {
        const keys = source.keybindings(command.id);
        const defaults = source.defaultKeybindings(command.id);
        const labels = keys.map(formatKey);
        const category = command.category ?? '';
        const label = category ? `${category}: ${command.title}` : command.title;
        const haystack = `${label} ${command.id} ${keys.join(' ')} ${labels.join(' ')}`.toLowerCase();
        if (!terms.every((term) => haystack.includes(term))) {
            continue;
        }
        rows.push({ id: command.id, label, category, title: command.title, keys, labels, defaults, modified: keysChanged(defaults, keys) });
    }
    return rows.sort((a, b) => a.label.localeCompare(b.label));
}

/** The commands other than `id` that hold `key` now (they lose it when `id` takes it). */
export function conflictsOf(source: KeybindingSource, id: string, key: string, platform: string): KeybindingCommand[] {
    const wanted = canonicalKeybinding(key, platform);
    return source.list().filter((command) => command.id !== id
        && source.keybindings(command.id).some((existing) => canonicalKeybinding(existing, platform) === wanted));
}

/**
 * The accelerators the application menu should listen for, by command ID:
 * each menu-owned command's first single-stroke key, or null when it has
 * none (removed, or only a chord). `suspended` gives null for all, which
 * frees every menu key while the user records a new one.
 */
export function menuAccelerators(source: Pick<KeybindingSource, 'keybindings'>, suspended = false): Record<string, string | null> {
    return Object.fromEntries(Object.keys(MENU_KEYBINDINGS).map((id) => [id, suspended ? null : menuAccelerator(source.keybindings(id)) ?? null]));
}

/**
 * A key recorder: each stroke the user presses, up to two (a chord); a third
 * starts over. `Enter` accepts and `Escape` cancels, so neither can be
 * recorded alone (with a modifier they can).
 */
export interface KeyRecorder {
    readonly strokes: readonly string[];
    /** The recorded keybinding ("CmdOrCtrl+K Z"), or null before the first stroke. */
    value(): string | null;
    press(stroke: string): void;
    clear(): void;
}

export function createKeyRecorder(): KeyRecorder {
    let strokes: string[] = [];
    return {
        get strokes() { return strokes; },
        value: () => (strokes.length === 0 ? null : strokes.join(' ')),
        press(stroke) {
            strokes = strokes.length >= 2 ? [stroke] : [...strokes, stroke];
        },
        clear() {
            strokes = [];
        },
    };
}
