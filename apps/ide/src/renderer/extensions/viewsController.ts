import { commandLink, parseWelcome, type ViewNotification, type ViewRequest } from '../../shared/extensionViewsProtocol.ts';
import type { ContributedView, ContributedViewContainer, ExtensionContributions, ExtensionsApi } from '../../shared/extensions.ts';
import { whenHolds } from '../../shared/whenClause.ts';
import { showContextMenu, type ContextMenuItem } from '../contextMenu.ts';
import { el, icon } from '../dom.ts';
import type { ExtensionViewContainer, ViewId } from '../workbench.ts';
import type { ContextKeys } from './contextKeys.ts';
import { extensionIcon } from './extensionIcons.ts';
import { menuGroups, splitActions, type MenuAction, type MenuGroup } from './menuModel.ts';
import { createTreeView, type ExtensionTreeView } from './treeView.ts';
import type { WebviewHost } from './webviewHost.ts';

/**
 * #261: the views extensions contribute. Each `viewsContainers` entry gets an
 * activity item and a side-bar pane; each `views` entry is a folding section
 * in its container (or under the built-in Explorer, Source Control or Run and
 * Debug view). A section shows the tree its extension registers, its welcome
 * content while the tree is empty or missing, and its title bar's buttons
 * from `view/title`. `when` clauses are re-read whenever a context key
 * changes. Visibility goes to the host (`onView:` activation,
 * `TreeView.onDidChangeVisibility`).
 */

export interface ViewsWorkbench {
    addViewContainer(id: string, title: string, icon: Element | null): ExtensionViewContainer;
    readonly extensionSections: Readonly<Record<'explorer' | 'scm' | 'debug', HTMLElement>>;
    showView(id: ViewId): void;
    onDidChangeView(listener: (id: ViewId | null) => void): () => void;
}

export interface ViewsControllerDeps {
    readonly extensions: ExtensionsApi;
    readonly workbench: ViewsWorkbench;
    readonly contextKeys: ContextKeys;
    readonly storage: Storage | null;
    /** Runs a command of an extension (or a built-in one the host maps). */
    runCommand(command: string, args?: readonly unknown[]): void;
    openExternalLink(url: string): void;
    onError(message: string): void;
    /** #261: shows a `type: "webview"` view's frame over its slot. */
    readonly webviews: Pick<WebviewHost, 'setViewSlot'>;
}

export interface ViewsController {
    /** The contributions (or the runnable extensions) changed: rebuild the containers and sections. */
    setContributions(contributions: ExtensionContributions, runnable: ReadonlySet<string>): void;
    notification(notification: ViewNotification): void;
    /** The host started or stopped: its trees are gone. */
    reset(): void;
    /** `<view>.focus`, `workbench.view.extension.<container>`, ...: false when `id` is not one. */
    command(id: string): boolean;
    /** The groups of an extension menu in a context (`explorer/context`, `editor/title`, ...). */
    menu(menu: string, extra: Readonly<Record<string, unknown>>): MenuGroup[];
}

const CHEVRON = 'M9 6l6 6-6 6';
const MORE = 'M5 12h.01M12 12h.01M19 12h.01';
const COLLAPSE_ALL = 'M9 9h10v10H9zM5 15V5h10M12 14h4';

interface Section {
    readonly view: ContributedView;
    readonly element: HTMLElement;
    readonly header: HTMLElement;
    readonly toggle: HTMLButtonElement;
    readonly titleText: HTMLElement;
    readonly descriptionText: HTMLElement;
    readonly actions: HTMLElement;
    readonly body: HTMLElement;
    readonly message: HTMLElement;
    readonly welcome: HTMLElement;
    /** A `type: "webview"` view's slot, which its frame is laid over. */
    readonly slot: HTMLElement | null;
    readonly container: string;
    collapsed: boolean;
    visible: boolean;
}

interface TreeState {
    readonly tree: ExtensionTreeView;
    readonly extensionId: string;
    readonly showCollapseAll: boolean;
    title: string | null;
    description: string | null;
    message: string | null;
    badge: { value: number; tooltip: string } | null;
    loaded: boolean;
}

function readFlag(storage: Storage | null, key: string): boolean | null {
    try {
        const value = storage?.getItem(key);
        return value === 'true' ? true : value === 'false' ? false : null;
    } catch {
        return null;
    }
}

function writeFlag(storage: Storage | null, key: string, value: boolean): void {
    try {
        storage?.setItem(key, String(value));
    } catch {
        // Storage unavailable: the default next time.
    }
}

/** A menu's groups as context menu items, separated. */
export function contextMenuItems(groups: readonly MenuGroup[], run: (action: MenuAction) => void): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    for (const group of groups) {
        if (items.length > 0 && group.actions.length > 0) {
            items.push({ separator: true });
        }
        for (const action of group.actions) {
            items.push({ label: action.title, enabled: action.enabled, run: () => run(action), testId: `ext-menu-${action.command}` });
        }
    }
    return items;
}

export function createViewsController(deps: ViewsControllerDeps): ViewsController {
    let contributions: ExtensionContributions | null = null;
    let runnable: ReadonlySet<string> = new Set();
    const containers = new Map<string, ExtensionViewContainer>();
    const containerKeys = new Map<string, string>();
    const sections = new Map<string, Section>();
    const trees = new Map<string, TreeState>();
    let shown: ViewId | null = null;

    const request = (req: ViewRequest): Promise<unknown> => deps.extensions.view(req);
    const lookup = (extra: Readonly<Record<string, unknown>> = {}): ReturnType<ContextKeys['lookup']> => deps.contextKeys.lookup(extra);
    const isRunnable = (extensionId: string): boolean => runnable.has(extensionId);

    function menu(menuId: string, extra: Readonly<Record<string, unknown>>): MenuGroup[] {
        if (!contributions) {
            return [];
        }
        return menuGroups(menuId, contributions.menus, contributions.commands, lookup(extra), isRunnable);
    }

    function paneOf(container: string): HTMLElement | null {
        if (container === 'explorer' || container === 'scm' || container === 'debug') {
            return deps.workbench.extensionSections[container];
        }
        return containers.get(container)?.pane ?? null;
    }

    function activityOf(container: string): ViewId {
        return container === 'explorer' || container === 'scm' || container === 'debug' ? container : `ext:${container}`;
    }

    /* ------------------------------ sections ------------------------------ */

    function renderButtons(section: Section): void {
        const tree = trees.get(section.view.id);
        const groups = menu('view/title', { view: section.view.id, focusedView: section.view.id });
        const { primary, secondary } = splitActions(groups, 'navigation');
        const buttons: HTMLElement[] = primary.map((action) => {
            const button = el('button', { className: 'icon-button ext-action', attrs: { type: 'button', title: action.title, 'aria-label': action.title } });
            const glyph = extensionIcon(action.icon, { monochrome: true });
            if (glyph) {
                button.append(glyph);
            } else {
                button.textContent = action.title;
                button.classList.add('is-text');
            }
            button.disabled = !action.enabled;
            button.addEventListener('click', () => deps.runCommand(action.command));
            return button;
        });
        if (tree?.showCollapseAll) {
            const collapse = el('button', { className: 'icon-button ext-action', attrs: { type: 'button', title: 'Collapse All', 'aria-label': 'Collapse All' } }, [icon(COLLAPSE_ALL)]);
            collapse.addEventListener('click', () => tree.tree.collapseAll());
            buttons.push(collapse);
        }
        const more = secondary.flatMap((group) => group.actions);
        if (more.length > 0) {
            const button = el('button', { className: 'icon-button ext-action', attrs: { type: 'button', title: 'More Actions...', 'aria-label': 'More Actions...', 'aria-haspopup': 'menu' } }, [icon(MORE)]);
            button.addEventListener('click', () => {
                const rect = button.getBoundingClientRect();
                showContextMenu(contextMenuItems(secondary, (action) => deps.runCommand(action.command)), rect.left, rect.bottom, { label: `${section.view.name} actions` });
            });
            buttons.push(button);
        }
        section.actions.replaceChildren(...buttons);
    }

    function renderWelcome(section: Section): void {
        const tree = trees.get(section.view.id);
        const showWelcome = section.slot === null && (!tree || tree.tree.isEmpty());
        const entries = (contributions?.viewsWelcome ?? []).filter((entry) => entry.view === section.view.id && whenHolds(entry.when, lookup({ view: section.view.id })));
        if (!showWelcome || entries.length === 0) {
            section.welcome.hidden = true;
            section.welcome.replaceChildren();
            return;
        }
        const children: HTMLElement[] = [];
        const follow = (target: string): void => {
            const link = commandLink(target);
            if (link) {
                deps.runCommand(link.command, link.args);
            } else if (/^https?:\/\//i.test(target)) {
                deps.openExternalLink(target);
            }
        };
        for (const entry of entries) {
            for (const line of parseWelcome(entry.contents)) {
                if (line.kind === 'button') {
                    const button = el('button', { className: 'primary-button ext-welcome-button', attrs: { type: 'button' }, text: line.label });
                    button.addEventListener('click', () => follow(line.target));
                    children.push(button);
                    continue;
                }
                children.push(el('p', { className: 'ext-welcome-text' }, line.parts.map((part) => {
                    if ('text' in part) {
                        return document.createTextNode(part.text);
                    }
                    const link = el('a', { className: 'ext-welcome-link', text: part.label, attrs: { href: '#', role: 'link' } });
                    link.addEventListener('click', (event) => {
                        event.preventDefault();
                        follow(part.target);
                    });
                    return link;
                })));
            }
        }
        section.welcome.replaceChildren(...children);
        section.welcome.hidden = false;
    }

    function renderHeader(section: Section): void {
        const tree = trees.get(section.view.id);
        section.titleText.textContent = tree?.title ?? section.view.name;
        section.descriptionText.textContent = tree?.description ?? '';
        section.message.textContent = tree?.message ?? '';
        section.message.hidden = !tree?.message;
    }

    function renderBadge(container: string): void {
        const target = containers.get(container);
        if (!target) {
            return;
        }
        let total = 0;
        const tooltips: string[] = [];
        for (const section of sections.values()) {
            const badge = trees.get(section.view.id)?.badge;
            if (section.container === container && badge && badge.value > 0) {
                total += badge.value;
                if (badge.tooltip) {
                    tooltips.push(badge.tooltip);
                }
            }
        }
        target.setBadge(total, tooltips.join(', '));
    }

    /** Whether the person can see the section now (its pane shown, it unfolded and its `when` holding). */
    function isShown(section: Section): boolean {
        return section.visible && !section.collapsed && shown === activityOf(section.container);
    }

    function updateVisibility(section: Section): void {
        const now = isShown(section);
        if (section.element.dataset['shown'] === String(now)) {
            return;
        }
        section.element.dataset['shown'] = String(now);
        if (section.slot) {
            deps.webviews.setViewSlot(section.view.id, now ? section.slot : null);
            return;
        }
        void request({ kind: 'viewVisibility', viewId: section.view.id, visible: now }).catch(() => undefined);
        const tree = trees.get(section.view.id);
        if (now && tree && !tree.loaded) {
            tree.loaded = true;
            void tree.tree.load();
        }
    }

    function setCollapsed(section: Section, collapsed: boolean): void {
        section.collapsed = collapsed;
        section.element.classList.toggle('is-collapsed', collapsed);
        section.toggle.setAttribute('aria-expanded', String(!collapsed));
        section.body.hidden = collapsed;
        writeFlag(deps.storage, `codexr:extview:${section.view.id}:collapsed`, collapsed);
        updateVisibility(section);
    }

    function createSection(view: ContributedView): Section | null {
        const pane = paneOf(view.container);
        if (!pane) {
            return null;
        }
        const titleText = el('span', { className: 'ext-view-title', text: view.name });
        const descriptionText = el('span', { className: 'ext-view-description' });
        const toggle = el('button', { className: 'outline-toggle ext-view-toggle', attrs: { type: 'button', 'aria-expanded': 'true', 'data-testid': `ext-view-toggle-${view.id}` } }, [icon(CHEVRON, 'tree-chevron'), titleText, descriptionText]);
        const actions = el('span', { className: 'ext-view-actions' });
        const header = el('div', { className: 'outline-header ext-view-header' }, [toggle, actions]);
        const message = el('p', { className: 'muted ext-view-message', attrs: { hidden: '' } });
        const welcome = el('div', { className: 'ext-welcome', attrs: { hidden: '' } });
        const slot = view.type === 'webview' ? el('div', { className: 'webview-slot ext-webview-slot', attrs: { 'data-testid': `ext-webview-slot-${view.id}` } }) : null;
        const body = el('div', { className: 'ext-view-body' }, slot ? [message, slot] : [message, welcome]);
        const element = el('section', { className: 'ext-view', attrs: { 'aria-label': view.name, 'data-view-id': view.id, 'data-testid': `ext-view-${view.id}` } }, [header, body]);
        const section: Section = { view, element, header, toggle, titleText, descriptionText, actions, body, message, welcome, slot, container: view.container, collapsed: false, visible: true };
        toggle.addEventListener('click', () => setCollapsed(section, !section.collapsed));
        const stored = readFlag(deps.storage, `codexr:extview:${view.id}:collapsed`);
        section.collapsed = stored ?? view.collapsed;
        element.classList.toggle('is-collapsed', section.collapsed);
        toggle.setAttribute('aria-expanded', String(!section.collapsed));
        body.hidden = section.collapsed;
        pane.append(element);
        return section;
    }

    function attachTree(section: Section): void {
        const tree = trees.get(section.view.id);
        if (tree && tree.tree.element.parentElement !== section.body) {
            section.body.insertBefore(tree.tree.element, section.welcome);
        }
        renderHeader(section);
        renderButtons(section);
        renderWelcome(section);
    }

    function evaluate(): void {
        for (const section of sections.values()) {
            section.visible = whenHolds(section.view.when, lookup({ view: section.view.id }));
            section.element.hidden = !section.visible;
            renderButtons(section);
            renderWelcome(section);
            updateVisibility(section);
        }
        // A container whose views are all hidden keeps its item, as in VS Code; nothing more to do.
    }

    function clearSections(): void {
        for (const section of sections.values()) {
            if (section.slot) {
                deps.webviews.setViewSlot(section.view.id, null);
            }
            const tree = trees.get(section.view.id);
            tree?.tree.element.remove();
            section.element.remove();
        }
        sections.clear();
    }

    /**
     * Keeps the activity items whose container did not change, so a refresh
     * (an extension activating, the trust changing) neither moves the person
     * off the container they are looking at nor makes its item blink.
     */
    function syncContainers(wanted: readonly ContributedViewContainer[]): void {
        const keys = new Map(wanted.map((container) => [container.id, JSON.stringify([container.title, container.icon])]));
        for (const [id, container] of containers) {
            if (keys.get(id) !== containerKeys.get(id)) {
                container.dispose();
                containers.delete(id);
                containerKeys.delete(id);
            }
        }
        for (const container of wanted) {
            if (!containers.has(container.id)) {
                containers.set(container.id, deps.workbench.addViewContainer(container.id, container.title, extensionIcon(container.icon, { monochrome: true })));
                containerKeys.set(container.id, keys.get(container.id) ?? '');
            }
        }
    }

    function build(): void {
        clearSections();
        // Only containers with a view of an extension that is on (`views` only lists placed ones).
        syncContainers(contributions ? contributions.viewContainers.filter((container) => contributions?.views.some((view) => view.container === container.id)) : []);
        if (!contributions) {
            return;
        }
        for (const view of contributions.views) {
            const section = createSection(view);
            if (section) {
                sections.set(view.id, section);
                attachTree(section);
            }
        }
        for (const container of containers.keys()) {
            renderBadge(container);
        }
        evaluate();
    }

    deps.contextKeys.onDidChange(() => {
        evaluate();
        for (const tree of trees.values()) {
            tree.tree.rerender();
        }
    });
    deps.workbench.onDidChangeView((id) => {
        shown = id;
        for (const section of sections.values()) {
            updateVisibility(section);
        }
    });

    function revealSection(viewId: string): Section | null {
        const section = sections.get(viewId);
        if (!section) {
            return null;
        }
        deps.workbench.showView(activityOf(section.container));
        if (section.collapsed) {
            setCollapsed(section, false);
        }
        section.element.scrollIntoView({ block: 'nearest' });
        return section;
    }

    function disposeTree(viewId: string): void {
        const tree = trees.get(viewId);
        if (!tree) {
            return;
        }
        tree.tree.dispose();
        trees.delete(viewId);
        const section = sections.get(viewId);
        if (section) {
            attachTree(section);
            renderBadge(section.container);
        }
    }

    return {
        setContributions(next, nextRunnable) {
            contributions = next;
            runnable = nextRunnable;
            build();
        },
        notification(notification) {
            switch (notification.kind) {
                case 'treeRegistered': {
                    disposeTree(notification.viewId);
                    const tree = createTreeView({
                        viewId: notification.viewId,
                        canSelectMany: notification.canSelectMany,
                        request,
                        itemMenu: (item) => menu('view/item/context', { view: notification.viewId, viewItem: item.contextValue ?? '', focusedView: notification.viewId }),
                        runItemCommand: (action, item, selected) => {
                            void request({ kind: 'treeCommand', viewId: notification.viewId, command: action.command, handle: item.handle, selected: selected.map((entry) => entry.handle) })
                                .catch((error: unknown) => deps.onError(`Command '${action.command}' failed: ${String(error)}`));
                        },
                        showMenu: (groups, x, y, run) => showContextMenu(contextMenuItems(groups, run), x, y, { label: `${notification.viewId} item actions` }),
                        onEmptyChange: () => {
                            const section = sections.get(notification.viewId);
                            if (section) {
                                renderWelcome(section);
                            }
                        },
                        onError: deps.onError,
                    });
                    trees.set(notification.viewId, { tree, extensionId: notification.extensionId, showCollapseAll: notification.showCollapseAll, title: null, description: null, message: null, badge: null, loaded: false });
                    const section = sections.get(notification.viewId);
                    if (section) {
                        attachTree(section);
                        section.element.dataset['shown'] = '';
                        updateVisibility(section);
                    }
                    return;
                }
                case 'treeDisposed':
                    disposeTree(notification.viewId);
                    return;
                case 'treeChanged': {
                    const tree = trees.get(notification.viewId);
                    if (tree?.loaded) {
                        void tree.tree.refresh(notification.handles);
                    }
                    return;
                }
                case 'treeReveal': {
                    const tree = trees.get(notification.viewId);
                    if (!tree) {
                        return;
                    }
                    if (notification.focus || notification.select) {
                        revealSection(notification.viewId);
                    }
                    tree.loaded = true;
                    void tree.tree.reveal(notification.path, notification.select, notification.focus, notification.expand);
                    return;
                }
                case 'viewMeta': {
                    const tree = trees.get(notification.viewId);
                    if (!tree) {
                        return;
                    }
                    if (notification.title !== undefined) {
                        tree.title = notification.title;
                    }
                    if (notification.description !== undefined) {
                        tree.description = notification.description;
                    }
                    if (notification.message !== undefined) {
                        tree.message = notification.message;
                    }
                    if (notification.badge !== undefined) {
                        tree.badge = notification.badge;
                    }
                    const section = sections.get(notification.viewId);
                    if (section) {
                        renderHeader(section);
                        renderBadge(section.container);
                    }
                    return;
                }
                case 'viewFocus':
                    if (revealSection(notification.viewId)) {
                        trees.get(notification.viewId)?.tree.focus();
                    }
                    return;
            }
        },
        reset() {
            for (const viewId of [...trees.keys()]) {
                disposeTree(viewId);
            }
        },
        command(id) {
            const focus = /^(.+)\.focus$/.exec(id);
            if (focus && sections.has(focus[1] as string)) {
                revealSection(focus[1] as string);
                trees.get(focus[1] as string)?.tree.focus();
                return true;
            }
            const container = /^workbench\.view\.extension\.(.+)$/.exec(id);
            if (container && containers.has(container[1] as string)) {
                deps.workbench.showView(`ext:${container[1] as string}`);
                return true;
            }
            const collapse = /^workbench\.actions\.treeView\.(.+)\.collapseAll$/.exec(id);
            if (collapse && trees.has(collapse[1] as string)) {
                trees.get(collapse[1] as string)?.tree.collapseAll();
                return true;
            }
            const refresh = /^workbench\.actions\.treeView\.(.+)\.refresh$/.exec(id);
            if (refresh && trees.has(refresh[1] as string)) {
                void trees.get(refresh[1] as string)?.tree.refresh(null);
                return true;
            }
            return false;
        },
        menu,
    };
}
