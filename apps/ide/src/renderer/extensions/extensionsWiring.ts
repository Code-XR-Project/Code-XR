import type { CodeXRApi } from '../../shared/api.ts';
import type { ContributedTheme, InstalledExtension } from '../../shared/extensions.ts';
import type { CommandRegistry } from '../commands/commandRegistry.ts';
import { createContributionsController, type ContributionsController } from './contributionsController.ts';
import { createExtensionsView, type ExtensionsView } from './extensionsView.ts';
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

    api.extensions.onDidChange((event) => {
        view.setInstalled(event.installed);
        void contributions.reload();
    });
    void contributions.reload();

    const commands = [
        { id: 'extensions.showView', category: 'Extensions', title: 'Show Extensions', keybinding: 'CmdOrCtrl+Shift+X', run: () => { deps.showView(); view.focusSearch(); } },
        { id: 'extensions.installVsix', category: 'Extensions', title: 'Install from VSIX…', run: () => { deps.showView(); void view.installVsix(); } },
        { id: 'extensions.showInstalled', category: 'Extensions', title: 'Show Installed Extensions', run: () => { deps.showView(); view.focusSearch(''); } },
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
    };
}
