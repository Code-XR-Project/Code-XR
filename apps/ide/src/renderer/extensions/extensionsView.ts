import type { ExtensionId, ExtensionsApi, GalleryDetails, GalleryExtension, InstalledDetails, InstalledExtension, InstallResult } from '../../shared/extensions.ts';
import { el, icon } from '../dom.ts';
import { compactCount, installedStateLabel, matchesInstalled, rowAction } from './extensionsModel.ts';

/**
 * The Extensions view (#255): the installed extensions, a search of the Open
 * VSX registry, and a details page over the editor area with the README.
 * Nothing goes online until the person types a search or opens a registry
 * page. Install and Uninstall always end in a native confirmation in the
 * main process (the renderer cannot answer it).
 */

export interface ExtensionsView {
    focusSearch(text?: string): void;
    /** The list changed (an event from the main process). */
    setInstalled(installed: readonly InstalledExtension[]): void;
    showDetails(id: ExtensionId): void;
    installVsix(): Promise<void>;
}

export interface ExtensionsViewHooks {
    onStatus(message: string): void;
    notify(kind: 'info' | 'warning' | 'error', message: string): void;
    openExternalLink(url: string): void;
    /** Where the details page goes: the workbench root (it sits over the editor area). */
    readonly detailsHost: HTMLElement;
    /** Builds the README view (the Markdown preview of #179, loaded on first use). */
    renderMarkdown(text: string, container: HTMLElement): Promise<void>;
    /** After an install: offers the colour themes it brought, for example. */
    afterInstall(extension: InstalledExtension): void;
}

const ICONS = {
    vsix: 'M12 4v11M7 10l5 5 5-5M5 19h14',
    refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
    verified: 'M12 2l2.4 2.1 3.2-.3.7 3.1 2.8 1.6-1.3 2.9 1.3 2.9-2.8 1.6-.7 3.1-3.2-.3L12 22l-2.4-2.1-3.2.3-.7-3.1-2.8-1.6 1.3-2.9-1.3-2.9 2.8-1.6.7-3.1 3.2.3zM8.5 12l2.5 2.5 4.5-5',
    close: 'M6 6l12 12M18 6L6 18',
    puzzle: 'M4 4h7v7H4zM4 13h7v7H4zM13 13h7v7h-7zM16.5 3l4.5 4.5L16.5 12 12 7.5z',
};

const SEARCH_DELAY_MS = 350;
const PAGE = 30;

export function createExtensionsView(container: HTMLElement, api: ExtensionsApi, hooks: ExtensionsViewHooks): ExtensionsView {
    let installed: readonly InstalledExtension[] = [];
    let results: GalleryExtension[] = [];
    let total = 0;
    let query = '';
    let searchSeq = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const busy = new Set<ExtensionId>();
    const iconCache = new Map<string, Promise<string | null>>();

    const iconButton = (label: string, path: string, testId: string, run: () => void): HTMLButtonElement => {
        const button = el('button', { className: 'icon-button', attrs: { type: 'button', title: label, 'aria-label': label, 'data-testid': testId } }, [icon(path)]);
        button.addEventListener('click', run);
        return button;
    };

    const searchField = el('input', { className: 'search-input extensions-search', attrs: { type: 'search', placeholder: 'Search extensions in Open VSX', 'aria-label': 'Search extensions in Open VSX', spellcheck: 'false', 'data-testid': 'extensions-search' } });
    const installedList = el('ul', { className: 'extensions-list', attrs: { 'aria-label': 'Installed extensions', 'data-testid': 'extensions-installed' } });
    const resultsList = el('ul', { className: 'extensions-list', attrs: { 'aria-label': 'Open VSX results', 'data-testid': 'extensions-results' } });
    const installedTitle = el('h3', { className: 'extensions-section-title', text: 'Installed' });
    const resultsTitle = el('h3', { className: 'extensions-section-title', text: 'Open VSX' });
    const resultsNote = el('p', { className: 'muted side-note', attrs: { 'data-testid': 'extensions-results-note' } });
    const more = el('button', { className: 'secondary-button extensions-more', text: 'Show more', attrs: { type: 'button', hidden: '' } });
    const popular = el('button', { className: 'secondary-button extensions-more', text: 'Browse popular extensions', attrs: { type: 'button', 'data-testid': 'extensions-popular' } });
    const resultsSection = el('section', { className: 'extensions-section' }, [resultsTitle, resultsNote, resultsList, more]);
    const installedNote = el('p', { className: 'muted side-note', text: 'No extensions installed yet. Search Open VSX above, or install a .vsix file.' });
    const installedSection = el('section', { className: 'extensions-section' }, [installedTitle, installedNote, installedList, popular]);

    container.append(
        el('div', { className: 'side-bar-header' }, [
            el('h2', { className: 'side-bar-title', text: 'Extensions' }),
            el('div', { className: 'side-bar-actions' }, [
                iconButton('Install from VSIX…', ICONS.vsix, 'extensions-install-vsix', () => void view.installVsix()),
                iconButton('Refresh', ICONS.refresh, 'extensions-refresh', () => void refreshInstalled()),
            ]),
        ]),
        el('div', { className: 'extensions-search-row' }, [searchField]),
        el('div', { className: 'extensions-scroll' }, [resultsSection, installedSection]),
    );
    resultsSection.hidden = true;

    function installedOf(id: ExtensionId): InstalledExtension | undefined {
        return installed.find((extension) => extension.id === id);
    }

    function galleryIcon(url: string | null, img: HTMLImageElement): void {
        if (!url) {
            return;
        }
        let pending = iconCache.get(url);
        if (!pending) {
            pending = api.galleryIcon(url).catch(() => null);
            iconCache.set(url, pending);
        }
        void pending.then((data) => {
            if (data) {
                img.src = data;
                img.classList.remove('is-placeholder');
            }
        });
    }

    function iconElement(src: string | null): HTMLImageElement {
        const img = el('img', { className: 'extension-icon', attrs: { alt: '', 'aria-hidden': 'true' } });
        if (src && src.startsWith('data:')) {
            img.src = src;
            return img;
        }
        img.classList.add('is-placeholder');
        return img;
    }

    async function runInstall(id: ExtensionId, version?: string): Promise<void> {
        if (busy.has(id)) {
            return;
        }
        busy.add(id);
        render();
        hooks.onStatus(`Installing ${id}…`);
        let result: InstallResult;
        try {
            result = await api.install(id, version);
        } catch (error) {
            result = { ok: false, error: String(error) };
        }
        busy.delete(id);
        finishInstall(result);
    }

    function finishInstall(result: InstallResult): void {
        if (result.ok) {
            hooks.onStatus(`Installed ${result.extension.displayName} ${result.extension.version}.`);
            hooks.notify('info', `${result.extension.displayName} ${result.extension.version} installed${result.replaced ? ` (was ${result.replaced})` : ''}.`);
            hooks.afterInstall(result.extension);
        } else if (!result.cancelled) {
            hooks.notify('error', `The extension was not installed: ${result.error}`);
            hooks.onStatus('');
        } else {
            hooks.onStatus('');
        }
        void refreshInstalled();
    }

    async function toggle(extension: InstalledExtension): Promise<void> {
        await api.setEnabled(extension.id, extension.state === 'disabled');
    }

    async function uninstall(extension: InstalledExtension): Promise<void> {
        busy.add(extension.id);
        render();
        try {
            if (await api.uninstall(extension.id)) {
                hooks.notify('info', `${extension.displayName} uninstalled.`);
            }
        } catch (error) {
            hooks.notify('error', `Could not uninstall ${extension.displayName}: ${String(error)}`);
        } finally {
            busy.delete(extension.id);
            void refreshInstalled();
        }
    }

    function actionButton(label: string, testId: string, run: () => void, primary = false): HTMLButtonElement {
        const button = el('button', { className: primary ? 'primary-button extension-action' : 'secondary-button extension-action', text: label, attrs: { type: 'button', 'data-testid': testId } });
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            run();
        });
        return button;
    }

    function installedRow(extension: InstalledExtension): HTMLElement {
        const state = installedStateLabel(extension);
        const actions: HTMLElement[] = [];
        if (busy.has(extension.id)) {
            actions.push(el('span', { className: 'muted extension-busy', text: 'Working…' }));
        } else {
            actions.push(actionButton(extension.state === 'disabled' ? 'Enable' : 'Disable', `extension-toggle-${extension.id}`, () => void toggle(extension)));
            actions.push(actionButton('Uninstall', `extension-uninstall-${extension.id}`, () => void uninstall(extension)));
        }
        return row(extension.id, extension.icon, extension.displayName, extension.publisher, false, extension.description, `v${extension.version}`, state, actions, () => showDetails(extension.id));
    }

    function galleryRow(extension: GalleryExtension): HTMLElement {
        const action = rowAction(extension, installedOf(extension.id), busy.has(extension.id));
        const actions: HTMLElement[] = [];
        if (action.kind === 'busy') {
            actions.push(el('span', { className: 'muted extension-busy', text: 'Installing…' }));
        } else if (action.kind === 'install' || action.kind === 'update') {
            actions.push(actionButton(action.kind === 'install' ? 'Install' : `Update to ${extension.version}`, `extension-install-${extension.id}`, () => void runInstall(extension.id), true));
        } else {
            actions.push(el('span', { className: 'muted extension-installed-mark', text: 'Installed' }));
        }
        const item = row(extension.id, null, extension.displayName, extension.namespace, extension.verified, extension.description, `${compactCount(extension.downloadCount)} downloads`, null, actions, () => showDetails(extension.id, extension));
        const img = item.querySelector('img');
        if (img) {
            galleryIcon(extension.iconUrl, img);
        }
        return item;
    }

    function row(id: string, iconSrc: string | null, name: string, publisher: string, verified: boolean, description: string, meta: string, state: string | null, actions: HTMLElement[], open: () => void): HTMLElement {
        const publisherLine = el('span', { className: 'extension-publisher' }, [document.createTextNode(publisher)]);
        if (verified) {
            publisherLine.append(el('span', { className: 'extension-verified', attrs: { title: 'Verified publisher', 'aria-label': 'verified publisher' } }, [icon(ICONS.verified)]));
        }
        const item = el('li', { className: 'extension-row', attrs: { tabindex: '0', role: 'button', 'data-extension-id': id, 'data-testid': `extension-row-${id}` } }, [
            iconElement(iconSrc),
            el('div', { className: 'extension-main' }, [
                el('div', { className: 'extension-title-line' }, [
                    el('span', { className: 'extension-name', text: name }),
                    el('span', { className: 'extension-meta muted', text: meta }),
                ]),
                el('div', { className: 'extension-description', text: description }),
                el('div', { className: 'extension-footer' }, [publisherLine, ...(state ? [el('span', { className: 'extension-state', text: state })] : []), el('span', { className: 'extension-actions' }, actions)]),
            ]),
        ]);
        item.addEventListener('click', open);
        item.addEventListener('keydown', (event) => {
            if ((event.key === 'Enter' || event.key === ' ') && event.target === item) {
                event.preventDefault();
                open();
            }
        });
        return item;
    }

    function render(): void {
        const filter = query.trim();
        const shownInstalled = installed.filter((extension) => matchesInstalled(extension, filter));
        installedList.replaceChildren(...shownInstalled.map(installedRow));
        installedNote.hidden = installed.length > 0;
        installedTitle.textContent = filter ? `Installed (${shownInstalled.length})` : `Installed (${installed.length})`;
        resultsList.replaceChildren(...results.map(galleryRow));
        more.hidden = results.length >= total || results.length === 0;
    }

    async function refreshInstalled(): Promise<void> {
        try {
            installed = await api.list();
        } catch (error) {
            hooks.notify('error', `Could not list the extensions: ${String(error)}`);
        }
        render();
        if (details && detailsId) {
            void fillDetails(detailsId, detailsGallery);
        }
    }

    async function search(text: string, offset: number, sortBy?: 'downloadCount'): Promise<void> {
        const seq = ++searchSeq;
        resultsSection.hidden = false;
        resultsTitle.textContent = sortBy ? 'Popular on Open VSX' : 'Open VSX';
        resultsNote.textContent = 'Searching…';
        try {
            const page = await api.search({ text, offset, size: PAGE, ...(sortBy ? { sortBy } : {}) });
            if (seq !== searchSeq) {
                return;
            }
            results = offset === 0 ? [...page.extensions] : [...results, ...page.extensions];
            total = page.totalSize;
            resultsNote.textContent = total === 0 ? 'No extension matches.' : `${total.toLocaleString()} found`;
        } catch (error) {
            if (seq !== searchSeq) {
                return;
            }
            results = [];
            total = 0;
            resultsNote.textContent = `The registry could not be searched: ${errorText(error)}`;
        }
        render();
    }

    let lastSort: 'downloadCount' | undefined;
    searchField.addEventListener('input', () => {
        query = searchField.value;
        clearTimeout(timer);
        render();
        if (query.trim() === '') {
            searchSeq++;
            results = [];
            resultsSection.hidden = true;
            render();
            return;
        }
        timer = setTimeout(() => {
            lastSort = undefined;
            void search(query.trim(), 0);
        }, SEARCH_DELAY_MS);
    });
    searchField.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            clearTimeout(timer);
            lastSort = undefined;
            void search(query.trim(), 0);
        }
    });
    more.addEventListener('click', () => void search(lastSort ? '' : query.trim(), results.length, lastSort));
    popular.addEventListener('click', () => {
        lastSort = 'downloadCount';
        void search('', 0, 'downloadCount');
    });

    // --- The details page, over the editor area.
    let details: HTMLElement | null = null;
    let detailsId: ExtensionId | null = null;
    let detailsGallery: GalleryExtension | undefined;
    const closeDetails = (): void => {
        details?.remove();
        details = null;
        detailsId = null;
    };

    function showDetails(id: ExtensionId, gallery?: GalleryExtension): void {
        detailsId = id;
        detailsGallery = gallery;
        if (!details) {
            details = el('section', { className: 'extension-details', attrs: { 'aria-label': 'Extension details', 'data-testid': 'extension-details', tabindex: '-1' } });
            details.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    closeDetails();
                }
            });
            hooks.detailsHost.append(details);
        }
        details.replaceChildren(el('p', { className: 'muted extension-details-loading', text: 'Loading…' }));
        details.focus();
        void fillDetails(id, gallery);
    }

    async function fillDetails(id: ExtensionId, gallery?: GalleryExtension): Promise<void> {
        const local = installedOf(id);
        let installedDetails: InstalledDetails | null = null;
        let remote: GalleryDetails | null = null;
        let remoteError: string | null = null;
        if (local) {
            installedDetails = await api.details(id).catch(() => null);
        } else {
            try {
                remote = await api.galleryDetails(id);
            } catch (error) {
                remoteError = errorText(error);
            }
        }
        if (!details || detailsId !== id) {
            return;
        }
        const extension = installedDetails?.extension;
        const name = extension?.displayName ?? remote?.displayName ?? gallery?.displayName ?? id;
        const head = el('header', { className: 'extension-details-head' });
        const img = iconElement(extension?.icon ?? null);
        img.classList.add('is-large');
        if (!extension) {
            galleryIcon(remote?.iconUrl ?? gallery?.iconUrl ?? null, img);
        }
        const facts: [string, string][] = [];
        const publisher = extension?.publisher ?? remote?.publisherDisplayName ?? gallery?.namespace ?? '';
        facts.push(['Identifier', id]);
        facts.push(['Version', extension?.version ?? remote?.version ?? gallery?.version ?? '']);
        const license = extension?.license ?? remote?.license;
        if (license) {
            facts.push(['Licence', license]);
        }
        if (remote) {
            facts.push(['Downloads', remote.downloadCount.toLocaleString()]);
        }
        const engine = extension?.engine ?? remote?.engine;
        if (engine) {
            facts.push(['VS Code API', engine]);
        }
        if (extension) {
            facts.push(['Source', extension.source === 'open-vsx' ? 'Open VSX' : '.vsix file']);
            facts.push(['State', installedStateLabel(extension)]);
        }
        const actions: HTMLElement[] = [];
        if (extension) {
            actions.push(actionButton(extension.state === 'disabled' ? 'Enable' : 'Disable', 'extension-details-toggle', () => void toggle(extension)));
            actions.push(actionButton('Uninstall', 'extension-details-uninstall', () => void uninstall(extension)));
        } else if (remote || gallery) {
            actions.push(actionButton(busy.has(id) ? 'Installing…' : 'Install', 'extension-details-install', () => void runInstall(id), true));
        }
        const repository = extension?.repository ?? remote?.repository ?? remote?.homepage ?? null;
        if (repository) {
            actions.push(actionButton('Repository', 'extension-details-repository', () => hooks.openExternalLink(repository)));
        }
        const publisherLine = el('p', { className: 'extension-details-publisher' }, [document.createTextNode(publisher)]);
        if (remote?.verified ?? gallery?.verified) {
            publisherLine.append(el('span', { className: 'extension-verified', attrs: { title: 'Verified publisher' } }, [icon(ICONS.verified)]), document.createTextNode(' verified'));
        }
        const closeButton = iconButton('Close', ICONS.close, 'extension-details-close', closeDetails);
        head.append(img, el('div', { className: 'extension-details-title' }, [
            el('h2', { text: name }),
            publisherLine,
            el('p', { className: 'extension-details-description', text: extension?.description ?? remote?.description ?? gallery?.description ?? '' }),
            el('div', { className: 'extension-details-actions' }, actions),
        ]), closeButton);
        const factList = el('dl', { className: 'extension-details-facts' }, facts.flatMap(([term, value]) => [el('dt', { text: term }), el('dd', { text: value })]));
        const body = el('div', { className: 'extension-details-body' });
        const side = el('aside', { className: 'extension-details-side' }, [factList]);
        if (extension) {
            side.append(contributionsList(extension));
            if (extension.activationError) {
                side.append(el('p', { className: 'error', text: `Activation failed: ${extension.activationError}` }));
            }
        }
        const readme = installedDetails?.readme ?? remote?.readme ?? null;
        const readmeHost = el('article', { className: 'extension-details-readme', attrs: { 'data-testid': 'extension-details-readme' } });
        if (remoteError) {
            readmeHost.append(el('p', { className: 'error', text: `The registry could not be reached: ${remoteError}` }));
        } else if (readme) {
            void hooks.renderMarkdown(readme, readmeHost).catch((error: unknown) => readmeHost.append(el('p', { className: 'error', text: `The README could not be shown: ${String(error)}` })));
        } else {
            readmeHost.append(el('p', { className: 'muted', text: 'This extension has no README.' }));
        }
        body.append(readmeHost, side);
        details.replaceChildren(head, body);
    }

    function contributionsList(extension: InstalledExtension): HTMLElement {
        const c = extension.contributes;
        const items: [string, string][] = [];
        const names = (values: readonly string[]): string => values.slice(0, 12).join(', ') + (values.length > 12 ? ` and ${values.length - 12} more` : '');
        if (c.themes.length) { items.push(['Colour themes', names(c.themes)]); }
        if (c.iconThemes.length) { items.push(['Icon themes (not supported yet)', names(c.iconThemes)]); }
        if (c.languages.length) { items.push(['Languages', names(c.languages)]); }
        if (c.grammars) { items.push(['Grammars', String(c.grammars)]); }
        if (c.snippets) { items.push(['Snippet files', String(c.snippets)]); }
        if (c.commands.length) { items.push(['Commands', names(c.commands)]); }
        if (c.views.length) { items.push(['Views', names(c.views)]); }
        if (c.settings) { items.push(['Settings', String(c.settings)]); }
        if (c.keybindings) { items.push(['Keybindings', String(c.keybindings)]); }
        if (c.localizations.length) { items.push(['Language packs (VS Code UI only)', names(c.localizations)]); }
        return el('section', { className: 'extension-details-contributions' }, [
            el('h3', { text: 'Contributes' }),
            items.length ? el('dl', { className: 'extension-details-facts' }, items.flatMap(([term, value]) => [el('dt', { text: term }), el('dd', { text: value })])) : el('p', { className: 'muted', text: 'Nothing declarative.' }),
            el('p', { className: 'muted', text: extension.hasCode ? `Runs code (${extension.activation === 'active' ? 'active' : extension.activation === 'failed' ? 'failed to activate' : 'activates when needed'}).` : 'Runs no code.' }),
        ]);
    }

    const view: ExtensionsView = {
        focusSearch(text?: string): void {
            if (text !== undefined) {
                searchField.value = text;
                searchField.dispatchEvent(new Event('input'));
            }
            searchField.focus();
        },
        setInstalled(list: readonly InstalledExtension[]): void {
            installed = list;
            render();
            if (details && detailsId) {
                void fillDetails(detailsId, detailsGallery);
            }
        },
        showDetails(id: ExtensionId): void {
            showDetails(id);
        },
        async installVsix(): Promise<void> {
            hooks.onStatus('Choose a .vsix file…');
            let result: InstallResult;
            try {
                result = await api.installVsix();
            } catch (error) {
                result = { ok: false, error: String(error) };
            }
            finishInstall(result);
        },
    };
    void refreshInstalled();
    return view;
}

function errorText(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    // Electron prefixes errors that cross IPC with the channel name.
    return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
