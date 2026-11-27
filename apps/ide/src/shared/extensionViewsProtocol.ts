/**
 * #261: the views extensions add to the workbench — the tree views of
 * `contributes.views` filled by `window.registerTreeDataProvider` /
 * `createTreeView` — and the menus that act on them. The wire between the
 * renderer, the main process and the extension host.
 *
 * Tree elements never leave the host: each gets an opaque handle, and the
 * workbench asks for children, clicks and menu commands by handle. Icons from
 * files are read by the main process (inside an extension or the workspace
 * only) and reach the renderer as data URLs; a `resource` path is rewritten
 * like every other path (workspace paths in the renderer, absolute in the
 * host).
 *
 * Shared by main, the host and the renderer: no Node, Electron or DOM import.
 */

import type { ExtensionId } from './extensions.ts';

/** An icon as the workbench draws it. */
export type IconData =
    /** A product icon (`$(name)`, `ThemeIcon`), from the codicon font. */
    | { readonly kind: 'codicon'; readonly name: string; readonly color?: string }
    /** An image, as `data:` URLs (the dark one for dark themes). */
    | { readonly kind: 'image'; readonly light: string; readonly dark: string }
    /** `ThemeIcon.File` / `ThemeIcon.Folder`: the workbench's file icon for the item's resource. */
    | { readonly kind: 'file' }
    | { readonly kind: 'folder' };

/** An icon as the host sends it: a file to read stays absolute until the main process inlines it. */
export type HostIconData = IconData | { readonly kind: 'iconFile'; readonly file: string; readonly darkFile?: string };

/** `TreeItemCollapsibleState`: none, collapsed, expanded. */
export type Collapsible = 0 | 1 | 2;

export interface TreeItemData {
    readonly handle: string;
    readonly label: string;
    /** `TreeItemLabel.highlights`: [start, end) ranges of the label. */
    readonly highlights?: readonly (readonly [number, number])[];
    readonly description?: string;
    readonly tooltip?: string;
    readonly collapsible: Collapsible;
    readonly icon?: HostIconData;
    /** `resourceUri`: a workspace path in the renderer (null when outside the folder), absolute in the host. */
    readonly resource?: { readonly path: string } | null;
    /** The resource's file name, kept when the path is outside the folder (for the label and the icon). */
    readonly resourceName?: string;
    /** The item has a `command`: a click runs it (the host keeps the arguments). */
    readonly hasCommand?: boolean;
    readonly contextValue?: string;
    readonly accessibilityLabel?: string;
    /** `TreeItemCheckboxState`, when the item shows a checkbox. */
    readonly checked?: boolean;
}

/** Renderer -> host, by way of the main process. */
export type ViewRequest =
    /** The children of `handle` (null: the roots). Answers `{ items }`, or null when no provider is registered. */
    | { readonly kind: 'treeChildren'; readonly viewId: string; readonly handle: string | null }
    /** The item was clicked (or Enter): runs its `command`. */
    | { readonly kind: 'treeClick'; readonly viewId: string; readonly handle: string }
    /** A menu command on items: runs `command` with the element (and the selected elements). */
    | { readonly kind: 'treeCommand'; readonly viewId: string; readonly command: string; readonly handle: string | null; readonly selected: readonly string[] }
    | { readonly kind: 'treeExpand'; readonly viewId: string; readonly handle: string; readonly expanded: boolean }
    | { readonly kind: 'treeSelection'; readonly viewId: string; readonly handles: readonly string[] }
    | { readonly kind: 'treeCheckbox'; readonly viewId: string; readonly handle: string; readonly checked: boolean }
    /** The view was shown or hidden: activates `onView:<id>` and fires `onDidChangeVisibility`. */
    | { readonly kind: 'viewVisibility'; readonly viewId: string; readonly visible: boolean };

export const MAX_VIEW_SELECTION = 1000;

/** Host -> renderer (a `UiNotification` of kind `view`). */
export type ViewNotification =
    | { readonly kind: 'treeRegistered'; readonly viewId: string; readonly extensionId: ExtensionId; readonly showCollapseAll: boolean; readonly canSelectMany: boolean; readonly manageCheckboxStateManually: boolean }
    | { readonly kind: 'treeDisposed'; readonly viewId: string }
    /** `onDidChangeTreeData`: these items changed (null: the whole tree). */
    | { readonly kind: 'treeChanged'; readonly viewId: string; readonly handles: readonly string[] | null }
    /** `TreeView.reveal`: the chain from a root to the item, which is selected and/or focused, and expanded `expand` levels. */
    | { readonly kind: 'treeReveal'; readonly viewId: string; readonly path: readonly string[]; readonly select: boolean; readonly focus: boolean; readonly expand: number }
    /** `TreeView.title`, `description`, `message`, `badge`; an absent field is unchanged, null clears it. */
    | { readonly kind: 'viewMeta'; readonly viewId: string; readonly title?: string | null; readonly description?: string | null; readonly message?: string | null; readonly badge?: { readonly value: number; readonly tooltip: string } | null }
    /** Shows and focuses a view (`<viewId>.focus`, `workbench.view.extension.<container>`). */
    | { readonly kind: 'viewFocus'; readonly viewId: string };

/** The context keys of an item, for `view/item/context` menus. */
export function itemContext(viewId: string, item: Pick<TreeItemData, 'contextValue'> | null): Readonly<Record<string, unknown>> {
    return { view: viewId, viewItem: item?.contextValue ?? '', focusedView: viewId };
}

/** `$(name)` or `$(name~spin)` -> the codicon's name; null for any other string. */
export function codiconName(value: string): string | null {
    const match = /^\$\(([a-z0-9-]+)(?:~[a-z]+)?\)$/i.exec(value.trim());
    return match ? match[1] as string : null;
}

/** Splits text with `$(icon)` references into text and icons (a label like `$(sync~spin) Syncing`). */
export function splitIcons(text: string): ({ readonly text: string } | { readonly icon: string })[] {
    const parts: ({ readonly text: string } | { readonly icon: string })[] = [];
    const pattern = /\$\(([a-z0-9-]+)(?:~[a-z]+)?\)/gi;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        if (match.index > last) {
            parts.push({ text: text.slice(last, match.index) });
        }
        parts.push({ icon: match[1] as string });
        last = match.index + match[0].length;
    }
    if (last < text.length) {
        parts.push({ text: text.slice(last) });
    }
    return parts;
}

/**
 * The welcome content of an empty view: paragraphs, each either text with
 * `[label](command:id)` / `[label](https://...)` links, or one link alone,
 * which VS Code draws as a button.
 */
export type WelcomeLine =
    | { readonly kind: 'button'; readonly label: string; readonly target: string }
    | { readonly kind: 'text'; readonly parts: readonly ({ readonly text: string } | { readonly label: string; readonly target: string })[] };

export function parseWelcome(contents: string): WelcomeLine[] {
    const lines: WelcomeLine[] = [];
    for (const raw of contents.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '') {
            continue;
        }
        const alone = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(line);
        if (alone) {
            lines.push({ kind: 'button', label: alone[1] as string, target: alone[2] as string });
            continue;
        }
        const parts: ({ readonly text: string } | { readonly label: string; readonly target: string })[] = [];
        const pattern = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
        let last = 0;
        for (const match of line.matchAll(pattern)) {
            if (match.index > last) {
                parts.push({ text: line.slice(last, match.index) });
            }
            parts.push({ label: match[1] as string, target: match[2] as string });
            last = match.index + match[0].length;
        }
        if (last < line.length) {
            parts.push({ text: line.slice(last) });
        }
        lines.push({ kind: 'text', parts });
    }
    return lines;
}

/** A `command:` link of welcome content: the command and its JSON arguments; null for any other target. */
export function commandLink(target: string): { readonly command: string; readonly args: readonly unknown[] } | null {
    if (!target.startsWith('command:')) {
        return null;
    }
    const rest = target.slice('command:'.length);
    const query = rest.indexOf('?');
    const command = query < 0 ? rest : rest.slice(0, query);
    if (command === '') {
        return null;
    }
    if (query < 0) {
        return { command, args: [] };
    }
    try {
        const parsed: unknown = JSON.parse(decodeURIComponent(rest.slice(query + 1)));
        return { command, args: Array.isArray(parsed) ? parsed : [parsed] };
    } catch {
        return { command, args: [] };
    }
}

const MAX_VIEW_ID = 256;
const MAX_HANDLE = 4096;

function viewIdOk(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_VIEW_ID;
}

function handleOk(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_HANDLE;
}

/** A request from the renderer, checked field by field; null when anything is off. */
export function parseViewRequest(raw: unknown): ViewRequest | null {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const r = raw as Record<string, unknown>;
    if (!viewIdOk(r['viewId'])) {
        return null;
    }
    const viewId = r['viewId'];
    switch (r['kind']) {
        case 'treeChildren':
            return r['handle'] === null || handleOk(r['handle']) ? { kind: 'treeChildren', viewId, handle: r['handle'] as string | null } : null;
        case 'treeClick':
            return handleOk(r['handle']) ? { kind: 'treeClick', viewId, handle: r['handle'] } : null;
        case 'treeCommand': {
            const selected = r['selected'];
            if (typeof r['command'] !== 'string' || r['command'] === '' || r['command'].length > 300 || !(r['handle'] === null || handleOk(r['handle']))
                || !Array.isArray(selected) || selected.length > MAX_VIEW_SELECTION || !selected.every(handleOk)) {
                return null;
            }
            return { kind: 'treeCommand', viewId, command: r['command'], handle: r['handle'] as string | null, selected: selected as string[] };
        }
        case 'treeExpand':
            return handleOk(r['handle']) && typeof r['expanded'] === 'boolean' ? { kind: 'treeExpand', viewId, handle: r['handle'], expanded: r['expanded'] } : null;
        case 'treeSelection': {
            const handles = r['handles'];
            return Array.isArray(handles) && handles.length <= MAX_VIEW_SELECTION && handles.every(handleOk) ? { kind: 'treeSelection', viewId, handles: handles as string[] } : null;
        }
        case 'treeCheckbox':
            return handleOk(r['handle']) && typeof r['checked'] === 'boolean' ? { kind: 'treeCheckbox', viewId, handle: r['handle'], checked: r['checked'] } : null;
        case 'viewVisibility':
            return typeof r['visible'] === 'boolean' ? { kind: 'viewVisibility', viewId, visible: r['visible'] } : null;
        default:
            return null;
    }
}
