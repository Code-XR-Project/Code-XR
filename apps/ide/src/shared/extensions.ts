/**
 * VS Code extensions in the IDE (epic #251, ADR 0002): the contract between
 * the renderer and the main process. Extensions come from Open VSX (never the
 * Visual Studio Marketplace) or from a `.vsix` file, are unpacked into the
 * IDE's user-data folder, and contribute either declaratively (themes,
 * languages, grammars, snippets: applied by the workbench itself) or with
 * code, which runs in the extension host process, never in the renderer.
 *
 * Shared by main, preload and renderer: no Node, Electron or DOM import.
 */

import type { HostUiEvent } from './extensionHostProtocol.ts';
import type { DocumentEvent, ProvideRequest } from './extensionLanguageProtocol.ts';
import type { IconData, ViewRequest } from './extensionViewsProtocol.ts';

/** `publisher.name`, lower-cased: VS Code compares extension ids without case. */
export type ExtensionId = string;

/** The canonical id of an extension, as VS Code builds it. */
export function extensionIdOf(publisher: string, name: string): ExtensionId {
    return `${publisher}.${name}`.toLowerCase();
}

/** A well-formed `publisher.name` id: what the renderer may send for an extension. */
export function isExtensionId(value: unknown): value is ExtensionId {
    return typeof value === 'string' && value.length <= 256 && /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/i.test(value);
}

/** Why an installed extension does not run, when it does not. */
export type ExtensionRunState =
    /** Enabled; its code (if any) activates on its activation events. */
    | 'enabled'
    /** Turned off by the person. */
    | 'disabled'
    /** #263: the folder is in Restricted Mode and the extension does not declare it supports that. */
    | 'restricted';

/** Where the activation of an extension with code stands in this window's host. */
export type ExtensionActivation = 'none' | 'inactive' | 'activating' | 'active' | 'failed';

/** What an extension contributes, as counts and names for the Extensions view. */
export interface ContributionSummary {
    readonly themes: readonly string[];
    readonly iconThemes: readonly string[];
    readonly languages: readonly string[];
    readonly grammars: number;
    readonly snippets: number;
    readonly commands: readonly string[];
    readonly views: readonly string[];
    readonly settings: number;
    readonly keybindings: number;
    readonly localizations: readonly string[];
}

/** An installed extension, as the Extensions view lists it. */
export interface InstalledExtension {
    readonly id: ExtensionId;
    readonly publisher: string;
    readonly name: string;
    readonly version: string;
    readonly displayName: string;
    readonly description: string;
    readonly categories: readonly string[];
    readonly license: string | null;
    readonly repository: string | null;
    /** Its icon as a `data:` URL (small PNG/SVG), or null. */
    readonly icon: string | null;
    /** Whether it has code to run (`main`), not only declarative contributions. */
    readonly hasCode: boolean;
    readonly state: ExtensionRunState;
    readonly activation: ExtensionActivation;
    /** The error of a failed activation, for the view. */
    readonly activationError?: string;
    /** `engines.vscode` as declared. */
    readonly engine: string;
    /** Its `engines.vscode` asks for a newer API than the host implements: it still runs, with a warning. */
    readonly engineWarning: boolean;
    /** Open VSX or a `.vsix` file. */
    readonly source: 'open-vsx' | 'vsix';
    readonly installedAt: number;
    readonly contributes: ContributionSummary;
    /** True when it supports Restricted Mode (`capabilities.untrustedWorkspaces.supported`). */
    readonly supportsUntrusted: boolean;
}

/** An extension in the registry's search results. */
export interface GalleryExtension {
    readonly id: ExtensionId;
    readonly namespace: string;
    readonly name: string;
    readonly version: string;
    readonly displayName: string;
    readonly description: string;
    /** An https URL on the registry, shown through the main process (see `galleryIcon`). */
    readonly iconUrl: string | null;
    readonly downloadCount: number;
    readonly averageRating: number | null;
    /** The registry vouches for the publisher (Open VSX: `verified`). */
    readonly verified: boolean;
    readonly timestamp: string | null;
}

export interface GallerySearchResult {
    readonly offset: number;
    readonly totalSize: number;
    readonly extensions: readonly GalleryExtension[];
}

export const GALLERY_SORTS = ['relevance', 'downloadCount', 'averageRating', 'timestamp'] as const;
export type GallerySort = (typeof GALLERY_SORTS)[number];

export interface GalleryQuery {
    readonly text: string;
    readonly category?: string;
    readonly sortBy?: GallerySort;
    readonly offset?: number;
    readonly size?: number;
}

/** The details page of an extension in the registry. */
export interface GalleryDetails extends GalleryExtension {
    readonly publisherDisplayName: string;
    readonly license: string | null;
    readonly repository: string | null;
    readonly homepage: string | null;
    readonly categories: readonly string[];
    readonly tags: readonly string[];
    readonly engine: string | null;
    /** Versions offered, newest first. */
    readonly versions: readonly string[];
    readonly readme: string | null;
    /** Target platforms this version is published for (`universal` when one build fits all). */
    readonly targetPlatforms: readonly string[];
}

/** What `install` reports. */
export type InstallResult =
    | { readonly ok: true; readonly extension: InstalledExtension; readonly replaced: string | null }
    | { readonly ok: false; readonly cancelled?: boolean; readonly error: string };

/** The README of an installed extension, for its details tab. */
export interface InstalledDetails {
    readonly extension: InstalledExtension;
    readonly readme: string | null;
    readonly changelog: string | null;
}

// --- Declarative contributions, resolved by the main process for the workbench (#257, #258).

/** A colour theme contributed by an extension, as the theme picker lists it. */
export interface ContributedTheme {
    /** `<extension id>/<theme id or label>`: what the `workbench.colorTheme` setting stores. */
    readonly id: string;
    readonly label: string;
    readonly extensionId: ExtensionId;
    /** VS Code's base: `vs` (light), `vs-dark`, `hc-black`, `hc-light`. */
    readonly uiTheme: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
}

/** A theme file resolved: `include` chains merged, `.tmTheme` read. */
export interface ResolvedTheme {
    readonly id: string;
    readonly label: string;
    readonly uiTheme: ContributedTheme['uiTheme'];
    readonly colors: Readonly<Record<string, string>>;
    readonly tokenColors: readonly ThemeTokenRule[];
    readonly semanticHighlighting: boolean;
}

export interface ThemeTokenRule {
    readonly scope: readonly string[];
    readonly foreground?: string;
    readonly background?: string;
    readonly fontStyle?: string;
}

/** A language contributed by an extension. */
export interface ContributedLanguage {
    readonly id: string;
    readonly extensionId: ExtensionId;
    readonly aliases: readonly string[];
    readonly extensions: readonly string[];
    readonly filenames: readonly string[];
    readonly filenamePatterns: readonly string[];
    readonly firstLine: string | null;
    readonly mimetypes: readonly string[];
    /** The parsed `language-configuration.json`, if any (JSON with comments, already parsed). */
    readonly configuration: unknown;
}

/** A TextMate grammar contributed by an extension. */
export interface ContributedGrammar {
    readonly extensionId: ExtensionId;
    readonly language: string | null;
    readonly scopeName: string;
    /** Opaque handle to fetch its content with `grammarContent`. */
    readonly ref: string;
    readonly embeddedLanguages: Readonly<Record<string, string>>;
    readonly tokenTypes: Readonly<Record<string, string>>;
    readonly injectTo: readonly string[];
}

/** The text of a grammar file and its format. */
export interface GrammarContent {
    readonly format: 'json' | 'plist';
    readonly content: string;
}

/** One snippet, as `contributes.snippets` files hold them. */
export interface ContributedSnippet {
    readonly extensionId: ExtensionId;
    readonly language: string;
    readonly name: string;
    readonly prefixes: readonly string[];
    readonly body: string;
    readonly description: string;
}

/** A command of `contributes.commands` (#259): the palette lists it, the extension host runs it. */
export interface ContributedCommand {
    readonly extensionId: ExtensionId;
    readonly command: string;
    readonly title: string;
    readonly category: string | null;
    /** `menus.commandPalette` hides it (`"when": "false"`): it runs, but the palette does not list it. */
    readonly hiddenFromPalette: boolean;
    /** #261: `menus.commandPalette`'s other `when` clause: the palette lists it only while that holds. */
    readonly paletteWhen: string | null;
    /** #261: `enablement`: menus show it disabled while that does not hold. */
    readonly enablement: string | null;
    /** #261: its icon, for menus that show icons (`view/title`, inline item actions, `editor/title`). */
    readonly icon: IconData | null;
}

/** #261: `contributes.viewsContainers`: an activity bar item of its own (panel containers are shown there too). */
export interface ContributedViewContainer {
    readonly id: string;
    readonly extensionId: ExtensionId;
    readonly title: string;
    readonly icon: IconData | null;
}

/** #261: a view of `contributes.views`. */
export interface ContributedView {
    readonly id: string;
    readonly extensionId: ExtensionId;
    /** `explorer`, `scm`, `debug` or a contributed container's id. */
    readonly container: string;
    readonly name: string;
    readonly when: string | null;
    readonly type: 'tree' | 'webview';
    /** `visibility: "collapsed"`: the section starts folded. */
    readonly collapsed: boolean;
}

/** #261: `contributes.viewsWelcome`: what an empty view shows. */
export interface ContributedViewWelcome {
    readonly extensionId: ExtensionId;
    readonly view: string;
    readonly contents: string;
    readonly when: string | null;
}

/** #261: an entry of `contributes.menus`. */
export interface ContributedMenuItem {
    readonly extensionId: ExtensionId;
    /** `view/title`, `view/item/context`, `editor/title`, `editor/context`, `explorer/context`, `editor/title/context`. */
    readonly menu: string;
    readonly command: string;
    readonly when: string | null;
    /** `navigation`, `inline`, `1_modification@2`...: the part before `@` groups, the number orders. */
    readonly group: string;
    readonly order: number;
}

/** Everything declarative the workbench applies from the enabled extensions. */
export interface ExtensionContributions {
    readonly themes: readonly ContributedTheme[];
    readonly languages: readonly ContributedLanguage[];
    readonly grammars: readonly ContributedGrammar[];
    readonly snippets: readonly ContributedSnippet[];
    readonly commands: readonly ContributedCommand[];
    /** #261: views, their containers, their welcome content and the menus. */
    readonly viewContainers: readonly ContributedViewContainer[];
    readonly views: readonly ContributedView[];
    readonly viewsWelcome: readonly ContributedViewWelcome[];
    readonly menus: readonly ContributedMenuItem[];
}

export interface ExtensionsChangedEvent {
    readonly installed: readonly InstalledExtension[];
}

/** One line for the *Extensions* channel of the Output panel. */
export interface ExtensionLogEvent {
    readonly level: 'info' | 'warn' | 'error';
    readonly message: string;
}

export interface ExtensionsApi {
    /** The installed extensions, with their state in this window. */
    list(): Promise<readonly InstalledExtension[]>;
    /** Searches the registry (network: only when the person searches). */
    search(query: GalleryQuery): Promise<GallerySearchResult>;
    /** The registry's page for an extension (README included). */
    galleryDetails(id: ExtensionId): Promise<GalleryDetails>;
    /** An icon of the registry as a `data:` URL (the CSP keeps the renderer off the network). */
    galleryIcon(url: string): Promise<string | null>;
    /** Asks, then downloads, checks and installs; `version` defaults to the latest. */
    install(id: ExtensionId, version?: string): Promise<InstallResult>;
    /** Asks for a `.vsix` file with a native dialog and installs it. */
    installVsix(): Promise<InstallResult>;
    uninstall(id: ExtensionId): Promise<boolean>;
    setEnabled(id: ExtensionId, enabled: boolean): Promise<void>;
    /** Turns every extension off (recovery). */
    disableAll(): Promise<void>;
    details(id: ExtensionId): Promise<InstalledDetails | null>;
    contributions(): Promise<ExtensionContributions>;
    /** A contributed theme, resolved; null if its extension is gone or disabled. */
    theme(themeId: string): Promise<ResolvedTheme | null>;
    grammarContent(ref: string): Promise<GrammarContent | null>;
    onDidChange(listener: (event: ExtensionsChangedEvent) => void): () => void;
    onLog(listener: (event: ExtensionLogEvent) => void): () => void;
    /** #259: the workbench is ready; starts this window's extension host if an extension with code may run. */
    hostReady(): Promise<void>;
    /** Stops and starts this window's extension host again (after a crash, or on request). */
    restartHost(): Promise<void>;
    /** Runs a command an extension contributes or registers (activating it first). */
    executeCommand(id: string, args?: readonly unknown[]): Promise<unknown>;
    /** Fires an activation event of the workbench: `onLanguage:<id>`, `onView:<id>`, `onUri`. */
    activateByEvent(event: string): Promise<void>;
    /** Answers a request of the host (`onHostUi`'s `request`), with its result or null when dismissed. */
    hostReply(id: number, result: unknown): Promise<void>;
    onHostUi(listener: (event: HostUiEvent) => void): () => void;
    /** #260: the editor's documents and active editor changed (workspace paths). */
    documentEvents(events: readonly DocumentEvent[]): Promise<void>;
    /** #260: asks an extension's language feature provider; the answer is plain data (extensionLanguageProtocol.ts). */
    provide(request: ProvideRequest): Promise<unknown>;
    /** #261: the extensions' views (tree children, clicks, menu commands, visibility); see extensionViewsProtocol.ts. */
    view(request: ViewRequest): Promise<unknown>;
}

/** Activation events the renderer may fire (the others are the main process's or the host's own). */
export function isWorkbenchActivationEvent(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 300 && /^(onLanguage|onView|onWebviewPanel|onCustomEditor|onFileSystem):[\w.\-/+#@]+$|^onUri$/.test(value);
}

export const EXTENSION_IPC_CHANNELS = {
    extensionsList: 'codexr:extensions:list',
    extensionsSearch: 'codexr:extensions:search',
    extensionsGalleryDetails: 'codexr:extensions:gallery-details',
    extensionsGalleryIcon: 'codexr:extensions:gallery-icon',
    extensionsInstall: 'codexr:extensions:install',
    extensionsInstallVsix: 'codexr:extensions:install-vsix',
    extensionsUninstall: 'codexr:extensions:uninstall',
    extensionsSetEnabled: 'codexr:extensions:set-enabled',
    extensionsDisableAll: 'codexr:extensions:disable-all',
    extensionsDetails: 'codexr:extensions:details',
    extensionsContributions: 'codexr:extensions:contributions',
    extensionsTheme: 'codexr:extensions:theme',
    extensionsGrammarContent: 'codexr:extensions:grammar-content',
    extensionsHostReady: 'codexr:extensions:host-ready',
    extensionsRestartHost: 'codexr:extensions:restart-host',
    extensionsExecuteCommand: 'codexr:extensions:execute-command',
    extensionsActivateByEvent: 'codexr:extensions:activate-by-event',
    extensionsHostReply: 'codexr:extensions:host-reply',
    extensionsDocuments: 'codexr:extensions:documents',
    extensionsProvide: 'codexr:extensions:provide',
    extensionsView: 'codexr:extensions:view',
} as const;

export const EXTENSION_IPC_EVENTS = {
    extensionsChanged: 'codexr:extensions:changed',
    extensionsLog: 'codexr:extensions:log',
    extensionsHostUi: 'codexr:extensions:host-ui',
} as const;

/** The default registry, and the setting that changes it. */
export const DEFAULT_GALLERY_URL = 'https://open-vsx.org';
export const GALLERY_URL_SETTING = 'extensions.gallery.serviceUrl';

/** Prefix of the `workbench.colorTheme` values that name an extension's theme. */
export const EXTENSION_THEME_PREFIX = 'ext:';

/** The highest VS Code API version the host implements (for `engines.vscode`). */
export const HOST_VSCODE_API_VERSION = '1.146.0';
