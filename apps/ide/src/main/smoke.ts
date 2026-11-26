import type { BrowserWindow } from 'electron';
import { APP_ORIGIN, originOf } from './security.ts';
import { IPC_EVENTS } from '../shared/api.ts';

/**
 * `--codexr-smoke`: start the IDE hidden, probe the security baseline from
 * inside the real renderer, print one result line and exit. Run by
 * `npm run ide:smoke` and by CI on Windows, macOS and Linux, so "it opens a
 * window on all three" is checked rather than claimed.
 */
export const SMOKE_FLAG = '--codexr-smoke';
export const SMOKE_RESULT_PREFIX = 'CODEXR_SMOKE_RESULT ';

export interface SmokeProbe {
    readonly title: string;
    readonly apiType: string;
    readonly apiFrozen: boolean;
    readonly apiKeys: readonly string[];
    readonly requireType: string;
    readonly processType: string;
    readonly evalBlocked: boolean;
    readonly windowOpenBlocked: boolean;
    readonly welcomeRendered: boolean;
    readonly infoName: string | null;
    readonly infoError: string | null;
    /** #14: names in the explorer's first level for the folder opened with --folder=. */
    readonly explorerItems: readonly string[];
    readonly readFileKind: string | null;
    readonly traversalRefused: boolean;
    /** #14: package.json opened from the explorer in a Monaco tab, with no CSP violation on the way. */
    readonly editorOpened: boolean;
    /** #138: file icons in the explorer and the tabs, and those that failed to load from the app. */
    readonly fileIconsShown: number;
    readonly fileIconsBroken: readonly string[];
    /** #18: F1 from the editor opened the palette with the commands, ":3" offered line 3, Escape gave the focus back. */
    readonly palette: { readonly opened: boolean; readonly hasSave: boolean; readonly lineOffered: boolean; readonly focusReturned: boolean };
    /** #164: quick open found src/main/index.ts by a fuzzy name, listed by the main process. */
    readonly quickOpenFound: boolean;
    /** #165: Ctrl/Cmd+Shift+F opened the Search view and "renderWorkbench" found src/renderer/workbench.ts. */
    readonly searchFound: boolean;
    /** #166: the status bar shows the cursor position and the language of the open file. */
    readonly editorStatus: string;
    readonly cspViolations: readonly string[];
}

/**
 * #137: the terminal panel opened by the View menu's command (Ctrl+`), with the
 * default profile, `echo codexr-smoke` typed into xterm.js, and its output
 * read back from what xterm drew.
 */
export interface TerminalProbe {
    readonly opened: boolean;
    /** The tab's label: the default profile's name. */
    readonly profile: string | null;
    /** A drawn line that is exactly `codexr-smoke`: the command's output, not its echo. */
    readonly echoed: boolean;
    /** The last lines drawn, for the failure message. */
    readonly screen: readonly string[];
    readonly status: string;
    readonly cspViolations: readonly string[];
}

export interface SmokeResult {
    readonly ok: boolean;
    readonly failures: readonly string[];
    readonly probe: SmokeProbe | null;
    readonly terminal: TerminalProbe | null;
    readonly navigationBlocked: boolean;
    readonly platform: string;
}

// Runs in the renderer's main world. Plain JS on purpose: it is sent as a string.
const RENDERER_PROBE = `(async () => {
    const until = Date.now() + 10000;
    while (!document.querySelector('[data-testid="welcome"][data-ready="true"]') && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 50));
    }
    // The shell before any file opens (opening one changes the title and replaces the welcome view).
    const title = document.title;
    const welcomeRendered = !!document.querySelector('[data-testid="welcome"][data-ready="true"]');
    let evalBlocked = false;
    try { eval('1'); } catch { evalBlocked = true; }
    // Violation events are queued: let the eval check's own report go by first,
    // so from here on any violation is the app's.
    await new Promise((r) => setTimeout(r, 200));
    const cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => cspViolations.push(e.violatedDirective + ' ' + (e.blockedURI || 'inline') + ' at ' + (e.sourceFile || '?') + ':' + e.lineNumber));
    let infoName = null, infoError = null;
    try { infoName = (await window.codexr.app.getInfo()).name; } catch (e) { infoError = String(e); }
    const treeUntil = Date.now() + 10000;
    while (!document.querySelector('[data-testid="explorer-tree"] [role="treeitem"]') && Date.now() < treeUntil) {
        await new Promise((r) => setTimeout(r, 50));
    }
    const explorerItems = [...document.querySelectorAll('[data-testid="explorer-tree"] > li > [role="treeitem"]')].map((row) => row.textContent);
    let readFileKind = null;
    try { readFileKind = (await window.codexr.workspace.readFile('package.json')).kind; } catch { readFileKind = null; }
    let traversalRefused = false;
    try { await window.codexr.workspace.readFile('../package.json'); } catch { traversalRefused = true; }
    document.querySelector('[data-testid="explorer-tree"] [data-path="package.json"]')?.click();
    const editorUntil = Date.now() + 15000;
    const editorReady = () => document.querySelector('.editor-tab[data-path="package.json"][aria-selected="true"]') && document.querySelector('.monaco-editor .view-line');
    while (!editorReady() && Date.now() < editorUntil) {
        await new Promise((r) => setTimeout(r, 50));
    }
    const editorOpened = !!editorReady();
    // Each icon is a CSS background: load every distinct image they resolve to.
    const iconSpans = [...document.querySelectorAll('[data-testid="explorer-tree"] .file-icon, .editor-tab .file-icon')];
    const fileIconsShown = iconSpans.length;
    const fileIconsBroken = [];
    for (const css of new Set(iconSpans.map((span) => getComputedStyle(span).backgroundImage))) {
        const url = css.startsWith('url("') ? css.slice(5, -2) : '';
        const loaded = url && await new Promise((r) => { const img = new Image(); img.onload = () => r(img.naturalWidth > 0); img.onerror = () => r(false); img.src = url; });
        if (!loaded) { fileIconsBroken.push(css); }
    }
    // #165: the Search view, opened by its key (the workbench's handler) and run with Enter.
    let searchFound = false;
    const isMacProbe = navigator.userAgent.includes('Macintosh');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', code: 'KeyF', shiftKey: true, ctrlKey: !isMacProbe, metaKey: isMacProbe, bubbles: true, cancelable: true }));
    const searchField = document.querySelector('[data-testid="search-query"]');
    if (searchField && !document.querySelector('[data-testid="search-view"]')?.hidden) {
        searchField.value = 'renderWorkbench';
        searchField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        const searchUntil = Date.now() + 15000;
        const hit = () => !!document.querySelector('[data-testid="search-results"] [data-path="src/renderer/workbench.ts"]');
        while (!hit() && Date.now() < searchUntil) {
            await new Promise((r) => setTimeout(r, 50));
        }
        searchFound = hit();
    }
    document.querySelector('[data-testid="explorer-tree"] [data-path="package.json"]')?.click();
    await new Promise((r) => setTimeout(r, 200));
    // #166: the active editor's items in the status bar (drawn on the next frame).
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));
    const editorStatus = document.querySelector('[data-testid="editor-status"]')?.hidden === false
        ? [...document.querySelectorAll('[data-testid="editor-status"] .status-item')].map((node) => node.textContent).join(' | ')
        : '';
    // #18: the command palette, opened with F1 from inside Monaco (the workbench's capture-phase key).
    const palette = { opened: false, hasSave: false, lineOffered: false, focusReturned: false };
    let quickOpenFound = false;
    const focusedEditor = document.querySelector('.monaco-editor textarea');
    if (focusedEditor) {
        focusedEditor.focus();
        focusedEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', code: 'F1', bubbles: true, cancelable: true }));
        const layer = document.querySelector('[data-testid="quick-input"]')?.parentElement;
        const field = document.querySelector('[data-testid="quick-input-field"]');
        palette.opened = !!layer && !layer.hidden && document.activeElement === field;
        const labels = () => [...document.querySelectorAll('[data-testid="quick-input-list"] .quick-input-label')].map((node) => node.textContent);
        palette.hasSave = labels().includes('File: Save');
        if (field) {
            field.value = ':3';
            field.dispatchEvent(new Event('input'));
            palette.lineOffered = labels().includes('Go to line 3');
            field.value = 'mainindex';
            field.dispatchEvent(new Event('input'));
            const quickOpenUntil = Date.now() + 10000;
            const found = () => [...document.querySelectorAll('[data-testid="quick-input-list"] .quick-input-row')]
                .some((row) => row.getAttribute('data-id') === 'src/main/index.ts');
            while (!found() && Date.now() < quickOpenUntil) {
                await new Promise((r) => setTimeout(r, 50));
            }
            quickOpenFound = found();
            field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        }
        palette.focusReturned = !!layer && layer.hidden && !!document.activeElement?.closest('.monaco-editor');
    }
    await new Promise((r) => setTimeout(r, 500));
    return {
        title,
        apiType: typeof window.codexr,
        apiFrozen: Object.isFrozen(window.codexr) && Object.isFrozen(window.codexr.app) && Object.isFrozen(window.codexr.workspace) && Object.isFrozen(window.codexr.commands) && Object.isFrozen(window.codexr.terminal) && Object.isFrozen(window.codexr.agents),
        apiKeys: Object.keys(window.codexr || {}),
        requireType: typeof window.require,
        processType: typeof window.process,
        evalBlocked,
        windowOpenBlocked: window.open('https://example.com/') === null,
        welcomeRendered,
        infoName,
        infoError,
        explorerItems,
        readFileKind,
        traversalRefused,
        editorOpened,
        fileIconsShown,
        fileIconsBroken,
        palette,
        quickOpenFound,
        searchFound,
        editorStatus,
        cspViolations,
    };
})()`;

// Runs after the main process sent the `terminal.toggle` command. Typing goes
// through xterm's own input handler (an 'input' event on its textarea, as an
// IME or a paste would), so the bytes take the real path: xterm -> preload ->
// IPC -> pty -> shell -> IPC -> xterm.
const TERMINAL_PROBE = `(async () => {
    const cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => cspViolations.push(e.violatedDirective + ' ' + (e.blockedURI || 'inline') + ' at ' + (e.sourceFile || '?') + ':' + e.lineNumber));
    const wait = async (test, ms) => {
        const until = Date.now() + ms;
        while (!test() && Date.now() < until) { await new Promise((r) => setTimeout(r, 50)); }
        return test();
    };
    const lines = () => [...document.querySelectorAll('.terminal-host:not([hidden]) .xterm-rows > div')].map((row) => row.textContent.replace(/\\u00a0/g, ' ').trimEnd());
    const textarea = () => document.querySelector('.terminal-host:not([hidden]) .xterm-helper-textarea');
    const opened = !!(await wait(() => textarea() && document.querySelector('.terminal-tab[aria-selected="true"]'), 20000));
    const profile = document.querySelector('.terminal-tab[aria-selected="true"] .tab-label')?.textContent ?? null;
    let echoed = false;
    if (opened) {
        // Let the shell draw its prompt first (it may take a while on a cold Windows runner).
        await wait(() => lines().some((line) => line.trim() !== ''), 15000);
        const type = (data) => textarea().dispatchEvent(new InputEvent('input', { data, inputType: 'insertText', bubbles: true }));
        textarea().focus();
        type('echo codexr-smoke');
        type('\\r');
        echoed = await wait(() => lines().some((line) => line.trim() === 'codexr-smoke'), 20000);
    }
    const status = document.querySelector('.status-bar > span')?.textContent ?? '';
    return { opened, profile, echoed, screen: lines().filter((line) => line.trim() !== '').slice(-8), status, cspViolations };
})()`;

/** Pure: turns what was observed into a verdict. */
export function evaluateSmoke(probe: SmokeProbe | null, navigationBlocked: boolean, platform: string, terminal: TerminalProbe | null = null): SmokeResult {
    const failures: string[] = [];
    if (!probe) {
        failures.push('renderer probe did not run');
    } else {
        if (probe.title !== 'Code-XR') { failures.push(`unexpected title "${probe.title}"`); }
        if (probe.apiType !== 'object') { failures.push('window.codexr is missing'); }
        if (!probe.apiFrozen) { failures.push('window.codexr is not frozen'); }
        if (probe.requireType !== 'undefined') { failures.push('require is reachable from the renderer'); }
        if (probe.processType !== 'undefined') { failures.push('process is reachable from the renderer'); }
        if (!probe.evalBlocked) { failures.push('eval is not blocked by the CSP'); }
        if (!probe.windowOpenBlocked) { failures.push('window.open is not blocked'); }
        if (!probe.welcomeRendered) { failures.push('the welcome view did not render'); }
        if (probe.infoName !== 'Code-XR IDE') { failures.push(`IPC app.getInfo failed: ${probe.infoError ?? probe.infoName}`); }
        if (!probe.explorerItems.includes('src') || !probe.explorerItems.includes('package.json')) {
            failures.push(`the explorer did not list the smoke folder (got ${JSON.stringify(probe.explorerItems)})`);
        }
        if (probe.readFileKind !== 'text') { failures.push(`workspace.readFile failed (got ${String(probe.readFileKind)})`); }
        if (!probe.traversalRefused) { failures.push('workspace.readFile followed a path out of the folder'); }
        if (!probe.editorOpened) { failures.push('package.json did not open in a Monaco editor tab'); }
        if (probe.fileIconsShown === 0) { failures.push('the explorer and the tabs showed no file icon'); }
        if (probe.fileIconsBroken.length > 0) { failures.push(`file icons did not load: ${probe.fileIconsBroken.join(', ')}`); }
        if (!probe.palette.opened || !probe.palette.hasSave) { failures.push(`F1 did not open the command palette with the commands (${JSON.stringify(probe.palette)})`); }
        if (!probe.palette.lineOffered || !probe.palette.focusReturned) { failures.push(`go to line or closing the palette failed (${JSON.stringify(probe.palette)})`); }
        if (!probe.searchFound) { failures.push('the Search view did not find renderWorkbench in src/renderer/workbench.ts'); }
        if (!probe.quickOpenFound) { failures.push('quick open did not find src/main/index.ts'); }
        if (!/^Ln \d+, Col \d+ \| .+ \| UTF-8 \| (LF|CRLF) \| JSON$/.test(probe.editorStatus)) { failures.push(`the status bar did not show the editor's position and language (got "${probe.editorStatus}")`); }
        if (probe.cspViolations.length > 0) { failures.push(`CSP violations: ${probe.cspViolations.join(', ')}`); }
    }
    if (!terminal) {
        failures.push('terminal probe did not run');
    } else {
        if (!terminal.opened) {
            failures.push(`the terminal panel did not open a terminal (status: "${terminal.status}")`);
        } else if (!terminal.echoed) {
            failures.push(`the terminal (${terminal.profile ?? '?'}) did not print the output of echo: ${JSON.stringify(terminal.screen)}`);
        }
        if (terminal.cspViolations.length > 0) { failures.push(`CSP violations in the terminal: ${terminal.cspViolations.join(', ')}`); }
    }
    if (!navigationBlocked) { failures.push('navigation to an external URL was not blocked'); }
    return { ok: failures.length === 0, failures, probe, terminal, navigationBlocked, platform };
}

export async function runSmoke(win: BrowserWindow, expectedOrigins: ReadonlySet<string>): Promise<SmokeResult> {
    const contents = win.webContents;
    let probe: SmokeProbe | null = null;
    try {
        probe = (await contents.executeJavaScript(RENDERER_PROBE)) as SmokeProbe;
    } catch {
        probe = null;
    }

    // #137: open the terminal the way View > Terminal (Ctrl+`) does.
    let terminal: TerminalProbe | null = null;
    try {
        contents.send(IPC_EVENTS.command, 'terminal.toggle');
        terminal = (await contents.executeJavaScript(TERMINAL_PROBE)) as TerminalProbe;
    } catch (error) {
        process.stderr.write(`[smoke] terminal probe threw: ${String(error)}\n`);
        terminal = null;
    }

    // Try to leave the app from inside the page, then check where it is.
    await contents.executeJavaScript(`location.href = 'https://example.com/'; true`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const origin = originOf(contents.getURL());
    const navigationBlocked = origin !== null && (expectedOrigins.has(origin) || origin === APP_ORIGIN);

    return evaluateSmoke(probe, navigationBlocked, process.platform, terminal);
}
