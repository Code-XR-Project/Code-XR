import { sortOutline, type OutlineKind, type OutlineSort, type OutlineSymbol } from '../../shared/outline.ts';
import { el, icon } from '../dom.ts';

/**
 * #172: the Outline section under the explorer. The symbols of the active
 * file as a tree, following the cursor (the innermost symbol around it is
 * marked and scrolled into view) and sortable by position or name; a click
 * or Enter puts the cursor on a symbol. The section folds to its header, as
 * VS Code's does, and remembers that.
 *
 * Where the symbols come from is the controller's business
 * (editor/outlineController.ts): the language service where the editor has
 * one, otherwise the functions the Code-XR analysis measured. The view only
 * draws them and says which.
 */

export type OutlineSource = 'language' | 'analysis';

export type OutlineState =
    | { readonly kind: 'no-editor' }
    | { readonly kind: 'loading'; readonly path: string }
    | { readonly kind: 'symbols'; readonly path: string; readonly symbols: readonly OutlineSymbol[]; readonly source: OutlineSource }
    /** Nothing to show: `reason` says why ("no functions", "Python not set up"). */
    | { readonly kind: 'empty'; readonly path: string; readonly reason: string };

export interface OutlineView {
    show(state: OutlineState): void;
    /** The cursor of the active file moved to `line`. */
    follow(line: number): void;
    setSort(sort: OutlineSort): void;
}

const CHEVRON = 'M9 6l6 6-6 6';
const SORT = 'M4 7h10M4 12h7M4 17h4M17 6v12M14 15l3 3 3-3';
const COLLAPSED_KEY = 'codexr:outline:collapsed';

/** A letter and a colour per kind, like VS Code's symbol icons, in the workbench's own palette. */
const KIND_BADGE: Readonly<Record<OutlineKind, { readonly letter: string; readonly tone: string }>> = {
    class: { letter: 'C', tone: 'warn' }, interface: { letter: 'I', tone: 'accent' }, struct: { letter: 'S', tone: 'warn' },
    enum: { letter: 'E', tone: 'warn' }, namespace: { letter: 'N', tone: 'muted' }, module: { letter: 'M', tone: 'muted' },
    type: { letter: 'T', tone: 'accent' }, function: { letter: 'ƒ', tone: 'violet' }, method: { letter: 'm', tone: 'violet' },
    constructor: { letter: 'c', tone: 'violet' }, property: { letter: 'p', tone: 'accent' }, field: { letter: 'f', tone: 'accent' },
    variable: { letter: 'v', tone: 'accent' }, constant: { letter: 'k', tone: 'accent' }, other: { letter: '·', tone: 'muted' },
};

function readCollapsed(storage: Storage | null): boolean {
    try {
        return storage?.getItem(COLLAPSED_KEY) === 'true';
    } catch {
        return false;
    }
}

function writeCollapsed(storage: Storage | null, collapsed: boolean): void {
    try {
        storage?.setItem(COLLAPSED_KEY, String(collapsed));
    } catch {
        // Storage unavailable: the section just opens expanded next time.
    }
}

interface Row {
    readonly element: HTMLElement;
    readonly symbol: OutlineSymbol;
    readonly group: HTMLUListElement | null;
    readonly parent: Row | null;
}

export function createOutlineView(container: HTMLElement, options: {
    readonly storage: Storage | null;
    readonly sort: OutlineSort;
    /** A symbol was picked: put the cursor on its line. */
    reveal(symbol: OutlineSymbol, focusEditor: boolean): void;
    /** The sort button was pressed (the setting stores the choice). */
    onSortChange(sort: OutlineSort): void;
}): OutlineView {
    let sort = options.sort;
    let collapsed = readCollapsed(options.storage);
    let state: OutlineState = { kind: 'no-editor' };
    let rows: Row[] = [];
    let activeRow: Row | null = null;
    let cursorLine = 0;
    /** Symbols folded by the person, by their path of names, kept while the file stays the same. */
    const folded = new Set<string>();
    let foldedPath: string | null = null;

    const toggle = el('button', {
        className: 'outline-toggle',
        attrs: { type: 'button', 'aria-expanded': String(!collapsed), 'aria-controls': 'outline-body', 'data-testid': 'outline-toggle' },
    }, [icon(CHEVRON, 'tree-chevron'), el('span', { text: 'Outline' })]);
    const sortButton = el('button', { className: 'icon-button', attrs: { type: 'button', 'data-testid': 'outline-sort' } }, [icon(SORT)]);
    const actions = el('div', { className: 'side-bar-actions' }, [sortButton]);
    const header = el('div', { className: 'outline-header' }, [toggle, actions]);
    const body = el('div', { className: 'outline-body', attrs: { id: 'outline-body', 'data-testid': 'outline' } });
    container.replaceChildren(header, body);
    container.classList.add('outline-section');

    function applyCollapsed(): void {
        container.classList.toggle('is-collapsed', collapsed);
        toggle.setAttribute('aria-expanded', String(!collapsed));
        body.hidden = collapsed;
        actions.hidden = collapsed;
    }
    toggle.addEventListener('click', () => {
        collapsed = !collapsed;
        writeCollapsed(options.storage, collapsed);
        applyCollapsed();
        if (!collapsed) {
            render();
        }
    });

    function labelSort(): void {
        const next = sort === 'position' ? 'name' : 'position';
        const label = `Sort by ${next === 'name' ? 'Name' : 'Position'}`;
        sortButton.title = label;
        sortButton.setAttribute('aria-label', label);
    }
    sortButton.addEventListener('click', () => {
        options.onSortChange(sort === 'position' ? 'name' : 'position');
    });

    const keyOf = (row: Row): string => `${row.parent ? keyOf(row.parent) : ''}/${row.symbol.name}@${row.symbol.kind}`;

    function note(text: string): void {
        body.replaceChildren(el('p', { className: 'muted outline-note', text }));
    }

    function renderTree(symbols: readonly OutlineSymbol[], source: OutlineSource): void {
        rows = [];
        const tree = el('ul', { className: 'tree outline-tree', attrs: { role: 'tree', 'aria-label': 'Outline' } });
        const build = (list: readonly OutlineSymbol[], parentGroup: HTMLUListElement, parent: Row | null, depth: number): void => {
            for (const symbol of list) {
                const badge = KIND_BADGE[symbol.kind];
                const hasChildren = symbol.children.length > 0;
                const element = el('div', {
                    className: 'tree-row outline-row',
                    attrs: { role: 'treeitem', tabindex: '-1', title: `${symbol.name} (line ${symbol.line})`, 'aria-level': String(depth + 1), 'data-line': String(symbol.line) },
                }, [
                    hasChildren ? icon(CHEVRON, 'tree-chevron') : el('span', { className: 'tree-chevron-space' }),
                    el('span', { className: `symbol-kind tone-${badge.tone}`, text: badge.letter, attrs: { 'aria-hidden': 'true' } }),
                    el('span', { className: 'tree-label', text: symbol.name }),
                ]);
                element.style.paddingLeft = `${4 + depth * 12}px`;
                const item = el('li', { attrs: { role: 'none' } }, [element]);
                const group = hasChildren ? el('ul', { attrs: { role: 'group' } }) : null;
                const row: Row = { element, symbol, group, parent };
                rows.push(row);
                if (group) {
                    const open = !folded.has(keyOf(row));
                    element.setAttribute('aria-expanded', String(open));
                    group.hidden = !open;
                    item.append(group);
                    build(symbol.children, group, row, depth + 1);
                }
                parentGroup.append(item);
            }
        };
        build(symbols, tree, null, 0);
        const children: Node[] = [tree];
        if (source === 'analysis') {
            children.push(el('p', { className: 'muted small outline-note', text: 'Functions from the Code-XR analysis, as saved on disk.' }));
        }
        body.replaceChildren(...children);
        const first = rows[0];
        if (first) {
            first.element.tabIndex = 0;
        }
        activeRow = null;
        follow(cursorLine);
    }

    function render(): void {
        labelSort();
        if (collapsed) {
            return;
        }
        switch (state.kind) {
            case 'no-editor': note('No file is open in the editor.'); break;
            case 'loading': note('Reading the symbols…'); break;
            case 'empty': note(state.reason); break;
            case 'symbols': renderTree(sortOutline(state.symbols, sort), state.source); break;
        }
    }

    function visibleRows(): Row[] {
        return rows.filter((row) => {
            for (let parent = row.parent; parent; parent = parent.parent) {
                if (parent.group?.hidden) {
                    return false;
                }
            }
            return true;
        });
    }

    function setFolded(row: Row, fold: boolean): void {
        if (!row.group) {
            return;
        }
        row.group.hidden = fold;
        row.element.setAttribute('aria-expanded', String(!fold));
        if (fold) { folded.add(keyOf(row)); } else { folded.delete(keyOf(row)); }
    }

    function focusRow(row: Row): void {
        for (const other of rows) {
            other.element.tabIndex = other === row ? 0 : -1;
        }
        row.element.focus();
    }

    function rowOf(target: EventTarget | null): Row | undefined {
        const element = target instanceof Element ? target.closest('.outline-row') : null;
        return rows.find((row) => row.element === element);
    }

    body.addEventListener('click', (event) => {
        const row = rowOf(event.target);
        if (!row) {
            return;
        }
        if (row.group && event.target instanceof Element && event.target.closest('.tree-chevron')) {
            setFolded(row, !row.group.hidden);
            return;
        }
        focusRow(row);
        options.reveal(row.symbol, false);
    });
    body.addEventListener('keydown', (event) => {
        const row = rowOf(event.target);
        if (!row) {
            return;
        }
        const visible = visibleRows();
        const index = visible.indexOf(row);
        const move = (target: Row | undefined): void => { if (target) { focusRow(target); } };
        switch (event.key) {
            case 'ArrowDown': move(visible[index + 1]); break;
            case 'ArrowUp': move(visible[index - 1]); break;
            case 'Home': move(visible[0]); break;
            case 'End': move(visible.at(-1)); break;
            case 'ArrowRight': if (row.group?.hidden) { setFolded(row, false); } else { move(row.group ? visible[index + 1] : undefined); } break;
            case 'ArrowLeft': if (row.group && !row.group.hidden) { setFolded(row, true); } else { move(row.parent ?? undefined); } break;
            case 'Enter': options.reveal(row.symbol, true); break;
            case ' ': options.reveal(row.symbol, false); break;
            default: return;
        }
        event.preventDefault();
    });

    /** Marks the innermost symbol around `line` (the first of two that share it), unfolding nothing: a folded parent is marked instead. */
    function follow(line: number): void {
        cursorLine = line;
        let best: Row | null = null;
        const within = (row: Row, ancestor: Row): boolean => {
            for (let parent = row.parent; parent; parent = parent.parent) {
                if (parent === ancestor) { return true; }
            }
            return false;
        };
        for (const row of visibleRows()) {
            const { startLine, endLine } = row.symbol;
            if (startLine <= line && endLine >= line && (!best || within(row, best))) {
                best = row;
            }
        }
        if (best === activeRow) {
            return;
        }
        activeRow?.element.classList.remove('is-active');
        activeRow?.element.removeAttribute('aria-current');
        activeRow = best;
        if (best) {
            best.element.classList.add('is-active');
            best.element.setAttribute('aria-current', 'location');
            if (!container.closest('[hidden]')) {
                best.element.scrollIntoView({ block: 'nearest' });
            }
        }
    }

    applyCollapsed();
    render();

    return {
        show(next): void {
            const path = next.kind === 'no-editor' ? null : next.path;
            if (path !== foldedPath) {
                folded.clear();
                foldedPath = path;
            }
            state = next;
            render();
        },
        follow,
        setSort(next): void {
            if (next !== sort) {
                sort = next;
                render();
            }
        },
    };
}
