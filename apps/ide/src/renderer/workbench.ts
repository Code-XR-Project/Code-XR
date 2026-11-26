import type { AppInfo } from '../shared/api.ts';
import { el, icon } from './dom.ts';

/**
 * The workbench shell: activity bar, side bar, editor area and status bar.
 * The side bar hosts the explorer (#14, explorer.ts); the editor area is the
 * welcome view until Monaco arrives (#14), then analysis views (#16), the
 * terminal (#17) and the command palette (#18) take their slots. Built with DOM APIs
 * only, never innerHTML, so nothing here can turn text into markup.
 */

interface ActivityItem {
    readonly id: string;
    readonly label: string;
    readonly icon: string; // SVG path data, 24x24 viewBox
}

const ACTIVITY: readonly ActivityItem[] = [
    { id: 'explorer', label: 'Explorer', icon: 'M3 6h7l2 2h9v11H3z' },
    { id: 'analysis', label: 'Analysis', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
    { id: 'xr', label: 'XR scene', icon: 'M2 8h20v9h-6l-2-3h-4l-2 3H2z' },
];

export type ViewId = 'explorer' | 'analysis' | 'xr';

export interface Workbench {
    /** The explorer's pane of the side bar. */
    readonly sideBar: HTMLElement;
    /** The Analysis view's pane of the side bar (#15: the Python environment). */
    readonly analysisView: HTMLElement;
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
}

export function renderWorkbench(root: HTMLElement): Workbench {
    const buttons = new Map<ViewId, HTMLButtonElement>();
    const activityBar = el('nav', { className: 'activity-bar', attrs: { 'aria-label': 'Views' } },
        ACTIVITY.map((item, index) => {
            const button = el('button', {
                className: index === 0 ? 'activity-item is-active' : 'activity-item',
                attrs: { type: 'button', title: item.label, 'aria-label': item.label, 'aria-pressed': String(index === 0), 'data-view': item.id },
            }, [icon(item.icon)]);
            button.addEventListener('click', () => showView(item.id as ViewId));
            buttons.set(item.id as ViewId, button);
            return button;
        }));

    const sideBar = el('div', { className: 'side-pane', attrs: { 'data-view': 'explorer' } });
    const analysisView = el('div', { className: 'side-pane', attrs: { 'data-view': 'analysis', 'data-testid': 'analysis-view' } });
    const xrView = el('div', { className: 'side-pane', attrs: { 'data-view': 'xr' } }, [
        el('h2', { className: 'side-bar-title', text: 'XR scene' }),
        el('p', { className: 'muted side-note', text: 'Run an analysis from the Analysis view: its XR scene opens beside the code.' }),
    ]);
    const panes = new Map<ViewId, HTMLElement>([['explorer', sideBar], ['analysis', analysisView], ['xr', xrView]]);
    const sideBarFrame = el('aside', { className: 'side-bar', attrs: { 'aria-label': 'Explorer', 'data-testid': 'side-bar' } }, [sideBar, analysisView, xrView]);

    function showView(id: ViewId): void {
        for (const [viewId, pane] of panes) {
            pane.hidden = viewId !== id;
            const button = buttons.get(viewId);
            button?.classList.toggle('is-active', viewId === id);
            button?.setAttribute('aria-pressed', String(viewId === id));
        }
        sideBarFrame.setAttribute('aria-label', ACTIVITY.find((item) => item.id === id)?.label ?? id);
    }
    showView('explorer');

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
    const statusBar = el('footer', { className: 'status-bar' }, [statusLeft, el('span', { className: 'status-right' }, [pythonItem, statusRight])]);

    const sceneArea = el('section', { className: 'scene-area', attrs: { 'aria-label': 'Analysis scene', 'data-testid': 'scene-area', hidden: '' } });
    const shell = el('div', { className: 'workbench' }, [activityBar, sideBarFrame, editorArea, sceneArea, statusBar]);
    root.replaceChildren(shell);

    return {
        sideBar,
        analysisView,
        showView,
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
