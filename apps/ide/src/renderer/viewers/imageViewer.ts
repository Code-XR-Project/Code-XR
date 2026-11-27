import { el } from '../dom.ts';
import type { CustomEditorView } from '../editor/customEditor.ts';
import { clampZoom, dataUrlBytes, formatBytes, stepZoom, zoomLabel } from './viewerModel.ts';
import { VIEWER_ICONS, viewerButton } from './viewerChrome.ts';

/**
 * #256: an image of the folder in an editor tab. The bytes come from the
 * main process as a `data:` URL (the only images the CSP lets the window
 * load), the image starts fitted to the tab, and the toolbar zooms it in
 * steps, to its actual size, or back to fit (Ctrl + wheel works too).
 */
export function createImageView(path: string, readImage: (path: string) => Promise<string | null>): CustomEditorView {
    const image = el('img', { className: 'image-viewer-image', attrs: { alt: path, draggable: 'false', 'data-testid': 'image-viewer-image' } });
    const stage = el('div', { className: 'viewer-scroll image-viewer-stage is-fit', attrs: { tabindex: '0', 'data-testid': 'image-viewer-stage' } }, [image]);
    const message = el('div', { className: 'viewer-message muted', attrs: { hidden: '' } });
    const zoomText = el('span', { className: 'viewer-zoom', attrs: { 'data-testid': 'viewer-zoom' } });
    const info = el('span', { className: 'viewer-info muted', attrs: { 'data-testid': 'image-viewer-info' } });
    const fitButton = viewerButton('Fit to the tab', VIEWER_ICONS.fit, 'viewer-fit', () => setFit(true));
    const toolbar = el('div', { className: 'viewer-toolbar', attrs: { role: 'toolbar', 'aria-label': 'Image' } }, [
        viewerButton('Zoom out (Ctrl+-)', VIEWER_ICONS.zoomOut, 'viewer-zoom-out', () => zoomBy(-1)),
        zoomText,
        viewerButton('Zoom in (Ctrl+=)', VIEWER_ICONS.zoomIn, 'viewer-zoom-in', () => zoomBy(1)),
        fitButton,
        viewerButton('Actual size', VIEWER_ICONS.actualSize, 'viewer-actual-size', () => setZoom(1)),
        el('span', { className: 'viewer-spacer' }),
        info,
    ]);
    const element = el('div', { className: 'viewer image-viewer', attrs: { 'data-testid': 'image-viewer' } }, [toolbar, stage, message]);

    let fit = true;
    let zoom = 1;
    let bytes = 0;
    let disposed = false;

    /** The zoom the fitted image is shown at (for the label, and as the start of a step). */
    function fittedZoom(): number {
        if (!image.naturalWidth || !image.naturalHeight) {
            return 1;
        }
        const width = stage.clientWidth - 32;
        const height = stage.clientHeight - 32;
        return Math.min(1, width / image.naturalWidth, height / image.naturalHeight);
    }

    function render(): void {
        stage.classList.toggle('is-fit', fit);
        fitButton.setAttribute('aria-pressed', String(fit));
        if (fit) {
            image.style.width = '';
            image.style.height = '';
        } else {
            image.style.width = `${image.naturalWidth * zoom}px`;
            image.style.height = `${image.naturalHeight * zoom}px`;
        }
        zoomText.textContent = zoomLabel(fit ? fittedZoom() : zoom);
        info.textContent = image.naturalWidth ? `${image.naturalWidth} x ${image.naturalHeight} px, ${formatBytes(bytes)}` : '';
    }

    function setFit(value: boolean): void {
        fit = value;
        render();
    }

    function setZoom(value: number): void {
        fit = false;
        zoom = clampZoom(value);
        render();
    }

    function zoomBy(direction: 1 | -1): void {
        setZoom(stepZoom(fit ? fittedZoom() : zoom, direction));
    }

    function showMessage(text: string | null): void {
        message.textContent = text ?? '';
        message.hidden = text === null;
        stage.hidden = text !== null;
    }

    async function load(): Promise<void> {
        let url: string | null;
        try {
            url = await readImage(path);
        } catch {
            url = null;
        }
        if (disposed) {
            return;
        }
        if (!url) {
            showMessage(`${path} cannot be shown: it is gone, over 8 MB, or not an image the viewer reads.`);
            return;
        }
        bytes = dataUrlBytes(url);
        showMessage(null);
        image.src = url;
    }

    image.addEventListener('load', render);
    image.addEventListener('error', () => showMessage(`${path} is not an image the viewer can decode.`));
    stage.addEventListener('wheel', (event) => {
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            zoomBy(event.deltaY < 0 ? 1 : -1);
        }
    }, { passive: false });
    element.addEventListener('keydown', (event) => {
        const mod = event.ctrlKey || event.metaKey;
        if (mod && (event.key === '=' || event.key === '+')) {
            zoomBy(1);
        } else if (mod && event.key === '-') {
            zoomBy(-1);
        } else if (mod && event.key === '0') {
            setFit(true);
        } else {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
    });
    const resize = new ResizeObserver(() => { if (fit) { render(); } });
    resize.observe(stage);
    void load();

    return {
        element,
        focus: () => stage.focus(),
        fileChanged: () => void load(),
        dispose: () => {
            disposed = true;
            resize.disconnect();
        },
    };
}
