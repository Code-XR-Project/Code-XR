import type { CodeXRApi } from '../../shared/api.ts';
import { MAX_OUTPUT_LINES, OUTPUT_CHANNELS, type OutputChannelId } from '../../shared/output.ts';
import { copyText, el, icon } from '../dom.ts';
import type { PanelHost } from '../panel/panelHost.ts';

/**
 * The Output view of the bottom panel (#174): what the IDE, the analysis
 * core, the Python environment and the servers wrote, one channel at a
 * time. The main process collects and redacts the lines (main/outputPanel); this
 * view only shows them, keeping at most MAX_OUTPUT_LINES in the page.
 */

const ICONS = {
    lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
    unlock: 'M7 11V8a5 5 0 0 1 9.6-2M5 11h14v10H5z',
    copy: 'M9 9h11v11H9zM5 15V4h11',
    clear: 'M4 7h16M10 11v6M14 11v6M9 7V4h6v3M6 7l1 13h10l1-13',
} as const;

export interface OutputView {
    /** Shows the panel on the Output view, on `channel` if given. */
    show(channel?: OutputChannelId): void;
    readonly channel: OutputChannelId;
}

export function createOutputView(host: PanelHost, api: CodeXRApi['output'], hooks: { onError(message: string): void }): OutputView {
    let channel: OutputChannelId = 'ide';
    let scrollLock = false;
    // Lines that arrived for the shown channel while its snapshot was loading.
    let loading: string[] | null = null;
    let generation = 0;

    const select = el('select', { className: 'output-channel', attrs: { 'aria-label': 'Output channel', 'data-testid': 'output-channel' } });
    for (const { id, label } of OUTPUT_CHANNELS) {
        select.append(el('option', { text: label, attrs: { value: id } }));
    }
    const button = (label: string, path: string, testId: string): HTMLButtonElement =>
        el('button', { className: 'icon-button', attrs: { type: 'button', title: label, 'aria-label': label, 'data-testid': testId } }, [icon(path)]);
    const lockButton = button('Turn Auto Scrolling Off', ICONS.unlock, 'output-scroll-lock');
    lockButton.setAttribute('aria-pressed', 'false');
    const copyButton = button('Copy Output', ICONS.copy, 'output-copy');
    const clearButton = button('Clear Output', ICONS.clear, 'output-clear');
    const lines = el('div', { className: 'output-lines', attrs: { role: 'log', 'aria-live': 'off', tabindex: '0', 'data-testid': 'output-lines' } });
    const empty = el('p', { className: 'muted output-empty', text: 'Nothing has been written to this channel yet.' });
    const body = el('div', { className: 'output-body', attrs: { 'data-testid': 'output-body' } }, [empty, lines]);

    host.register({
        id: 'output',
        label: 'Output',
        body,
        center: select,
        actions: [lockButton, copyButton, clearButton],
        onShow: () => scrollToEnd(),
    });

    function lineElement(text: string): HTMLElement {
        const level = /^\S*\s*\[(ERROR|WARN)\]/.exec(text)?.[1];
        return el('div', { className: level ? `output-line is-${level.toLowerCase()}` : 'output-line', text });
    }

    function append(texts: readonly string[]): void {
        if (texts.length === 0) {
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const text of texts.slice(-MAX_OUTPUT_LINES)) {
            fragment.append(lineElement(text));
        }
        lines.append(fragment);
        while (lines.childElementCount > MAX_OUTPUT_LINES) {
            lines.firstElementChild?.remove();
        }
        empty.hidden = true;
        scrollToEnd();
    }

    function scrollToEnd(): void {
        if (!scrollLock && host.isShowing('output')) {
            lines.scrollTop = lines.scrollHeight;
        }
    }

    function load(): void {
        const current = ++generation;
        loading = [];
        lines.replaceChildren();
        empty.hidden = false;
        api.lines(channel).then((snapshot) => {
            if (current !== generation) {
                return;
            }
            const late = loading ?? [];
            loading = null;
            append([...snapshot, ...late]);
        }, (error: unknown) => {
            loading = null;
            hooks.onError(`Could not read the output: ${String(error)}`);
        });
    }

    function setChannel(id: OutputChannelId): void {
        if (id !== channel) {
            channel = id;
            select.value = id;
            load();
        }
    }

    api.onAppended((event) => {
        if (event.channel !== channel) {
            return;
        }
        if (event.cleared) {
            lines.replaceChildren();
            empty.hidden = false;
            if (loading) { loading = []; }
            return;
        }
        if (loading) {
            loading.push(...event.lines);
        } else {
            append(event.lines);
        }
    });

    select.addEventListener('change', () => setChannel(select.value as OutputChannelId));
    lockButton.addEventListener('click', () => {
        scrollLock = !scrollLock;
        const label = scrollLock ? 'Turn Auto Scrolling On' : 'Turn Auto Scrolling Off';
        lockButton.setAttribute('aria-pressed', String(scrollLock));
        lockButton.title = label;
        lockButton.setAttribute('aria-label', label);
        lockButton.replaceChildren(icon(scrollLock ? ICONS.lock : ICONS.unlock));
        scrollToEnd();
    });
    copyButton.addEventListener('click', () => {
        const selection = window.getSelection();
        const selected = selection && !selection.isCollapsed && lines.contains(selection.anchorNode) ? selection.toString() : '';
        copyText(selected || [...lines.children].map((line) => line.textContent ?? '').join('\n'));
    });
    clearButton.addEventListener('click', () => {
        api.clear(channel).catch((error: unknown) => hooks.onError(`Could not clear the output: ${String(error)}`));
    });
    load();

    return {
        show(id?: OutputChannelId): void {
            if (id) {
                setChannel(id);
            }
            host.show('output');
        },
        get channel() { return channel; },
    };
}
