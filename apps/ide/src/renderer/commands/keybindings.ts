/**
 * Keybindings (#18), written as Electron accelerators so the same string can
 * go to the application menu or to the workbench's own key handler:
 * modifiers `CmdOrCtrl`, `Ctrl`, `Cmd`, `Alt`, `Shift`, then one key
 * (`P`, `F1`, `` ` ``, `\`, `Tab`, `PageUp`…). `CmdOrCtrl` is Cmd on macOS
 * and Ctrl elsewhere. Pure module, unit-tested in Node.
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
    return { ctrl, meta, alt, shift, key: key.toUpperCase() };
}

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
};

/** How a keybinding is written in the palette and tooltips: "Ctrl+Shift+P", "Cmd+Shift+P" on macOS. */
export function formatKeybinding(binding: string, platform: KeyPlatform): string {
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
