import fs from 'node:fs';
import path from 'node:path';
import { codiconName, type IconData } from '../../shared/extensionViewsProtocol.ts';
import { EXTENSION_THEME_PREFIX, type ContributedGrammar, type ContributedLanguage, type ContributedMenuItem, type ContributedSnippet, type ContributedCommand, type ContributedTheme, type ContributedView, type ContributedViewContainer, type ContributedViewWelcome, type ExtensionContributions, type GrammarContent, type ResolvedTheme, type ThemeTokenRule } from '../../shared/extensions.ts';
import { readJsonc, resolveInExtension, type LoadedExtension } from './extensionStore.ts';
import { parsePlist, type PlistValue } from './plist.ts';

/**
 * The declarative contributions of the enabled extensions (#257, #258):
 * colour themes, languages, TextMate grammars and snippets. These run no
 * extension code: the main process reads the files the manifest names
 * (always inside the extension's folder) and the workbench applies them.
 * Grammars are handed out by an opaque reference, never by path.
 */

function record(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.map(record) : [];
}

function strings(value: unknown): string[] {
    if (typeof value === 'string') {
        return [value];
    }
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

const UI_THEMES = new Set(['vs', 'vs-dark', 'hc-black', 'hc-light']);
const MAX_CONTRIBUTION_FILE = 8 * 1024 * 1024;

function themeId(extensionId: string, theme: Record<string, unknown>): string {
    return `${EXTENSION_THEME_PREFIX}${extensionId}/${str(theme.id) ?? str(theme.label) ?? str(theme.path) ?? 'theme'}`;
}

/** A file named by the manifest, inside the extension, small enough to read; else null. */
function contributionFile(extension: LoadedExtension, relative: unknown): string | null {
    if (typeof relative !== 'string') {
        return null;
    }
    const file = resolveInExtension(extension.location, relative);
    if (!file) {
        return null;
    }
    try {
        const stat = fs.statSync(file);
        return stat.isFile() && stat.size <= MAX_CONTRIBUTION_FILE ? file : null;
    } catch {
        return null;
    }
}

const IMAGE_TYPES: Readonly<Record<string, string>> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** Icons are small; anything bigger is not drawn (a 256 KB data URL is already generous for a 16px icon). */
export const MAX_ICON_FILE = 256 * 1024;

/** An image file as a `data:` URL, or null (not an image, too big, unreadable). Callers check where it is first. */
export function imageDataUrl(file: string): string | null {
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!type) {
        return null;
    }
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_ICON_FILE) {
            return null;
        }
        return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
    } catch {
        return null;
    }
}

/** #261: an icon of the manifest: `$(codicon)`, a path inside the extension, or `{ light, dark }` paths. */
export function manifestIcon(extension: LoadedExtension, value: unknown): IconData | null {
    if (typeof value === 'string') {
        const name = codiconName(value);
        if (name) {
            return { kind: 'codicon', name };
        }
        const file = contributionFile(extension, value);
        const url = file ? imageDataUrl(file) : null;
        return url ? { kind: 'image', light: url, dark: url } : null;
    }
    const pair = record(value);
    const lightFile = contributionFile(extension, pair['light']);
    const darkFile = contributionFile(extension, pair['dark']);
    const light = lightFile ? imageDataUrl(lightFile) : null;
    const dark = darkFile ? imageDataUrl(darkFile) : null;
    return light || dark ? { kind: 'image', light: (light ?? dark) as string, dark: (dark ?? light) as string } : null;
}

/** `"navigation@2"` -> group `navigation`, order 2. */
export function menuGroup(value: unknown): { group: string; order: number } {
    const text = typeof value === 'string' ? value : '';
    const at = text.lastIndexOf('@');
    if (at < 0) {
        return { group: text, order: 0 };
    }
    const order = Number(text.slice(at + 1));
    return { group: text.slice(0, at), order: Number.isFinite(order) ? order : 0 };
}

/** The menus #261 draws; the others (`scm/title`, `debug/toolbar`, ...) are not read. */
export const SUPPORTED_MENUS: ReadonlySet<string> = new Set(['view/title', 'view/item/context', 'editor/title', 'editor/title/context', 'editor/context', 'explorer/context']);

const BUILTIN_CONTAINERS: ReadonlySet<string> = new Set(['explorer', 'scm', 'debug']);

export class ContributionIndex {
    private readonly extensions: readonly LoadedExtension[];
    private readonly grammarFiles = new Map<string, string>();
    private readonly themeEntries = new Map<string, { extension: LoadedExtension; theme: Record<string, unknown>; label: string; uiTheme: ContributedTheme['uiTheme'] }>();
    private readonly onWarning: (message: string) => void;
    readonly contributions: ExtensionContributions;

    constructor(enabled: readonly LoadedExtension[], onWarning: (message: string) => void = () => undefined) {
        this.extensions = enabled;
        this.onWarning = onWarning;
        this.contributions = this.collect();
    }

    private collect(): ExtensionContributions {
        const themes: ContributedTheme[] = [];
        const languages: ContributedLanguage[] = [];
        const grammars: ContributedGrammar[] = [];
        const snippets: ContributedSnippet[] = [];
        const commands: ContributedCommand[] = [];
        const viewContainers: ContributedViewContainer[] = [];
        const views: ContributedView[] = [];
        const viewsWelcome: ContributedViewWelcome[] = [];
        const menus: ContributedMenuItem[] = [];
        const containerIds = new Set<string>();
        for (const extension of this.extensions) {
            const c = extension.manifest.contributes;
            const extensionId = extension.manifest.id;
            for (const theme of list(c.themes)) {
                const id = themeId(extensionId, theme);
                const uiTheme = UI_THEMES.has(String(theme.uiTheme)) ? theme.uiTheme as ContributedTheme['uiTheme'] : 'vs-dark';
                const label = str(theme.label) ?? str(theme.id) ?? id;
                if (!contributionFile(extension, theme.path)) {
                    this.onWarning(`${extensionId}: theme "${label}" names a file that is missing or outside the extension.`);
                    continue;
                }
                this.themeEntries.set(id, { extension, theme, label, uiTheme });
                themes.push({ id, label, extensionId, uiTheme });
            }
            for (const language of list(c.languages)) {
                const id = str(language.id);
                if (!id) {
                    continue;
                }
                let configuration: unknown = null;
                const configFile = contributionFile(extension, language.configuration);
                if (configFile) {
                    try {
                        configuration = readJsonc(configFile);
                    } catch (error) {
                        this.onWarning(`${extensionId}: ${(error as Error).message}`);
                    }
                }
                languages.push({
                    id,
                    extensionId,
                    aliases: strings(language.aliases),
                    extensions: strings(language.extensions),
                    filenames: strings(language.filenames),
                    filenamePatterns: strings(language.filenamePatterns),
                    firstLine: str(language.firstLine),
                    mimetypes: strings(language.mimetypes),
                    configuration,
                });
            }
            list(c.grammars).forEach((grammar, index) => {
                const scopeName = str(grammar.scopeName);
                const file = contributionFile(extension, grammar.path);
                if (!scopeName || !file) {
                    this.onWarning(`${extensionId}: a grammar without a scope name or a readable file was skipped.`);
                    return;
                }
                const ref = `${extensionId}#${index}`;
                this.grammarFiles.set(ref, file);
                const pairs = (value: unknown): Record<string, string> => Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
                grammars.push({
                    extensionId,
                    language: str(grammar.language),
                    scopeName,
                    ref,
                    embeddedLanguages: pairs(grammar.embeddedLanguages),
                    tokenTypes: pairs(grammar.tokenTypes),
                    injectTo: strings(grammar.injectTo),
                });
            });
            for (const entry of list(c.snippets)) {
                const file = contributionFile(extension, entry.path);
                if (!file) {
                    continue;
                }
                try {
                    snippets.push(...parseSnippets(readJsonc(file), extensionId, str(entry.language)));
                } catch (error) {
                    this.onWarning(`${extensionId}: snippets ${String(entry.path)}: ${(error as Error).message}`);
                }
            }
            // #259: the palette's commands, for the extensions whose code can run them.
            if (extension.manifest.main) {
                const palette = list(record(c.menus)['commandPalette']);
                const hidden = new Set(palette.filter((entry) => entry.when === 'false' || entry.when === false).map((entry) => str(entry.command)));
                const paletteWhen = new Map(palette.filter((entry) => typeof entry.when === 'string' && entry.when !== 'false').map((entry) => [str(entry.command), entry.when as string]));
                for (const command of list(c.commands)) {
                    const id = str(command.command);
                    const title = typeof command.title === 'string' ? command.title : str(record(command.title)['value']);
                    if (!id || !title) {
                        continue;
                    }
                    const category = typeof command.category === 'string' ? command.category : str(record(command.category)['value']);
                    commands.push({
                        extensionId, command: id, title, category: category ?? null, hiddenFromPalette: hidden.has(id),
                        paletteWhen: paletteWhen.get(id) ?? null,
                        enablement: str(command.enablement),
                        icon: command.icon === undefined ? null : manifestIcon(extension, command.icon),
                    });
                }
                // #261: the menus #261 draws. They run code, so only for extensions that have some.
                for (const [menu, entries] of Object.entries(record(c.menus))) {
                    if (!SUPPORTED_MENUS.has(menu)) {
                        continue;
                    }
                    for (const entry of list(entries)) {
                        const command = str(entry.command);
                        if (!command) {
                            continue; // A submenu reference: not drawn.
                        }
                        menus.push({ extensionId, menu, command, when: str(entry.when), ...menuGroup(entry.group) });
                    }
                }
            }
            // #261: view containers and views.
            const containers = record(c.viewsContainers);
            for (const location of ['activitybar', 'panel']) {
                for (const container of list(containers[location])) {
                    const id = str(container.id);
                    const title = str(container.title);
                    if (!id || !title || !/^[\w.-]+$/.test(id) || containerIds.has(id) || BUILTIN_CONTAINERS.has(id)) {
                        if (id) {
                            this.onWarning(`${extensionId}: view container "${id}" was skipped (bad or repeated id, or no title).`);
                        }
                        continue;
                    }
                    containerIds.add(id);
                    viewContainers.push({ id, extensionId, title, icon: manifestIcon(extension, container.icon) });
                }
            }
            for (const [container, entries] of Object.entries(record(c.views))) {
                for (const view of list(entries)) {
                    const id = str(view.id);
                    const name = str(view.name) ?? id;
                    if (!id || !name) {
                        continue;
                    }
                    views.push({
                        id, extensionId, container, name,
                        when: str(view.when),
                        type: view.type === 'webview' ? 'webview' : 'tree',
                        collapsed: view.visibility === 'collapsed',
                    });
                }
            }
            for (const welcome of list(c.viewsWelcome)) {
                const view = str(welcome.view);
                const contents = str(welcome.contents);
                if (view && contents) {
                    viewsWelcome.push({ extensionId, view, contents, when: str(welcome.when) });
                }
            }
        }
        // A view in a container nobody contributed (another extension's that is disabled, `test`, a panel
        // id this IDE has not got) would be invisible: VS Code drops those too, but say so.
        const known = new Set([...BUILTIN_CONTAINERS, ...containerIds]);
        const placed = views.filter((view) => {
            if (known.has(view.container)) {
                return true;
            }
            this.onWarning(`${view.extensionId}: view "${view.id}" is in the container "${view.container}", which this IDE does not show.`);
            return false;
        });
        return { themes, languages, grammars, snippets, commands, viewContainers, views: placed, viewsWelcome, menus };
    }

    grammarContent(ref: string): GrammarContent | null {
        const file = this.grammarFiles.get(ref);
        if (!file) {
            return null;
        }
        const content = fs.readFileSync(file, 'utf8');
        return { format: /\.json$/i.test(file) ? 'json' : 'plist', content };
    }

    /** A contributed theme, with its `include` chain and any `.tmTheme` read. */
    theme(id: string): ResolvedTheme | null {
        const entry = this.themeEntries.get(id);
        if (!entry) {
            return null;
        }
        const file = contributionFile(entry.extension, entry.theme.path);
        if (!file) {
            return null;
        }
        const colors: Record<string, string> = {};
        const tokenColors: ThemeTokenRule[] = [];
        let semanticHighlighting = false;
        loadThemeFile(entry.extension, file, colors, tokenColors, (value) => { semanticHighlighting = value; }, 0);
        return { id, label: entry.label, uiTheme: entry.uiTheme, colors, tokenColors, semanticHighlighting };
    }
}

/** Reads a theme file into `colors` and `tokenColors`, following `include` first (the including file wins). */
function loadThemeFile(extension: LoadedExtension, file: string, colors: Record<string, string>, tokenColors: ThemeTokenRule[], semantic: (value: boolean) => void, depth: number): void {
    if (depth > 8) {
        throw new Error('Theme include chain too deep.');
    }
    const relative = (target: string): string | null => {
        const absolute = path.resolve(path.dirname(file), target);
        return contributionFile(extension, path.relative(extension.location, absolute).split(path.sep).join('/'));
    };
    if (/\.tmTheme$/i.test(file)) {
        const tm = readTmTheme(fs.readFileSync(file, 'utf8'));
        Object.assign(colors, { ...tm.colors, ...colors });
        tokenColors.push(...tm.rules);
        return;
    }
    const json = record(readJsonc(file));
    if (typeof json.include === 'string') {
        const included = relative(json.include);
        if (included) {
            loadThemeFile(extension, included, colors, tokenColors, semantic, depth + 1);
        }
    }
    for (const [key, value] of Object.entries(record(json.colors))) {
        if (typeof value === 'string') {
            colors[key] = value;
        }
    }
    if (typeof json.semanticHighlighting === 'boolean') {
        semantic(json.semanticHighlighting);
    }
    if (typeof json.tokenColors === 'string') {
        const tm = relative(json.tokenColors);
        if (tm) {
            loadThemeFile(extension, tm, colors, tokenColors, semantic, depth + 1);
        }
    } else {
        tokenColors.push(...toRules(json.tokenColors));
    }
}

function toRules(raw: unknown): ThemeTokenRule[] {
    const rules: ThemeTokenRule[] = [];
    for (const item of list(raw)) {
        const settings = record(item.settings);
        const scope = typeof item.scope === 'string' ? item.scope.split(',').map((s) => s.trim()).filter(Boolean) : strings(item.scope);
        const rule: { scope: string[]; foreground?: string; background?: string; fontStyle?: string } = { scope };
        for (const key of ['foreground', 'background', 'fontStyle'] as const) {
            if (typeof settings[key] === 'string') {
                rule[key] = settings[key] as string;
            }
        }
        if (rule.foreground || rule.background || rule.fontStyle !== undefined) {
            rules.push(rule);
        }
    }
    return rules;
}

/** A `.tmTheme`: its first scope-less entry holds the editor colours, the rest are token rules. */
export function readTmTheme(text: string): { colors: Record<string, string>; rules: ThemeTokenRule[] } {
    const root = parsePlist(text) as Record<string, PlistValue> | null;
    const settings = Array.isArray(root?.settings) ? root.settings : [];
    const colors: Record<string, string> = {};
    const map: Record<string, string> = {
        background: 'editor.background',
        foreground: 'editor.foreground',
        caret: 'editorCursor.foreground',
        selection: 'editor.selectionBackground',
        lineHighlight: 'editor.lineHighlightBackground',
        invisibles: 'editorWhitespace.foreground',
        findHighlight: 'editor.findMatchHighlightBackground',
    };
    const entries = settings.map(record);
    const global = entries.find((entry) => entry.scope === undefined);
    for (const [key, value] of Object.entries(record(global?.settings))) {
        if (typeof value === 'string' && map[key]) {
            colors[map[key]] = value;
        }
    }
    return { colors, rules: toRules(entries.filter((entry) => entry !== global)) };
}

/** A snippets file: `{ name: { prefix, body, description, scope } }`. */
export function parseSnippets(json: unknown, extensionId: string, language: string | null): ContributedSnippet[] {
    const out: ContributedSnippet[] = [];
    for (const [name, raw] of Object.entries(record(json))) {
        const snippet = record(raw);
        const prefixes = strings(snippet.prefix);
        const body = Array.isArray(snippet.body) ? strings(snippet.body).join('\n') : str(snippet.body);
        if (prefixes.length === 0 || body === null) {
            continue;
        }
        const languages = language ? [language] : (str(snippet.scope)?.split(',').map((s) => s.trim()).filter(Boolean) ?? ['*']);
        for (const lang of languages) {
            out.push({ extensionId, language: lang, name, prefixes, body, description: str(snippet.description) ?? '' });
        }
    }
    return out;
}
