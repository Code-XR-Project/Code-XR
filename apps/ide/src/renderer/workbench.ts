import type { AppInfo } from '../shared/api.ts';
import { el, icon } from './dom.ts';
import { PROBLEM_ICONS } from './problems/problemsView.ts';
import { createLayout, type LayoutStorage, type WorkbenchLayout } from './layout/layout.ts';
// The extension's own logo, bundled by Vite rather than copied into the IDE.
import codeXrLogoUrl from '../../../vscode-extension/resources/icon.svg?url';

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
    // #17: Source Control (git/scmView.ts).
    { id: 'scm', label: 'Source Control', icon: 'M6 3v12M6 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM18 9a3 3 0 1 0 0-6a3 3 0 1 0 0 6zM18 9c0 6-12 3-12 6' },
    // #180: Run and Debug (debug/debugView.ts).
    { id: 'debug', label: 'Run and Debug', icon: 'M5 4l9 6-9 6zM16 13a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM16 13v-2M13 17h-2M21 17h-2' },
    { id: 'analysis', label: 'Analysis', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
    { id: 'xr', label: 'XR scene', icon: 'M2 8h20v9h-6l-2-3h-4l-2 3H2z' },
    // The AI agent hub (agents/agentsView.ts).
    { id: 'agents', label: 'Agents', icon: 'M4 5h16v11H9l-5 4zM9 10h.01M12 10h.01M15 10h.01' },
    // #255: VS Code extensions from Open VSX (extensions/extensionsView.ts).
    { id: 'extensions', label: 'Extensions', icon: 'M4 4h7v7H4zM4 13h7v7H4zM13 13h7v7h-7zM16.5 3l4.5 4.5L16.5 12 12 7.5z' },
    // #18: the Settings view, at the foot of the activity bar as in VS Code.
    { id: 'settings', label: 'Settings', icon: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1', bottom: true },
];

/** `keybindings` has no activity item of its own: it is part of Settings (#18, part 3). */
export type ViewId = 'explorer' | 'search' | 'scm' | 'debug' | 'analysis' | 'xr' | 'agents' | 'extensions' | 'settings' | 'keybindings';

export interface Workbench {
    /** The explorer's part of its side-bar pane (the file tree). */
    readonly sideBar: HTMLElement;
    /** #172: the Outline section under the file tree, in the same pane. */
    readonly outlineView: HTMLElement;
    /** The Search view's pane of the side bar (#165). */
    readonly searchView: HTMLElement;
    /** The Source Control view's pane of the side bar (#17). */
    readonly scmView: HTMLElement;
    /** #180: the Run and Debug view's pane of the side bar. */
    readonly debugView: HTMLElement;
    /** The status bar's slot for the current branch (#17), at its left. */
    readonly branchStatus: HTMLElement;
    /** #177: the Restricted Mode item, at the start of the status bar (trustView.ts fills it). */
    readonly trustStatus: HTMLButtonElement;
    /** Whether a side-bar view is the one shown (and the side bar visible). */
    isViewVisible(id: ViewId): boolean;
    /** The Analysis view's pane of the side bar (#15: the Python environment). */
    readonly analysisView: HTMLElement;
    /** The Agents view's pane of the side bar (AI agent hub). */
    readonly agentsView: HTMLElement;
    /** The Extensions view's pane of the side bar (#255, extensions/extensionsView.ts). */
    readonly extensionsView: HTMLElement;
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
    /** #173: the errors and warnings in the Problems panel, at the left of the status bar. */
    setProblemCounts(errors: number, warnings: number): void;
    /** #173: clicking the problem counts. */
    onProblemsClick(listener: () => void): void;
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

    // #172: the explorer pane holds the file tree and, under it, the Outline section.
    const sideBar = el('div', { className: 'explorer-section' });
    const outlineView = el('section', { attrs: { 'aria-label': 'Outline', 'data-testid': 'outline-section' } });
    const explorerPane = el('div', { className: 'side-pane explorer-pane', attrs: { 'data-view': 'explorer' } }, [sideBar, outlineView]);
    const searchView = el('div', { className: 'side-pane', attrs: { 'data-view': 'search', 'data-testid': 'search-view' } });
    const scmView = el('div', { className: 'side-pane', attrs: { 'data-view': 'scm', 'data-testid': 'scm-view' } });
    const debugView = el('div', { className: 'side-pane', attrs: { 'data-view': 'debug', 'data-testid': 'debug-view' } });
    const analysisView = el('div', { className: 'side-pane', attrs: { 'data-view': 'analysis', 'data-testid': 'analysis-view' } });
    const xrView = el('div', { className: 'side-pane', attrs: { 'data-view': 'xr' } }, [
        el('h2', { className: 'side-bar-title', text: 'XR scene' }),
        el('p', { className: 'muted side-note', text: 'Run an analysis from the Analysis view: its XR scene opens beside the code.' }),
    ]);
    const agentsView = el('div', { className: 'side-pane', attrs: { 'data-view': 'agents', 'data-testid': 'agents-view' } });
    const extensionsView = el('div', { className: 'side-pane', attrs: { 'data-view': 'extensions', 'data-testid': 'extensions-view' } });
    const settingsView = el('div', { className: 'side-pane', attrs: { 'data-view': 'settings', 'data-testid': 'settings-view' } });
    const keybindingsView = el('div', { className: 'side-pane', attrs: { 'data-view': 'keybindings', 'data-testid': 'keybindings-view' } });
    const panes = new Map<ViewId, HTMLElement>([['explorer', explorerPane], ['search', searchView], ['scm', scmView], ['debug', debugView], ['analysis', analysisView], ['xr', xrView], ['agents', agentsView], ['extensions', extensionsView], ['settings', settingsView], ['keybindings', keybindingsView]]);
    const sideBarFrame = el('aside', { className: 'side-bar', attrs: { 'aria-label': 'Explorer', 'data-testid': 'side-bar' } }, [explorerPane, searchView, scmView, debugView, analysisView, xrView, agentsView, extensionsView, settingsView, keybindingsView]);

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

    // The logo is drawn as a mask in the text colour: the SVG is black, which would vanish on the dark theme.
    const logo = el('span', { className: 'welcome-logo', attrs: { 'aria-hidden': 'true', 'data-testid': 'welcome-logo' } });
    logo.style.setProperty('--logo-url', `url("${codeXrLogoUrl}")`);
    const welcome = el('section', { className: 'welcome', attrs: { 'data-testid': 'welcome', 'data-ready': 'false' } }, [
        logo,
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

    const statusLeft = el('span', { className: 'status-message', text: 'Code-XR' });
    // #173: the problem counts; icons are the Problems panel's (renderer/problems/problemsView.ts).
    const errorCount = el('span', { text: '0' });
    const warningCount = el('span', { text: '0' });
    const problemsItem = el('button', {
        className: 'status-item status-problems',
        attrs: { type: 'button', title: 'No Problems', 'aria-label': 'No Problems', 'data-testid': 'problems-status' },
    }, [icon(PROBLEM_ICONS.error), errorCount, icon(PROBLEM_ICONS.warning), warningCount]);
    let problemsListener: (() => void) | null = null;
    problemsItem.addEventListener('click', () => problemsListener?.());
    const statusRight = el('span', { text: '' });
    const pythonItem = el('button', { className: 'status-item', attrs: { type: 'button', 'data-testid': 'python-status', hidden: '' } });
    pythonItem.addEventListener('click', () => showView('analysis'));
    // #166: the active editor's position, indentation, encoding, line endings and language.
    const editorStatus = el('span', { className: 'status-editor', attrs: { 'data-testid': 'editor-status' } });
    const branchStatus = el('span', { className: 'status-branch', attrs: { 'data-testid': 'branch-status' } });
    const trustStatus = el('button', { className: 'status-item status-trust', attrs: { type: 'button', 'data-testid': 'trust-status', hidden: '' } });
    const statusBar = el('footer', { className: 'status-bar' }, [el('span', { className: 'status-left' }, [trustStatus, branchStatus, problemsItem, statusLeft]), el('span', { className: 'status-right' }, [editorStatus, pythonItem, statusRight])]);

    const sceneArea = el('section', { className: 'scene-area', attrs: { 'aria-label': 'Analysis scene', 'data-testid': 'scene-area', hidden: '' } });
    // #137: the bottom panel (hidden until the terminal opens).
    const panel = el('section', { className: 'panel', attrs: { hidden: '' } });

    const shell = el('div', { className: 'workbench' }, [activityBar, sideBarFrame, editorArea, panel, sceneArea, statusBar]);
    root.replaceChildren(shell);
    const layout = createLayout({ shell, sideBar: sideBarFrame, panel, sceneArea }, storage);
    showView('explorer', false);

    return {
        sideBar,
        outlineView,
        searchView,
        scmView,
        debugView,
        branchStatus,
        trustStatus,
        isViewVisible: (id: ViewId) => !panes.get(id)?.hidden && layout.sideBarVisible && !layout.zen,
        analysisView,
        agentsView,
        extensionsView,
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
        setProblemCounts(errors: number, warnings: number): void {
            errorCount.textContent = String(errors);
            warningCount.textContent = String(warnings);
            const label = errors + warnings === 0 ? 'No Problems' : `Errors: ${errors}, Warnings: ${warnings}`;
            problemsItem.title = label;
            problemsItem.setAttribute('aria-label', label);
        },
        onProblemsClick(listener: () => void): void {
            problemsListener = listener;
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
