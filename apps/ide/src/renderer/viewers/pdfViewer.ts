import { getDocument, GlobalWorkerOptions, PasswordException, PixelsPerInch, TextLayer, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker';
import { el } from '../dom.ts';
import type { CustomEditorView } from '../editor/customEditor.ts';
import { fitZoom, findInPages, itemsInRange, stepZoom, clampZoom, zoomLabel, type PageMatch } from './viewerModel.ts';
import { VIEWER_ICONS, viewerButton } from './viewerChrome.ts';

/**
 * #256: a PDF of the folder in an editor tab, drawn by pdf.js. The bytes come
 * from the main process (a size-capped read inside the folder); pdf.js parses
 * them in its own worker, bundled by Vite and served from the app's origin,
 * so the CSP stays as it is (`worker-src 'self'`, no frames, no objects).
 *
 * Pages are placeholders of the right size until they come near the
 * viewport; only then is a page drawn on a canvas (at the screen's pixel
 * ratio) with its text layer over it, so text selects and copies. Pages far
 * from the viewport give their canvas back. The find (Ctrl+F) reads each
 * page's text once, lists the matches, and highlights the current one.
 */

let workerStarted = false;
/** One pdf.js worker for every PDF tab of the window. */
function ensureWorker(): void {
    if (!workerStarted) {
        GlobalWorkerOptions.workerPort = new PdfWorker();
        workerStarted = true;
    }
}

/** CSS pixels per PDF point at 100 % (pdf.js's own viewer uses the same, 96/72). */
const CSS_UNITS = PixelsPerInch.PDF_TO_CSS_UNITS;
/** Pages within this distance of the viewport are drawn. */
const RENDER_MARGIN = '150% 0px';

interface PageSlot {
    readonly index: number;
    readonly element: HTMLElement;
    /** The page's size at 100 %, in CSS pixels (the first page's until its own is known). */
    width: number;
    height: number;
    page: PDFPageProxy | null;
    /** The zoom it is drawn at (0: not drawn). */
    drawnAt: number;
    renderTask: RenderTask | null;
    textLayer: TextLayer | null;
    visible: boolean;
}

export function createPdfView(path: string, readDocument: (path: string) => Promise<Uint8Array | null>): CustomEditorView {
    const pages = el('div', { className: 'pdf-pages' });
    const scroll = el('div', { className: 'viewer-scroll pdf-scroll', attrs: { tabindex: '0', 'data-testid': 'pdf-scroll' } }, [pages]);
    const message = el('div', { className: 'viewer-message muted', attrs: { hidden: '' } });
    const pageInput = el('input', { className: 'pdf-page-input', attrs: { type: 'text', inputmode: 'numeric', 'aria-label': 'Page number', 'data-testid': 'pdf-page-input', value: '1' } });
    const pageCount = el('span', { className: 'muted', attrs: { 'data-testid': 'pdf-page-count' } });
    const zoomText = el('span', { className: 'viewer-zoom', attrs: { 'data-testid': 'viewer-zoom' } });
    const findInput = el('input', { className: 'viewer-find-input', attrs: { type: 'search', placeholder: 'Find', 'aria-label': 'Find in the document', 'data-testid': 'pdf-find-input' } });
    const findCount = el('span', { className: 'viewer-find-count muted', attrs: { 'aria-live': 'polite', 'data-testid': 'pdf-find-count' } });
    const fitWidthButton = viewerButton('Fit width', VIEWER_ICONS.fitWidth, 'viewer-fit-width', () => setZoom('fit'));
    const toolbar = el('div', { className: 'viewer-toolbar', attrs: { role: 'toolbar', 'aria-label': 'PDF' } }, [
        viewerButton('Previous page', VIEWER_ICONS.previous, 'pdf-previous-page', () => goToPage(currentPage - 1)),
        viewerButton('Next page', VIEWER_ICONS.next, 'pdf-next-page', () => goToPage(currentPage + 1)),
        pageInput,
        pageCount,
        el('span', { className: 'viewer-separator' }),
        viewerButton('Zoom out (Ctrl+-)', VIEWER_ICONS.zoomOut, 'viewer-zoom-out', () => setZoom(stepZoom(zoom, -1))),
        zoomText,
        viewerButton('Zoom in (Ctrl+=)', VIEWER_ICONS.zoomIn, 'viewer-zoom-in', () => setZoom(stepZoom(zoom, 1))),
        fitWidthButton,
        viewerButton('Actual size', VIEWER_ICONS.actualSize, 'viewer-actual-size', () => setZoom(1)),
        el('span', { className: 'viewer-spacer' }),
        el('div', { className: 'viewer-find' }, [
            findInput,
            findCount,
            viewerButton('Previous match (Shift+Enter)', VIEWER_ICONS.previous, 'pdf-find-previous', () => stepMatch(-1)),
            viewerButton('Next match (Enter)', VIEWER_ICONS.next, 'pdf-find-next', () => stepMatch(1)),
        ]),
    ]);
    const element = el('div', { className: 'viewer pdf-viewer', attrs: { 'data-testid': 'pdf-viewer' } }, [toolbar, scroll, message]);

    let pdf: PDFDocumentProxy | null = null;
    /** The loading task of `pdf`: destroying it frees the document in the worker. */
    let pdfTask: PDFDocumentLoadingTask | null = null;
    let slots: PageSlot[] = [];
    let zoom = 1;
    let fitting = true;
    let currentPage = 1;
    let disposed = false;
    /** Bumped on every (re)load: work of an older load stops when it sees another value. */
    let generation = 0;
    let observer: IntersectionObserver | null = null;
    // The find: each page's text items, read once per load, and the matches of the query.
    let pageTexts: Promise<string[][]> | null = null;
    let matches: PageMatch[] = [];
    let matchIndex = -1;
    let query = '';

    function showMessage(text: string | null): void {
        message.textContent = text ?? '';
        message.hidden = text === null;
        scroll.hidden = text !== null;
    }

    function sizeSlot(slot: PageSlot): void {
        const width = Math.floor(slot.width * zoom);
        const height = Math.floor(slot.height * zoom);
        slot.element.style.width = `${width}px`;
        slot.element.style.height = `${height}px`;
    }

    function clearSlot(slot: PageSlot): void {
        slot.renderTask?.cancel();
        slot.renderTask = null;
        slot.textLayer?.cancel();
        slot.textLayer = null;
        slot.drawnAt = 0;
        slot.element.replaceChildren();
    }

    async function drawSlot(slot: PageSlot): Promise<void> {
        const doc = pdf;
        const mine = generation;
        if (!doc || slot.drawnAt === zoom) {
            return;
        }
        clearSlot(slot);
        const at = zoom;
        slot.drawnAt = at;
        const page = slot.page ?? await doc.getPage(slot.index + 1);
        if (mine !== generation || slot.drawnAt !== at) {
            return;
        }
        if (!slot.page) {
            slot.page = page;
            const natural = page.getViewport({ scale: CSS_UNITS });
            slot.width = natural.width;
            slot.height = natural.height;
            sizeSlot(slot);
        }
        const viewport = page.getViewport({ scale: at * CSS_UNITS });
        const ratio = window.devicePixelRatio || 1;
        const canvas = el('canvas', { className: 'pdf-canvas' });
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const text = el('div', { className: 'textLayer' });
        slot.element.replaceChildren(canvas, text);
        slot.element.style.setProperty('--total-scale-factor', String(viewport.scale));
        const task = page.render({ canvas, viewport, ...(ratio !== 1 ? { transform: [ratio, 0, 0, ratio, 0, 0] } : {}) });
        slot.renderTask = task;
        const layer = new TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
        slot.textLayer = layer;
        try {
            await Promise.all([task.promise, layer.render()]);
        } catch {
            return; // cancelled by a zoom, a scroll far away, or a reload
        }
        if (slot.renderTask === task) {
            slot.renderTask = null;
            markMatch(slot);
        }
    }

    function observe(): void {
        observer?.disconnect();
        observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const slot = slots[Number((entry.target as HTMLElement).dataset['index'])];
                if (!slot) {
                    continue;
                }
                slot.visible = entry.isIntersecting;
                if (entry.isIntersecting) {
                    void drawSlot(slot);
                } else if (slot.drawnAt !== 0) {
                    clearSlot(slot); // its canvas memory goes back
                }
            }
        }, { root: scroll, rootMargin: RENDER_MARGIN });
        for (const slot of slots) {
            observer.observe(slot.element);
        }
    }

    function fitWidthZoom(): number {
        const widest = slots.reduce((max, slot) => Math.max(max, slot.width), 0);
        return fitZoom(widest, scroll.clientWidth - 16);
    }

    /** Applies a zoom (a value, or 'fit' for the width), keeping the page in view. */
    function setZoom(value: number | 'fit'): void {
        fitting = value === 'fit';
        const next = value === 'fit' ? fitWidthZoom() : clampZoom(value);
        fitWidthButton.setAttribute('aria-pressed', String(fitting));
        zoomText.textContent = zoomLabel(next);
        if (next === zoom || slots.length === 0) {
            zoom = next;
            return;
        }
        const slot = slots[currentPage - 1];
        const within = slot ? (scroll.scrollTop - slot.element.offsetTop) / Math.max(1, slot.element.offsetHeight) : 0;
        zoom = next;
        for (const each of slots) {
            sizeSlot(each);
            if (each.visible) {
                void drawSlot(each);
            } else {
                clearSlot(each);
            }
        }
        if (slot) {
            scroll.scrollTop = slot.element.offsetTop + within * slot.element.offsetHeight;
        }
    }

    function goToPage(number: number): void {
        const slot = slots[Math.min(Math.max(1, Math.round(number)), slots.length) - 1];
        if (slot) {
            scroll.scrollTop = slot.element.offsetTop - 8;
            setCurrentPage(slot.index + 1);
        }
    }

    function setCurrentPage(number: number): void {
        currentPage = number;
        if (document.activeElement !== pageInput) {
            pageInput.value = String(number);
        }
    }

    /** The page under the middle of the viewport. */
    function pageAtScroll(): number {
        const mark = scroll.scrollTop + scroll.clientHeight / 2;
        let low = 0;
        let high = slots.length - 1;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if ((slots[middle]?.element.offsetTop ?? 0) <= mark) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        return low + 1;
    }

    // The find.
    function readTexts(): Promise<string[][]> {
        const doc = pdf;
        if (!doc) {
            return Promise.resolve([]);
        }
        pageTexts ??= (async () => {
            const texts: string[][] = [];
            for (let number = 1; number <= doc.numPages; number++) {
                const page = await doc.getPage(number);
                const content = await page.getTextContent();
                texts.push(content.items.map((item) => ('str' in item ? item.str : '')));
            }
            return texts;
        })();
        return pageTexts;
    }

    async function runFind(): Promise<void> {
        const wanted = findInput.value;
        query = wanted;
        const texts = await readTexts();
        if (query !== wanted) {
            return; // typed on meanwhile
        }
        matches = findInPages(texts.map((items) => items.join('')), wanted);
        matchIndex = matches.length > 0 ? 0 : -1;
        showMatch();
    }

    function stepMatch(direction: 1 | -1): void {
        if (matches.length === 0) {
            void runFind();
            return;
        }
        matchIndex = (matchIndex + direction + matches.length) % matches.length;
        showMatch();
    }

    function showMatch(): void {
        findCount.textContent = query === '' ? '' : matches.length === 0 ? 'No results' : `${matchIndex + 1} of ${matches.length}`;
        for (const slot of slots) {
            markMatch(slot);
        }
        const match = matches[matchIndex];
        const slot = match ? slots[match.page] : undefined;
        if (slot && match) {
            const span = slot.element.querySelector<HTMLElement>('.highlight.selected');
            if (span) {
                span.scrollIntoView({ block: 'center', inline: 'nearest' });
            } else {
                goToPage(slot.index + 1);
            }
        }
    }

    /**
     * Highlights the current match on `slot` when it is the match's page and
     * its text layer is drawn: the matched characters of each item it covers
     * are wrapped in a mark, the rest of the item stays plain text.
     */
    function markMatch(slot: PageSlot): void {
        const layer = slot.textLayer;
        if (!layer) {
            return;
        }
        const strings = layer.textContentItemsStr;
        const divs = layer.textDivs;
        for (const div of slot.element.querySelectorAll<HTMLElement>('[data-marked]')) {
            div.textContent = strings[Number(div.dataset['marked'])] ?? div.textContent;
            delete div.dataset['marked'];
        }
        const match = matches[matchIndex];
        if (!match || match.page !== slot.index) {
            return;
        }
        let start = 0;
        const starts = strings.map((str) => { const at = start; start += str.length; return at; });
        const hit = itemsInRange(strings.map((str) => str.length), match.offset, query.length);
        let first: HTMLElement | null = null;
        for (const index of hit) {
            const div = divs[index];
            const text = strings[index] ?? '';
            if (!div) {
                continue;
            }
            const from = Math.max(0, match.offset - (starts[index] ?? 0));
            const to = Math.min(text.length, match.offset + query.length - (starts[index] ?? 0));
            const mark = el('span', { className: 'highlight selected', text: text.slice(from, to) });
            div.replaceChildren(text.slice(0, from), mark, text.slice(to));
            div.dataset['marked'] = String(index);
            first ??= mark;
        }
        first?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }

    async function load(): Promise<void> {
        const mine = ++generation;
        const keepPage = currentPage;
        let bytes: Uint8Array | null;
        try {
            bytes = await readDocument(path);
        } catch {
            bytes = null;
        }
        if (disposed || mine !== generation) {
            return;
        }
        if (!bytes) {
            showMessage(`${path} cannot be shown: it is gone, or over 64 MB.`);
            return;
        }
        ensureWorker();
        let next: PDFDocumentProxy;
        const task = getDocument({ data: bytes, useSystemFonts: true });
        try {
            next = await task.promise;
        } catch (error) {
            if (!disposed && mine === generation) {
                showMessage(error instanceof PasswordException
                    ? `${path} is protected by a password, which the viewer does not support yet.`
                    : `${path} is not a PDF the viewer can read: ${error instanceof Error ? error.message : String(error)}`);
            }
            return;
        }
        if (disposed || mine !== generation) {
            void task.destroy();
            return;
        }
        // The new document replaces the old one only once it parsed.
        for (const slot of slots) {
            clearSlot(slot);
        }
        void pdfTask?.destroy();
        pdf = next;
        pdfTask = task;
        pageTexts = null;
        matches = [];
        matchIndex = -1;
        const first = await next.getPage(1);
        if (disposed || mine !== generation) {
            return;
        }
        const size = first.getViewport({ scale: CSS_UNITS });
        slots = Array.from({ length: next.numPages }, (_, index) => ({
            index,
            element: el('div', { className: 'pdf-page', attrs: { 'data-index': String(index), 'data-testid': 'pdf-page', 'aria-label': `Page ${index + 1}` } }),
            width: size.width,
            height: size.height,
            page: index === 0 ? first : null,
            drawnAt: 0,
            renderTask: null,
            textLayer: null,
            visible: false,
        }));
        pages.replaceChildren(...slots.map((slot) => slot.element));
        pageCount.textContent = `of ${next.numPages}`;
        showMessage(null);
        const keepZoom = zoom;
        zoom = 0; // forces the sizes below
        setZoom(fitting ? 'fit' : keepZoom);
        observe();
        goToPage(keepPage);
        if (query !== '') {
            void runFind();
        }
    }

    scroll.addEventListener('scroll', () => setCurrentPage(pageAtScroll()), { passive: true });
    scroll.addEventListener('wheel', (event) => {
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            setZoom(stepZoom(zoom, event.deltaY < 0 ? 1 : -1));
        }
    }, { passive: false });
    pageInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            goToPage(Number(pageInput.value));
            scroll.focus();
            event.preventDefault();
        }
    });
    pageInput.addEventListener('blur', () => { pageInput.value = String(currentPage); });
    findInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            if (findInput.value !== query) {
                void runFind();
            } else {
                stepMatch(event.shiftKey ? -1 : 1);
            }
            event.preventDefault();
        } else if (event.key === 'Escape') {
            findInput.value = '';
            query = '';
            matches = [];
            matchIndex = -1;
            showMatch();
            scroll.focus();
            event.preventDefault();
        }
    });
    let findTimer: ReturnType<typeof setTimeout> | undefined;
    findInput.addEventListener('input', () => {
        clearTimeout(findTimer);
        findTimer = setTimeout(() => void runFind(), 250);
    });
    element.addEventListener('keydown', (event) => {
        const mod = event.ctrlKey || event.metaKey;
        const inField = event.target === findInput || event.target === pageInput;
        if (mod && event.key.toLowerCase() === 'f') {
            findInput.focus();
            findInput.select();
        } else if (mod && (event.key === '=' || event.key === '+')) {
            setZoom(stepZoom(zoom, 1));
        } else if (mod && event.key === '-') {
            setZoom(stepZoom(zoom, -1));
        } else if (mod && event.key === '0') {
            setZoom('fit');
        } else if (!inField && (event.key === 'PageDown' || event.key === 'PageUp') && !mod) {
            return; // the scroller handles them
        } else if (!inField && !mod && (event.key === 'Home' || event.key === 'End')) {
            goToPage(event.key === 'Home' ? 1 : slots.length);
        } else {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
    });
    const resize = new ResizeObserver(() => { if (fitting && slots.length > 0) { setZoom('fit'); } });
    resize.observe(scroll);
    zoomText.textContent = zoomLabel(1);
    void load();

    return {
        element,
        focus: () => scroll.focus(),
        fileChanged: () => void load(),
        dispose: () => {
            disposed = true;
            generation++;
            clearTimeout(findTimer);
            observer?.disconnect();
            resize.disconnect();
            for (const slot of slots) {
                clearSlot(slot);
            }
            void pdfTask?.destroy();
            pdfTask = null;
            pdf = null;
        },
    };
}
