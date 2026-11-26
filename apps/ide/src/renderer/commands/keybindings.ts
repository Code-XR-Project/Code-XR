/**
 * Keybindings (#18), written as Electron accelerators so the same string can
 * go to the application menu or to the workbench's own key handler:
 * modifiers `CmdOrCtrl`, `Ctrl`, `Cmd`, `Alt`, `Shift`, then one key
 * (`P`, `F1`, `` ` ``, `\`, `Tab`, `PageUp`…). `CmdOrCtrl` is Cmd on macOS
 * and Ctrl elsewhere. A chord is two strokes separated by a space
 * (`CmdOrCtrl+K Z`, #169); only the workbench's handler can listen for one,
 * the menu cannot. Pure module, unit-tested in Node.
 */

export type KeyPlatform = 'darwin' | 'win32' | 'linux' | string;

export interface ParsedKeybinding {
    readonly ctrl: boolean;
    readonly meta: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
    /** The key, upper-cased for letters ("P", "F1", "`", "PAGEUP"). */
    readonly key: string;
}

/** The fields of a KeyboardEvent the matcher reads. */
export interface KeyEventLike {
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
    readonly key: string;
    readonly code: string;
}

export function parseKeybinding(binding: string, platform: KeyPlatform): ParsedKeybinding {
    const parts = binding.split('+');
    // "Ctrl++" binds the plus key: an empty last part means the key was '+'.
    let key = parts.pop() ?? '';
    if (key === '' && parts.at(-1) === '') {
        parts.pop();
        key = '+';
    }
    if (key === '') {
        throw new Error(`Keybinding "${binding}" has no key.`);
    }
    const isMac = platform === 'darwin';
    let ctrl = false;
    let meta = false;
    let alt = false;
    let shift = false;
    for (const part of parts) {
        switch (part.toLowerCase()) {
            case 'cmdorctrl': case 'commandorcontrol':
                if (isMac) { meta = true; } else { ctrl = true; }
                break;
            case 'ctrl': case 'control': ctrl = true; break;
            case 'cmd': case 'command': case 'super': case 'meta': meta = true; break;
            case 'alt': case 'option': alt = true; break;
            case 'shift': shift = true; break;
            default: throw new Error(`Unknown modifier "${part}" in keybinding "${binding}".`);
        }
    }
    const upper = key.toUpperCase();
    return { ctrl, meta, alt, shift, key: KEY_ALIASES[upper] ?? upper };
}

/** Other names Electron accepts for the same key (#18, part 3: user keybindings may use either). */
const KEY_ALIASES: Record<string, string> = { ESC: 'ESCAPE', RETURN: 'ENTER', PLUS: '+' };

/** The key a KeyboardEvent stands for, independent of Shift and the layout's shifted symbol. */
function eventKey(event: KeyEventLike): string {
    const code = event.code;
    if (/^Key[A-Z]$/.test(code)) { return code.slice(3); }
    if (/^Digit[0-9]$/.test(code)) { return code.slice(5); }
    if (/^F[0-9]{1,2}$/.test(code)) { return code; }
    switch (code) {
        case 'Backquote': return '`';
        case 'Backslash': return '\\';
        case 'Slash': return '/';
        case 'Comma': return ',';
        case 'Period': return '.';
        case 'Minus': return '-';
        case 'Equal': return '=';
        case 'BracketLeft': return '[';
        case 'BracketRight': return ']';
        case 'Semicolon': return ';';
        case 'Quote': return "'";
        case 'Space': return 'SPACE';
        case 'ArrowUp': return 'UP';
        case 'ArrowDown': return 'DOWN';
        case 'ArrowLeft': return 'LEFT';
        case 'ArrowRight': return 'RIGHT';
        default: break;
    }
    return event.key.toUpperCase();
}

export function matchesKeybinding(event: KeyEventLike, binding: ParsedKeybinding): boolean {
    return event.ctrlKey === binding.ctrl
        && event.metaKey === binding.meta
        && event.altKey === binding.alt
        && event.shiftKey === binding.shift
        && eventKey(event) === binding.key;
}

const KEY_LABELS: Record<string, string> = {
    PAGEUP: 'PageUp',
    PAGEDOWN: 'PageDown',
    ESCAPE: 'Esc',
    TAB: 'Tab',
    ENTER: 'Enter',
    SPACE: 'Space',
    UP: 'Up',
    DOWN: 'Down',
    LEFT: 'Left',
    RIGHT: 'Right',
    BACKSPACE: 'Backspace',
    DELETE: 'Delete',
    INSERT: 'Insert',
    HOME: 'Home',
    END: 'End',
};

/**
 * The accelerator a key press stands for, to record a new keybinding
 * (#18, part 3): `CmdOrCtrl+Shift+K` for Ctrl+Shift+K on Windows and Linux
 * and Cmd+Shift+K on macOS, so the file means the same key on every OS.
 * Null for a modifier alone or a key an accelerator cannot name.
 */
export function strokeFromEvent(event: KeyEventLike, platform: KeyPlatform): string | null {
    if (isModifierKey(event)) {
        return null;
    }
    const key = eventKey(event);
    const label = KEY_LABELS[key];
    let name: string;
    if (key.length === 1 && key > ' ' && key <= '~') {
        name = key;
    } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) {
        name = key;
    } else if (key === 'ESCAPE') {
        name = 'Escape';
    } else if (label !== undefined) {
        name = label;
    } else {
        return null;
    }
    const isMac = platform === 'darwin';
    const parts: string[] = [];
    if (isMac ? event.metaKey : event.ctrlKey) { parts.push('CmdOrCtrl'); }
    if (isMac && event.ctrlKey) { parts.push('Ctrl'); }
    if (!isMac && event.metaKey) { parts.push('Super'); }
    if (event.altKey) { parts.push('Alt'); }
    if (event.shiftKey) { parts.push('Shift'); }
    parts.push(name);
    return parts.join('+');
}

/** A keybinding's strokes: one, or two for a chord ("CmdOrCtrl+K Z"). */
export function parseChord(binding: string, platform: KeyPlatform): readonly ParsedKeybinding[] {
    const strokes = binding.trim().split(/\s+/);
    if (strokes.length > 2) {
        throw new Error(`Keybinding "${binding}" has more than two strokes.`);
    }
    return strokes.map((stroke) => parseKeybinding(stroke, platform));
}

/** True when the key pressed is only a modifier (the second stroke of a chord has not come yet). */
export function isModifierKey(event: Pick<KeyEventLike, 'key'>): boolean {
    return event.key === 'Control' || event.key === 'Meta' || event.key === 'Alt' || event.key === 'Shift';
}

/** How a keybinding is written in the palette and tooltips: "Ctrl+Shift+P", "Cmd+Shift+P" on macOS, "Ctrl+K Z" for a chord. */
export function formatKeybinding(binding: string, platform: KeyPlatform): string {
    return binding.trim().split(/\s+/).map((stroke) => formatStroke(stroke, platform)).join(' ');
}

function formatStroke(binding: string, platform: KeyPlatform): string {
    const parsed = parseKeybinding(binding, platform);
    const parts: string[] = [];
    const isMac = platform === 'darwin';
    if (isMac) {
        // macOS order: Ctrl, Option, Shift, Cmd.
        if (parsed.ctrl) { parts.push('Ctrl'); }
        if (parsed.alt) { parts.push('Option'); }
        if (parsed.shift) { parts.push('Shift'); }
        if (parsed.meta) { parts.push('Cmd'); }
    } else {
        if (parsed.ctrl) { parts.push('Ctrl'); }
        if (parsed.meta) { parts.push(platform === 'win32' ? 'Win' : 'Super'); }
        if (parsed.alt) { parts.push('Alt'); }
        if (parsed.shift) { parts.push('Shift'); }
    }
    const key = parsed.key;
    parts.push(KEY_LABELS[key] ?? (key.length === 1 ? key : key.charAt(0) + key.slice(1).toLowerCase()));
    return parts.join('+');
}

/** A command's keybinding, parsed into its strokes. */
export interface StrokeBinding {
    readonly id: string;
    readonly strokes: readonly ParsedKeybinding[];
}

/** How long the second stroke of a chord may wait. */
export const CHORD_TIMEOUT_MS = 3000;

/**
 * What a key press does (#169): runs a single-stroke binding, finishes a
 * chord (`chord`: the caller swallows the key), starts a chord (null: the key
 * goes on, so Monaco still sees `Ctrl+K` and keeps its own chords) or nothing.
 */
export interface KeyDispatcher {
    dispatch(event: KeyEventLike, bindings: readonly StrokeBinding[], canStartChord: boolean): { readonly kind: 'single' | 'chord'; readonly id: string } | null;
}

export function createKeyDispatcher(now: () => number = () => Date.now()): KeyDispatcher {
    let pending: { readonly candidates: readonly StrokeBinding[]; readonly until: number } | null = null;
    return {
        dispatch(event, bindings, canStartChord) {
            if (isModifierKey(event)) {
                return null;
            }
            if (pending) {
                const { candidates, until } = pending;
                pending = null;
                const second = now() <= until
                    ? candidates.find((binding) => binding.strokes[1] !== undefined && matchesKeybinding(event, binding.strokes[1]))
                    : undefined;
                if (second) {
                    return { kind: 'chord', id: second.id };
                }
            }
            const single = bindings.find((binding) => binding.strokes.length === 1 && binding.strokes[0] !== undefined && matchesKeybinding(event, binding.strokes[0]));
            if (single) {
                return { kind: 'single', id: single.id };
            }
            const chords = bindings.filter((binding) => binding.strokes.length === 2 && binding.strokes[0] !== undefined && matchesKeybinding(event, binding.strokes[0]));
            if (chords.length > 0 && canStartChord) {
                pending = { candidates: chords, until: now() + CHORD_TIMEOUT_MS };
            }
            return null;
        },
    };
}
