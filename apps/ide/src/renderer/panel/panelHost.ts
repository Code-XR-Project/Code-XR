import { el, icon } from '../dom.ts';

/**
 * The bottom panel (#174): one frame under the editors holding several views
 * (Terminal, Output; Problems with #173), VS Code's way. Its header has the
 * views' tabs on the left, the active view's own controls after them, and
 * the panel's maximise and close buttons at the end. The layout (#169) owns
 * its size; a view owns its body.
 */

const MAXIMIZE = 'M6 15l6-6 6 6M5 4h14';
const RESTORE = 'M6 9l6 6 6-6M5 20h14';
const CLOSE = 'M6 6l12 12M18 6L6 18';

export type PanelViewId = 'terminal' | 'output' | 'problems';

export interface PanelView {
    readonly id: PanelViewId;
    readonly label: string;
    readonly body: HTMLElement;
    /** Controls between the tabs and the actions (the terminal tabs, the output channel picker). */
    readonly center?: HTMLElement;
    /** The view's buttons, left of maximise and close. */
    readonly actions?: readonly HTMLElement[];
    /** The view became the visible one (fit a terminal, scroll the output). */
    onShow?(): void;
    /** The view stopped being visible (another view, or the panel hidden): close its menus. */
    onHide?(): void;
}

export interface PanelHost {
    readonly element: HTMLElement;
    register(view: PanelView): void;
    readonly visible: boolean;
    /** The view shown, or last shown while the panel is hidden. */
    readonly activeView: PanelViewId | null;
    /** True when the panel is visible and showing `id`. */
    isShowing(id: PanelViewId): boolean;
    /** Shows the panel with `id` (by default the view it showed last). */
    show(id?: PanelViewId): void;
    hide(): void;
    setMaximized(maximized: boolean): void;
    /** A count beside a view's tab (the problems), or none. */
    setBadge(id: PanelViewId, text: string | null): void;
}

export function createPanelHost(panel: HTMLElement, hooks: { toggleMaximized?(): void; onHide?(): void }): PanelHost {
    const views = new Map<PanelViewId, { readonly view: PanelView; readonly tab: HTMLButtonElement; readonly badge: HTMLElement }>();
    let active: PanelViewId | null = null;

    const tabList = el('div', { className: 'panel-views', attrs: { role: 'tablist', 'aria-label': 'Panel views' } });
    const center = el('div', { className: 'panel-center' });
    const viewActions = el('div', { className: 'panel-actions' });
    const button = (label: string, path: string, testId: string): HTMLButtonElement =>
        el('button', { className: 'icon-button', attrs: { type: 'button', title: label, 'aria-label': label, 'data-testid': testId } }, [icon(path)]);
    // The test ids predate the other views (#137, #169); scripts and the smoke run use them.
    const maximizeButton = button('Maximize Panel Size', MAXIMIZE, 'terminal-maximize');
    maximizeButton.setAttribute('aria-pressed', 'false');
    maximizeButton.hidden = !hooks.toggleMaximized;
    maximizeButton.addEventListener('click', () => hooks.toggleMaximized?.());
    const closeButton = button('Close Panel', CLOSE, 'terminal-close-panel');
    closeButton.addEventListener('click', () => hide());
    const header = el('div', { className: 'panel-header' }, [
        tabList, center, el('div', { className: 'panel-actions' }, [viewActions, maximizeButton, closeButton]),
    ]);
    panel.classList.add('terminal-panel');
    panel.setAttribute('data-testid', 'terminal-panel');
    panel.setAttribute('aria-label', 'Panel');
    panel.hidden = true;
    panel.replaceChildren(header);

    function activate(id: PanelViewId): void {
        const entry = views.get(id);
        if (!entry) {
            return;
        }
        if (active !== null && active !== id) {
            views.get(active)?.view.onHide?.();
        }
        active = id;
        for (const [viewId, { view, tab }] of views) {
            const selected = viewId === id;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            tab.classList.toggle('is-active', selected);
            view.body.hidden = !selected;
        }
        center.replaceChildren(...(entry.view.center ? [entry.view.center] : []));
        viewActions.replaceChildren(...(entry.view.actions ?? []));
        panel.setAttribute('aria-label', entry.view.label);
        if (!panel.hidden) {
            entry.view.onShow?.();
        }
    }

    function show(id?: PanelViewId): void {
        const target = id ?? active ?? views.keys().next().value;
        if (target === undefined) {
            return;
        }
        panel.hidden = false;
        activate(target);
    }

    function hide(): void {
        if (panel.hidden) {
            return;
        }
        panel.hidden = true;
        if (active !== null) {
            views.get(active)?.view.onHide?.();
        }
        hooks.onHide?.();
    }

    tabList.addEventListener('keydown', (event) => {
        const ids = [...views.keys()];
        const index = active === null ? -1 : ids.indexOf(active);
        const next = event.key === 'ArrowRight' ? ids[(index + 1) % ids.length]
            : event.key === 'ArrowLeft' ? ids[(index - 1 + ids.length) % ids.length] : undefined;
        if (next !== undefined) {
            event.preventDefault();
            show(next);
            views.get(next)?.tab.focus();
        }
    });

    return {
        element: panel,
        register(view: PanelView): void {
            const badge = el('span', { className: 'panel-badge', attrs: { hidden: '' } });
            const tab = el('button', {
                className: 'panel-title',
                attrs: { type: 'button', role: 'tab', 'aria-selected': 'false', tabindex: '-1', 'data-testid': `panel-tab-${view.id}` },
            }, [document.createTextNode(view.label), badge]);
            tab.addEventListener('click', () => show(view.id));
            tabList.append(tab);
            view.body.hidden = true;
            panel.append(view.body);
            views.set(view.id, { view, tab, badge });
            if (active === null) {
                activate(view.id);
            }
        },
        get visible() { return !panel.hidden; },
        get activeView() { return active; },
        isShowing: (id) => !panel.hidden && active === id,
        show,
        hide,
        setMaximized(maximized: boolean): void {
            maximizeButton.setAttribute('aria-pressed', String(maximized));
            const label = maximized ? 'Restore Panel Size' : 'Maximize Panel Size';
            maximizeButton.title = label;
            maximizeButton.setAttribute('aria-label', label);
            maximizeButton.replaceChildren(icon(maximized ? RESTORE : MAXIMIZE));
        },
        setBadge(id: PanelViewId, text: string | null): void {
            const badge = views.get(id)?.badge;
            if (badge) {
                badge.textContent = text ?? '';
                badge.hidden = text === null;
            }
        },
    };
}
