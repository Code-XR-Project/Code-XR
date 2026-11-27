import { el, icon } from '../dom.ts';
import './viewers.css';

/** #256: the toolbar icons of the PDF and image viewers (24x24 stroke paths). */
export const VIEWER_ICONS = {
    zoomIn: 'M11 4a7 7 0 1 0 0.01 0M16 16l5 5M8 11h6M11 8v6',
    zoomOut: 'M11 4a7 7 0 1 0 0.01 0M16 16l5 5M8 11h6',
    fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    fitWidth: 'M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4',
    actualSize: 'M5 6h2v12M15 6h2v12M11 9v0.01M11 15v0.01',
    previous: 'M6 15l6-6 6 6',
    next: 'M6 9l6 6 6-6',
    search: 'M10 4a6 6 0 1 0 0.01 0M15 15l5 5',
    close: 'M6 6l12 12M18 6L6 18',
} as const;

export function viewerButton(label: string, path: string, testId: string, run: () => void): HTMLButtonElement {
    const button = el('button', { className: 'icon-button', attrs: { type: 'button', title: label, 'aria-label': label, 'data-testid': testId } }, [icon(path)]);
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        run();
    });
    return button;
}
