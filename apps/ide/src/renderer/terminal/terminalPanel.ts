import type { CodeXRApi, TerminalCreated, TerminalProfile, TerminalProfileList } from '../../shared/api.ts';
import { el, icon } from '../dom.ts';
import type { PanelHost } from '../panel/panelHost.ts';
import { createTerminalFind } from './terminalFind.ts';
import { createWorkspaceFileChecker, type ListDirectory } from './terminalLinks.ts';
import type * as XtermModule from './xtermView.ts';
import type { XtermView } from './xtermView.ts';

/**
 * The terminal panel (#137): the Terminal view of the bottom panel (#174),
 * its terminal tabs in the panel's header.
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
    terminal: 'M4 17l6-5-6-5M12 19h8',
    task: 'M5 4h14v16H5zM9 9l3 3-3 3M13 15h3',
} as const;

export interface TerminalPanel {
    readonly visible: boolean;
    /** Ctrl+`: shows the terminal (starting one if there is none) or hides the panel. */
    toggle(): void;
    show(): void;
    hide(): void;
    /** Starts a terminal from a profile (null: the default) and shows it. */
    newTerminal(profileId?: string | null): Promise<void>;
    /** #176: a task in a terminal of its own; resolves with its terminal id, or null when it did not start. */
    runTask(label: string, start: (cols: number, rows: number) => Promise<TerminalCreated>): Promise<number | null>;
    /** #18: the terminals' font size, for the open ones and the next. */
    setFontSize(size: number): void;
    /** #286: the focus is in a terminal (or its find widget): the scope of the terminal's Ctrl+F. */
    hasFocus(): boolean;
    /** #286: opens the find widget on the active terminal. */
    find(): void;
}

export interface TerminalPanelHooks {
    onError(message: string): void;
    /** #286: links in the terminal's output. */
    readonly links: TerminalLinkTargets;
}

export interface TerminalLinkTargets {
    /** The open folder (absolute), or null: file links need one. */
    workspaceRoot(): string | null;
    /** `workspace.listDirectory`: how a file link is checked (the main process keeps it inside the folder). */
    listDirectory: ListDirectory;
    openFile(path: string, line?: number, column?: number): void;
    /** `workspace.openExternalLink`: the main process opens http(s) only. */
    openUrl(url: string): void;
}

interface TerminalTab {
    readonly id: number;
    readonly tab: HTMLElement;
    readonly label: HTMLElement;
    readonly host: HTMLElement;
    readonly view: XtermView;
    exited: boolean;
    /** #176: the task this terminal runs, or null for a shell. */
    readonly task: string | null;
}

export function createTerminalPanel(host: PanelHost, api: CodeXRApi['terminal'], platform: Promise<string>, hooks: TerminalPanelHooks): TerminalPanel {
    let activeId: number | null = null;
    let fontSize = 13;
    let loadingView: Promise<typeof XtermModule> | null = null;
    let profiles: TerminalProfileList = { profiles: [], defaultProfileId: null };
    const tabs = new Map<number, TerminalTab>();
    // Output that arrived before `create` resolved in this page (the two travel separately).
    const early = new Map<number, string>();
    const earlyExit = new Map<number, number>();
    let starting = 0;

    const tabList = el('div', { className: 'terminal-tabs', attrs: { role: 'tablist', 'aria-label': 'Terminals', 'data-testid': 'terminal-tabs' } });
    const button = (label: string, path: string, testId: string): HTMLButtonElement =>
        el('button', { className: 'icon-button', attrs: { type: 'button', title: label, 'aria-label': label, 'data-testid': testId } }, [icon(path)]);
    const newButton = button('New Terminal (Ctrl+Shift+`)', ICONS.plus, 'terminal-new');
    const menuButton = button('Terminal profiles', ICONS.menu, 'terminal-menu-button');
    menuButton.setAttribute('aria-haspopup', 'menu');
    menuButton.setAttribute('aria-expanded', 'false');
    const killButton = button('Kill Terminal', ICONS.trash, 'terminal-kill');
    const body = el('div', { className: 'terminal-body', attrs: { 'data-testid': 'terminal-body' } });
    const empty = el('p', { className: 'muted terminal-empty', text: 'No terminal is running. Start one with + or Ctrl+Shift+`.' });
    body.append(empty);
    const menu = el('div', { className: 'terminal-menu', attrs: { role: 'menu', 'data-testid': 'terminal-menu', hidden: '' } });
    host.register({
        id: 'terminal',
        label: 'Terminal',
        body,
        center: tabList,
        actions: [newButton, menuButton, killButton],
        onShow: () => activate(activeId),
        onHide: () => closeMenu(),
    });
    host.element.append(menu);
    // #286: one find widget for the panel, on the active terminal.
    const find = createTerminalFind(body);
    let fileChecker: ((path: string) => Promise<string | null>) | null = null;

    // Fitting follows the body's size (panel resize, window resize, tab switch).
    let fitFrame = 0;
    const scheduleFit = (): void => {
        cancelAnimationFrame(fitFrame);
        fitFrame = requestAnimationFrame(() => {
            const active = activeId === null ? undefined : tabs.get(activeId);
            if (active && host.isShowing('terminal') && active.view.fit() && !active.exited) {
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
        find.setTarget(active?.view ?? null);
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
        if (tabs.size === 0 && host.isShowing('terminal')) {
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
        await openTerminal((cols, rows) => api.create(profileId, cols, rows), null);
    }

    /**
     * Starts a terminal through `create` (a shell, or #176 a task's command)
     * and adds its tab. `task` names the task: its tab stays after it exits,
     * with the exit code. Resolves with the terminal's id, or null when it
     * could not start.
     */
    async function openTerminal(create: (cols: number, rows: number) => Promise<TerminalCreated>, task: string | null): Promise<number | null> {
        show(false);
        const [{ createXtermView }, os] = await Promise.all([loadingView ??= import('./xtermView.ts'), platform]);
        const host = el('div', { className: 'terminal-host' });
        body.append(host);
        let id: number | null = null;
        let profileName = 'Terminal';
        const checkFile = fileChecker ??= createWorkspaceFileChecker(hooks.links.listDirectory, os);
        const view: XtermView = createXtermView(host, {
            platform: os,
            fontSize,
            onInput: (data) => {
                if (id !== null && !tabs.get(id)?.exited) {
                    void api.input(id, data).catch(() => undefined);
                }
            },
            onFindResults: (index, count) => find.setResults(view, index, count),
            links: {
                context: () => {
                    const root = hooks.links.workspaceRoot();
                    return root === null ? null : { root, platform: os };
                },
                resolveFile: checkFile,
                openFile: (path, line, column) => hooks.links.openFile(path, line, column),
                openUrl: (url) => hooks.links.openUrl(url),
            },
        });
        view.fit();
        starting += 1;
        try {
            const created = await create(view.cols, view.rows);
            id = created.id;
            profileName = created.profile.name;
            if (task !== null && 'command' in created && typeof created.command === 'string') {
                // As in VS Code: the task's command line first, so the output can be read against it.
                view.write(`\x1b[2m> Executing task: ${created.command.replace(/[\x00-\x1f\x7f]/g, ' ')}\x1b[0m\r\n\r\n`);
            }
        } catch (error) {
            view.dispose();
            host.remove();
            hooks.onError(`Could not start ${task === null ? 'a terminal' : `"${task}"`}: ${error instanceof Error ? error.message : String(error)}`);
            activate(activeId);
            return null;
        } finally {
            starting -= 1;
        }
        const terminalId = id;
        const label = el('span', { className: 'tab-label' });
        const close = el('button', { className: 'tab-close', attrs: { type: 'button', 'aria-label': 'Kill terminal', title: 'Kill terminal', tabindex: '-1' } }, [icon(ICONS.close)]);
        const tab = el('div', { className: 'terminal-tab', attrs: { role: 'tab', 'data-terminal-id': String(terminalId) } }, [icon(task === null ? ICONS.terminal : ICONS.task, 'terminal-tab-icon'), label, close]);
        label.textContent = uniqueTitle(task === null ? profileName : `Task - ${task}`);
        tab.title = `${label.textContent} (double-click to rename)`;
        host.dataset['terminalId'] = String(terminalId);
        if (task !== null) {
            tab.classList.add('is-task');
        }
        const entry: TerminalTab = { id: terminalId, tab, label, host, view, exited: false, task };
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
        const exit = earlyExit.get(terminalId);
        if (exit !== undefined) {
            earlyExit.delete(terminalId);
            exited(entry, exit);
        }
        return terminalId;
    }

    function exited(entry: TerminalTab, exitCode: number): void {
        entry.exited = true;
        if (entry.task !== null) {
            // #176: a task's tab stays, so its output and its result can be read.
            entry.tab.classList.add('is-exited', exitCode === 0 ? 'is-succeeded' : 'is-failed');
            entry.tab.dataset['exitCode'] = String(exitCode);
            entry.view.write(`\r\n\x1b[2m[Task "${entry.task}" finished with exit code ${exitCode}. Close this tab or run the task again.]\x1b[0m\r\n`);
        } else if (exitCode === 0) {
            // A clean `exit` closes the tab, as in VS Code; a failure stays readable.
            removeTab(entry.id);
        } else {
            entry.tab.classList.add('is-exited');
            entry.view.write(`\r\n\x1b[2m[The process exited with code ${exitCode}.]\x1b[0m\r\n`);
        }
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
        const entry = tabs.get(id);
        if (!entry) {
            // A short task can end before `create` resolved here: kept for its tab.
            if (starting > 0) {
                earlyExit.set(id, exitCode);
            }
            return;
        }
        early.delete(id);
        exited(entry, exitCode);
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
    activate(null);
    void refreshProfiles().catch(() => undefined);

    function show(startIfEmpty = true): void {
        host.show('terminal');
        if (tabs.size === 0 && startIfEmpty) {
            void newTerminal();
        }
    }

    function hide(): void {
        closeMenu();
        host.hide();
    }

    return {
        get visible() { return host.isShowing('terminal'); },
        hasFocus: () => activeId !== null && body.contains(document.activeElement),
        find(): void {
            const active = activeId === null ? undefined : tabs.get(activeId);
            if (active) {
                find.open(active.view);
            }
        },
        toggle: () => (host.isShowing('terminal') ? hide() : show()),
        show: () => show(),
        hide,
        newTerminal,
        runTask: (label, start) => openTerminal(start, label),
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
    };
}
