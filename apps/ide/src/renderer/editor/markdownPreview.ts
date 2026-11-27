/**
 * #179: the Markdown preview beside the editor groups. The one place in the
 * renderer that inserts parsed markup, so it is fenced three ways:
 *
 * - DOMPurify runs on everything marked produces, in its own instance, with
 *   no `<style>`, no `style` attribute, no forms or frames, and every `id` or
 *   `name` from the document prefixed (`user-content-`), so a README can
 *   neither run script, restyle the IDE, cover it, nor clobber its globals.
 * - The window's CSP stays as it is: no inline script, and images from the
 *   app or `data:` only. Images are rewritten while the markup is still in
 *   DOMPurify's inert document, before anything could fetch them: an image
 *   of the open folder is read by the main process (checked against the
 *   folder, raster formats only) and inlined, a remote one becomes a button
 *   that opens it in the browser, so the preview itself never goes online.
 * - Links never navigate the window: `#anchor` scrolls the preview, a
 *   relative link opens the file in the IDE, http(s)/mailto open outside
 *   after the main process checks the scheme, anything else does nothing.
 *
 * Code blocks are coloured by Monaco's own tokenizer, so they follow the
 * theme like the rest of the preview, whose colours are the workbench's.
 */
import createDOMPurify, { type Config } from 'dompurify';
import { el, icon } from '../dom.ts';
import { monaco } from './monaco.ts';
import { blockIndexForLine, headingSlugger, renderMarkdownBlocks, resolveImage, resolveLink } from './markdownModel.ts';

const CLOSE = 'M6 6l12 12M18 6L6 18';
const RENDER_DELAY_MS = 120;

export interface MarkdownPreview {
    readonly element: HTMLElement;
    /** The file shown, or null before the first `show`. */
    path(): string | null;
    show(path: string, text: string): void;
    /** The file's text changed (typing): re-rendered after a short pause. */
    update(text: string): void;
    /** Scrolls to the part of the document that starts at `line` (the editor's first visible line). */
    scrollToLine(line: number): void;
    dispose(): void;
}

export interface MarkdownPreviewHost {
    readImage(path: string): Promise<string | null>;
    openExternalLink(url: string): Promise<void>;
    openFile(path: string, anchor: string | null): void;
    onStatus(message: string): void;
    onClose(): void;
}

const purifier = createDOMPurify(window);
/** Passed on every call: DOMPurify ignores a call's own options once setConfig was used. */
const SANITIZE: Config & { RETURN_DOM_FRAGMENT: true } = {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base', 'svg', 'math'],
    FORBID_ATTR: ['style', 'srcset', 'action', 'formaction', 'background', 'ping'],
    SANITIZE_NAMED_PROPS: true,
};
/** The image currently being sanitised belongs to this document: its src is resolved in the inert document. */
let sanitisingFor: string | null = null;
purifier.addHook('afterSanitizeAttributes', (node) => {
    // GitHub task lists: the only input kept is a disabled checkbox.
    if (node.nodeName === 'INPUT') {
        const input = node as HTMLInputElement;
        if (input.getAttribute('type') !== 'checkbox') {
            input.remove();
            return;
        }
        input.setAttribute('disabled', '');
        input.removeAttribute('name');
        return;
    }
    if (node.nodeName !== 'IMG' || sanitisingFor === null) {
        return;
    }
    const image = node as HTMLImageElement;
    const source = resolveImage(sanitisingFor, image.getAttribute('src'));
    image.setAttribute('loading', 'lazy');
    if (source.kind !== 'data') {
        image.removeAttribute('src');
    }
    if (source.kind === 'workspace') {
        image.setAttribute('data-codexr-path', source.path);
    } else if (source.kind === 'remote') {
        image.setAttribute('data-codexr-remote', source.url);
    } else if (source.kind === 'data') {
        image.setAttribute('data-codexr-data', '');
    }
});

export function createMarkdownPreview(host: MarkdownPreviewHost): MarkdownPreview {
    const title = el('span', { className: 'markdown-preview-title' });
    const close = el('button', { className: 'markdown-preview-close', attrs: { type: 'button', title: 'Close Preview', 'aria-label': 'Close the Markdown preview', 'data-testid': 'markdown-preview-close' } }, [icon(CLOSE)]);
    const body = el('div', { className: 'markdown-preview-body markdown-body', attrs: { 'data-testid': 'markdown-preview-body', tabindex: '0' } });
    const element = el('section', { className: 'markdown-preview', attrs: { 'aria-label': 'Markdown preview', 'data-testid': 'markdown-preview' } }, [
        el('header', { className: 'markdown-preview-header' }, [title, close]),
        body,
    ]);
    close.addEventListener('click', () => host.onClose());

    let currentPath: string | null = null;
    let lines: number[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingText: string | null = null;
    let lastLine = 1;
    /** Images of the folder, by path, for the life of one shown document. */
    let images = new Map<string, Promise<string | null>>();

    function render(text: string): void {
        if (currentPath === null) {
            return;
        }
        const scrollTop = body.scrollTop;
        const blocks = renderMarkdownBlocks(text);
        const fragment = document.createDocumentFragment();
        sanitisingFor = currentPath;
        try {
            for (const block of blocks) {
                const wrapper = el('div', { className: 'md-block', attrs: { 'data-line': String(block.line) } });
                wrapper.append(purifier.sanitize(block.html, SANITIZE));
                fragment.append(wrapper);
            }
        } finally {
            sanitisingFor = null;
        }
        const slug = headingSlugger();
        for (const heading of fragment.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
            heading.id = `md-${slug(heading.textContent ?? '')}`;
        }
        for (const image of fragment.querySelectorAll<HTMLImageElement>('img')) {
            placeImage(image);
        }
        for (const code of fragment.querySelectorAll<HTMLElement>('pre > code')) {
            colorize(code);
        }
        lines = blocks.map((block) => block.line);
        body.replaceChildren(fragment);
        body.scrollTop = scrollTop;
    }

    function placeImage(image: HTMLImageElement): void {
        const path = image.dataset['codexrPath'];
        const remote = image.dataset['codexrRemote'];
        if (path) {
            let loading = images.get(path);
            if (!loading) {
                loading = host.readImage(path).catch(() => null);
                images.set(path, loading);
            }
            void loading.then((dataUrl) => {
                if (dataUrl) {
                    image.src = dataUrl;
                } else {
                    image.replaceWith(el('span', { className: 'md-image-missing', text: `[image not shown: ${path}]` }));
                }
            });
        } else if (remote) {
            const label = image.getAttribute('alt') || remote;
            const button = el('a', {
                className: 'md-remote-image',
                text: `Remote image: ${label} (open in the browser)`,
                attrs: { href: remote, title: remote, 'data-testid': 'markdown-remote-image' },
            });
            image.replaceWith(button);
        } else if (image.hasAttribute('data-codexr-data')) {
            // An inline data: image is already in the document; DOMPurify kept it (the CSP allows data:).
        } else {
            image.remove();
        }
    }

    function colorize(code: HTMLElement): void {
        const name = [...code.classList].find((entry) => entry.startsWith('language-'))?.slice('language-'.length).toLowerCase();
        if (!name) {
            return;
        }
        const language = monaco.languages.getLanguages().find((entry) => entry.id === name
            || entry.aliases?.some((alias) => alias.toLowerCase() === name)
            || entry.extensions?.includes(`.${name}`));
        if (!language) {
            return;
        }
        const text = code.textContent ?? '';
        // Monaco's spans carry the theme's token classes; they go through the sanitiser like the rest.
        void monaco.editor.colorize(text, language.id, { tabSize: 4 }).then((html) => {
            if (code.isConnected && code.textContent === text) {
                code.replaceChildren(purifier.sanitize(html, SANITIZE));
            }
        }, () => undefined);
    }

    function scrollToAnchor(id: string): void {
        const target = body.querySelector(`[id="md-${CSS.escape(id)}"]`) ?? body.querySelector(`[id="user-content-${CSS.escape(id)}"]`);
        target?.scrollIntoView({ block: 'start' });
    }

    body.addEventListener('click', (event) => {
        const link = (event.target as Element).closest('a');
        if (!link || currentPath === null) {
            return;
        }
        event.preventDefault();
        const target = resolveLink(currentPath, link.getAttribute('href'));
        if (target.kind === 'anchor') {
            scrollToAnchor(target.id);
        } else if (target.kind === 'file') {
            host.openFile(target.path, target.anchor);
        } else if (target.kind === 'external') {
            host.openExternalLink(target.url).catch((error: unknown) => host.onStatus(`Could not open the link: ${String(error)}`));
        }
    });

    return {
        element,
        path: () => currentPath,
        show(path, text) {
            if (path !== currentPath) {
                images = new Map();
                body.scrollTop = 0;
            }
            currentPath = path;
            title.textContent = `Preview ${path.split('/').pop() ?? path}`;
            title.title = path;
            clearTimeout(timer);
            pendingText = null;
            render(text);
            this.scrollToLine(lastLine);
        },
        update(text) {
            pendingText = text;
            clearTimeout(timer);
            timer = setTimeout(() => {
                const next = pendingText;
                pendingText = null;
                if (next !== null) {
                    render(next);
                }
            }, RENDER_DELAY_MS);
        },
        scrollToLine(line) {
            lastLine = line;
            const index = blockIndexForLine(lines.map((start) => ({ line: start })), line);
            const block = body.children[index] as HTMLElement | undefined;
            if (!block || line <= 1) {
                body.scrollTop = 0;
                return;
            }
            const start = lines[index] ?? 1;
            const next = body.children[index + 1] as HTMLElement | undefined;
            const nextLine = lines[index + 1];
            const fraction = next && nextLine !== undefined && nextLine > start ? Math.min(1, (line - start) / (nextLine - start)) : 0;
            const top = block.offsetTop + fraction * ((next?.offsetTop ?? block.offsetTop) - block.offsetTop);
            body.scrollTop = top; // the body is the blocks' offset parent (position: relative)
        },
        dispose() {
            clearTimeout(timer);
            element.remove();
        },
    };
}
