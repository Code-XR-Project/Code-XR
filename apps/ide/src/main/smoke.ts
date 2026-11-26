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
    /** #169: Ctrl/Cmd+K Z toggled zen mode, the side-bar sash resized it from the keyboard and the size was saved, the active activity item hid the side bar. */
    readonly layout: { readonly zen: boolean; readonly resized: boolean; readonly saved: boolean; readonly sideBarToggled: boolean };
    /** #167: a click opened a preview that the next click replaced, a double click kept it, Ctrl+PageDown cycled, the session was saved, the tab menu closed all. */
    readonly tabs: { readonly previewReplaced: boolean; readonly kept: boolean; readonly cycled: boolean; readonly sessionSaved: boolean; readonly closedAll: boolean };
    /** #18: the Settings view changed the editor font size (stored by the main process, applied to Monaco), and its reset undid it. */
    readonly settings: { readonly listed: boolean; readonly applied: boolean; readonly reset: boolean };
    readonly theme: { readonly previewed: boolean; readonly reverted: boolean; readonly stored: boolean };
    readonly keybindings: { readonly opened: boolean; readonly recorded: boolean; readonly works: boolean; readonly reset: boolean };
    /** #174: Ctrl/Cmd+Shift+U showed the Output view with the IDE's own log lines, the channel picker switched channel, the close button hid the panel. */
    readonly output: { readonly shown: boolean; readonly hasLines: boolean; readonly switched: boolean; readonly closed: boolean };
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
    // #169: the layout. Zen mode by its chord (the first stroke goes on to Monaco, which keeps its own chords).
    const layout = { zen: false, resized: false, saved: false, sideBarToggled: false };
    const shell = document.querySelector('.workbench');
    const chordKey = (key, code, mod) => window.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey: mod && !isMacProbe, metaKey: mod && isMacProbe, bubbles: true, cancelable: true }));
    chordKey('k', 'KeyK', true);
    chordKey('z', 'KeyZ', false);
    const zenOn = !!shell?.classList.contains('zen');
    chordKey('k', 'KeyK', true);
    chordKey('z', 'KeyZ', false);
    layout.zen = zenOn && !shell?.classList.contains('zen');
    const sideBar = document.querySelector('[data-testid="side-bar"]');
    const sash = document.querySelector('[data-testid="sash-side"]');
    if (sideBar && sash) {
        const before = sideBar.getBoundingClientRect().width;
        sash.focus();
        sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        const after = sideBar.getBoundingClientRect().width;
        layout.resized = after > before;
        try {
            layout.saved = JSON.parse(localStorage.getItem('codexr.layout') ?? '{}').sideBarWidth === Math.round(after);
        } catch { layout.saved = false; }
        sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const active = document.querySelector('.activity-item.is-active');
        active?.click();
        const hidden = sideBar.getBoundingClientRect().width === 0;
        active?.click();
        layout.sideBarToggled = hidden && sideBar.getBoundingClientRect().width > 0;
    }
    // #167: preview tabs, cycling, the saved session and the tab menu.
    const tabsProbe = { previewReplaced: false, kept: false, cycled: false, sessionSaved: false, closedAll: false };
    const tabPaths = () => [...document.querySelectorAll('[data-testid="editor-tabs"] .editor-tab')].map((tab) => tab.getAttribute('data-path'));
    const waitFor = async (check, ms = 5000) => {
        const until = Date.now() + ms;
        while (!check() && Date.now() < until) { await new Promise((r) => setTimeout(r, 50)); }
        return check();
    };
    const explorerRow = (path) => document.querySelector('[data-testid="explorer-tree"] [data-path="' + path + '"]');
    const tabOf = (path) => document.querySelector('[data-testid="editor-tabs"] .editor-tab[data-path="' + path + '"]');
    if (explorerRow('README.md') && explorerRow('tsconfig.json')) {
        const keptBefore = tabPaths().filter((path) => !tabOf(path)?.classList.contains('is-preview'));
        explorerRow('README.md').click();
        await waitFor(() => tabOf('README.md'));
        explorerRow('tsconfig.json').click();
        await waitFor(() => tabOf('tsconfig.json'));
        tabsProbe.previewReplaced = !tabOf('README.md') && !!tabOf('tsconfig.json')?.classList.contains('is-preview')
            && keptBefore.every((path) => tabOf(path));
        tabOf('tsconfig.json')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        tabsProbe.kept = !tabOf('tsconfig.json')?.classList.contains('is-preview');
        explorerRow('README.md').click();
        await waitFor(() => tabOf('README.md')?.getAttribute('aria-selected') === 'true');
        const order = tabPaths();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', code: 'PageDown', ctrlKey: true, bubbles: true, cancelable: true }));
        const activeAfter = document.querySelector('[data-testid="editor-tabs"] .editor-tab[aria-selected="true"]')?.getAttribute('data-path');
        tabsProbe.cycled = activeAfter === order[(order.indexOf('README.md') + 1) % order.length];
        await new Promise((r) => setTimeout(r, 450));
        const sessionEntry = Object.keys(localStorage).find((key) => key.startsWith('codexr.tabs:'));
        try {
            const saved = JSON.parse(localStorage.getItem(sessionEntry ?? '') ?? '{}');
            tabsProbe.sessionSaved = Array.isArray(saved.tabs) && saved.tabs.some((tab) => tab.path === 'tsconfig.json') && saved.preview === 'README.md';
        } catch { tabsProbe.sessionSaved = false; }
        const confirmBefore = window.confirm;
        window.confirm = () => true;
        tabOf('README.md')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 40 }));
        document.querySelector('[data-testid="tab-menu-close-all"]')?.click();
        window.confirm = confirmBefore;
        tabsProbe.closedAll = tabPaths().length === 0 && !document.querySelector('[data-testid="context-menu"]');
    }
    // #18: the Settings view. The smoke run keeps the user's settings in memory.
    const settingsProbe = { listed: false, applied: false, reset: false };
    document.querySelector('.activity-item[data-view="settings"]')?.click();
    const fontInput = document.querySelector('[data-testid="settings-view"] input[data-key="editor.fontSize"]');
    settingsProbe.listed = !!fontInput && document.querySelectorAll('[data-testid="settings-row"]').length > 5;
    explorerRow('package.json')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => tabOf('package.json'));
    const editorFont = () => parseFloat(getComputedStyle(document.querySelector('.monaco-editor .view-lines') ?? document.body).fontSize);
    if (fontInput) {
        fontInput.value = '21';
        fontInput.dispatchEvent(new Event('change', { bubbles: true }));
        settingsProbe.applied = await waitFor(() => editorFont() === 21);
        const reset = document.querySelector('[data-testid="settings-row"][data-key="editor.fontSize"] .settings-reset');
        reset?.click();
        settingsProbe.reset = await waitFor(() => editorFont() === 13);
    }
    // #18, part 3: Keyboard Shortcuts. Opened by its chord, Zen Mode gets F9, F9 runs it, reset restores the chord.
    const keybindingsProbe = { opened: false, recorded: false, works: false, reset: false };
    const isMac = navigator.userAgent.includes('Macintosh');
    const press = (target, code, keyName, mods) => target.dispatchEvent(new KeyboardEvent('keydown', { code, key: keyName, bubbles: true, cancelable: true, ...(mods || {}) }));
    press(document.body, 'KeyK', 'k', isMac ? { metaKey: true } : { ctrlKey: true });
    press(document.body, 'KeyS', 's');
    keybindingsProbe.opened = await waitFor(() => {
        const view = document.querySelector('[data-testid="keybindings-view"]');
        return view && !view.hidden && view.querySelectorAll('[data-testid="keybinding-row"]').length > 20;
    });
    const zenRow = () => document.querySelector('[data-testid="keybinding-row"][data-command="view.toggleZenMode"]');
    zenRow()?.querySelector('[data-testid="keybinding-change"]')?.click();
    const recorder = await waitFor(() => document.querySelector('[data-testid="keybinding-recorder"]'));
    if (recorder) {
        press(recorder, 'F9', 'F9');
        press(recorder, 'Enter', 'Enter');
        keybindingsProbe.recorded = await waitFor(() => (zenRow()?.querySelector('[data-testid="keybinding-keys"]')?.textContent ?? '') === 'F9' && zenRow()?.classList.contains('is-modified'));
        const isZen = () => !!document.querySelector('.workbench.zen');
        const before = isZen();
        press(document.body, 'F9', 'F9');
        const toggled = await waitFor(() => isZen() !== before);
        press(document.body, 'F9', 'F9');
        keybindingsProbe.works = toggled && await waitFor(() => isZen() === before);
        zenRow()?.querySelector('[data-testid="keybinding-reset"]')?.click();
        keybindingsProbe.reset = await waitFor(() => !zenRow()?.classList.contains('is-modified') && (zenRow()?.querySelector('[data-testid="keybinding-keys"]')?.textContent ?? '').includes('K Z'));
    }
    // #171: the theme picker previews Dark then Light, Escape reverts, Enter on Light stores it and Monaco follows.
    const themeProbe = { previewed: false, reverted: false, stored: false };
    const isLight = () => window.matchMedia('(prefers-color-scheme: light)').matches;
    const systemLight = isLight();
    const field = () => document.querySelector('[data-testid="quick-input-field"]');
    const openThemes = async () => {
        press(document.body, 'KeyK', 'k', isMac ? { metaKey: true } : { ctrlKey: true });
        press(document.body, 'KeyT', 't', isMac ? { metaKey: true } : { ctrlKey: true });
        return waitFor(() => document.querySelector('[data-testid="quick-input-list"] [data-id="light"]'));
    };
    if (await openThemes()) {
        press(field(), 'ArrowDown', 'ArrowDown');
        const darkShown = await waitFor(() => !isLight());
        press(field(), 'ArrowDown', 'ArrowDown');
        themeProbe.previewed = darkShown && await waitFor(() => isLight());
        press(field(), 'Escape', 'Escape');
        themeProbe.reverted = await waitFor(() => isLight() === systemLight);
    }
    if (await openThemes()) {
        press(field(), 'ArrowDown', 'ArrowDown');
        press(field(), 'ArrowDown', 'ArrowDown');
        press(field(), 'Enter', 'Enter');
        const monacoLight = () => { const editor = document.querySelector('.monaco-editor'); return !!editor && !editor.classList.contains('vs-dark'); };
        themeProbe.stored = await waitFor(() => isLight() && monacoLight())
            && (await window.codexr.settings.get()).user['workbench.colorTheme'] === 'light';
        await window.codexr.settings.update('user', 'workbench.colorTheme', null);
        await waitFor(() => isLight() === systemLight);
    }
    // #174: the Output view shows what the main process logged, per channel.
    const outputProbe = { shown: false, hasLines: false, switched: false, closed: false };
    press(document.body, 'KeyU', 'U', isMac ? { metaKey: true, shiftKey: true } : { ctrlKey: true, shiftKey: true });
    const outputLines = () => document.querySelector('[data-testid="output-lines"]');
    outputProbe.shown = !!(await waitFor(() => !document.querySelector('[data-testid="terminal-panel"]').hidden && !document.querySelector('[data-testid="output-body"]').hidden));
    outputProbe.hasLines = !!(await waitFor(() => (outputLines()?.childElementCount ?? 0) > 0 && /\\[INFO\\]/.test(outputLines()?.textContent ?? '')));
    const channelPicker = document.querySelector('[data-testid="output-channel"]');
    if (channelPicker) {
        channelPicker.value = 'servers';
        channelPicker.dispatchEvent(new Event('change'));
        const serverLines = await window.codexr.output.lines('servers');
        outputProbe.switched = await waitFor(() => (outputLines()?.childElementCount ?? 0) === serverLines.length);
        channelPicker.value = 'ide';
        channelPicker.dispatchEvent(new Event('change'));
    }
    document.querySelector('[data-testid="terminal-close-panel"]')?.click();
    outputProbe.closed = await waitFor(() => document.querySelector('[data-testid="terminal-panel"]').hidden);
    document.querySelector('.activity-item[data-view="explorer"]')?.click();
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
        layout,
        tabs: tabsProbe,
        settings: settingsProbe,
        keybindings: keybindingsProbe,
        theme: themeProbe,
        output: outputProbe,
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
        if (!probe.layout.zen || !probe.layout.resized || !probe.layout.saved || !probe.layout.sideBarToggled) { failures.push(`the layout did not respond (${JSON.stringify(probe.layout)})`); }
        if (Object.values(probe.settings).some((ok) => !ok)) { failures.push(`the Settings view did not change the editor (${JSON.stringify(probe.settings)})`); }
        if (Object.values(probe.theme).some((ok) => !ok)) { failures.push(`the theme picker did not switch the theme (${JSON.stringify(probe.theme)})`); }
        if (Object.values(probe.keybindings).some((ok) => !ok)) { failures.push(`Keyboard Shortcuts did not rebind Zen Mode (${JSON.stringify(probe.keybindings)})`); }
        if (Object.values(probe.output).some((ok) => !ok)) { failures.push(`the Output panel did not show the logs (${JSON.stringify(probe.output)})`); }
        if (Object.values(probe.tabs).some((ok) => !ok)) { failures.push(`the editor tabs did not behave (${JSON.stringify(probe.tabs)})`); }
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
