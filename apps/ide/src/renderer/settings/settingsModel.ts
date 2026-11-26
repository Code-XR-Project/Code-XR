import { COLOR_THEMES, SETTINGS, type ColorTheme, type SettingDefinition, type SettingScope, type SettingsSnapshot, type SettingValue } from '../../shared/settings.ts';

/**
 * The Settings view (#18) as data: which settings a filter shows, grouped by
 * category, and what each row says about where its value comes from. Pure,
 * unit-tested in Node.
 */

export interface SettingRow {
    readonly setting: SettingDefinition;
    /** The value the control shows: this scope's own, else the one in force below it. */
    readonly value: SettingValue;
    /** This scope sets the value itself (the row can be reset). */
    readonly modified: boolean;
    /** Shown under the title: a folder value hiding the user's, or a user value the folder inherits. */
    readonly note: string | null;
    /** The scope cannot set it (a user-only setting on the Folder tab): the control is disabled. */
    readonly readOnly: boolean;
}

export interface SettingGroup {
    readonly category: string;
    readonly rows: readonly SettingRow[];
}

const words = (text: string): string => text.toLowerCase();

/** Every word of the filter must appear in the key, title, description or category. */
export function matchesFilter(setting: SettingDefinition, filter: string): boolean {
    const terms = words(filter).split(/\s+/).filter(Boolean);
    const haystack = words(`${setting.key} ${setting.category} ${setting.title} ${setting.description}`);
    return terms.every((term) => haystack.includes(term));
}

export function settingRows(snapshot: SettingsSnapshot, scope: SettingScope, filter: string): SettingGroup[] {
    const groups = new Map<string, SettingRow[]>();
    for (const setting of SETTINGS) {
        if (!matchesFilter(setting, filter)) {
            continue;
        }
        const readOnly = scope === 'folder' && setting.userOnly === true;
        const own = scope === 'user' ? snapshot.user[setting.key] : readOnly ? undefined : snapshot.folder?.[setting.key];
        const user = snapshot.user[setting.key];
        const folder = snapshot.folder?.[setting.key];
        const inherited = scope === 'folder' ? user ?? setting.default : setting.default;
        let note: string | null = null;
        if (setting.userOnly && scope === 'folder') {
            note = 'Only your user settings set this: it applies to every window.';
        } else if (scope === 'user' && folder !== undefined && !setting.userOnly) {
            note = 'This folder sets its own value, which wins here.';
        } else if (scope === 'folder' && own === undefined && user !== undefined) {
            note = 'Your user setting applies.';
        }
        const rows = groups.get(setting.category) ?? [];
        rows.push({ setting, value: own ?? inherited, modified: own !== undefined, note, readOnly });
        groups.set(setting.category, rows);
    }
    return [...groups].map(([category, rows]) => ({ category, rows }));
}

/** A typed value from a control's text, or null when it does not fit the setting. */
export function parseControlValue(setting: SettingDefinition, input: string | boolean): SettingValue | null {
    switch (setting.type) {
        case 'boolean':
            return typeof input === 'boolean' ? input : null;
        case 'number': {
            const value = typeof input === 'string' && input.trim() !== '' ? Number(input) : Number.NaN;
            if (!Number.isFinite(value) || value < setting.min || value > setting.max || (setting.integer && !Number.isInteger(value))) {
                return null;
            }
            return value;
        }
        case 'enum':
            return typeof input === 'string' && setting.options.includes(input) ? input : null;
        case 'string':
            return typeof input === 'string' && input.length <= setting.maxLength ? input : null;
    }
}

/** #171: the theme picker's rows, the one in use marked. */
export function themeChoices(current: ColorTheme): { readonly id: ColorTheme; readonly label: string; readonly description?: string }[] {
    const labels: Record<ColorTheme, string> = { system: 'Follow the OS', dark: 'Dark', light: 'Light' };
    return COLOR_THEMES.map((theme) => ({ id: theme, label: labels[theme], ...(theme === current ? { description: 'current' } : {}) }));
}
