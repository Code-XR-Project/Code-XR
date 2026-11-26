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

export interface Workbench {
    /** The side bar's content slot, owned by the explorer. */
    readonly sideBar: HTMLElement;
    showInfo(info: AppInfo): void;
    showError(message: string): void;
    /** Left status-bar text, for short messages ("Opened …"). */
    setStatus(message: string): void;
}

export function renderWorkbench(root: HTMLElement): Workbench {
    const activityBar = el('nav', { className: 'activity-bar', attrs: { 'aria-label': 'Views' } },
        ACTIVITY.map((item, index) => {
            const button = el('button', {
                className: index === 0 ? 'activity-item is-active' : 'activity-item',
                attrs: { type: 'button', title: item.label, 'aria-label': item.label, 'aria-pressed': String(index === 0) },
            }, [icon(item.icon)]);
            return button;
        }));

    const sideBar = el('aside', { className: 'side-bar', attrs: { 'aria-label': 'Explorer', 'data-testid': 'side-bar' } });

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
    const statusBar = el('footer', { className: 'status-bar' }, [statusLeft, statusRight]);

    root.replaceChildren(el('div', { className: 'workbench' }, [activityBar, sideBar, editorArea, statusBar]));

    return {
        sideBar,
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
