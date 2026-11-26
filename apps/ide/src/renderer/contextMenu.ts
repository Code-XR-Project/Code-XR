import { el } from './dom.ts';

/**
 * A small context menu (#167, the editor tabs), drawn in the page: role
 * `menu`, arrow keys, Enter, Escape, and it closes on any click outside or
 * when the window loses focus. Items are plain text, never markup. It is kept
 * left of `rightInset` (the scene view is a native view drawn over the page).
 */

export type ContextMenuItem =
    | { readonly label: string; readonly run: () => void; readonly enabled?: boolean; readonly keybinding?: string; readonly testId?: string }
    | { readonly separator: true };

let current: { close(): void } | null = null;

export function showContextMenu(items: readonly ContextMenuItem[], x: number, y: number, options: { rightInset?: () => number; label?: string } = {}): void {
    current?.close();
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const buttons: HTMLButtonElement[] = [];
    const menu = el('div', { className: 'context-menu', attrs: { role: 'menu', 'aria-label': options.label ?? 'Context menu', 'data-testid': 'context-menu' } });
    for (const item of items) {
        if ('separator' in item) {
            menu.append(el('div', { className: 'context-menu-separator', attrs: { role: 'separator' } }));
            continue;
        }
        const button = el('button', {
            className: 'context-menu-item',
            attrs: { type: 'button', role: 'menuitem', tabindex: '-1', ...(item.testId ? { 'data-testid': item.testId } : {}) },
        }, [
            el('span', { className: 'context-menu-label', text: item.label }),
            el('span', { className: 'context-menu-key', text: item.keybinding ?? '' }),
        ]);
        button.disabled = item.enabled === false;
        button.addEventListener('click', () => {
            close(false);
            item.run();
        });
        buttons.push(button);
        menu.append(button);
    }
    document.body.append(menu);

    // Keep the menu inside the window and left of the scene view.
    const rect = menu.getBoundingClientRect();
    const right = window.innerWidth - (options.rightInset?.() ?? 0) - 4;
    menu.style.left = `${Math.max(4, Math.min(x, right - rect.width))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;

    const enabled = (): HTMLButtonElement[] => buttons.filter((button) => !button.disabled);
    const focusAt = (index: number): void => {
        const list = enabled();
        list[((index % list.length) + list.length) % list.length]?.focus();
    };
    focusAt(0);

    function close(restoreFocus = true): void {
        if (current !== handle) {
            return;
        }
        current = null;
        menu.remove();
        document.removeEventListener('pointerdown', onPointerDown, true);
        window.removeEventListener('blur', onBlur);
        if (restoreFocus) {
            returnFocus?.focus();
        }
    }
    const onPointerDown = (event: PointerEvent): void => {
        if (!menu.contains(event.target as Node)) {
            close(false);
        }
    };
    const onBlur = (): void => close(false);
    menu.addEventListener('keydown', (event) => {
        const list = enabled();
        const index = list.indexOf(document.activeElement as HTMLButtonElement);
        switch (event.key) {
            case 'ArrowDown': focusAt(index + 1); break;
            case 'ArrowUp': focusAt(index - 1); break;
            case 'Home': focusAt(0); break;
            case 'End': focusAt(list.length - 1); break;
            case 'Escape': close(); break;
            case 'Tab': close(); break;
            default: return;
        }
        event.preventDefault();
        event.stopPropagation();
    });
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onBlur);
    const handle = { close: () => close(false) };
    current = handle;
}
