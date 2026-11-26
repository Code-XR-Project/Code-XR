import type { AppInfo } from '../shared/api.ts';
import { el, icon } from './dom.ts';
import { createLayout, type LayoutStorage, type WorkbenchLayout } from './layout/layout.ts';

/**
 * The workbench shell: activity bar, side bar, editor area and status bar.
 * The side bar hosts the explorer (#14, explorer.ts); the editor area is the
 * welcome view until Monaco arrives (#14), then analysis views (#16), the
 * terminal (#137, the bottom panel) and the command palette (#18) take their slots. Built with DOM APIs
 * only, never innerHTML, so nothing here can turn text into markup.
 */

interface ActivityItem {
    readonly id: string;
    readonly label: string;
    readonly icon: string; // SVG path data, 24x24 viewBox
    readonly bottom?: boolean;
}

const ACTIVITY: readonly ActivityItem[] = [
    { id: 'explorer', label: 'Explorer', icon: 'M3 6h7l2 2h9v11H3z' },
    // #165: search across the workspace (search/searchView.ts).
    { id: 'search', label: 'Search', icon: 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM15.5 15.5L21 21' },
    { id: 'analysis', label: 'Analysis', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
    { id: 'xr', label: 'XR scene', icon: 'M2 8h20v9h-6l-2-3h-4l-2 3H2z' },
    // #18: the Settings view, at the foot of the activity bar as in VS Code.
    { id: 'settings', label: 'Settings', icon: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1', bottom: true },
];

/** `keybindings` has no activity item of its own: it is part of Settings (#18, part 3). */
export type ViewId = 'explorer' | 'search' | 'analysis' | 'xr' | 'settings' | 'keybindings';

export interface Workbench {
    /** The explorer's pane of the side bar. */
    readonly sideBar: HTMLElement;
    /** The Search view's pane of the side bar (#165). */
    readonly searchView: HTMLElement;
    /** The Analysis view's pane of the side bar (#15: the Python environment). */
    readonly analysisView: HTMLElement;
    /** The Settings view's pane of the side bar (#18, settings/settingsView.ts). */
    readonly settingsView: HTMLElement;
    /** The Keyboard Shortcuts pane (#18, part 3, settings/keybindingsView.ts), shown under the Settings item. */
    readonly keybindingsView: HTMLElement;
    /** Shows a view in the side bar, as clicking its activity item does. */
    showView(id: ViewId): void;
    /** The status-bar item of the Python environment; clicking it opens the Analysis view. */
    setPythonStatus(text: string, tooltip: string, state: string): void;
    /** The editor area; the welcome view until the first file opens, then the editor group's. */
    readonly editorArea: HTMLElement;
    showInfo(info: AppInfo): void;
    showError(message: string): void;
    /** Left status-bar text, for short messages ("Opened …"). */
    setStatus(message: string): void;
    /** The column beside the editors where an analysis scene is shown (#16), hidden until one opens. */
    readonly sceneArea: HTMLElement;
    /** Shows or hides the scene column. */
    setSceneVisible(visible: boolean): void;
    /** The bottom panel under the editor area (#137: the terminal, terminal/terminalPanel.ts). */
    readonly panel: HTMLElement;
    /** The status bar's slot for the active editor's items (#166, editor/editorStatus.ts). */
    readonly editorStatus: HTMLElement;
    /** Sizes and visibility of the side bar, panel and scene column (#169, layout/layout.ts). */
    readonly layout: WorkbenchLayout;
}

export function renderWorkbench(root: HTMLElement, storage: LayoutStorage | null = null): Workbench {
    const buttons = new Map<ViewId, HTMLButtonElement>();
    const activityBar = el('nav', { className: 'activity-bar', attrs: { 'aria-label': 'Views' } },
        ACTIVITY.map((item, index) => {
            const button = el('button', {
                className: ['activity-item', index === 0 ? 'is-active' : '', item.bottom ? 'is-bottom' : ''].filter(Boolean).join(' '),
                attrs: { type: 'button', title: item.label, 'aria-label': item.label, 'aria-pressed': String(index === 0), 'data-view': item.id },
            }, [icon(item.icon)]);
            // #169: clicking the active view's item hides the side bar, as in VS Code; any click shows it again.
            button.addEventListener('click', () => {
                if (button.classList.contains('is-active') && layout.sideBarVisible && !layout.zen) {
                    layout.setSideBarVisible(false);
                } else {
                    showView(item.id as ViewId);
                }
            });
            buttons.set(item.id as ViewId, button);
            return button;
        }));

    const sideBar = el('div', { className: 'side-pane', attrs: { 'data-view': 'explorer' } });
    const searchView = el('div', { className: 'side-pane', attrs: { 'data-view': 'search', 'data-testid': 'search-view' } });
    const analysisView = el('div', { className: 'side-pane', attrs: { 'data-view': 'analysis', 'data-testid': 'analysis-view' } });
    const xrView = el('div', { className: 'side-pane', attrs: { 'data-view': 'xr' } }, [
        el('h2', { className: 'side-bar-title', text: 'XR scene' }),
        el('p', { className: 'muted side-note', text: 'Run an analysis from the Analysis view: its XR scene opens beside the code.' }),
    ]);
    const settingsView = el('div', { className: 'side-pane', attrs: { 'data-view': 'settings', 'data-testid': 'settings-view' } });
    const keybindingsView = el('div', { className: 'side-pane', attrs: { 'data-view': 'keybindings', 'data-testid': 'keybindings-view' } });
    const panes = new Map<ViewId, HTMLElement>([['explorer', sideBar], ['search', searchView], ['analysis', analysisView], ['xr', xrView], ['settings', settingsView], ['keybindings', keybindingsView]]);
    const sideBarFrame = el('aside', { className: 'side-bar', attrs: { 'aria-label': 'Explorer', 'data-testid': 'side-bar' } }, [sideBar, searchView, analysisView, xrView, settingsView, keybindingsView]);

    function showView(id: ViewId, reveal = true): void {
        if (reveal && (!layout.sideBarVisible || layout.zen)) {
            layout.setSideBarVisible(true);
        }
        const activity: ViewId = id === 'keybindings' ? 'settings' : id;
        for (const [viewId, pane] of panes) {
            pane.hidden = viewId !== id;
            const button = buttons.get(viewId);
            button?.classList.toggle('is-active', viewId === activity);
            button?.setAttribute('aria-pressed', String(viewId === activity));
        }
        sideBarFrame.setAttribute('aria-label', id === 'keybindings' ? 'Keyboard Shortcuts' : ACTIVITY.find((item) => item.id === id)?.label ?? id);
    }

    const infoList = el('dl', { className: 'info-list' });
    const status = el('p', { className: 'muted', text: 'Connecting to the main process…' });

    const welcome = el('section', { className: 'welcome', attrs: { 'data-testid': 'welcome', 'data-ready': 'false' } }, [
        el('h1', { className: 'welcome-title' }, [
            document.createTextNode('Code-'),
            el('span', { className: 'accent', text: 'XR' }),
            document.createTextNode(' IDE'),
        ]),
        el('p', { className: 'welcome-tagline', text: 'Edit, analyse and explore your code in extended reality.' }),
        status,
        infoList,
    ]);

    const editorArea = el('main', { className: 'editor-area' }, [welcome]);

    const statusLeft = el('span', { text: 'Code-XR' });
    const statusRight = el('span', { text: '' });
    const pythonItem = el('button', { className: 'status-item', attrs: { type: 'button', 'data-testid': 'python-status', hidden: '' } });
    pythonItem.addEventListener('click', () => showView('analysis'));
    // #166: the active editor's position, indentation, encoding, line endings and language.
    const editorStatus = el('span', { className: 'status-editor', attrs: { 'data-testid': 'editor-status' } });
    const statusBar = el('footer', { className: 'status-bar' }, [statusLeft, el('span', { className: 'status-right' }, [editorStatus, pythonItem, statusRight])]);

    const sceneArea = el('section', { className: 'scene-area', attrs: { 'aria-label': 'Analysis scene', 'data-testid': 'scene-area', hidden: '' } });
    // #137: the bottom panel (hidden until the terminal opens).
    const panel = el('section', { className: 'panel', attrs: { hidden: '' } });

    const shell = el('div', { className: 'workbench' }, [activityBar, sideBarFrame, editorArea, panel, sceneArea, statusBar]);
    root.replaceChildren(shell);
    const layout = createLayout({ shell, sideBar: sideBarFrame, panel, sceneArea }, storage);
    showView('explorer', false);

    return {
        sideBar,
        searchView,
        analysisView,
        settingsView,
        keybindingsView,
        showView: (id: ViewId) => showView(id),
        setPythonStatus(text: string, tooltip: string, state: string): void {
            pythonItem.hidden = false;
            pythonItem.textContent = text;
            pythonItem.title = tooltip;
            pythonItem.dataset['state'] = state;
        },
        editorArea,
        sceneArea,
        setSceneVisible(visible: boolean): void {
            sceneArea.hidden = !visible;
            shell.classList.toggle('has-scene', visible);
        },
        panel,
        editorStatus,
        layout,
        setStatus(message: string): void {
            statusLeft.textContent = message;
        },
        showInfo(info: AppInfo): void {
            const rows: Array<[string, string]> = [
                ['Version', info.version],
                ['Platform', `${info.platform} (${info.arch})`],
                ['Electron', info.versions.electron],
                ['Chromium', info.versions.chrome],
                ['Node.js', info.versions.node],
                ['Mode', info.isDevelopment ? 'development' : 'production'],
            ];
            infoList.replaceChildren(...rows.flatMap(([term, value]) => [
                el('dt', { text: term }),
                el('dd', { text: value }),
            ]));
            status.textContent = 'Sandboxed renderer, context isolation on, strict CSP.';
            statusLeft.textContent = `Code-XR IDE ${info.version}`;
            statusRight.textContent = `${info.platform} · Electron ${info.versions.electron}`;
            welcome.setAttribute('data-ready', 'true');
        },
        showError(message: string): void {
            status.textContent = message;
            status.className = 'error';
        },
    };
}
