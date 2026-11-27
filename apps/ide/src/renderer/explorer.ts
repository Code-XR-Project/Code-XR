import type { CodeXRApi, DirEntry, WorkspaceInfo } from '../shared/api.ts';
import { el, fileIcon, icon } from './dom.ts';
import type { ExplorerGitDecoration } from '../shared/gitGutter.ts';

/**
 * The explorer (#14): the open folder as a tree that loads each folder's
 * children only when it is expanded, so a large project opens at once.
 * Keyboard follows the WAI-ARIA tree pattern: Up/Down move, Right expands or
 * enters, Left collapses or goes to the parent, Enter/Space activates, Home/End.
 * F2 renames the focused entry and Delete moves it to the trash; New File and
 * New Folder create inside the focused folder (or the focused file's folder).
 * Each row shows the icon of its language or type (#138, `fileIcons.ts`);
 * a folder's icon opens and closes with it.
 */

const CHEVRON = 'M9 6l6 6-6 6';
const NEW_FILE = 'M6 3h8l4 4v14H6zM12 11v6M9 14h6';
const NEW_FOLDER = 'M3 6h7l2 2h9v11H3zM12 11v6M9 14h6';

const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/');

export interface Explorer {
    show(workspace: WorkspaceInfo | null): Promise<void>;
    /** The folder picker, after `confirmOpenFolder` agrees. */
    openFolder(): void;
    /** The root (`''`) and every expanded folder: what should follow the disk. */
    expandedFolders(): string[];
    /** Re-lists the loaded folders among `paths` (changed on disk), keeping what is expanded. */
    refresh(paths: readonly string[]): Promise<void>;
    /** Inline name box for a new file / folder in the focused folder. */
    newFile(): Promise<void>;
    newFolder(): Promise<void>;
    /** #167: expands the folders down to `path`, selects its row and shows the explorer's focus on it. */
    reveal(path: string): Promise<boolean>;
    /** #175: the Git state of the changed files and of the folders above them (colour, and a letter on files). */
    setGitDecorations(decorations: ReadonlyMap<string, ExplorerGitDecoration>): void;
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
        /** #167: a single click opens a preview (`preview` true); Enter and a double click open for keeps. */
        onOpenFile(path: string, preview: boolean): void;
        onError(message: string): void;
        /** Asked before the picker opens; false keeps the current folder (unsaved editors). */
        confirmOpenFolder(): boolean;
        /** A new folder was opened from the picker. */
        onOpened?(workspace: WorkspaceInfo): void;
        /** A folder was expanded or collapsed (the watched set changes). */
        onExpandedChange?(): void;
        /** An entry was created from the explorer. */
        onCreated?(path: string, kind: DirEntry['kind']): void;
        /** An entry (and everything below it) was renamed from the explorer. */
        onRenamed?(from: string, to: string): void;
        /** An entry (and everything below it) was moved to the trash from the explorer. */
        onTrashed?(path: string): void;
        /** #16: a right click on a file (the menu with its analyses). */
        onFileContextMenu?(path: string, x: number, y: number): void;
        /** A recent folder was opened from the empty explorer. */
        confirmOpenRecent?(): boolean;
    },
): Explorer {
    const title = el('h2', { className: 'side-bar-title', text: 'Explorer' });
    const actionButton = (label: string, path: string, testId: string, run: () => void): HTMLButtonElement => {
        const button = el('button', { className: 'icon-button', attrs: { type: 'button', title: label, 'aria-label': label, 'data-testid': testId } }, [icon(path)]);
        button.addEventListener('click', run);
        return button;
    };
    const actions = el('div', { className: 'side-bar-actions' }, [
        actionButton('New File…', NEW_FILE, 'new-file', () => void createEntry('file')),
        actionButton('New Folder…', NEW_FOLDER, 'new-folder', () => void createEntry('directory')),
    ]);
    actions.hidden = true;
    const header = el('div', { className: 'side-bar-header' }, [title, actions]);
    const body = el('div', { className: 'explorer-body' });
    container.replaceChildren(header, body);

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

    // #175: rows follow the last Git status; a row rendered later picks its state up in renderItem.
    let gitDecorations: ReadonlyMap<string, ExplorerGitDecoration> = new Map();
    function decorate(row: HTMLElement, path: string): void {
        const decoration = gitDecorations.get(path);
        const state = decoration?.state ?? '';
        if ((row.dataset['git'] ?? '') === state && (row.querySelector('.tree-git-letter')?.textContent ?? '') === (decoration?.letter ?? '')) {
            return;
        }
        if (state) {
            row.dataset['git'] = state;
        } else {
            delete row.dataset['git'];
        }
        row.querySelector('.tree-git-letter')?.remove();
        if (decoration?.letter) {
            row.append(el('span', { className: 'tree-git-letter', text: decoration.letter, attrs: { 'aria-hidden': 'true' } }));
        }
        const base = row.title.replace(/ \((modified|added|deleted|untracked|renamed|conflict)\)$/, '');
        row.title = state ? `${base} (${state})` : base;
    }
    function setGitDecorations(decorations: ReadonlyMap<string, ExplorerGitDecoration>): void {
        gitDecorations = decorations;
        for (const node of nodes.values()) {
            decorate(node.row, node.entry.path);
        }
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
            fileIcon(entry.name, entry.kind),
            el('span', { className: 'tree-label', text: entry.name }),
        ]);
        row.style.paddingLeft = `${4 + (level - 1) * 12}px`;
        const item = el('li', { attrs: { role: 'none' } }, [row]);
        nodes.set(row, { entry, row, item, group: null, expanded: false });
        decorate(row, entry.path);
        return item;
    }

    async function toggle(node: TreeNode, expand = !node.expanded): Promise<void> {
        if (node.entry.kind !== 'directory' || node.expanded === expand) {
            return;
        }
        node.expanded = expand;
        node.row.setAttribute('aria-expanded', String(expand));
        node.row.querySelector(':scope > .file-icon')?.replaceWith(fileIcon(node.entry.name, 'directory', expand));
        if (expand && !node.group) {
            node.group = await loadChildren(node.entry.path, Number(node.row.getAttribute('aria-level')) + 1);
            node.item.append(node.group);
        }
        if (node.group) {
            node.group.hidden = !expand;
        }
        callbacks.onExpandedChange?.();
    }

    function activate(node: TreeNode, preview = false): void {
        focusRow(node.row);
        if (node.entry.kind === 'directory') {
            void toggle(node);
        } else {
            callbacks.onOpenFile(node.entry.path, preview);
        }
    }

    async function reveal(path: string): Promise<boolean> {
        const parts = path.split('/');
        for (let depth = 1; depth < parts.length; depth++) {
            const folder = nodeAt(parts.slice(0, depth).join('/'));
            if (!folder || folder.entry.kind !== 'directory') {
                return false;
            }
            if (!folder.expanded) {
                await toggle(folder, true);
            }
        }
        const node = nodeAt(path);
        if (!node) {
            return false;
        }
        focusRow(node.row);
        node.row.scrollIntoView({ block: 'nearest' });
        return true;
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
        if ((event.target as HTMLElement).tagName === 'INPUT') {
            return; // the inline name box handles its own keys
        }
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
            case 'F2':
                void renameEntry(node);
                break;
            case 'Delete':
                void trashEntry(node);
                break;
            case 'Backspace':
                if (!event.metaKey) { return; } // Cmd+Backspace: the macOS delete shortcut
                void trashEntry(node);
                break;
            default:
                return;
        }
        event.preventDefault();
    }

    async function show(workspace: WorkspaceInfo | null): Promise<void> {
        nodes.clear();
        tree = null;
        actions.hidden = !workspace;
        if (!workspace) {
            title.textContent = 'Explorer';
            body.replaceChildren(el('p', { className: 'muted', text: 'No folder opened.' }), openButton());
            void showRecent();
            return;
        }
        title.textContent = workspace.name;
        title.title = workspace.root;
        const root = await loadChildren('', 1);
        root.className = 'tree';
        root.setAttribute('aria-label', `Files of ${workspace.name}`);
        root.setAttribute('data-testid', 'explorer-tree');
        root.addEventListener('click', (event) => {
            if ((event.target as HTMLElement).tagName === 'INPUT') {
                return;
            }
            const row = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
            const node = row ? nodes.get(row) : undefined;
            if (node) { activate(node, true); }
        });
        root.addEventListener('dblclick', (event) => {
            const row = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
            const node = row ? nodes.get(row) : undefined;
            if (node && node.entry.kind === 'file') { callbacks.onOpenFile(node.entry.path, false); }
        });
        root.addEventListener('contextmenu', (event) => {
            const row = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
            const node = row ? nodes.get(row) : undefined;
            if (node?.entry.kind === 'file' && callbacks.onFileContextMenu) {
                event.preventDefault();
                callbacks.onFileContextMenu(node.entry.path, event.clientX, event.clientY);
            }
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

    /** Recent folders under the Open Folder button, while nothing is open. */
    async function showRecent(): Promise<void> {
        let folders: readonly string[];
        try {
            folders = await api.recentFolders();
        } catch {
            return;
        }
        if (tree || folders.length === 0) {
            return;
        }
        const list = el('ul', { className: 'recent-list', attrs: { 'aria-label': 'Recent folders', 'data-testid': 'recent-folders' } });
        for (const folder of folders) {
            const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
            const button = el('button', { className: 'recent-item', attrs: { type: 'button', title: folder } }, [
                el('span', { className: 'recent-name', text: name }),
                el('span', { className: 'recent-path muted small', text: folder }),
            ]);
            button.addEventListener('click', () => {
                if (callbacks.confirmOpenRecent && !callbacks.confirmOpenRecent()) {
                    return;
                }
                api.openRecent(folder).then((info) => {
                    callbacks.onOpened?.(info);
                    void show(info);
                }, (error: unknown) => {
                    callbacks.onError(String(error));
                    void show(null);
                });
            });
            list.append(el('li', {}, [button]));
        }
        body.append(el('h3', { className: 'side-bar-subtitle', text: 'Recent' }), list);
    }

    function selectedNode(): TreeNode | undefined {
        const row = tree?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]');
        return row ? nodes.get(row) : undefined;
    }

    /**
     * An inline name box. Enter resolves with the trimmed name, Escape or
     * leaving the box resolves with null. `select` picks the part to replace.
     */
    function askName(host: HTMLElement, initial: string, label: string, select: [number, number] = [0, initial.length]): Promise<string | null> {
        const input = el('input', { className: 'tree-input', attrs: { type: 'text', 'aria-label': label, spellcheck: 'false', 'data-testid': 'explorer-name-input' } });
        input.value = initial;
        host.append(input);
        input.focus();
        input.setSelectionRange(...select);
        return new Promise((resolve) => {
            let done = false;
            const finish = (value: string | null): void => {
                if (done) { return; }
                done = true;
                input.remove();
                resolve(value?.trim() ? value.trim() : null);
            };
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') { event.preventDefault(); finish(input.value); }
                if (event.key === 'Escape') { event.preventDefault(); finish(null); }
                event.stopPropagation();
            });
            input.addEventListener('blur', () => finish(null));
        });
    }

    async function createEntry(kind: DirEntry['kind']): Promise<void> {
        if (!tree) {
            return;
        }
        const selected = selectedNode();
        let parent = '';
        let group: HTMLUListElement = tree;
        let level = 1;
        const folderNode = selected?.entry.kind === 'directory' ? selected : selected ? nodeAt(parentOf(selected.entry.path)) : undefined;
        if (folderNode) {
            await toggle(folderNode, true);
            if (folderNode.group) {
                parent = folderNode.entry.path;
                group = folderNode.group;
                level = Number(folderNode.row.getAttribute('aria-level')) + 1;
            }
        }
        const row = el('div', { className: 'tree-row is-editing' }, [el('span', { className: 'tree-chevron-space' }), fileIcon('', kind)]);
        row.style.paddingLeft = `${4 + (level - 1) * 12}px`;
        const placeholder = el('li', { attrs: { role: 'none' } }, [row]);
        group.prepend(placeholder);
        const name = await askName(row, '', kind === 'directory' ? 'New folder name' : 'New file name');
        placeholder.remove();
        if (!name) {
            return;
        }
        try {
            const created = await api.createEntry(parent, name, kind);
            await refresh([parent]);
            const node = nodeAt(created);
            if (node) { focusRow(node.row); }
            callbacks.onCreated?.(created, kind);
        } catch (error) {
            callbacks.onError(`Could not create ${name}: ${errorText(error)}`);
        }
    }

    async function renameEntry(node: TreeNode): Promise<void> {
        const label = node.row.querySelector<HTMLElement>('.tree-label');
        const old = node.entry.name;
        const dot = node.entry.kind === 'file' ? old.lastIndexOf('.') : -1;
        if (label) { label.hidden = true; }
        node.row.classList.add('is-editing');
        const name = await askName(node.row, old, `Rename ${old}`, [0, dot > 0 ? dot : old.length]);
        node.row.classList.remove('is-editing');
        if (label) { label.hidden = false; }
        if (!name || name === old) {
            node.row.focus();
            return;
        }
        try {
            const renamed = await api.rename(node.entry.path, name);
            await refresh([parentOf(node.entry.path)]);
            const moved = nodeAt(renamed);
            if (moved) { focusRow(moved.row); }
            callbacks.onRenamed?.(node.entry.path, renamed);
        } catch (error) {
            callbacks.onError(`Could not rename ${old}: ${errorText(error)}`);
            node.row.focus();
        }
    }

    async function trashEntry(node: TreeNode): Promise<void> {
        const what = node.entry.kind === 'directory' ? `the folder ${node.entry.name} and everything in it` : node.entry.name;
        if (!window.confirm(`Move ${what} to the trash?`)) {
            node.row.focus();
            return;
        }
        const rows = visibleRows();
        const next = rows[rows.indexOf(node.row) + 1] ?? rows[rows.indexOf(node.row) - 1];
        const nextPath = next ? nodes.get(next)?.entry.path : undefined;
        try {
            await api.trash(node.entry.path);
            await refresh([parentOf(node.entry.path)]);
            const neighbour = nextPath ? nodeAt(nextPath) : undefined;
            if (neighbour) { focusRow(neighbour.row); }
            callbacks.onTrashed?.(node.entry.path);
        } catch (error) {
            callbacks.onError(`Could not move ${node.entry.name} to the trash: ${errorText(error)}`);
        }
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

    return { show, openFolder, expandedFolders, refresh, newFile: () => createEntry('file'), newFolder: () => createEntry('directory'), reveal, setGitDecorations };
}

/** The message of an IPC rejection, without Electron's "Error invoking remote method" prefix. */
function errorText(error: unknown): string {
    return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}
