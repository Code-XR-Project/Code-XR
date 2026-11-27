import path from 'node:path';
import type { Collapsible, HostIconData, TreeItemData, ViewNotification, ViewRequest } from '../shared/extensionViewsProtocol.ts';
import { MAX_VIEW_SELECTION } from '../shared/extensionViewsProtocol.ts';
import type { ExtensionId } from '../shared/extensions.ts';
import type { ExtensionHost } from './host.ts';
import { CancellationTokenNone, Disposable, EventEmitter, MarkdownString, ThemeColor, ThemeIcon, TreeItemCheckboxState, Uri } from './types.ts';

/**
 * #261: the tree views of extensions (`window.registerTreeDataProvider`,
 * `window.createTreeView`). The provider and its elements stay here; the
 * workbench sees each element as an opaque handle and asks for the children
 * of a handle, a click on one, or a menu command on some.
 *
 * A handle is the item's `id` when the provider gives one (so a refreshed
 * tree keeps what was expanded), else a number tied to the element object.
 */

interface TreeProvider {
    getChildren(element?: unknown): unknown;
    getTreeItem(element: unknown): unknown;
    getParent?(element: unknown): unknown;
    resolveTreeItem?(item: unknown, element: unknown, token: unknown): unknown;
    onDidChangeTreeData?: (listener: (value: unknown) => void) => { dispose(): unknown };
}

interface TreeEntry {
    readonly viewId: string;
    readonly extensionId: ExtensionId;
    readonly provider: TreeProvider;
    readonly view: TreeViewImpl;
    /** handle -> element, element -> handle. */
    readonly elements: Map<string, unknown>;
    readonly handles: Map<unknown, string>;
    /** handle -> the TreeItem last returned, for clicks and menu arguments. */
    readonly items: Map<string, Record<string, unknown>>;
    readonly subscription: { dispose(): unknown } | null;
    next: number;
}

/** Elements kept per view before the oldest numbers are forgotten (a tree refreshed forever must not grow forever). */
const MAX_ELEMENTS = 20_000;

function labelOf(item: Record<string, unknown>): { label: string; highlights?: [number, number][] } {
    const raw = item['label'];
    if (typeof raw === 'string') {
        return { label: raw };
    }
    if (typeof raw === 'object' && raw !== null && typeof (raw as { label?: unknown }).label === 'string') {
        const value = raw as { label: string; highlights?: unknown };
        const highlights = Array.isArray(value.highlights)
            ? value.highlights.filter((pair): pair is [number, number] => Array.isArray(pair) && pair.length === 2 && pair.every((n) => Number.isInteger(n)))
            : [];
        return highlights.length > 0 ? { label: value.label, highlights } : { label: value.label };
    }
    const resource = item['resourceUri'];
    return { label: resource instanceof Uri ? path.basename(resource.path) : '' };
}

function text(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (value instanceof MarkdownString || (typeof value === 'object' && value !== null && typeof (value as { value?: unknown }).value === 'string')) {
        return (value as { value: string }).value;
    }
    return undefined;
}

function iconFile(value: unknown): string | null {
    if (value instanceof Uri) {
        return value.scheme === 'file' ? value.fsPath : null;
    }
    return typeof value === 'string' && path.isAbsolute(value) ? value : null;
}

/** A tree item's `iconPath`, as the wire carries it. */
export function iconData(value: unknown): HostIconData | undefined {
    if (value instanceof ThemeIcon || (typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string' && !(value instanceof Uri))) {
        const icon = value as { id: string; color?: unknown };
        if (icon.id === 'file') {
            return { kind: 'file' };
        }
        if (icon.id === 'folder') {
            return { kind: 'folder' };
        }
        const color = icon.color instanceof ThemeColor || (typeof icon.color === 'object' && icon.color !== null && typeof (icon.color as { id?: unknown }).id === 'string') ? (icon.color as { id: string }).id : undefined;
        return { kind: 'codicon', name: icon.id.replace(/~[a-z]+$/, ''), ...(color ? { color } : {}) };
    }
    const single = iconFile(value);
    if (single) {
        return { kind: 'iconFile', file: single };
    }
    if (typeof value === 'object' && value !== null) {
        const pair = value as { light?: unknown; dark?: unknown };
        const light = iconFile(pair.light);
        const dark = iconFile(pair.dark);
        if (light || dark) {
            return { kind: 'iconFile', file: (light ?? dark) as string, ...(dark && dark !== light ? { darkFile: dark } : {}) };
        }
    }
    return undefined;
}

export class TreeViewImpl {
    readonly viewId: string;
    private readonly host: ExtensionHost;
    private readonly owner: TreeViews;
    readonly onDidChangeSelectionEmitter = new EventEmitter<{ selection: readonly unknown[] }>();
    readonly onDidChangeVisibilityEmitter = new EventEmitter<{ visible: boolean }>();
    readonly onDidExpandElementEmitter = new EventEmitter<{ element: unknown }>();
    readonly onDidCollapseElementEmitter = new EventEmitter<{ element: unknown }>();
    readonly onDidChangeCheckboxStateEmitter = new EventEmitter<{ items: readonly [unknown, number][] }>();
    readonly onDidChangeSelection = this.onDidChangeSelectionEmitter.event;
    readonly onDidChangeVisibility = this.onDidChangeVisibilityEmitter.event;
    readonly onDidExpandElement = this.onDidExpandElementEmitter.event;
    readonly onDidCollapseElement = this.onDidCollapseElementEmitter.event;
    readonly onDidChangeCheckboxState = this.onDidChangeCheckboxStateEmitter.event;
    selection: readonly unknown[] = [];
    visible = false;
    private titleValue: string | undefined;
    private descriptionValue: string | undefined;
    private messageValue: string | undefined;
    private badgeValue: { value: number; tooltip: string } | undefined;

    constructor(host: ExtensionHost, owner: TreeViews, viewId: string) {
        this.host = host;
        this.owner = owner;
        this.viewId = viewId;
    }

    private meta(change: Omit<Extract<ViewNotification, { kind: 'viewMeta' }>, 'kind' | 'viewId'>): void {
        this.host.uiNotify({ kind: 'view', notification: { kind: 'viewMeta', viewId: this.viewId, ...change } });
    }

    get title(): string | undefined {
        return this.titleValue;
    }

    set title(value: string | undefined) {
        this.titleValue = value;
        this.meta({ title: value ?? null });
    }

    get description(): string | undefined {
        return this.descriptionValue;
    }

    set description(value: string | undefined) {
        this.descriptionValue = value;
        this.meta({ description: value ?? null });
    }

    get message(): string | undefined {
        return this.messageValue;
    }

    set message(value: string | MarkdownString | undefined) {
        this.messageValue = text(value);
        this.meta({ message: this.messageValue ?? null });
    }

    get badge(): { value: number; tooltip: string } | undefined {
        return this.badgeValue;
    }

    set badge(value: { value: number; tooltip: string } | undefined) {
        this.badgeValue = value && Number.isFinite(value.value) ? { value: value.value, tooltip: String(value.tooltip ?? '') } : undefined;
        this.meta({ badge: this.badgeValue ?? null });
    }

    async reveal(element: unknown, options: { select?: boolean; focus?: boolean; expand?: boolean | number } = {}): Promise<void> {
        await this.owner.reveal(this.viewId, element, options);
    }

    dispose(): void {
        this.owner.dispose(this.viewId);
    }
}

export class TreeViews {
    private readonly host: ExtensionHost;
    private readonly trees = new Map<string, TreeEntry>();

    constructor(host: ExtensionHost) {
        this.host = host;
    }

    private notify(notification: ViewNotification): void {
        this.host.uiNotify({ kind: 'view', notification });
    }

    /** `createTreeView` / `registerTreeDataProvider`. */
    create(extensionId: ExtensionId, viewId: string, options: { treeDataProvider?: unknown; showCollapseAll?: boolean; canSelectMany?: boolean; manageCheckboxStateManually?: boolean }): TreeViewImpl {
        if (typeof viewId !== 'string' || viewId === '') {
            throw new Error('A tree view needs a view id');
        }
        const provider = options?.treeDataProvider as TreeProvider | undefined;
        if (!provider || typeof provider.getChildren !== 'function' || typeof provider.getTreeItem !== 'function') {
            throw new Error(`The tree view '${viewId}' needs a TreeDataProvider with getChildren and getTreeItem`);
        }
        if (this.trees.has(viewId)) {
            throw new Error(`A data provider is already registered for the view '${viewId}'`);
        }
        const view = new TreeViewImpl(this.host, this, viewId);
        const subscription = typeof provider.onDidChangeTreeData === 'function'
            ? provider.onDidChangeTreeData((changed) => this.changed(viewId, changed))
            : null;
        this.trees.set(viewId, { viewId, extensionId, provider, view, elements: new Map(), handles: new Map(), items: new Map(), subscription, next: 1 });
        this.notify({
            kind: 'treeRegistered', viewId, extensionId,
            showCollapseAll: options.showCollapseAll === true,
            canSelectMany: options.canSelectMany === true,
            manageCheckboxStateManually: options.manageCheckboxStateManually === true,
        });
        return view;
    }

    dispose(viewId: string): void {
        const entry = this.trees.get(viewId);
        if (!entry) {
            return;
        }
        this.trees.delete(viewId);
        entry.subscription?.dispose();
        this.notify({ kind: 'treeDisposed', viewId });
    }

    private changed(viewId: string, changed: unknown): void {
        const entry = this.trees.get(viewId);
        if (!entry) {
            return;
        }
        if (changed === undefined || changed === null) {
            this.notify({ kind: 'treeChanged', viewId, handles: null });
            return;
        }
        const list = Array.isArray(changed) ? changed : [changed];
        const handles = list.map((element) => entry.handles.get(element)).filter((handle): handle is string => handle !== undefined);
        // Elements the workbench never saw change nothing it shows; an element it saw under another
        // object (a provider that rebuilds its elements) would be missed, so refresh the tree then.
        this.notify({ kind: 'treeChanged', viewId, handles: handles.length === list.length ? handles : null });
    }

    private handleOf(entry: TreeEntry, element: unknown, item: Record<string, unknown>, parent: string | null, used: Set<string>): string {
        const handle = this.assignHandle(entry, element, item, parent, used);
        used.add(handle);
        return handle;
    }

    private assignHandle(entry: TreeEntry, element: unknown, item: Record<string, unknown>, parent: string | null, used: Set<string>): string {
        const known = entry.handles.get(element);
        const id = typeof item['id'] === 'string' ? `i:${item['id']}` : null;
        if (id) {
            if (known && known !== id) {
                entry.elements.delete(known);
            }
            entry.elements.set(id, element);
            entry.handles.set(element, id);
            return id;
        }
        if (known && !used.has(known)) {
            return known;
        }
        // A label path is stable across refreshes for providers that return new objects each time;
        // siblings with the same label get a counter.
        const label = labelOf(item).label;
        const base = `${parent ?? ''}/${label}`;
        let handle = base;
        for (let n = 2; used.has(handle); n++) {
            handle = `${base}#${n}`;
        }
        if (entry.elements.has(handle) && entry.elements.get(handle) !== element) {
            const old = entry.elements.get(handle);
            // The same place in the tree, a new object: the new one takes the handle.
            entry.handles.delete(old);
        }
        if (label === '') {
            handle = `n:${entry.next++}`;
        }
        entry.elements.set(handle, element);
        entry.handles.set(element, handle);
        if (entry.elements.size > MAX_ELEMENTS) {
            const oldest = entry.elements.keys().next().value as string;
            entry.handles.delete(entry.elements.get(oldest));
            entry.elements.delete(oldest);
            entry.items.delete(oldest);
        }
        return handle;
    }

    private async itemData(entry: TreeEntry, element: unknown, parent: string | null, used: Set<string>): Promise<TreeItemData> {
        const item = (await entry.provider.getTreeItem(element) ?? {}) as Record<string, unknown>;
        const handle = this.handleOf(entry, element, item, parent, used);
        entry.items.set(handle, item);
        const { label, highlights } = labelOf(item);
        const resource = item['resourceUri'] instanceof Uri && item['resourceUri'].scheme === 'file' ? item['resourceUri'] : null;
        const collapsible = (item['collapsibleState'] === 1 || item['collapsibleState'] === 2 ? item['collapsibleState'] : 0) as Collapsible;
        const icon = iconData(item['iconPath']);
        let description: string | undefined;
        if (typeof item['description'] === 'string') {
            description = item['description'];
        } else if (item['description'] === true && resource) {
            const root = this.host.data.workspaceFolder;
            description = root ? path.relative(root, path.dirname(resource.fsPath)) : path.dirname(resource.fsPath);
        }
        const tooltip = text(item['tooltip']);
        const command = item['command'] as { command?: unknown } | undefined;
        const checkbox = item['checkboxState'];
        const checked = typeof checkbox === 'number' ? checkbox === TreeItemCheckboxState.Checked
            : typeof checkbox === 'object' && checkbox !== null ? (checkbox as { state?: unknown }).state === TreeItemCheckboxState.Checked
                : undefined;
        const accessibility = item['accessibilityInformation'] as { label?: unknown } | undefined;
        return {
            handle,
            label,
            ...(highlights ? { highlights } : {}),
            ...(description !== undefined && description !== '' ? { description } : {}),
            ...(tooltip ? { tooltip } : {}),
            collapsible,
            ...(icon ? { icon } : {}),
            ...(resource ? { resource: { path: resource.fsPath }, resourceName: path.basename(resource.fsPath) } : {}),
            ...(command && typeof command.command === 'string' ? { hasCommand: true } : {}),
            ...(typeof item['contextValue'] === 'string' ? { contextValue: item['contextValue'] } : {}),
            ...(typeof accessibility?.label === 'string' ? { accessibilityLabel: accessibility.label } : {}),
            ...(checked !== undefined ? { checked } : {}),
        };
    }

    async children(viewId: string, handle: string | null): Promise<{ items: TreeItemData[] } | null> {
        const entry = this.trees.get(viewId);
        if (!entry) {
            return null;
        }
        let element: unknown;
        if (handle !== null) {
            if (!entry.elements.has(handle)) {
                return { items: [] };
            }
            element = entry.elements.get(handle);
        }
        const children = await entry.provider.getChildren(element);
        if (!Array.isArray(children)) {
            return { items: [] };
        }
        const items: TreeItemData[] = [];
        const used = new Set<string>();
        for (const child of children) {
            items.push(await this.itemData(entry, child, handle, used));
        }
        return { items };
    }

    private elementsOf(entry: TreeEntry, handles: readonly string[]): unknown[] {
        return handles.slice(0, MAX_VIEW_SELECTION).filter((handle) => entry.elements.has(handle)).map((handle) => entry.elements.get(handle));
    }

    /** The workbench's side of a tree view: children, clicks, menus, selection, expansion, visibility. */
    async request(request: ViewRequest): Promise<unknown> {
        if (request.kind === 'viewVisibility') {
            if (request.visible) {
                await this.host.activateByEvent(`onView:${request.viewId}`);
            }
            const entry = this.trees.get(request.viewId);
            if (entry && entry.view.visible !== request.visible) {
                entry.view.visible = request.visible;
                entry.view.onDidChangeVisibilityEmitter.fire({ visible: request.visible });
            }
            return null;
        }
        const entry = this.trees.get(request.viewId);
        switch (request.kind) {
            case 'treeChildren':
                if (!entry) {
                    // The view's extension may not have activated yet: `onView` wakes it.
                    await this.host.activateByEvent(`onView:${request.viewId}`);
                }
                return this.children(request.viewId, request.handle);
            case 'treeClick': {
                const item = entry?.items.get(request.handle);
                let command = item?.['command'] as { command?: unknown; arguments?: unknown } | undefined;
                if (entry && item && !command && typeof entry.provider.resolveTreeItem === 'function') {
                    const resolved = await entry.provider.resolveTreeItem(item, entry.elements.get(request.handle), CancellationTokenNone) as Record<string, unknown> | undefined;
                    command = (resolved ?? item)['command'] as typeof command;
                }
                if (command && typeof command.command === 'string') {
                    await this.host.executeCommand(command.command, Array.isArray(command.arguments) ? command.arguments : []);
                }
                return null;
            }
            case 'treeCommand': {
                if (!entry) {
                    await this.host.executeCommand(request.command, []);
                    return null;
                }
                const element = request.handle === null ? undefined : entry.elements.get(request.handle);
                const selected = this.elementsOf(entry, request.selected);
                const args = request.handle === null ? [] : selected.length > 1 ? [element, selected] : [element];
                await this.host.executeCommand(request.command, args);
                return null;
            }
            case 'treeExpand': {
                if (!entry || !entry.elements.has(request.handle)) {
                    return null;
                }
                const element = entry.elements.get(request.handle);
                (request.expanded ? entry.view.onDidExpandElementEmitter : entry.view.onDidCollapseElementEmitter).fire({ element });
                return null;
            }
            case 'treeSelection': {
                if (!entry) {
                    return null;
                }
                entry.view.selection = this.elementsOf(entry, request.handles);
                entry.view.onDidChangeSelectionEmitter.fire({ selection: entry.view.selection });
                return null;
            }
            case 'treeCheckbox': {
                if (!entry || !entry.elements.has(request.handle)) {
                    return null;
                }
                const element = entry.elements.get(request.handle);
                entry.view.onDidChangeCheckboxStateEmitter.fire({ items: [[element, request.checked ? TreeItemCheckboxState.Checked : TreeItemCheckboxState.Unchecked]] });
                return null;
            }
        }
    }

    /** `TreeView.reveal`: needs `getParent` for anything but a root. */
    async reveal(viewId: string, element: unknown, options: { select?: boolean; focus?: boolean; expand?: boolean | number }): Promise<void> {
        const entry = this.trees.get(viewId);
        if (!entry) {
            return;
        }
        const chain: unknown[] = [element];
        if (typeof entry.provider.getParent === 'function') {
            let parent = await entry.provider.getParent(element);
            while (parent !== undefined && parent !== null && chain.length < 64) {
                chain.unshift(parent);
                parent = await entry.provider.getParent(parent);
            }
        }
        // Handles in order from a root, assigned the way `children` would.
        const pathHandles: string[] = [];
        let parentHandle: string | null = null;
        for (const node of chain) {
            const item = (await entry.provider.getTreeItem(node) ?? {}) as Record<string, unknown>;
            const handle = this.handleOf(entry, node, item, parentHandle, new Set());
            entry.items.set(handle, item);
            pathHandles.push(handle);
            parentHandle = handle;
        }
        const expand = options.expand === true ? 1 : typeof options.expand === 'number' ? Math.max(0, Math.min(3, Math.floor(options.expand))) : 0;
        this.notify({ kind: 'treeReveal', viewId, path: pathHandles, select: options.select !== false, focus: options.focus === true, expand });
    }

    /** Disposable for `registerTreeDataProvider`. */
    register(extensionId: ExtensionId, viewId: string, provider: unknown): Disposable {
        const view = this.create(extensionId, viewId, { treeDataProvider: provider });
        return new Disposable(() => view.dispose());
    }
}
