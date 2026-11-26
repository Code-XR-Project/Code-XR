import type { CodeXRApi, TerminalProfile, TerminalProfileList } from '../../shared/api.ts';
import { el, icon } from '../dom.ts';
import type * as XtermModule from './xtermView.ts';
import type { XtermView } from './xtermView.ts';

/**
 * The terminal panel (#137): a bottom panel of terminal tabs under the editor.
 *
 * Each tab is an xterm.js view (loaded with the first terminal, in its own
 * chunk) wired to a pty in the main process through `window.codexr.terminal`.
 * The renderer never names an executable: it asks for a terminal from a
 * profile id the main process listed, and the main process picks the path.
 */

const ICONS = {
    plus: 'M12 5v14M5 12h14',
    menu: 'M6 9l6 6 6-6',
    trash: 'M4 7h16M10 11v6M14 11v6M9 7V4h6v3M6 7l1 13h10l1-13',
    close: 'M6 6l12 12M18 6L6 18',
    maximize: 'M6 15l6-6 6 6M5 4h14',
    restore: 'M6 9l6 6 6-6M5 20h14',
    terminal: 'M4 17l6-5-6-5M12 19h8',
} as const;

export interface TerminalPanel {
    readonly visible: boolean;
    /** Ctrl+`: shows the panel (starting a terminal if there is none) or hides it. */
    toggle(): void;
    show(): void;
    hide(): void;
    /** Starts a terminal from a profile (null: the default) and shows it. */
    newTerminal(profileId?: string | null): Promise<void>;
    /** Shows the panel as maximised or not (#169); the layout owns the state. */
    setMaximized(maximized: boolean): void;
    /** #18: the terminals' font size, for the open ones and the next. */
    setFontSize(size: number): void;
}

export interface TerminalPanelHooks {
    onError(message: string): void;
    /** The header's maximise button (#169). */
    toggleMaximized?(): void;
}

interface TerminalTab {
    readonly id: number;
    readonly tab: HTMLElement;
    readonly label: HTMLElement;
    readonly host: HTMLElement;
    readonly view: XtermView;
    exited: boolean;
}

export function createTerminalPanel(panel: HTMLElement, api: CodeXRApi['terminal'], platform: Promise<string>, hooks: TerminalPanelHooks): TerminalPanel {
    let activeId: number | null = null;
    let fontSize = 13;
    let loadingView: Promise<typeof XtermModule> | null = null;
    let profiles: TerminalProfileList = { profiles: [], defaultProfileId: null };
    const tabs = new Map<number, TerminalTab>();
    // Output that arrived before `create` resolved in this page (the two travel separately).
    const early = new Map<number, string>();

    const tabList = el('div', { className: 'terminal-tabs', attrs: { role: 'tablist', 'aria-label': 'Terminals', 'data-testid': 'terminal-tabs' } });
    const button = (label: string, path: string, testId: string): HTMLButtonElement =>
        el('button', { className: 'icon-button', attrs: { type: 'button', title: label, 'aria-label': label, 'data-testid': testId } }, [icon(path)]);
    const newButton = button('New Terminal (Ctrl+Shift+`)', ICONS.plus, 'terminal-new');
    const menuButton = button('Terminal profiles', ICONS.menu, 'terminal-menu-button');
    menuButton.setAttribute('aria-haspopup', 'menu');
    menuButton.setAttribute('aria-expanded', 'false');
    const killButton = button('Kill Terminal', ICONS.trash, 'terminal-kill');
    const closeButton = button('Close Panel', ICONS.close, 'terminal-close-panel');
    // #169: the panel's size is the layout's (layout/layout.ts): its sash, and maximising it.
    const maximizeButton = button('Maximize Panel Size', ICONS.maximize, 'terminal-maximize');
    maximizeButton.setAttribute('aria-pressed', 'false');
    maximizeButton.hidden = !hooks.toggleMaximized;
    maximizeButton.addEventListener('click', () => hooks.toggleMaximized?.());
    const header = el('div', { className: 'panel-header' }, [
        el('span', { className: 'panel-title', text: 'Terminal' }),
        tabList,
        el('div', { className: 'panel-actions' }, [newButton, menuButton, killButton, maximizeButton, closeButton]),
    ]);
    const body = el('div', { className: 'terminal-body', attrs: { 'data-testid': 'terminal-body' } });
    const empty = el('p', { className: 'muted terminal-empty', text: 'No terminal is running. Start one with + or Ctrl+Shift+`.' });
    body.append(empty);
    const menu = el('div', { className: 'terminal-menu', attrs: { role: 'menu', 'data-testid': 'terminal-menu', hidden: '' } });
    panel.classList.add('terminal-panel');
    panel.setAttribute('data-testid', 'terminal-panel');
    panel.setAttribute('aria-label', 'Terminal');
    panel.hidden = true;
    panel.replaceChildren(header, body, menu);

    // Fitting follows the body's size (panel resize, window resize, tab switch).
    let fitFrame = 0;
    const scheduleFit = (): void => {
        cancelAnimationFrame(fitFrame);
        fitFrame = requestAnimationFrame(() => {
            const active = activeId === null ? undefined : tabs.get(activeId);
            if (active && !panel.hidden && active.view.fit() && !active.exited) {
                void api.resize(active.id, active.view.cols, active.view.rows).catch(() => undefined);
            }
        });
    };
    new ResizeObserver(scheduleFit).observe(body);


    function activate(id: number | null): void {
        activeId = id;
        for (const entry of tabs.values()) {
            const selected = entry.id === id;
            entry.tab.setAttribute('aria-selected', String(selected));
            entry.tab.tabIndex = selected ? 0 : -1;
            entry.host.hidden = !selected;
        }
        empty.hidden = tabs.size > 0;
        killButton.disabled = id === null;
        const active = id === null ? undefined : tabs.get(id);
        if (active) {
            scheduleFit();
            active.view.focus();
        }
    }

    function uniqueTitle(base: string): string {
        const titles = new Set([...tabs.values()].map((entry) => entry.label.textContent));
        if (!titles.has(base)) {
            return base;
        }
        let n = 2;
        while (titles.has(`${base} (${n})`)) { n++; }
        return `${base} (${n})`;
    }

    function startRename(entry: TerminalTab): void {
        const input = el('input', { className: 'tab-rename', attrs: { type: 'text', 'aria-label': 'Terminal name', value: entry.label.textContent ?? '' } });
        entry.label.replaceWith(input);
        input.select();
        let done = false;
        const finish = (commit: boolean): void => {
            if (done) { return; }
            done = true;
            const name = input.value.trim().slice(0, 80);
            if (commit && name) {
                entry.label.textContent = name;
                entry.tab.title = name;
            }
            input.replaceWith(entry.label);
            entry.view.focus();
        };
        input.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Enter') { finish(true); }
            if (event.key === 'Escape') { finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
        input.focus();
    }

    function removeTab(id: number): void {
        const entry = tabs.get(id);
        if (!entry) { return; }
        tabs.delete(id);
        entry.view.dispose();
        entry.tab.remove();
        entry.host.remove();
        if (activeId === id) {
            const next = [...tabs.keys()].at(-1) ?? null;
            activate(next);
        } else {
            activate(activeId);
        }
        // As in VS Code: closing the last terminal closes the panel.
        if (tabs.size === 0) {
            hide();
        }
    }

    function closeTerminal(id: number): void {
        const entry = tabs.get(id);
        if (entry && !entry.exited) {
            void api.kill(id).catch(() => undefined);
        }
        removeTab(id);
    }

    async function newTerminal(profileId: string | null = null): Promise<void> {
        show(false);
        const [{ createXtermView }, os] = await Promise.all([loadingView ??= import('./xtermView.ts'), platform]);
        const host = el('div', { className: 'terminal-host' });
        body.append(host);
        let id: number | null = null;
        let profileName = 'Terminal';
        const view = createXtermView(host, {
            platform: os,
            fontSize,
            onInput: (data) => {
                if (id !== null && !tabs.get(id)?.exited) {
                    void api.input(id, data).catch(() => undefined);
                }
            },
        });
        view.fit();
        try {
            const created = await api.create(profileId, view.cols, view.rows);
            id = created.id;
            profileName = created.profile.name;
        } catch (error) {
            view.dispose();
            host.remove();
            hooks.onError(`Could not start a terminal: ${error instanceof Error ? error.message : String(error)}`);
            activate(activeId);
            return;
        }
        const terminalId = id;
        const label = el('span', { className: 'tab-label' });
        const close = el('button', { className: 'tab-close', attrs: { type: 'button', 'aria-label': 'Kill terminal', title: 'Kill terminal', tabindex: '-1' } }, [icon(ICONS.close)]);
        const tab = el('div', { className: 'terminal-tab', attrs: { role: 'tab', 'data-terminal-id': String(terminalId) } }, [icon(ICONS.terminal, 'terminal-tab-icon'), label, close]);
        label.textContent = uniqueTitle(profileName);
        tab.title = `${label.textContent} (double-click to rename)`;
        host.dataset['terminalId'] = String(terminalId);
        const entry: TerminalTab = { id: terminalId, tab, label, host, view, exited: false };
        tabs.set(terminalId, entry);
        tab.addEventListener('click', () => activate(terminalId));
        tab.addEventListener('dblclick', () => startRename(entry));
        tab.addEventListener('auxclick', (event) => { if (event.button === 1) { closeTerminal(terminalId); } });
        tab.addEventListener('keydown', (event) => {
            if (event.key === 'F2') { startRename(entry); }
            if (event.key === 'Delete') { closeTerminal(terminalId); }
        });
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            closeTerminal(terminalId);
        });
        tabList.append(tab);
        const pending = early.get(terminalId);
        if (pending) {
            early.delete(terminalId);
            view.write(pending);
        }
        activate(terminalId);
    }

    api.onData(({ id, data }) => {
        const entry = tabs.get(id);
        if (entry) {
            entry.view.write(data);
        } else {
            early.set(id, (early.get(id) ?? '') + data);
        }
    });
    api.onExit(({ id, exitCode }) => {
        early.delete(id);
        const entry = tabs.get(id);
        if (!entry) { return; }
        entry.exited = true;
        // A clean `exit` closes the tab, as in VS Code; a failure stays readable.
        if (exitCode === 0) {
            removeTab(id);
        } else {
            entry.tab.classList.add('is-exited');
            entry.view.write(`\r\n\x1b[2m[The process exited with code ${exitCode}.]\x1b[0m\r\n`);
        }
    });

    // The profiles menu: start a terminal from any profile, pick the default, manage custom ones.
    function renderMenu(): void {
        const items: Node[] = [el('div', { className: 'terminal-menu-heading', text: 'New terminal' })];
        for (const profile of profiles.profiles) {
            const item = el('button', { className: 'terminal-menu-item', attrs: { type: 'button', role: 'menuitem', title: profileTitle(profile) } }, [
                el('span', { text: profile.name }),
                el('span', { className: 'muted small', text: profile.source === 'custom' ? 'custom' : '' }),
            ]);
            item.addEventListener('click', () => { closeMenu(); void newTerminal(profile.id); });
            items.push(item);
        }
        if (profiles.profiles.length === 0) {
            items.push(el('p', { className: 'muted small terminal-menu-note', text: 'No shell was found on this machine.' }));
        }
        items.push(el('div', { className: 'terminal-menu-heading', text: 'Default profile' }));
        for (const profile of profiles.profiles) {
            const checked = profile.id === profiles.defaultProfileId;
            const item = el('button', {
                className: 'terminal-menu-item',
                attrs: { type: 'button', role: 'menuitemradio', 'aria-checked': String(checked), 'data-profile-id': profile.id, title: profileTitle(profile) },
            }, [el('span', { className: 'terminal-menu-check', text: checked ? '●' : '' }), el('span', { text: profile.name })]);
            item.addEventListener('click', () => {
                void api.setDefaultProfile(profile.id).then((list) => { profiles = list; renderMenu(); }, (error: unknown) => hooks.onError(String(error)));
            });
            if (profile.source === 'custom') {
                const remove = el('button', { className: 'icon-button terminal-menu-remove', attrs: { type: 'button', title: `Remove ${profile.name}`, 'aria-label': `Remove ${profile.name}` } }, [icon(ICONS.close)]);
                remove.addEventListener('click', (event) => {
                    event.stopPropagation();
                    void api.removeCustomProfile(profile.id).then((list) => { profiles = list; renderMenu(); }, (error: unknown) => hooks.onError(String(error)));
                });
                items.push(el('div', { className: 'terminal-menu-row' }, [item, remove]));
            } else {
                items.push(item);
            }
        }
        const argsInput = el('input', { className: 'terminal-menu-input', attrs: { type: 'text', placeholder: 'Arguments (optional)', 'aria-label': 'Arguments for the custom profile' } });
        const add = el('button', { className: 'secondary-button', attrs: { type: 'button' }, text: 'Choose executable…' });
        add.addEventListener('click', () => {
            void api.addCustomProfile(argsInput.value).then((list) => { profiles = list; renderMenu(); }, (error: unknown) => hooks.onError(error instanceof Error ? error.message : String(error)));
        });
        argsInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { add.click(); } });
        items.push(
            el('div', { className: 'terminal-menu-heading', text: 'Add custom profile' }),
            el('div', { className: 'terminal-menu-custom' }, [argsInput, add]),
        );
        menu.replaceChildren(...items);
    }

    function profileTitle(profile: TerminalProfile): string {
        return [profile.path, ...profile.args].join(' ');
    }

    async function refreshProfiles(): Promise<void> {
        profiles = await api.profiles();
    }

    function openMenu(): void {
        void refreshProfiles().then(() => {
            renderMenu();
            menu.hidden = false;
            menuButton.setAttribute('aria-expanded', 'true');
            menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        }, (error: unknown) => hooks.onError(`Could not list terminal profiles: ${String(error)}`));
    }
    function closeMenu(): void {
        menu.hidden = true;
        menuButton.setAttribute('aria-expanded', 'false');
    }
    menuButton.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
    menu.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { closeMenu(); menuButton.focus(); }
    });
    document.addEventListener('pointerdown', (event) => {
        if (!menu.hidden && !menu.contains(event.target as Node) && !menuButton.contains(event.target as Node)) {
            closeMenu();
        }
    });

    newButton.addEventListener('click', () => void newTerminal());
    killButton.addEventListener('click', () => { if (activeId !== null) { closeTerminal(activeId); } });
    closeButton.addEventListener('click', () => hide());
    activate(null);
    void refreshProfiles().catch(() => undefined);

    function show(startIfEmpty = true): void {
        panel.hidden = false;
        if (tabs.size === 0 && startIfEmpty) {
            void newTerminal();
            return;
        }
        activate(activeId);
    }

    function hide(): void {
        panel.hidden = true;
        closeMenu();
    }

    return {
        get visible() { return !panel.hidden; },
        toggle: () => (panel.hidden ? show() : hide()),
        show: () => show(),
        hide,
        newTerminal,
        setFontSize(size: number): void {
            if (size === fontSize) {
                return;
            }
            fontSize = size;
            for (const entry of tabs.values()) {
                entry.view.setFontSize(size);
            }
            scheduleFit();
        },
        setMaximized(maximized: boolean): void {
            maximizeButton.setAttribute('aria-pressed', String(maximized));
            const label = maximized ? 'Restore Panel Size' : 'Maximize Panel Size';
            maximizeButton.title = label;
            maximizeButton.setAttribute('aria-label', label);
            maximizeButton.replaceChildren(icon(maximized ? ICONS.restore : ICONS.maximize));
        },
    };
}
