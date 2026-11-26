import { symbolPathAt, type OutlineSymbol } from '../../shared/outline.ts';
import type { DirEntry } from '../../shared/api.ts';
import { showContextMenu, type ContextMenuItem } from '../contextMenu.ts';
import { el, fileIcon, icon } from '../dom.ts';

/**
 * #172: the breadcrumbs above the editor: the folders of the active file,
 * the file, then the symbols around the cursor. Each segment opens a
 * dropdown of its neighbours: a folder lists its entries (a file opens, a
 * folder is revealed in the explorer), the file lists its top-level symbols,
 * and a symbol lists the symbols beside it. The symbols are the Outline's.
 */

export interface Breadcrumbs {
    /** The active file and its outline (null: no file). */
    show(path: string | null, symbols: readonly OutlineSymbol[]): void;
    /** The cursor moved: the symbol segments follow. */
    follow(line: number): void;
    setEnabled(enabled: boolean): void;
}

const SEPARATOR = 'M9 6l6 6-6 6';
const MAX_MENU_ITEMS = 200;

export function createBreadcrumbs(bar: HTMLElement, options: {
    listFolder(path: string): Promise<readonly DirEntry[]>;
    openFile(path: string): void;
    revealFolder(path: string): void;
    reveal(symbol: OutlineSymbol): void;
    rightInset(): number;
}): Breadcrumbs {
    let path: string | null = null;
    let symbols: readonly OutlineSymbol[] = [];
    let chain: readonly OutlineSymbol[] = [];
    let line = 1;
    let enabled = true;
    bar.setAttribute('role', 'navigation');
    bar.setAttribute('aria-label', 'Breadcrumbs');

    function menuAt(segment: HTMLElement, items: readonly ContextMenuItem[], label: string): void {
        const box = segment.getBoundingClientRect();
        const shown = items.length > MAX_MENU_ITEMS
            ? [...items.slice(0, MAX_MENU_ITEMS), { label: `… ${items.length - MAX_MENU_ITEMS} more`, run: () => undefined, enabled: false }]
            : items;
        showContextMenu(shown.length > 0 ? shown : [{ label: 'Nothing here', run: () => undefined, enabled: false }], box.left, box.bottom + 2, { rightInset: options.rightInset, label });
    }

    function symbolItems(list: readonly OutlineSymbol[]): ContextMenuItem[] {
        return list.map((symbol) => ({ label: symbol.name, keybinding: `line ${symbol.line}`, run: () => options.reveal(symbol) }));
    }

    function folderMenu(segment: HTMLElement, folder: string): void {
        options.listFolder(folder).then((entries) => {
            const sorted = [...entries].sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
            menuAt(segment, sorted.map((entry) => ({
                label: entry.kind === 'directory' ? `${entry.name}/` : entry.name,
                run: () => (entry.kind === 'directory' ? options.revealFolder(entry.path) : options.openFile(entry.path)),
            })), `Contents of ${folder || 'the folder'}`);
        }, () => menuAt(segment, [], folder));
    }

    function segmentButton(label: string, leading: Node | null, onOpen: (segment: HTMLElement) => void, testId: string): HTMLButtonElement {
        const button = el('button', { className: 'crumb', attrs: { type: 'button', 'aria-haspopup': 'menu', 'data-testid': testId } },
            [...(leading ? [leading] : []), el('span', { className: 'crumb-label', text: label })]);
        button.addEventListener('click', () => onOpen(button));
        return button;
    }

    function render(): void {
        bar.hidden = !enabled || path === null;
        if (bar.hidden || path === null) {
            bar.replaceChildren();
            return;
        }
        const parts = path.split('/');
        const fileName = parts.pop() ?? path;
        const segments: Node[] = [];
        parts.forEach((name, index) => {
            const folder = parts.slice(0, index + 1).join('/');
            segments.push(segmentButton(name, null, (segment) => folderMenu(segment, folder), 'crumb-folder'));
        });
        segments.push(segmentButton(fileName, fileIcon(fileName, 'file'), (segment) => menuAt(segment, symbolItems(symbols), `Symbols of ${fileName}`), 'crumb-file'));
        chain.forEach((symbol, index) => {
            const siblings = index === 0 ? symbols : chain[index - 1]?.children ?? [];
            segments.push(segmentButton(symbol.name, null, (segment) => menuAt(segment, symbolItems(siblings), `Symbols beside ${symbol.name}`), 'crumb-symbol'));
        });
        const withSeparators = segments.flatMap((segment, index) => (index === 0 ? [segment] : [icon(SEPARATOR, 'crumb-separator'), segment]));
        bar.replaceChildren(...withSeparators);
        bar.lastElementChild?.scrollIntoView({ block: 'nearest', inline: 'end' });
    }

    function follow(next: number): void {
        line = next;
        const nextChain = symbolPathAt(symbols, line);
        if (nextChain.length === chain.length && nextChain.every((symbol, index) => symbol === chain[index])) {
            return;
        }
        chain = nextChain;
        render();
    }

    return {
        show(nextPath, nextSymbols): void {
            path = nextPath;
            symbols = nextSymbols;
            chain = symbolPathAt(symbols, line);
            render();
        },
        follow,
        setEnabled(next): void {
            enabled = next;
            render();
        },
    };
}
