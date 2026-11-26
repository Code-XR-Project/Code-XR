import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * One xterm.js terminal (#137), loaded with the panel in its own chunk. It
 * only draws and reads keys: the shell runs in the main process, and
 * everything typed goes out through `onInput`.
 *
 * xterm.js 6 draws with DOM elements and inline styles, so it needs nothing
 * from the Content-Security-Policy beyond the `style-src 'unsafe-inline'`
 * Monaco already needs: no canvas worker, no eval, no network.
 */
export interface XtermView {
    readonly cols: number;
    readonly rows: number;
    /** Fits the terminal to its container; true when the size changed. */
    fit(): boolean;
    write(data: string): void;
    focus(): void;
    dispose(): void;
}

export interface XtermOptions {
    readonly platform: string;
    onInput(data: string): void;
}

function token(name: string, fallback: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Colours from the workbench tokens, so the terminal follows the light and dark themes. */
function theme(): ITheme {
    const light = window.matchMedia('(prefers-color-scheme: light)').matches;
    return {
        background: token('--editor', light ? '#ffffff' : '#0e1319'),
        foreground: token('--fg', light ? '#1c2632' : '#d5dce5'),
        cursor: token('--accent', '#2fb0ff'),
        cursorAccent: token('--editor', '#0e1319'),
        selectionBackground: light ? '#b5d5f5' : '#264f78',
        // The light background needs darker ANSI colours than xterm's defaults to stay readable.
        ...(light
            ? { black: '#1c2632', yellow: '#946300', brightYellow: '#7a5200', white: '#596677', brightWhite: '#1c2632' }
            : {}),
    };
}

/**
 * Copies through a throwaway textarea and `execCommand('copy')`: it runs in
 * the key handler (a user gesture), so it needs no clipboard permission, and
 * the IDE grants none.
 */
function copyText(text: string): void {
    const active = document.activeElement as HTMLElement | null;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    active?.focus();
}

export function createXtermView(container: HTMLElement, options: XtermOptions): XtermView {
    const isMac = options.platform === 'darwin';
    const isWindows = options.platform === 'win32';
    const term = new Terminal({
        theme: theme(),
        fontFamily: "Consolas, 'Cascadia Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
        fontSize: 13,
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: false,
        macOptionIsMeta: false,
        // Windows: ConPTY reflows the buffer itself.
        ...(isWindows ? { windowsPty: { backend: 'conpty' as const } } : {}),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    // Keys the terminal must not swallow. Returning false makes xterm leave
    // the event alone (no preventDefault), so the browser's default or the
    // application menu's accelerator still gets it.
    term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') {
            return true;
        }
        const ctrlOnly = event.ctrlKey && !event.altKey && !event.metaKey;
        // Ctrl+` and Ctrl+Shift+`: the View menu's toggle and New Terminal.
        if (ctrlOnly && event.code === 'Backquote') {
            return false;
        }
        if (isMac) {
            // Cmd+C / Cmd+V go through the Edit menu (copy and paste events xterm handles).
            return true;
        }
        if (ctrlOnly && event.shiftKey && event.code === 'KeyC') {
            if (term.hasSelection()) {
                copyText(term.getSelection());
            }
            return false;
        }
        if (ctrlOnly && event.shiftKey && event.code === 'KeyV') {
            return false; // The browser pastes into xterm's textarea.
        }
        // Windows, like its own terminals: Ctrl+C copies when text is selected
        // (and interrupts otherwise), Ctrl+V pastes.
        if (isWindows && ctrlOnly && !event.shiftKey && event.code === 'KeyC' && term.hasSelection()) {
            copyText(term.getSelection());
            term.clearSelection();
            return false;
        }
        if (isWindows && ctrlOnly && !event.shiftKey && event.code === 'KeyV') {
            return false;
        }
        return true;
    });
    term.onData((data) => options.onInput(data));

    const scheme = window.matchMedia('(prefers-color-scheme: light)');
    const onScheme = (): void => { term.options.theme = theme(); };
    scheme.addEventListener('change', onScheme);

    return {
        get cols() { return term.cols; },
        get rows() { return term.rows; },
        fit(): boolean {
            if (container.clientWidth === 0 || container.clientHeight === 0) {
                return false;
            }
            const before = `${term.cols}x${term.rows}`;
            fitAddon.fit();
            return `${term.cols}x${term.rows}` !== before;
        },
        write: (data) => term.write(data),
        focus: () => term.focus(),
        dispose(): void {
            scheme.removeEventListener('change', onScheme);
            term.dispose();
        },
    };
}
