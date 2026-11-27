import type { ResolvedTheme } from '../../shared/extensions.ts';

/**
 * A VS Code colour theme turned into what the workbench uses (#257): a Monaco
 * theme (token rules and editor colours) and the workbench's own colour
 * tokens (`--editor`, `--panel`, ...), plus every theme colour as a
 * `--vscode-*` variable for extension webviews (#261). Pure, unit-tested.
 */

export interface MonacoThemeData {
    readonly base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
    readonly inherit: boolean;
    readonly rules: { token: string; foreground?: string; background?: string; fontStyle?: string }[];
    readonly colors: Record<string, string>;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** `#abc` -> `#aabbcc`, `#abcd` -> `#aabbccdd`; null for anything that is not a hex colour. */
export function normalizeHex(value: unknown): string | null {
    if (typeof value !== 'string' || !HEX.test(value.trim())) {
        return null;
    }
    const hex = value.trim().slice(1).toLowerCase();
    return `#${hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex}`;
}

/**
 * Monarch token names (Monaco's built-in tokenizers) that a TextMate scope
 * stands for, so a theme written for TextMate also colours the languages
 * Monaco tokenizes itself.
 */
const MONARCH_ALIASES: readonly [string, readonly string[]][] = [
    ['comment', ['comment']],
    ['string.regexp', ['regexp']],
    ['string', ['string']],
    ['constant.numeric', ['number']],
    ['constant.language', ['keyword']],
    ['constant', ['constant']],
    ['keyword.operator', ['operator', 'delimiter']],
    ['keyword', ['keyword']],
    ['storage.type', ['keyword']],
    ['storage', ['keyword']],
    ['entity.name.type', ['type', 'type.identifier']],
    ['entity.name.class', ['type', 'type.identifier']],
    ['support.type', ['type']],
    ['entity.name.function', ['function']],
    ['support.function', ['function']],
    ['entity.name.tag', ['tag']],
    ['entity.other.attribute-name', ['attribute.name']],
    ['variable.parameter', ['variable']],
    ['variable', ['variable', 'identifier']],
    ['punctuation', ['delimiter']],
    ['meta.annotation', ['annotation']],
    ['markup.heading', ['keyword.md']],
    ['invalid', ['invalid']],
];

function monarchFor(scope: string): readonly string[] {
    for (const [prefix, tokens] of MONARCH_ALIASES) {
        if (scope === prefix || scope.startsWith(`${prefix}.`)) {
            return tokens;
        }
    }
    return [];
}

/** The scope a rule applies to, as Monaco matches tokens: the last part of a descendant selector. */
export function ruleToken(selector: string): string | null {
    const trimmed = selector.trim();
    if (trimmed === '' || trimmed.startsWith('-') || trimmed.includes('|')) {
        return null;
    }
    const parts = trimmed.split(/\s+/);
    const last = parts[parts.length - 1] ?? '';
    return /^[A-Za-z0-9_.-]+$/.test(last) ? last : null;
}

function strip(hex: string): string {
    return hex.slice(1);
}

export function toMonacoTheme(theme: ResolvedTheme): MonacoThemeData {
    const rules: MonacoThemeData['rules'] = [];
    const foreground = normalizeHex(theme.colors['editor.foreground']) ?? normalizeHex(theme.colors.foreground);
    const background = normalizeHex(theme.colors['editor.background']);
    // The empty token is the default text: without it Monaco keeps the base theme's.
    if (foreground || background) {
        rules.push({ token: '', ...(foreground ? { foreground: strip(foreground) } : {}), ...(background ? { background: strip(background) } : {}) });
    }
    // For each Monarch alias, the most general scope wins (`keyword` over `keyword.control.import`); on a tie, the later rule.
    const monarch = new Map<string, { depth: number; rule: MonacoThemeData['rules'][number] }>();
    for (const rule of theme.tokenColors) {
        const fg = normalizeHex(rule.foreground);
        const bg = normalizeHex(rule.background);
        const style = typeof rule.fontStyle === 'string' ? rule.fontStyle.trim() : undefined;
        const settings = {
            ...(fg ? { foreground: strip(fg) } : {}),
            ...(bg ? { background: strip(bg) } : {}),
            ...(style !== undefined ? { fontStyle: style } : {}),
        };
        if (Object.keys(settings).length === 0) {
            continue;
        }
        for (const selector of rule.scope) {
            const token = ruleToken(selector);
            if (!token) {
                continue;
            }
            rules.push({ token, ...settings });
            const depth = token.split('.').length;
            for (const alias of monarchFor(token)) {
                const existing = monarch.get(alias);
                if (!existing || depth <= existing.depth) {
                    monarch.set(alias, { depth, rule: { token: alias, ...settings } });
                }
            }
        }
    }
    // Monarch aliases first: an exact TextMate rule of the same name, later in the list, overrides it.
    const colors: Record<string, string> = {};
    for (const [key, value] of Object.entries(theme.colors)) {
        const hex = normalizeHex(value);
        if (hex) {
            colors[key] = hex;
        }
    }
    return { base: theme.uiTheme, inherit: true, rules: [...[...monarch.values()].map((entry) => entry.rule), ...rules], colors };
}

/** The workbench token and the theme colours it comes from, first found wins. */
const WORKBENCH_TOKENS: readonly [string, readonly string[]][] = [
    ['--editor', ['editor.background']],
    ['--panel', ['sideBar.background', 'panel.background', 'editor.background']],
    ['--chrome', ['activityBar.background', 'titleBar.activeBackground', 'sideBar.background', 'editorGroupHeader.tabsBackground']],
    ['--line', ['sideBar.border', 'panel.border', 'editorGroup.border', 'tab.border', 'contrastBorder', 'widget.border']],
    ['--hover', ['list.hoverBackground', 'toolbar.hoverBackground', 'list.inactiveSelectionBackground']],
    ['--fg', ['foreground', 'sideBar.foreground', 'editor.foreground']],
    ['--muted', ['descriptionForeground', 'tab.inactiveForeground', 'editorLineNumber.foreground']],
    ['--accent', ['focusBorder', 'button.background', 'activityBarBadge.background', 'textLink.foreground']],
    ['--crit', ['errorForeground', 'editorError.foreground']],
    ['--warn', ['editorWarning.foreground', 'list.warningForeground']],
    ['--status', ['statusBar.background']],
    ['--status-fg', ['statusBar.foreground']],
    ['--symbol', ['symbolIcon.functionForeground', 'symbolIcon.methodForeground']],
];

/** The CSS custom properties to set on the root element for a theme. */
export function workbenchVariables(theme: ResolvedTheme): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const [token, keys] of WORKBENCH_TOKENS) {
        for (const key of keys) {
            const hex = normalizeHex(theme.colors[key]);
            if (hex) {
                vars[token] = hex;
                break;
            }
        }
    }
    for (const [key, value] of Object.entries(theme.colors)) {
        const hex = normalizeHex(value);
        if (hex && /^[A-Za-z0-9.]+$/.test(key)) {
            vars[`--vscode-${key.replace(/\./g, '-')}`] = hex;
        }
    }
    return vars;
}

/** Whether a theme is dark (`vs-dark`, `hc-black`), for the OS colour scheme the pages see. */
export function isDarkTheme(uiTheme: ResolvedTheme['uiTheme']): boolean {
    return uiTheme === 'vs-dark' || uiTheme === 'hc-black';
}
