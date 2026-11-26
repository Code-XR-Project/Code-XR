import { stripJsonComments } from './settings.ts';

/**
 * User keybindings (#18, part 3): the file format, its validation and how it
 * combines with the built-in keys. Shared by the main process (which stores
 * the file and rebuilds the menu) and the renderer (which resolves the keys
 * and listens for them). Pure module, unit-tested in Node.
 *
 * The file is `keybindings.json` in the IDE's user-data folder, an array of
 * rules read in order, as in VS Code:
 *
 *     [
 *         { "key": "CmdOrCtrl+Shift+S", "command": "file.saveAll" },
 *         { "key": "CmdOrCtrl+Alt+S", "command": "-file.saveAll" },
 *         { "command": "-view.toggleZenMode" }
 *     ]
 *
 * A rule adds a key to a command; a `-` before the command removes one of its
 * built-in keys (all of them when `key` is left out). Keys are Electron
 * accelerators, case-insensitive (`ctrl+shift+s` works too), and a chord is
 * two strokes separated by a space. A key a rule adds is taken away from any
 * other command that had it, so the user's choice always wins.
 */

export interface UserKeybinding {
    /** The key; may be absent only on a removal (`-command`). */
    readonly key?: string;
    /** A command ID, or `-` and a command ID to remove a key. */
    readonly command: string;
}

/** The menu's accelerators, by command ID: the defaults of the commands the application menu listens for. */
export const MENU_KEYBINDINGS: Readonly<Record<string, string>> = {
    'workbench.commandPalette': 'CmdOrCtrl+Shift+P',
    'editor.goToLine': 'Ctrl+G',
    'workbench.quickOpen': 'CmdOrCtrl+P',
    'editor.goToSymbol': 'CmdOrCtrl+Shift+O',
    'workspace.openFolder': 'CmdOrCtrl+O',
    'file.newFile': 'CmdOrCtrl+N',
    'file.save': 'CmdOrCtrl+S',
    'file.saveAll': 'CmdOrCtrl+Alt+S',
    'editor.close': 'CmdOrCtrl+W',
    'terminal.toggle': 'Ctrl+`',
    'terminal.new': 'Ctrl+Shift+`',
    'view.toggleSideBar': 'CmdOrCtrl+B',
    'view.togglePanel': 'CmdOrCtrl+J',
    'workbench.openSettings': 'CmdOrCtrl+,',
};

export const KEYBINDINGS_FILE_NAME = 'keybindings.json';
export const MAX_USER_KEYBINDINGS = 500;

const COMMAND_PATTERN = /^-?[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/;

const MODIFIERS: Readonly<Record<string, string>> = {
    cmdorctrl: 'cmdorctrl', commandorcontrol: 'cmdorctrl',
    ctrl: 'ctrl', control: 'ctrl',
    cmd: 'cmd', command: 'cmd', super: 'cmd', meta: 'cmd',
    alt: 'alt', option: 'alt',
    shift: 'shift',
};

const NAMED_KEYS: Readonly<Record<string, string>> = {
    TAB: 'TAB', ENTER: 'ENTER', RETURN: 'ENTER', SPACE: 'SPACE', ESC: 'ESCAPE', ESCAPE: 'ESCAPE',
    BACKSPACE: 'BACKSPACE', DELETE: 'DELETE', INSERT: 'INSERT', HOME: 'HOME', END: 'END',
    PAGEUP: 'PAGEUP', PAGEDOWN: 'PAGEDOWN', UP: 'UP', DOWN: 'DOWN', LEFT: 'LEFT', RIGHT: 'RIGHT', PLUS: '+',
};

/**
 * One stroke in a canonical form for comparing ("ctrl+shift+S"), or null if
 * it is not a valid accelerator. `CmdOrCtrl` becomes the platform's key, so
 * `CmdOrCtrl+S` and `Ctrl+S` are the same key on Windows and Linux.
 */
export function canonicalStroke(stroke: string, platform: string): string | null {
    const parts = stroke.split('+');
    let key = parts.pop() ?? '';
    if (key === '' && parts.at(-1) === '') {
        parts.pop();
        key = '+';
    }
    if (key === '') {
        return null;
    }
    const upper = key.toUpperCase();
    let canonicalKey: string | undefined;
    if (upper.length === 1 && upper > ' ' && upper <= '~') {
        canonicalKey = upper;
    } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(upper)) {
        canonicalKey = upper;
    } else {
        canonicalKey = NAMED_KEYS[upper];
    }
    if (canonicalKey === undefined) {
        return null;
    }
    const modifiers = new Set<string>();
    for (const part of parts) {
        let modifier = MODIFIERS[part.toLowerCase()];
        if (modifier === undefined || part === '') {
            return null;
        }
        if (modifier === 'cmdorctrl') {
            modifier = platform === 'darwin' ? 'cmd' : 'ctrl';
        }
        modifiers.add(modifier);
    }
    const ordered = ['ctrl', 'cmd', 'alt', 'shift'].filter((modifier) => modifiers.has(modifier));
    return [...ordered, canonicalKey].join('+');
}

/** A whole keybinding (one stroke, or two for a chord) in canonical form, or null if invalid. */
export function canonicalKeybinding(binding: string, platform: string): string | null {
    const strokes = binding.trim().split(/\s+/);
    if (strokes.length === 0 || strokes.length > 2 || strokes[0] === '') {
        return null;
    }
    const canonical = strokes.map((stroke) => canonicalStroke(stroke, platform));
    return canonical.every((stroke) => stroke !== null) ? canonical.join(' ') : null;
}

export function isValidKeybinding(binding: string): boolean {
    // Validity does not depend on the platform; any platform name gives the same answer.
    return canonicalKeybinding(binding, 'linux') !== null;
}

export function isChord(binding: string): boolean {
    return binding.trim().split(/\s+/).length > 1;
}

/** Keeps the rules that are well formed, and says what was dropped. */
export function cleanUserKeybindings(value: unknown): { readonly entries: UserKeybinding[]; readonly errors: string[] } {
    const errors: string[] = [];
    if (!Array.isArray(value)) {
        return { entries: [], errors: value === undefined ? [] : ['The keybindings file must hold an array of rules.'] };
    }
    const entries: UserKeybinding[] = [];
    value.slice(0, MAX_USER_KEYBINDINGS).forEach((item: unknown, index) => {
        const where = `Rule ${index + 1}`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            errors.push(`${where} is not an object.`);
            return;
        }
        const { key, command } = item as Record<string, unknown>;
        if (typeof command !== 'string' || !COMMAND_PATTERN.test(command)) {
            errors.push(`${where} has no valid "command".`);
            return;
        }
        const removal = command.startsWith('-');
        if (key === undefined && removal) {
            entries.push({ command });
            return;
        }
        if (typeof key !== 'string' || !isValidKeybinding(key)) {
            errors.push(`${where} (${command}) has no valid "key".`);
            return;
        }
        entries.push({ key: key.trim().split(/\s+/).join(' '), command });
    });
    if (value.length > MAX_USER_KEYBINDINGS) {
        errors.push(`Only the first ${MAX_USER_KEYBINDINGS} rules are read.`);
    }
    return { entries, errors };
}

/** Reads the file's text: comments and trailing commas are accepted, as in VS Code. */
export function parseKeybindingsFile(text: string | null): { readonly entries: UserKeybinding[]; readonly errors: string[] } {
    if (text === null || text.trim() === '') {
        return { entries: [], errors: [] };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripJsonComments(text));
    } catch (error) {
        return { entries: [], errors: [`The keybindings file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
    }
    return cleanUserKeybindings(parsed);
}

export function formatKeybindingsFile(entries: readonly UserKeybinding[]): string {
    const rules = entries.map((entry) => (entry.key === undefined ? { command: entry.command } : { key: entry.key, command: entry.command }));
    return `${JSON.stringify(rules, null, 4)}\n`;
}

/**
 * The keys in force, by command ID. `defaults` holds every command's
 * built-in keys (its primary key first). Removals apply first, then each
 * added key is taken from whichever command held it and given to the rule's
 * command; a later rule wins over an earlier one. Commands a rule names that
 * are not (yet) registered still get an entry, so a command an AI agent
 * registers later finds its keys waiting.
 */
export function resolveKeybindings(
    defaults: ReadonlyMap<string, readonly string[]>,
    entries: readonly UserKeybinding[],
    platform: string,
): Map<string, string[]> {
    const result = new Map<string, string[]>([...defaults].map(([id, keys]) => [id, [...keys]]));
    const same = (a: string, b: string): boolean => canonicalKeybinding(a, platform) === canonicalKeybinding(b, platform);
    for (const entry of entries) {
        if (!entry.command.startsWith('-')) {
            continue;
        }
        const id = entry.command.slice(1);
        const key = entry.key;
        result.set(id, key === undefined ? [] : (result.get(id) ?? []).filter((existing) => !same(existing, key)));
    }
    for (const entry of entries) {
        const key = entry.key;
        if (entry.command.startsWith('-') || key === undefined) {
            continue;
        }
        for (const [id, keys] of result) {
            if (keys.some((existing) => same(existing, key))) {
                result.set(id, keys.filter((existing) => !same(existing, key)));
            }
        }
        result.set(entry.command, [...(result.get(entry.command) ?? []), key]);
    }
    return result;
}

/**
 * The key the application menu shows and listens for: the command's first
 * single-stroke key (a menu cannot express a chord). The workbench handles
 * every other key of the command itself.
 */
export function menuAccelerator(keys: readonly string[]): string | undefined {
    return keys.find((key) => !isChord(key));
}

/** The rules after the user gives a command exactly this key, or no key at all (`null`). */
export function withCommandKey(entries: readonly UserKeybinding[], command: string, key: string | null): UserKeybinding[] {
    return [
        ...withoutCommandRules(entries, command),
        { command: `-${command}` },
        ...(key === null ? [] : [{ key, command }]),
    ];
}

/** The rules without any that name this command: it is back to its built-in keys. */
export function withoutCommandRules(entries: readonly UserKeybinding[], command: string): UserKeybinding[] {
    return entries.filter((entry) => entry.command !== command && entry.command !== `-${command}`);
}

/**
 * The rules after a command is reset to its built-in keys: the rules naming
 * it go, and so does any rule that gave one of those keys to another command
 * (otherwise the reset could not bring that key back).
 */
export function withCommandReset(entries: readonly UserKeybinding[], command: string, defaults: readonly string[], platform: string): UserKeybinding[] {
    const taken = new Set(defaults.map((key) => canonicalKeybinding(key, platform)));
    return withoutCommandRules(entries, command)
        .filter((entry) => entry.command.startsWith('-') || entry.key === undefined || !taken.has(canonicalKeybinding(entry.key, platform)));
}

/** True when a command's keys differ from its built-in ones. */
export function keysChanged(defaults: readonly string[], current: readonly string[]): boolean {
    return defaults.length !== current.length || defaults.some((key, index) => key !== current[index]);
}
