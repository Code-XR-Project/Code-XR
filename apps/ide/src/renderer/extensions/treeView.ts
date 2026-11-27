import type { TreeItemData, ViewRequest } from '../../shared/extensionViewsProtocol.ts';
import { el, icon } from '../dom.ts';
import { extensionIcon } from './extensionIcons.ts';
import type { MenuAction, MenuGroup } from './menuModel.ts';

/**
 * #261: an extension's tree view in the side bar. Children load when a node
 * is first expanded (or at once for an item that says it starts expanded);
 * a refresh of the host reloads the changed parts and keeps what was open.
 * A click selects and runs the item's command, or toggles a folder-like item;
 * the context menu and the row's inline buttons come from `view/item/context`.
 * Keyboard: arrows, Home/End, Enter, Space, Shift+F10.
 *
 * Every string an extension gives is set as text, never as markup.
 */

const CHEVRON = 'M9 6l6 6-6 6';

export interface TreeViewDeps {
    readonly viewId: string;
    readonly canSelectMany: boolean;
    request(request: ViewRequest): Promise<unknown>;
    /** The `view/item/context` entries for an item (and the selection). */
    itemMenu(item: TreeItemData): readonly MenuGroup[];
    /** Runs a menu command on an item (with the selected ones). */
    runItemCommand(action: MenuAction, item: TreeItemData, selected: readonly TreeItemData[]): void;
    showMenu(groups: readonly MenuGroup[], x: number, y: number, run: (action: MenuAction) => void): void;
    /** The tree went from empty to filled or back (the welcome content shows on an empty tree). */
    onEmptyChange(empty: boolean): void;
    onError(message: string): void;
}

interface Node {
    data: TreeItemData;
    readonly item: HTMLLIElement;
    row: HTMLElement;
    group: HTMLUListElement | null;
    expanded: boolean;
    loaded: boolean;
    readonly parent: Node | null;
    readonly depth: number;
    children: Node[];
}

export interface ExtensionTreeView {
    readonly element: HTMLElement;
    /** Loads the roots (the view became visible, or the provider arrived). */
    load(): Promise<void>;
    /** `onDidChangeTreeData`: these items (null: everything). */
    refresh(handles: readonly string[] | null): Promise<void>;
    reveal(path: readonly string[], select: boolean, focus: boolean, expand: number): Promise<void>;
    collapseAll(): void;
    /** Draws the rows again (the context keys changed: their inline buttons may too). */
    rerender(): void;
    isEmpty(): boolean;
    focus(): void;
    dispose(): void;
}

export function createTreeView(deps: TreeViewDeps): ExtensionTreeView {
    const root = el('ul', { className: 'tree ext-tree', attrs: { role: 'tree', 'aria-label': deps.viewId, 'aria-multiselectable': String(deps.canSelectMany), 'data-testid': `ext-tree-${deps.viewId}` } });
    const nodes = new Map<string, Node>();
    let roots: Node[] = [];
    let selected: Node[] = [];
    let focused: Node | null = null;
    let empty = true;
    let disposed = false;
    let rootsLoaded = false;

    const setEmpty = (value: boolean): void => {
        if (value !== empty) {
            empty = value;
            deps.onEmptyChange(value);
        }
    };

    const request = (req: ViewRequest): Promise<unknown> => deps.request(req).catch((error: unknown) => {
        deps.onError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error));
        return null;
    });

    function label(data: TreeItemData): HTMLElement {
        const text = data.label !== '' ? data.label : data.resourceName ?? '';
        const span = el('span', { className: 'tree-label' });
        const ranges = [...(data.highlights ?? [])].filter(([start, end]) => start >= 0 && end > start && end <= text.length).sort((a, b) => a[0] - b[0]);
        let at = 0;
        for (const [start, end] of ranges) {
            if (start < at) {
                continue;
            }
            span.append(document.createTextNode(text.slice(at, start)), el('mark', { className: 'tree-highlight', text: text.slice(start, end) }));
            at = end;
        }
        span.append(document.createTextNode(text.slice(at)));
        return span;
    }

    function renderRow(node: Node): HTMLElement {
        const { data } = node;
        const collapsible = data.collapsible !== 0;
        const iconElement = extensionIcon(data.icon && data.icon.kind !== 'iconFile' ? data.icon : null, { ...(data.resourceName ? { resourceName: data.resourceName } : {}), expanded: node.expanded });
        const inline = deps.itemMenu(data).filter((group) => group.group === 'inline').flatMap((group) => group.actions);
        const actions = el('span', { className: 'ext-tree-actions' }, inline.map((action) => {
            const button = el('button', { className: 'ext-action', attrs: { type: 'button', title: action.title, 'aria-label': action.title, tabindex: '-1' } });
            const glyph = extensionIcon(action.icon, { monochrome: true });
            if (glyph) {
                button.append(glyph);
            } else {
                button.textContent = action.title;
                button.classList.add('is-text');
            }
            button.disabled = !action.enabled;
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                deps.runItemCommand(action, node.data, selectionFor(node));
            });
            return button;
        }));
        const checkbox = data.checked === undefined ? null : el('input', { className: 'ext-tree-checkbox', attrs: { type: 'checkbox', tabindex: '-1', 'aria-label': data.label } });
        if (checkbox) {
            checkbox.checked = data.checked === true;
            checkbox.addEventListener('click', (event) => event.stopPropagation());
            checkbox.addEventListener('change', () => void request({ kind: 'treeCheckbox', viewId: deps.viewId, handle: node.data.handle, checked: checkbox.checked }));
        }
        const row = el('div', {
            className: 'tree-row ext-tree-row',
            attrs: {
                role: 'treeitem',
                tabindex: '-1',
                'aria-level': String(node.depth + 1),
                'aria-selected': String(selected.includes(node)),
                'aria-label': data.accessibilityLabel ?? (data.description ? `${data.label} ${data.description}` : data.label),
                'data-handle': data.handle,
                ...(collapsible ? { 'aria-expanded': String(node.expanded) } : {}),
            },
        }, [
            collapsible ? icon(CHEVRON, 'tree-chevron') : el('span', { className: 'tree-chevron-space' }),
            ...(checkbox ? [checkbox] : []),
            ...(iconElement ? [iconElement] : []),
            label(data),
            ...(data.description ? [el('span', { className: 'tree-description', text: data.description })] : []),
            actions,
        ]);
        if (data.tooltip) {
            row.title = data.tooltip;
        } else if (data.resource?.path) {
            row.title = data.resource.path;
        }
        row.style.paddingLeft = `${4 + node.depth * 12}px`;
        row.addEventListener('click', (event) => onClick(node, event));
        row.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            if (!selected.includes(node)) {
                select([node]);
            }
            openMenu(node, event.clientX, event.clientY);
        });
        const chevron = row.firstElementChild;
        if (collapsible && chevron) {
            chevron.addEventListener('click', (event) => {
                event.stopPropagation();
                void toggle(node);
            });
        }
        return row;
    }

    function selectionFor(node: Node): TreeItemData[] {
        return (selected.includes(node) ? selected : [node]).map((entry) => entry.data);
    }

    function openMenu(node: Node, x: number, y: number): void {
        const groups = deps.itemMenu(node.data).filter((group) => group.group !== 'inline');
        if (groups.length === 0) {
            return;
        }
        deps.showMenu(groups, x, y, (action) => deps.runItemCommand(action, node.data, selectionFor(node)));
    }

    function setFocus(node: Node | null, takeFocus = true): void {
        if (focused && focused !== node) {
            focused.row.tabIndex = -1;
        }
        focused = node;
        if (node) {
            node.row.tabIndex = 0;
            if (takeFocus) {
                node.row.focus();
            }
        }
    }

    function select(list: Node[], notify = true): void {
        for (const node of selected) {
            node.row.setAttribute('aria-selected', 'false');
        }
        selected = list;
        for (const node of selected) {
            node.row.setAttribute('aria-selected', 'true');
        }
        if (notify) {
            void request({ kind: 'treeSelection', viewId: deps.viewId, handles: selected.map((node) => node.data.handle) });
        }
    }

    function onClick(node: Node, event: MouseEvent): void {
        setFocus(node);
        if (deps.canSelectMany && (event.ctrlKey || event.metaKey)) {
            select(selected.includes(node) ? selected.filter((other) => other !== node) : [...selected, node]);
            return;
        }
        select([node]);
        activate(node);
    }

    function activate(node: Node): void {
        if (node.data.hasCommand) {
            void request({ kind: 'treeClick', viewId: deps.viewId, handle: node.data.handle });
        } else if (node.data.collapsible !== 0) {
            void toggle(node);
        }
    }

    function makeNode(data: TreeItemData, parent: Node | null): Node {
        const item = el('li', { attrs: { role: 'none' } });
        const node: Node = { data, item, row: el('div'), group: null, expanded: data.collapsible === 2, loaded: false, parent, depth: parent ? parent.depth + 1 : 0, children: [] };
        node.row = renderRow(node);
        item.append(node.row);
        return node;
    }

    function forget(node: Node): void {
        for (const child of node.children) {
            forget(child);
        }
        if (nodes.get(node.data.handle) === node) {
            nodes.delete(node.data.handle);
        }
        if (focused === node) {
            focused = null;
        }
        selected = selected.filter((entry) => entry !== node);
    }

    /** Fetches the children of `parent` (null: the roots) and reconciles them with what is shown. */
    async function loadChildren(parent: Node | null): Promise<void> {
        const answer = await request({ kind: 'treeChildren', viewId: deps.viewId, handle: parent ? parent.data.handle : null }) as { items?: TreeItemData[] } | null;
        if (disposed || (parent && nodes.get(parent.data.handle) !== parent)) {
            return;
        }
        const items = Array.isArray(answer?.items) ? answer.items : [];
        const previous = parent ? parent.children : roots;
        const byHandle = new Map(previous.map((node) => [node.data.handle, node]));
        const next: Node[] = [];
        for (const data of items) {
            const old = byHandle.get(data.handle);
            let node: Node;
            if (old) {
                byHandle.delete(data.handle);
                old.data = data;
                if (data.collapsible === 0) {
                    old.expanded = false;
                }
                const row = renderRow(old);
                old.row.replaceWith(row);
                if (focused === old) {
                    row.tabIndex = 0;
                }
                old.row = row;
                node = old;
            } else {
                node = makeNode(data, parent);
            }
            nodes.set(data.handle, node);
            next.push(node);
        }
        for (const gone of byHandle.values()) {
            forget(gone);
        }
        if (parent) {
            parent.children = next;
            parent.loaded = true;
            parent.group ??= el('ul', { attrs: { role: 'group' } });
            parent.group.replaceChildren(...next.map((node) => node.item));
            if (!parent.group.isConnected) {
                parent.item.append(parent.group);
            }
            parent.group.hidden = !parent.expanded;
        } else {
            roots = next;
            rootsLoaded = true;
            root.replaceChildren(...next.map((node) => node.item));
            setEmpty(next.length === 0);
            if (!focused && next[0]) {
                setFocus(next[0], false);
            }
        }
        // Items that are open (they start expanded, or were before the refresh) show their children too.
        await Promise.all(next.filter((node) => node.expanded && node.data.collapsible !== 0).map((node) => loadChildren(node)));
    }

    async function toggle(node: Node, expand = !node.expanded): Promise<void> {
        if (node.data.collapsible === 0 || node.expanded === expand) {
            return;
        }
        node.expanded = expand;
        node.row.setAttribute('aria-expanded', String(expand));
        void request({ kind: 'treeExpand', viewId: deps.viewId, handle: node.data.handle, expanded: expand });
        if (expand && !node.loaded) {
            await loadChildren(node);
        } else if (node.group) {
            node.group.hidden = !expand;
        }
        // A folder icon follows the state.
        if (node.data.icon?.kind === 'folder') {
            const row = renderRow(node);
            node.row.replaceWith(row);
            row.tabIndex = focused === node ? 0 : -1;
            node.row = row;
        }
    }

    function visibleNodes(): Node[] {
        const list: Node[] = [];
        const walk = (level: readonly Node[]): void => {
            for (const node of level) {
                list.push(node);
                if (node.expanded && node.loaded) {
                    walk(node.children);
                }
            }
        };
        walk(roots);
        return list;
    }

    root.addEventListener('keydown', (event) => {
        const list = visibleNodes();
        const current = focused ?? list[0];
        if (!current) {
            return;
        }
        const index = list.indexOf(current);
        switch (event.key) {
            case 'ArrowDown': setFocus(list[Math.min(list.length - 1, index + 1)] ?? current); break;
            case 'ArrowUp': setFocus(list[Math.max(0, index - 1)] ?? current); break;
            case 'Home': setFocus(list[0] ?? current); break;
            case 'End': setFocus(list[list.length - 1] ?? current); break;
            case 'ArrowRight':
                if (current.data.collapsible !== 0 && !current.expanded) {
                    void toggle(current, true);
                } else if (current.expanded && current.children[0]) {
                    setFocus(current.children[0]);
                }
                break;
            case 'ArrowLeft':
                if (current.expanded) {
                    void toggle(current, false);
                } else if (current.parent) {
                    setFocus(current.parent);
                }
                break;
            case 'Enter':
                select([current]);
                activate(current);
                break;
            case ' ':
                select(deps.canSelectMany && (event.ctrlKey || event.metaKey) ? [...selected, current] : [current]);
                break;
            case 'ContextMenu':
            case 'F10': {
                if (event.key === 'F10' && !event.shiftKey) {
                    return;
                }
                const rect = current.row.getBoundingClientRect();
                openMenu(current, rect.left + 16, rect.bottom);
                break;
            }
            default:
                return;
        }
        event.preventDefault();
    });

    return {
        element: root,
        load: () => loadChildren(null),
        async refresh(handles) {
            if (handles === null || !rootsLoaded) {
                await loadChildren(null);
                return;
            }
            // The parents of the changed items are asked again: that refreshes the items and their open children.
            const parents = new Set<Node | null>();
            for (const handle of handles) {
                const node = nodes.get(handle);
                if (node) {
                    parents.add(node.parent);
                }
            }
            if (parents.has(null)) {
                await loadChildren(null);
                return;
            }
            await Promise.all([...parents].map((parent) => loadChildren(parent)));
        },
        async reveal(path, doSelect, doFocus, expand) {
            if (!rootsLoaded) {
                await loadChildren(null);
            }
            let node: Node | undefined;
            for (const [index, handle] of path.entries()) {
                node = nodes.get(handle);
                if (!node) {
                    return;
                }
                if (index < path.length - 1) {
                    await toggle(node, true);
                    if (!node.loaded) {
                        await loadChildren(node);
                    }
                }
            }
            if (!node) {
                return;
            }
            let level: Node[] = [node];
            for (let depth = 0; depth < expand; depth++) {
                await Promise.all(level.map((entry) => toggle(entry, true)));
                level = level.flatMap((entry) => entry.children);
            }
            if (doSelect) {
                select([node]);
            }
            setFocus(node, doFocus);
            node.row.scrollIntoView({ block: 'nearest' });
        },
        collapseAll() {
            for (const node of nodes.values()) {
                if (node.expanded) {
                    void toggle(node, false);
                }
            }
        },
        rerender() {
            for (const node of nodes.values()) {
                const row = renderRow(node);
                row.tabIndex = focused === node ? 0 : -1;
                node.row.replaceWith(row);
                node.row = row;
            }
        },
        isEmpty: () => empty,
        focus() {
            (focused ?? roots[0])?.row.focus();
        },
        dispose() {
            disposed = true;
            root.remove();
        },
    };
}
