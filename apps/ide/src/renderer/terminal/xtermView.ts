import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { copyText } from '../dom.ts';
import { FIND_HIGHLIGHT_LIMIT, type TerminalFindOptions } from './terminalFind.ts';
import { findFileLinks, readLogicalLine, type TerminalLinkContext } from './terminalLinks.ts';

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
    /** #18: the terminal.integrated.fontSize setting. */
    setFontSize(size: number): void;
    /** The selected text, or '' (#286: the find widget starts from it). */
    selection(): string;
    /**
     * #286: finds `term` in the scrollback and selects the next (or previous)
     * match; `incremental` keeps the current match while it still matches
     * (typing). Results arrive through `onFindResults`.
     */
    find(term: string, options: TerminalFindOptions, direction: 'next' | 'previous', incremental?: boolean): void;
    /** #286: removes the matches' highlights. */
    clearFind(): void;
    dispose(): void;
}

/** #286: what links in the terminal open, and how a file link is checked. */
export interface XtermLinkHooks {
    /** The open folder and the OS, or null without a folder (no file links then). */
    context(): TerminalLinkContext | null;
    /** The file's own workspace path when it exists in the folder, else null. */
    resolveFile(path: string): Promise<string | null>;
    openFile(path: string, line?: number, column?: number): void;
    /** An http(s) URL; the main process checks the scheme again. */
    openUrl(url: string): void;
}

export interface XtermOptions {
    readonly platform: string;
    readonly fontSize?: number;
    onInput(data: string): void;
    /** #286: the find widget's "n of m"; `index` is -1 when no match is selected. */
    onFindResults?(index: number, count: number): void;
    readonly links?: XtermLinkHooks;
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

/** The match highlights: required by the search addon for its result count. */
function findDecorations(): NonNullable<ISearchOptions['decorations']> {
    const light = window.matchMedia('(prefers-color-scheme: light)').matches;
    const accent = token('--accent', '#2fb0ff');
    return {
        matchBackground: light ? '#f2dc9a' : '#5a4a1f',
        matchOverviewRuler: light ? '#c9a227' : '#a0862f',
        activeMatchBackground: light ? '#f0a83c' : '#9a5d12',
        activeMatchBorder: accent,
        activeMatchColorOverviewRuler: accent,
    };
}

/** The key that turns a click into "follow the link": Cmd on macOS, Ctrl elsewhere (as in VS Code). */
function isFollowClick(event: MouseEvent, isMac: boolean): boolean {
    return isMac ? event.metaKey : event.ctrlKey;
}

export function createXtermView(container: HTMLElement, options: XtermOptions): XtermView {
    const isMac = options.platform === 'darwin';
    const isWindows = options.platform === 'win32';
    const term = new Terminal({
        theme: theme(),
        fontFamily: "Consolas, 'Cascadia Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
        fontSize: options.fontSize ?? 13,
        cursorBlink: true,
        scrollback: 5000,
        // #286: the search addon counts matches through decorations, a "proposed" (not yet
        // stable) xterm.js API. It is an API-stability switch, not a permission.
        allowProposedApi: true,
        macOptionIsMeta: false,
        // Windows: ConPTY reflows the buffer itself.
        ...(isWindows ? { windowsPty: { backend: 'conpty' as const } } : {}),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    const searchAddon = new SearchAddon({ highlightLimit: FIND_HIGHLIGHT_LIMIT });
    term.loadAddon(searchAddon);
    searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => options.onFindResults?.(resultIndex, resultCount));
    term.open(container);

    // #286: links. Ctrl+click (Cmd+click on macOS) follows one; a plain click
    // stays a click, so selecting text over a path does not open it.
    const followHint = `Follow link (${isMac ? 'Cmd' : 'Ctrl'}+click)`;
    const hover = (): void => { container.title = followHint; };
    const leave = (): void => { container.removeAttribute('title'); };
    const links = options.links;
    if (links) {
        // http(s) only (the addon's own pattern), never window.open: the main process opens it.
        term.loadAddon(new WebLinksAddon((event, uri) => {
            if (isFollowClick(event, isMac)) {
                links.openUrl(uri);
            }
        }, { hover, leave }));
        term.registerLinkProvider({
            provideLinks(bufferLineNumber, callback) {
                const context = links.context();
                if (!context) {
                    callback(undefined);
                    return;
                }
                const line = readLogicalLine(term.buffer.active, bufferLineNumber - 1);
                const found = findFileLinks(line.text, context);
                if (found.length === 0) {
                    callback(undefined);
                    return;
                }
                void Promise.all(found.map(async (link) => ({ link, path: await links.resolveFile(link.path).catch(() => null) }))).then((resolved) => {
                    const result = resolved.flatMap(({ link, path }) => {
                        const first = line.cells[link.start];
                        const last = line.cells[link.end - 1];
                        if (path === null || !first || !last) {
                            return [];
                        }
                        return [{
                            range: { start: { x: first.x + 1, y: first.y + 1 }, end: { x: last.x + 1, y: last.y + 1 } },
                            text: link.text,
                            activate: (event: MouseEvent) => {
                                if (isFollowClick(event, isMac)) {
                                    links.openFile(path, link.line, link.column);
                                }
                            },
                            hover,
                            leave,
                        }];
                    });
                    callback(result.length > 0 ? result : undefined);
                });
            },
        });
    }

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
    let disposed = false;

    return {
        get cols() { return term.cols; },
        setFontSize(size: number): void {
            term.options.fontSize = size;
        },
        get rows() { return term.rows; },
        selection: () => term.getSelection(),
        find(text, findOptions, direction, incremental = false): void {
            if (disposed) {
                return;
            }
            const searchOptions: ISearchOptions = { caseSensitive: findOptions.caseSensitive, incremental, decorations: findDecorations() };
            if (direction === 'next') {
                searchAddon.findNext(text, searchOptions);
            } else {
                searchAddon.findPrevious(text, searchOptions);
            }
        },
        clearFind(): void {
            if (disposed) {
                return;
            }
            searchAddon.clearDecorations();
            options.onFindResults?.(-1, 0);
        },
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
            disposed = true;
            scheme.removeEventListener('change', onScheme);
            term.dispose();
        },
    };
}
