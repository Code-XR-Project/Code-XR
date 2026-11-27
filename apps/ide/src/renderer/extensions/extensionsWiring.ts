import type { CodeXRApi } from '../../shared/api.ts';
import type { ContributedTheme, InstalledExtension } from '../../shared/extensions.ts';
import type { CommandRegistry } from '../commands/commandRegistry.ts';
import type { QuickInputProvider } from '../commands/quickInput.ts';
import type { NotificationCenter } from '../notifications.ts';
import { createContributionsController, type ContributionsController } from './contributionsController.ts';
import { createExtensionsView, type ExtensionsView } from './extensionsView.ts';
import { createHostBridge } from './hostBridge.ts';
import './extensions.css';

/**
 * Wires the extensions (#251) into the workbench, so main.ts only calls
 * `installExtensions` and asks for the themes: the Extensions view, the
 * declarative contributions, and the palette commands.
 */

export interface ExtensionsWorkbench {
    readonly view: ExtensionsView;
    readonly contributions: ContributionsController;
    /** The colour themes of the enabled extensions, for the theme picker. */
    themes(): readonly ContributedTheme[];
    /** #259: Monaco is loaded: fire `onLanguage:` for every model's language from now on. */
    watchEditorLanguages(): void;
}

export interface ExtensionsWorkbenchDeps {
    readonly api: CodeXRApi;
    readonly registry: CommandRegistry;
    readonly viewContainer: HTMLElement;
    readonly detailsHost: HTMLElement;
    showView(): void;
    onStatus(message: string): void;
    notify(kind: 'info' | 'warning' | 'error', message: string): void;
    /** Opens the colour theme picker (after installing a theme). */
    selectColorTheme(): void;
    /** #259: what the extension host shows through the workbench. */
    readonly notifications: NotificationCenter;
    readonly statusLeft: HTMLElement;
    readonly statusRight: HTMLElement;
    openQuickInput(value: string, provider: QuickInputProvider): void;
    /** Opens a file of the folder (relative path), at a 1-based line and column when given. */
    openFile(path: string, line?: number, column?: number): Promise<void>;
}

export function installExtensions(deps: ExtensionsWorkbenchDeps): ExtensionsWorkbench {
    const { api } = deps;
    const contributions = createContributionsController(api.extensions, (message) => deps.notify('warning', message));
    const view = createExtensionsView(deps.viewContainer, api.extensions, {
        onStatus: deps.onStatus,
        notify: deps.notify,
        openExternalLink: (url) => void api.workspace.openExternalLink(url).catch((error: unknown) => deps.notify('error', String(error))),
        detailsHost: deps.detailsHost,
        async renderMarkdown(text, container) {
            const { createMarkdownPreview } = await import('../editor/markdownPreview.ts');
            const preview = createMarkdownPreview({
                readImage: async () => null,
                openExternalLink: (url) => api.workspace.openExternalLink(url),
                openFile: () => undefined,
                onStatus: deps.onStatus,
                onClose: () => undefined,
            });
            container.replaceChildren(preview.element);
            preview.show('README.md', text);
        },
        afterInstall(extension: InstalledExtension) {
            if (extension.contributes.themes.length > 0 && extension.state === 'enabled') {
                deps.notify('info', `${extension.displayName} adds colour themes: pick one with Preferences: Color Theme (Ctrl+K Ctrl+T).`);
            }
        },
    });

    // #259: the extension host's requests, status bar items and the palette's commands.
    const bridge = createHostBridge({
        extensions: api.extensions,
        registry: deps.registry,
        notifications: deps.notifications,
        statusLeft: deps.statusLeft,
        statusRight: deps.statusRight,
        openQuickInput: deps.openQuickInput,
        openFile: deps.openFile,
        setStatus: deps.onStatus,
        searchExtensions: (query) => {
            deps.showView();
            view.focusSearch(query);
        },
    });
    let installed: readonly InstalledExtension[] = [];
    const refresh = async (): Promise<void> => {
        await contributions.reload();
        bridge.setCommands(contributions.current().commands, installed);
    };
    api.extensions.onDidChange((event) => {
        installed = event.installed;
        view.setInstalled(event.installed);
        void refresh();
    });
    void api.extensions.list().then((list) => {
        installed = list;
        return refresh();
    }).catch((error: unknown) => deps.notify('error', `Could not list the extensions: ${String(error)}`));
    const firedLanguages = new Set<string>();
    const fireLanguage = (languageId: string): void => {
        if (!firedLanguages.has(languageId)) {
            firedLanguages.add(languageId);
            api.extensions.activateByEvent(`onLanguage:${languageId}`).catch(() => undefined);
        }
    };
    api.extensions.onDidChange(() => firedLanguages.clear());

    const commands = [
        { id: 'extensions.showView', category: 'Extensions', title: 'Show Extensions', keybinding: 'CmdOrCtrl+Shift+X', run: () => { deps.showView(); view.focusSearch(); } },
        { id: 'extensions.installVsix', category: 'Extensions', title: 'Install from VSIX…', run: () => { deps.showView(); void view.installVsix(); } },
        { id: 'extensions.showInstalled', category: 'Extensions', title: 'Show Installed Extensions', run: () => { deps.showView(); view.focusSearch(''); } },
        { id: 'extensions.restartHost', category: 'Developer', title: 'Restart Extension Host', run: () => void api.extensions.restartHost() },
        { id: 'extensions.searchThemes', category: 'Extensions', title: 'Browse Colour Themes in Open VSX', run: () => { deps.showView(); view.focusSearch('theme'); } },
        {
            id: 'extensions.disableAll',
            category: 'Extensions',
            title: 'Disable All Installed Extensions',
            run: () => void api.extensions.disableAll().then(() => deps.notify('info', 'Every extension was disabled. Enable them again one by one in the Extensions view.')),
        },
    ];
    for (const command of commands) {
        deps.registry.register(command);
    }

    return {
        view,
        contributions,
        themes: () => contributions.current().themes,
        watchEditorLanguages() {
            void import('./monacoContributions.ts').then((part) => part.watchModelLanguages(fireLanguage));
        },
    };
}
