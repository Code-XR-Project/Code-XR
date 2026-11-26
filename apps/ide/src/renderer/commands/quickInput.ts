import { el } from '../dom.ts';
import { highlightRuns } from './fuzzy.ts';
import type { PaletteAction, PaletteEntry, PaletteView } from './paletteModel.ts';

/**
 * The quick-input box (#18): the command palette, go to line and, with #164,
 * quick open. One box at the top of the editor area, as in VS Code, so the
 * muscle memory carries over: type to filter, Up/Down to move, Enter to run,
 * Escape or a click outside to close, focus back where it was.
 *
 * It sits left of the XR scene column, which is a native view drawn over the
 * page and would otherwise hide it. Text goes in through `textContent` only.
 */

export interface QuickInput {
    /** Opens the box with `value` (for example ">" for the commands). */
    open(value: string): void;
    close(): void;
    readonly isOpen: () => boolean;
}

export interface QuickInputOptions {
    view(value: string): PaletteView;
    accept(action: PaletteAction): void;
    /** Width taken by the scene column on the right, in pixels. */
    rightInset(): number;
}

const MAX_ROWS = 400;

export function createQuickInput(host: HTMLElement, options: QuickInputOptions): QuickInput {
    const input = el('input', {
        className: 'quick-input-field',
        attrs: {
            type: 'text',
            role: 'combobox',
            'aria-label': 'Type the name of a command to run, or : and a line number',
            'aria-controls': 'quick-input-list',
            'aria-expanded': 'true',
            'aria-autocomplete': 'list',
            spellcheck: 'false',
            autocomplete: 'off',
            'data-testid': 'quick-input-field',
        },
    });
    const list = el('div', { className: 'quick-input-list', attrs: { id: 'quick-input-list', role: 'listbox', 'data-testid': 'quick-input-list' } });
    const empty = el('p', { className: 'quick-input-empty muted', attrs: { 'aria-live': 'polite' } });
    const box = el('div', { className: 'quick-input', attrs: { role: 'dialog', 'aria-label': 'Command palette', 'data-testid': 'quick-input' } }, [input, list, empty]);
    const layer = el('div', { className: 'quick-input-layer' }, [box]);
    layer.hidden = true;
    host.append(layer);

    let view: PaletteView | null = null;
    let active = 0;
    let returnFocus: HTMLElement | null = null;

    function render(): void {
        view = options.view(input.value);
        active = view.entries.findIndex((entry) => entry.runnable);
        if (active < 0) { active = 0; }
        const rows = view.entries.slice(0, MAX_ROWS).map((entry, index) => row(entry, index));
        list.replaceChildren(...rows);
        empty.textContent = view.entries.length === 0 ? view.empty : '';
        empty.hidden = view.entries.length > 0;
        markActive();
    }

    function row(entry: PaletteEntry, index: number): HTMLElement {
        const label = el('span', { className: 'quick-input-label' },
            highlightRuns(entry.label, entry.highlights).map((run) => (run.matched
                ? el('mark', { text: run.text })
                : document.createTextNode(run.text))));
        const children: Node[] = [label];
        if (entry.description) {
            children.push(el('span', { className: 'quick-input-description muted', text: entry.description }));
        }
        const trailing: Node[] = [];
        if (entry.group) {
            trailing.push(el('span', { className: 'quick-input-group muted', text: entry.group }));
        }
        if (entry.keybinding) {
            trailing.push(el('kbd', { className: 'quick-input-key', text: entry.keybinding }));
        }
        if (trailing.length > 0) {
            children.push(el('span', { className: 'quick-input-trailing' }, trailing));
        }
        const item = el('div', {
            className: entry.runnable ? 'quick-input-row' : 'quick-input-row is-hint',
            attrs: { role: 'option', id: `quick-input-row-${index}`, 'aria-selected': 'false', 'data-id': entry.id },
        }, children);
        if (entry.group && index > 0) {
            item.classList.add('has-separator');
        }
        item.addEventListener('mousemove', () => {
            if (active !== index) {
                active = index;
                markActive();
            }
        });
        item.addEventListener('mousedown', (event) => event.preventDefault()); // Keep the focus in the field.
        item.addEventListener('click', () => {
            active = index;
            acceptActive();
        });
        return item;
    }

    function markActive(): void {
        const rows = list.children;
        for (let index = 0; index < rows.length; index++) {
            const selected = index === active;
            rows[index]?.classList.toggle('is-active', selected);
            rows[index]?.setAttribute('aria-selected', String(selected));
        }
        const current = rows[active] as HTMLElement | undefined;
        if (current) {
            input.setAttribute('aria-activedescendant', current.id);
            current.scrollIntoView({ block: 'nearest' });
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }

    function move(delta: number): void {
        const count = Math.min(view?.entries.length ?? 0, MAX_ROWS);
        if (count === 0) {
            return;
        }
        active = (active + delta + count) % count;
        markActive();
    }

    function acceptActive(): void {
        const entry = view?.entries[active];
        if (!view || !entry) {
            return;
        }
        const action = view.action(entry);
        if (action.kind === 'none') {
            // A hint row puts its prefix in the field.
            if (entry.fill !== undefined) {
                input.value = entry.fill;
                render();
            }
            return;
        }
        close();
        options.accept(action);
    }

    input.addEventListener('input', render);
    input.addEventListener('keydown', (event) => {
        switch (event.key) {
            case 'ArrowDown': move(1); break;
            case 'ArrowUp': move(-1); break;
            case 'PageDown': move(10); break;
            case 'PageUp': move(-10); break;
            case 'Enter': acceptActive(); break;
            case 'Escape': close(); break;
            default: return;
        }
        event.preventDefault();
        event.stopPropagation();
    });
    input.addEventListener('blur', () => {
        // A click outside the box closes it, as in VS Code.
        setTimeout(() => {
            if (!layer.hidden && document.activeElement !== input) {
                close();
            }
        }, 0);
    });

    function open(value: string): void {
        if (layer.hidden) {
            const focused = document.activeElement;
            returnFocus = focused instanceof HTMLElement && focused !== document.body ? focused : null;
        }
        layer.style.right = `${Math.max(0, options.rightInset())}px`;
        layer.hidden = false;
        input.value = value;
        render();
        input.focus();
        input.setSelectionRange(value.length, value.length);
    }

    function close(): void {
        if (layer.hidden) {
            return;
        }
        layer.hidden = true;
        list.replaceChildren();
        view = null;
        const target = returnFocus;
        returnFocus = null;
        if (target?.isConnected) {
            target.focus();
        }
    }

    return { open, close, isOpen: () => !layer.hidden };
}
