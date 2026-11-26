import type { CodeXRApi, DirEntry, WorkspaceInfo } from '../shared/api.ts';
import { el, icon } from './dom.ts';

/**
 * The explorer (#14): the open folder as a tree that loads each folder's
 * children only when it is expanded, so a large project opens at once.
 * Keyboard follows the WAI-ARIA tree pattern: Up/Down move, Right expands or
 * enters, Left collapses or goes to the parent, Enter/Space activates, Home/End.
 */

const CHEVRON = 'M9 6l6 6-6 6';
const FOLDER = 'M3 6h7l2 2h9v11H3z';
const FILE = 'M6 3h8l4 4v14H6z';

export interface Explorer {
    show(workspace: WorkspaceInfo | null): Promise<void>;
    /** The folder picker, after `confirmOpenFolder` agrees. */
    openFolder(): void;
    /** The root (`''`) and every expanded folder: what should follow the disk. */
    expandedFolders(): string[];
    /** Re-lists the loaded folders among `paths` (changed on disk), keeping what is expanded. */
    refresh(paths: readonly string[]): Promise<void>;
}

interface TreeNode {
    readonly entry: DirEntry;
    readonly row: HTMLElement;
    readonly item: HTMLLIElement;
    group: HTMLUListElement | null;
    expanded: boolean;
}

export function createExplorer(
    container: HTMLElement,
    api: CodeXRApi['workspace'],
    callbacks: {
        onOpenFile(path: string): void;
        onError(message: string): void;
        /** Asked before the picker opens; false keeps the current folder (unsaved editors). */
        confirmOpenFolder(): boolean;
        /** A new folder was opened from the picker. */
        onOpened?(workspace: WorkspaceInfo): void;
        /** A folder was expanded or collapsed (the watched set changes). */
        onExpandedChange?(): void;
    },
): Explorer {
    const title = el('h2', { className: 'side-bar-title', text: 'Explorer' });
    const body = el('div', { className: 'explorer-body' });
    container.replaceChildren(title, body);

    const nodes = new Map<HTMLElement, TreeNode>();
    let tree: HTMLUListElement | null = null;

    const openButton = (): HTMLButtonElement => {
        const button = el('button', { className: 'primary-button', text: 'Open Folder…', attrs: { type: 'button', 'data-testid': 'open-folder' } });
        button.addEventListener('click', openFolder);
        return button;
    };

    function openFolder(): void {
        if (!callbacks.confirmOpenFolder()) {
            return;
        }
        api.openFolder().then((info) => {
            if (info) {
                callbacks.onOpened?.(info);
                void show(info);
            }
        }, (error: unknown) => callbacks.onError(`Could not open the folder: ${String(error)}`));
    }

    async function loadChildren(parent: string, level: number): Promise<HTMLUListElement> {
        const group = el('ul', { attrs: { role: parent === '' ? 'tree' : 'group' } });
        await fillGroup(group, parent, level);
        return group;
    }

    /**
     * Lists `parent` into `group`. Rows already there for the same path and
     * kind are kept as they are (with their expanded subtree and focus); rows
     * for entries that disappeared are dropped with their descendants.
     */
    async function fillGroup(group: HTMLUListElement, parent: string, level: number): Promise<void> {
        let entries: readonly DirEntry[];
        try {
            entries = await api.listDirectory(parent);
        } catch (error) {
            callbacks.onError(`Could not list ${parent || 'the folder'}: ${String(error)}`);
            return;
        }
        const existing = new Map<string, TreeNode>();
        for (const row of group.querySelectorAll<HTMLElement>(':scope > li > [role="treeitem"]')) {
            const node = nodes.get(row);
            if (node) { existing.set(`${node.entry.kind}:${node.entry.path}`, node); }
        }
        const items = entries.map((entry) => {
            const key = `${entry.kind}:${entry.path}`;
            const kept = existing.get(key);
            if (kept) {
                existing.delete(key);
                kept.row.classList.toggle('is-ignored', entry.ignored);
                return kept.item;
            }
            return renderItem(entry, level);
        });
        for (const gone of existing.values()) {
            forget(gone.item);
        }
        group.replaceChildren(...items);
    }

    function forget(item: HTMLElement): void {
        for (const row of item.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
            nodes.delete(row);
        }
    }

    function nodeAt(path: string): TreeNode | undefined {
        for (const node of nodes.values()) {
            if (node.entry.path === path) { return node; }
        }
        return undefined;
    }

    function renderItem(entry: DirEntry, level: number): HTMLLIElement {
        const isDir = entry.kind === 'directory';
        const row = el('div', {
            className: `tree-row${entry.ignored ? ' is-ignored' : ''}`,
            attrs: {
                role: 'treeitem',
                tabindex: '-1',
                'aria-level': String(level),
                'aria-selected': 'false',
                'data-path': entry.path,
                title: entry.path,
                ...(isDir ? { 'aria-expanded': 'false' } : {}),
            },
        }, [
            isDir ? icon(CHEVRON, 'tree-chevron') : el('span', { className: 'tree-chevron-space' }),
            icon(isDir ? FOLDER : FILE, 'tree-icon'),
            el('span', { className: 'tree-label', text: entry.name }),
        ]);
        row.style.paddingLeft = `${4 + (level - 1) * 12}px`;
        const item = el('li', { attrs: { role: 'none' } }, [row]);
        nodes.set(row, { entry, row, item, group: null, expanded: false });
        return item;
    }

    async function toggle(node: TreeNode, expand = !node.expanded): Promise<void> {
        if (node.entry.kind !== 'directory' || node.expanded === expand) {
            return;
        }
        node.expanded = expand;
        node.row.setAttribute('aria-expanded', String(expand));
        if (expand && !node.group) {
            node.group = await loadChildren(node.entry.path, Number(node.row.getAttribute('aria-level')) + 1);
            node.item.append(node.group);
        }
        if (node.group) {
            node.group.hidden = !expand;
        }
        callbacks.onExpandedChange?.();
    }

    function activate(node: TreeNode): void {
        focusRow(node.row);
        if (node.entry.kind === 'directory') {
            void toggle(node);
        } else {
            callbacks.onOpenFile(node.entry.path);
        }
    }

    function focusRow(row: HTMLElement): void {
        for (const other of nodes.values()) {
            other.row.setAttribute('tabindex', '-1');
            other.row.setAttribute('aria-selected', 'false');
        }
        row.setAttribute('tabindex', '0');
        row.setAttribute('aria-selected', 'true');
        row.focus();
    }

    function visibleRows(): HTMLElement[] {
        return tree ? [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((row) => !row.closest('[hidden]')) : [];
    }

    function onKeyDown(event: KeyboardEvent): void {
        const row = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
        const node = row ? nodes.get(row) : undefined;
        if (!row || !node) {
            return;
        }
        const rows = visibleRows();
        const index = rows.indexOf(row);
        const move = (target: HTMLElement | undefined): void => { if (target) { focusRow(target); } };
        switch (event.key) {
            case 'ArrowDown': move(rows[index + 1]); break;
            case 'ArrowUp': move(rows[index - 1]); break;
            case 'Home': move(rows[0]); break;
            case 'End': move(rows[rows.length - 1]); break;
            case 'ArrowRight':
                if (node.entry.kind === 'directory' && !node.expanded) { void toggle(node, true); } else if (node.expanded) { move(rows[index + 1]); }
                break;
            case 'ArrowLeft':
                if (node.expanded) { void toggle(node, false); } else { move(row.parentElement?.parentElement?.closest('li')?.querySelector<HTMLElement>(':scope > [role="treeitem"]') ?? undefined); }
                break;
            case 'Enter':
            case ' ':
                activate(node);
                break;
            default:
                return;
        }
        event.preventDefault();
    }

    async function show(workspace: WorkspaceInfo | null): Promise<void> {
        nodes.clear();
        tree = null;
        if (!workspace) {
            title.textContent = 'Explorer';
            body.replaceChildren(el('p', { className: 'muted', text: 'No folder opened.' }), openButton());
            return;
        }
        title.textContent = workspace.name;
        title.title = workspace.root;
        const root = await loadChildren('', 1);
        root.className = 'tree';
        root.setAttribute('aria-label', `Files of ${workspace.name}`);
        root.setAttribute('data-testid', 'explorer-tree');
        root.addEventListener('click', (event) => {
            const row = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
            const node = row ? nodes.get(row) : undefined;
            if (node) { activate(node); }
        });
        root.addEventListener('keydown', onKeyDown);
        tree = root;
        body.replaceChildren(root);
        const first = root.querySelector<HTMLElement>('[role="treeitem"]');
        first?.setAttribute('tabindex', '0');
        if (!first) {
            body.append(el('p', { className: 'muted', text: 'This folder is empty.' }));
        }
        callbacks.onExpandedChange?.();
    }

    function expandedFolders(): string[] {
        if (!tree) {
            return [];
        }
        return ['', ...[...nodes.values()].filter((node) => node.expanded && !node.row.closest('[hidden]')).map((node) => node.entry.path)];
    }

    async function refresh(paths: readonly string[]): Promise<void> {
        if (!tree) {
            return;
        }
        for (const path of new Set(paths)) {
            if (path === '') {
                await fillGroup(tree, '', 1);
                continue;
            }
            const node = nodeAt(path);
            if (node?.group && node.entry.kind === 'directory') {
                await fillGroup(node.group, path, Number(node.row.getAttribute('aria-level')) + 1);
            }
        }
        if (!tree.querySelector('[role="treeitem"][tabindex="0"]')) {
            tree.querySelector<HTMLElement>('[role="treeitem"]')?.setAttribute('tabindex', '0');
        }
    }

    return { show, openFolder, expandedFolders, refresh };
}
