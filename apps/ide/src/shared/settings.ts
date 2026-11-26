/**
 * The IDE's settings (#18, part 2): one schema, shared by the main process
 * (which validates and stores them) and the renderer (which shows and applies
 * them). Values live in two flat JSON files of dotted keys, as VS Code's do:
 * the user's (`settings.json` in the IDE's user-data folder) and the open
 * folder's (`.codexr/settings.json`, committed with the project if the team
 * wants). A folder value wins over a user value, which wins over the default.
 * Anything not in the schema, or of the wrong shape, is ignored, never
 * applied. Pure, unit-tested in Node.
 */

export type SettingScope = 'user' | 'folder';

interface SettingBase<T> {
    readonly key: string;
    readonly title: string;
    readonly description: string;
    readonly category: string;
    readonly default: T;
    /** Only the user's file may set it (#171: the theme applies to every window, so a folder cannot own it). */
    readonly userOnly?: boolean;
}

export type SettingDefinition =
    | (SettingBase<boolean> & { readonly type: 'boolean' })
    | (SettingBase<number> & { readonly type: 'number'; readonly min: number; readonly max: number; readonly integer?: boolean })
    | (SettingBase<string> & { readonly type: 'enum'; readonly options: readonly string[]; readonly optionLabels?: readonly string[] })
    | (SettingBase<string> & { readonly type: 'string'; readonly maxLength: number });

export type SettingValue = boolean | number | string;

const MONO = "ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace";

/** #171: the colour theme. `system` follows the OS, live. */
export const COLOR_THEME_SETTING = 'workbench.colorTheme';
export const COLOR_THEMES = ['system', 'dark', 'light'] as const;
export type ColorTheme = (typeof COLOR_THEMES)[number];

export function isColorTheme(value: unknown): value is ColorTheme {
    return typeof value === 'string' && (COLOR_THEMES as readonly string[]).includes(value);
}

export const SETTINGS: readonly SettingDefinition[] = [
    { key: COLOR_THEME_SETTING, category: 'Workbench', title: 'Color Theme', description: 'Dark or light, or follow the operating system as it changes. Applies to every window.', type: 'enum', options: COLOR_THEMES, optionLabels: ['Follow the OS', 'Dark', 'Light'], default: 'system', userOnly: true },
    { key: 'editor.fontSize', category: 'Editor', title: 'Font Size', description: 'The editor font size, in pixels.', type: 'number', min: 6, max: 72, integer: true, default: 13 },
    { key: 'editor.fontFamily', category: 'Editor', title: 'Font Family', description: 'The editor fonts, as a CSS font-family list.', type: 'string', maxLength: 300, default: MONO },
    { key: 'editor.lineHeight', category: 'Editor', title: 'Line Height', description: 'The line height in pixels; 0 computes it from the font size.', type: 'number', min: 0, max: 150, integer: true, default: 0 },
    { key: 'editor.tabSize', category: 'Editor', title: 'Tab Size', description: 'Spaces a tab is worth. Files that already have an indentation keep theirs while Detect Indentation is on.', type: 'number', min: 1, max: 16, integer: true, default: 4 },
    { key: 'editor.insertSpaces', category: 'Editor', title: 'Insert Spaces', description: 'Tab inserts spaces. Overridden by the file\'s own indentation while Detect Indentation is on.', type: 'boolean', default: true },
    { key: 'editor.detectIndentation', category: 'Editor', title: 'Detect Indentation', description: 'Take the tab size and spaces-or-tabs from each file\'s content.', type: 'boolean', default: true },
    { key: 'editor.wordWrap', category: 'Editor', title: 'Word Wrap', description: 'How long lines wrap.', type: 'enum', options: ['off', 'on', 'bounded'], optionLabels: ['Off', 'At the viewport', 'At the viewport or the ruler'], default: 'off' },
    { key: 'editor.lineNumbers', category: 'Editor', title: 'Line Numbers', description: 'How line numbers are shown.', type: 'enum', options: ['on', 'off', 'relative'], optionLabels: ['On', 'Off', 'Relative to the cursor'], default: 'on' },
    { key: 'editor.renderWhitespace', category: 'Editor', title: 'Render Whitespace', description: 'Which whitespace characters are drawn.', type: 'enum', options: ['none', 'boundary', 'selection', 'trailing', 'all'], default: 'selection' },
    { key: 'editor.minimap.enabled', category: 'Editor', title: 'Minimap', description: 'Show the minimap beside the editor.', type: 'boolean', default: true },
    { key: 'editor.stickyScroll.enabled', category: 'Editor', title: 'Sticky Scroll', description: 'Keep the enclosing scopes at the top of the editor while scrolling.', type: 'boolean', default: false },
    { key: 'editor.bracketPairColorization.enabled', category: 'Editor', title: 'Bracket Pair Colorization', description: 'Colour matching brackets by depth.', type: 'boolean', default: true },
    { key: 'editor.cursorBlinking', category: 'Editor', title: 'Cursor Blinking', description: 'How the cursor blinks.', type: 'enum', options: ['blink', 'smooth', 'phase', 'expand', 'solid'], default: 'blink' },
    { key: 'editor.smoothScrolling', category: 'Editor', title: 'Smooth Scrolling', description: 'Animate scrolling in the editor.', type: 'boolean', default: false },
    { key: 'terminal.integrated.fontSize', category: 'Terminal', title: 'Font Size', description: 'The terminal font size, in pixels.', type: 'number', min: 6, max: 72, integer: true, default: 13 },
] as const;

const BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(SETTINGS.map((setting) => [setting.key, setting]));

export function settingDefinition(key: string): SettingDefinition | undefined {
    return BY_KEY.get(key);
}

/** The value if it fits the setting's schema, else undefined (it is then ignored). */
export function validSettingValue(key: string, value: unknown): SettingValue | undefined {
    const setting = BY_KEY.get(key);
    if (!setting) {
        return undefined;
    }
    switch (setting.type) {
        case 'boolean':
            return typeof value === 'boolean' ? value : undefined;
        case 'number':
            if (typeof value !== 'number' || !Number.isFinite(value) || value < setting.min || value > setting.max) {
                return undefined;
            }
            return setting.integer && !Number.isInteger(value) ? undefined : value;
        case 'enum':
            return typeof value === 'string' && setting.options.includes(value) ? value : undefined;
        case 'string':
            return typeof value === 'string' && value.length <= setting.maxLength && !value.includes('\0') ? value : undefined;
    }
}

export type SettingValues = Readonly<Record<string, SettingValue>>;

/** Keeps only the known keys with valid values. */
export function cleanSettings(raw: unknown): SettingValues {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return {};
    }
    const clean: Record<string, SettingValue> = {};
    for (const [key, value] of Object.entries(raw)) {
        const valid = validSettingValue(key, value);
        if (valid !== undefined) {
            clean[key] = valid;
        }
    }
    return clean;
}

export interface SettingsSnapshot {
    readonly user: SettingValues;
    /** Null when no folder is open. */
    readonly folder: SettingValues | null;
    /** Every setting's value in force: folder, else user, else the default. */
    readonly effective: SettingValues;
}

export function resolveSettings(user: SettingValues, folder: SettingValues | null): SettingsSnapshot {
    const effective: Record<string, SettingValue> = {};
    for (const setting of SETTINGS) {
        effective[setting.key] = (setting.userOnly ? undefined : folder?.[setting.key]) ?? user[setting.key] ?? setting.default;
    }
    return { user, folder, effective };
}

/** The value in force for `key`, typed by the caller. */
export function settingOf<T extends SettingValue>(snapshot: Pick<SettingsSnapshot, 'effective'>, key: string): T {
    return (snapshot.effective[key] ?? settingDefinition(key)?.default) as T;
}

/** A settings file's text, keys sorted, as the IDE writes it. */
export function formatSettingsFile(values: Readonly<Record<string, unknown>>): string {
    const sorted = Object.fromEntries(Object.keys(values).sort().map((key) => [key, values[key]]));
    return `${JSON.stringify(sorted, null, 4)}\n`;
}

/**
 * Reads a settings file's text. Comments (`//`, block comments) and trailing
 * commas are accepted, as in VS Code's files; unreadable text is an empty set
 * plus an error to show.
 */
export function parseSettingsFile(text: string): { readonly values: SettingValues; readonly error: string | null } {
    if (text.trim() === '') {
        return { values: {}, error: null };
    }
    try {
        return { values: cleanSettings(JSON.parse(stripJsonComments(text))), error: null };
    } catch (error) {
        return { values: {}, error: error instanceof Error ? error.message : String(error) };
    }
}

/** Removes comments and trailing commas outside strings. */
export function stripJsonComments(text: string): string {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const next = text[i + 1];
        if (inString) {
            out += char;
            if (char === '\\') {
                out += next ?? '';
                i++;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            out += char;
        } else if (char === '/' && next === '/') {
            while (i < text.length && text[i] !== '\n') { i++; }
            out += '\n';
        } else if (char === '/' && next === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { i++; }
            i++;
        } else if (char === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) {
            // A trailing comma: dropped.
        } else {
            out += char;
        }
    }
    return out;
}
