/**
 * #180: the debugger in the window. It keeps the breakpoints (per folder, in
 * the renderer's storage), starts sessions through the main process, which
 * resolves and runs everything and refuses in Restricted Mode (#177), and
 * follows the session: the paused line in the editor, the Run and Debug
 * view, the floating toolbar, the Debug Console and the status bar colour.
 * A missing Python adapter (debugpy) is installed only when the person says
 * so in the notification that explains it.
 */
import type { CodeXRApi } from '../../shared/api.ts';
import {
    LAUNCH_PATH, RESTRICTED_DEBUG_MESSAGE,
    type DebugBreakpoint, type DebugEvent, type DebugSessionInfo, type DebugStackFrame, type DebugStartResult, type DebugStepKind, type LaunchConfiguration,
} from '../../shared/debug.ts';
import type { CommandDefinition, CommandRegistry } from '../commands/commandRegistry.ts';
import { el, icon } from '../dom.ts';
import type { DebugBreakpointMark, DebugDecorationsHooks } from '../editor/debugDecorations.ts';
import type { NotificationCenter } from '../notifications.ts';
import type { PanelHost } from '../panel/panelHost.ts';
import { createDebugConsole } from './debugConsole.ts';
import { createDebugView, CURRENT_FILE_CHOICE, DEBUG_ICONS, type WatchRow } from './debugView.ts';

export interface DebugControllerOptions {
    readonly api: CodeXRApi['debug'];
    readonly notifications: NotificationCenter;
    /** The Run and Debug pane of the side bar. */
    readonly view: HTMLElement;
    readonly panel: PanelHost;
    /** Where the floating toolbar is centred. */
    readonly editorArea: HTMLElement;
    readonly storage: () => Storage | null;
    activeFile(): string | null;
    /** The active editor's cursor line, or null. */
    activeLine(): number | null;
    saveAll(): Promise<void>;
    openFile(path: string): void;
    revealLine(path: string, line: number, column: number): void;
    /** The editors redraw a file's breakpoints (every file's when null). */
    breakpointsChanged(path: string | null): void;
    setExecutionPoint(point: { readonly path: string; readonly line: number; readonly top: boolean } | null): void;
    showView(): void;
    manageTrust(): void;
    hasFolder(): boolean;
    setStatus(message: string): void;
}

export interface DebugController {
    /** The hooks the editors draw breakpoints with. */
    readonly decorations: DebugDecorationsHooks;
    /** Another folder opened (or none): its breakpoints come back, the session ends. */
    setFolder(root: string | null): void;
    /** `.codexr/launch.json` may have changed. */
    reloadConfigurations(): void;
    start(): void;
    stop(): void;
    restart(): void;
    step(kind: DebugStepKind): void;
    toggleBreakpoint(): void;
    showConsole(): void;
    configure(): void;
    readonly active: boolean;
    readonly paused: boolean;
}

const STORAGE_PREFIX = 'codexr.debug:';
const WATCH_KEY = 'codexr.debug.watch';
const MAX_BREAKPOINT_FILES = 500;

export function createDebugController(options: DebugControllerOptions): DebugController {
    const { api, notifications } = options;
    let root: string | null = null;
    /** Breakpoint lines by workspace path. */
    let breakpoints = new Map<string, number[]>();
    /** What the running session said about them. */
    const placed = new Map<string, readonly DebugBreakpoint[]>();
    let configurations: readonly LaunchConfiguration[] = [];
    let selected = CURRENT_FILE_CHOICE;
    let session: DebugSessionInfo | null = null;
    let frames: DebugStackFrame[] = [];
    let frameId: number | null = null;
    let watches: string[] = loadWatches();
    let watchValues: WatchRow['value'][] = watches.map(() => null);
    let starting = false;
    let lastEnded: number | null = null;
    /** The person pressed Stop: the exit code the kill gives is not worth reporting. */
    let stopRequested = false;
    /** Bumped on each stop, so a slow answer about an older one is dropped. */
    let stopGeneration = 0;

    const view = createDebugView(options.view, {
        start: () => start(),
        configure: () => configure(),
        selectConfiguration: (name) => {
            selected = name;
            persistSelection();
        },
        variables: (reference) => api.variables(reference),
        selectFrame: (frame) => selectFrame(frame, true),
        addWatch: (expression) => {
            watches = [...watches, expression];
            watchValues = [...watchValues, null];
            saveWatches();
            void evaluateWatches();
        },
        removeWatch: (index) => {
            watches = watches.filter((_, at) => at !== index);
            watchValues = watchValues.filter((_, at) => at !== index);
            saveWatches();
            renderWatches();
        },
        openBreakpoint: (path, line) => options.revealLine(path, line, 1),
        removeBreakpoint: (path, line) => setLines(path, (breakpoints.get(path) ?? []).filter((existing) => existing !== line)),
        removeAllBreakpoints: () => {
            for (const path of [...breakpoints.keys()]) {
                setLines(path, []);
            }
        },
    });
    const debugConsole = createDebugConsole(options.panel, async (expression) => {
        try {
            const result = await api.evaluate(expression, frameId, 'repl');
            return { text: result.result, failed: false };
        } catch (error) {
            return { text: message(error), failed: true };
        }
    });

    // ---- the floating toolbar
    const toolbarButton = (label: string, path: string, testId: string, run: () => void): HTMLButtonElement => {
        const button = el('button', { className: 'icon-button', attrs: { type: 'button', title: label, 'aria-label': label.replace(/ \(.*\)$/, ''), 'data-testid': testId } }, [icon(path)]);
        button.addEventListener('click', run);
        return button;
    };
    const continueButton = toolbarButton('Continue (F5)', DEBUG_ICONS.continue, 'debug-continue', () => step('continue'));
    const pauseButton = toolbarButton('Pause (F6)', DEBUG_ICONS.pause, 'debug-pause', () => step('pause'));
    const stepButtons = [
        toolbarButton('Step Over (F10)', DEBUG_ICONS.stepOver, 'debug-step-over', () => step('next')),
        toolbarButton('Step Into (F11)', DEBUG_ICONS.stepInto, 'debug-step-into', () => step('stepIn')),
        toolbarButton('Step Out (Shift+F11)', DEBUG_ICONS.stepOut, 'debug-step-out', () => step('stepOut')),
    ];
    const toolbar = el('div', { className: 'debug-toolbar', attrs: { role: 'toolbar', 'aria-label': 'Debug', 'data-testid': 'debug-toolbar', hidden: '' } }, [
        continueButton,
        pauseButton,
        ...stepButtons,
        toolbarButton('Restart (Ctrl+Shift+F5)', DEBUG_ICONS.restart, 'debug-restart', () => restart()),
        toolbarButton('Stop (Shift+F5)', DEBUG_ICONS.stop, 'debug-stop', () => stop()),
    ]);
    document.body.append(toolbar);
    function placeToolbar(): void {
        const rect = options.editorArea.getBoundingClientRect();
        toolbar.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
        toolbar.style.top = `${Math.round(rect.top + 4)}px`;
    }
    new ResizeObserver(() => placeToolbar()).observe(options.editorArea);
    window.addEventListener('resize', placeToolbar);

    // ---- breakpoints
    const marks = (path: string): DebugBreakpointMark[] => {
        const answered = placed.get(path);
        return (breakpoints.get(path) ?? []).map((line) => {
            const found = answered?.find((breakpoint) => breakpoint.line === line);
            return { line, verified: found ? found.verified : null, message: found?.message ?? null };
        });
    };

    function setLines(path: string, lines: readonly number[], redraw = true): void {
        const clean = [...new Set(lines)].filter((line) => line > 0).sort((a, b) => a - b);
        if (clean.length === 0) {
            breakpoints.delete(path);
        } else if (breakpoints.size < MAX_BREAKPOINT_FILES || breakpoints.has(path)) {
            breakpoints.set(path, clean);
        }
        placed.delete(path);
        persistBreakpoints();
        void api.setBreakpoints(path, breakpoints.get(path) ?? []).catch(() => undefined);
        if (redraw) {
            options.breakpointsChanged(path);
        }
        renderBreakpoints();
    }

    function renderBreakpoints(): void {
        const list: DebugBreakpoint[] = [];
        for (const path of [...breakpoints.keys()].sort()) {
            for (const mark of marks(path)) {
                list.push({ path, line: mark.line, verified: mark.verified, message: mark.message });
            }
        }
        view.setBreakpoints(list);
    }

    function persistBreakpoints(): void {
        if (root === null) {
            return;
        }
        try {
            options.storage()?.setItem(`${STORAGE_PREFIX}${root}`, JSON.stringify({ breakpoints: Object.fromEntries(breakpoints), selected }));
        } catch {
            // Storage full or unavailable: the breakpoints still work for this session.
        }
    }
    const persistSelection = persistBreakpoints;

    function loadFolderState(folder: string): { breakpoints: Map<string, number[]>; selected: string } {
        try {
            const parsed: unknown = JSON.parse(options.storage()?.getItem(`${STORAGE_PREFIX}${folder}`) ?? 'null');
            if (typeof parsed !== 'object' || parsed === null) {
                return { breakpoints: new Map(), selected: CURRENT_FILE_CHOICE };
            }
            const record = parsed as { breakpoints?: unknown; selected?: unknown };
            const entries = typeof record.breakpoints === 'object' && record.breakpoints !== null ? Object.entries(record.breakpoints) : [];
            const map = new Map<string, number[]>();
            for (const [path, lines] of entries.slice(0, MAX_BREAKPOINT_FILES)) {
                if (Array.isArray(lines)) {
                    const clean = lines.filter((line): line is number => Number.isInteger(line) && line > 0);
                    if (clean.length > 0) {
                        map.set(path, clean);
                    }
                }
            }
            return { breakpoints: map, selected: typeof record.selected === 'string' ? record.selected : CURRENT_FILE_CHOICE };
        } catch {
            return { breakpoints: new Map(), selected: CURRENT_FILE_CHOICE };
        }
    }

    function loadWatches(): string[] {
        try {
            const parsed: unknown = JSON.parse(options.storage()?.getItem(WATCH_KEY) ?? '[]');
            return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, 100) : [];
        } catch {
            return [];
        }
    }

    function saveWatches(): void {
        try {
            options.storage()?.setItem(WATCH_KEY, JSON.stringify(watches));
        } catch {
            // Not kept; still shown.
        }
    }

    // ---- configurations
    function reloadConfigurations(): void {
        if (!options.hasFolder()) {
            configurations = [];
            view.setConfigurations([], CURRENT_FILE_CHOICE);
            refreshStatus();
            return;
        }
        api.configurations().then((list) => {
            configurations = list.configurations;
            view.setConfigurations(configurations, selected);
            for (const error of list.errors) {
                notifications.notify('warning', error);
            }
            refreshStatus(list.trusted);
        }, () => undefined);
    }

    function refreshStatus(trusted?: boolean): void {
        if (session && session.state !== 'ended') {
            const text = session.state === 'starting' ? `Starting "${session.name}"…`
                : session.state === 'running' ? `Running "${session.name}".`
                    : `Paused on ${describeReason(session.reason)}${session.description ? `: ${session.description}` : '.'}`;
            view.setStatus(text, session.state === 'stopped' && session.reason === 'exception' ? 'error' : 'muted');
            return;
        }
        if (!options.hasFolder()) {
            view.setStatus('Open a folder to debug its code.', 'muted');
        } else if (trusted === false) {
            view.setStatus(RESTRICTED_DEBUG_MESSAGE, 'warning');
        } else {
            view.setStatus(configurations.length === 0 ? `Press F5 to debug the active Python or JavaScript file, or add configurations to ${LAUNCH_PATH} (the gear).` : '', 'muted');
        }
    }

    function configure(): void {
        api.configure().then(options.openFile, (error: unknown) => notifications.notify('error', `Could not open ${LAUNCH_PATH}: ${message(error)}`));
    }

    // ---- sessions
    function start(): void {
        if (session && session.state === 'stopped') {
            step('continue');
            return;
        }
        if ((session && session.state !== 'ended') || starting) {
            return;
        }
        if (!options.hasFolder()) {
            options.setStatus('Open a folder to debug its code.');
            return;
        }
        starting = true;
        void options.saveAll().catch(() => undefined).then(() => api.start(selected || null, options.activeFile()))
            .then((result) => handleStart(result), (error: unknown) => startFailed(error))
            .finally(() => { starting = false; });
    }

    function handleStart(result: DebugStartResult): void {
        if (result.ok) {
            options.showView();
            return;
        }
        if (result.missing === 'debugpy') {
            notifications.notify('info', `${result.message} Install it into the IDE's Python environment? It is downloaded from PyPI.`, {
                timeoutMs: 0,
                actions: [{ label: 'Install debugpy', run: () => installDebugpy() }],
            });
            return;
        }
        notifications.notify('warning', result.message);
    }

    function installDebugpy(): void {
        options.setStatus('Installing debugpy…');
        api.installAdapter('debugpy').then((installed) => {
            if (installed) {
                options.setStatus('debugpy installed.');
                start();
            } else {
                notifications.notify('error', 'debugpy could not be installed. The Python environment\'s log (Output, "Python environment") says why.');
            }
        }, (error: unknown) => startFailed(error));
    }

    function startFailed(error: unknown): void {
        const text = message(error);
        if (text === RESTRICTED_DEBUG_MESSAGE) {
            notifications.notify('warning', text, { actions: [{ label: 'Manage Workspace Trust', run: () => options.manageTrust() }] });
        } else {
            notifications.notify('error', `Could not start debugging: ${text}`);
        }
    }

    function stop(): void {
        if (session && session.state !== 'ended') {
            stopRequested = true;
            void api.stop().catch(() => undefined);
        }
    }

    function restart(): void {
        if (!session) {
            start();
            return;
        }
        void api.restart().then(handleStart, (error: unknown) => startFailed(error));
    }

    function step(kind: DebugStepKind): void {
        if (!session || session.state === 'ended') {
            return;
        }
        if (kind === 'pause' ? session.state !== 'running' : session.state !== 'stopped') {
            return;
        }
        void api.step(kind, session.threadId).catch((error: unknown) => notifications.notify('warning', message(error)));
    }

    function onSession(next: DebugSessionInfo): void {
        const previous = session;
        const isNew = previous === null || previous.id !== next.id;
        if (isNew && next.state !== 'ended') {
            debugConsole.clear();
            debugConsole.append('console', `Debugging "${next.name}".\n`);
        }
        if (next.state === 'ended' && lastEnded === next.id) {
            return;
        }
        session = next;
        document.body.classList.toggle('is-debugging', next.state !== 'ended');
        toolbar.hidden = next.state === 'ended';
        if (!toolbar.hidden) {
            placeToolbar();
        }
        continueButton.hidden = next.state !== 'stopped';
        pauseButton.hidden = next.state === 'stopped';
        for (const button of stepButtons) {
            button.disabled = next.state !== 'stopped';
        }
        view.setRunning(next.state !== 'ended');
        debugConsole.setEnabled(next.state !== 'ended');
        if (next.state === 'stopped') {
            void loadStop();
        } else {
            stopGeneration += 1;
            frames = [];
            frameId = null;
            options.setExecutionPoint(null);
            view.setScopes(null);
            view.setFrames([], null, next.state === 'running' ? 'Running.' : null);
            watchValues = watches.map(() => null);
            renderWatches();
        }
        if (next.state === 'ended') {
            const code = next.exitCode === null || stopRequested ? '' : ` (exit code ${next.exitCode})`;
            stopRequested = false;
            debugConsole.append('console', `Session "${next.name}" ended${code}.\n`);
            placed.clear();
            options.breakpointsChanged(null);
            renderBreakpoints();
            session = null;
            lastEnded = next.id;
            options.setStatus(`Debugging "${next.name}" ended${code}.`);
        }
        refreshStatus();
    }

    async function loadStop(): Promise<void> {
        const generation = ++stopGeneration;
        const current = session;
        if (!current || current.threadId === null) {
            return;
        }
        let list: DebugStackFrame[];
        try {
            list = await api.stackTrace(current.threadId);
        } catch {
            list = [];
        }
        if (generation !== stopGeneration) {
            return;
        }
        frames = list;
        if (current.reason === 'exception' && current.description) {
            debugConsole.append('stderr', `Paused on exception: ${current.description}\n`);
        }
        const first = list.find((frame) => frame.path !== null) ?? list[0];
        if (first) {
            selectFrame(first, true);
        } else {
            view.setFrames([], null, 'Paused.');
        }
    }

    function selectFrame(frame: DebugStackFrame, reveal: boolean): void {
        frameId = frame.id;
        const top = frames[0]?.id === frame.id;
        view.setFrames(frames, frame.id, session ? `Paused on ${describeReason(session.reason)}` : null);
        if (frame.path !== null) {
            options.setExecutionPoint({ path: frame.path, line: frame.line, top });
            if (reveal) {
                options.revealLine(frame.path, frame.line, Math.max(1, frame.column));
            }
        } else {
            options.setExecutionPoint(null);
        }
        const generation = stopGeneration;
        api.scopes(frame.id).then((scopes) => {
            if (generation === stopGeneration && frameId === frame.id) {
                view.setScopes(scopes);
            }
        }, () => view.setScopes([]));
        void evaluateWatches();
    }

    async function evaluateWatches(): Promise<void> {
        if (!session || session.state !== 'stopped') {
            renderWatches();
            return;
        }
        const generation = stopGeneration;
        const results = await Promise.all(watches.map((expression) => api.evaluate(expression, frameId, 'watch').then(
            (result) => ({ text: result.result, failed: false, reference: result.variablesReference }),
            (error: unknown) => ({ text: message(error), failed: true, reference: 0 }),
        )));
        if (generation !== stopGeneration) {
            return;
        }
        watchValues = results;
        renderWatches();
    }

    function renderWatches(): void {
        view.setWatches(watches.map((expression, index) => ({ expression, value: watchValues[index] ?? null })));
    }

    api.onEvent((event: DebugEvent) => {
        if (event.kind === 'session') {
            onSession(event.session);
        } else if (event.kind === 'output') {
            debugConsole.append(event.category, event.text);
        } else if (event.kind === 'breakpoints') {
            placed.set(event.path, event.breakpoints);
            options.breakpointsChanged(event.path);
            renderBreakpoints();
        }
    });

    const decorations: DebugDecorationsHooks = {
        breakpoints: marks,
        toggle: (path, line) => {
            const lines = breakpoints.get(path) ?? [];
            setLines(path, lines.includes(line) ? lines.filter((existing) => existing !== line) : [...lines, line]);
        },
        moved: (path, lines) => setLines(path, lines, true),
    };

    renderWatches();
    refreshStatus();

    return {
        decorations,
        setFolder(folder: string | null): void {
            if (folder === root) {
                return;
            }
            stop();
            for (const path of breakpoints.keys()) {
                void api.setBreakpoints(path, []).catch(() => undefined);
            }
            root = folder;
            const state = folder === null ? { breakpoints: new Map<string, number[]>(), selected: CURRENT_FILE_CHOICE } : loadFolderState(folder);
            breakpoints = state.breakpoints;
            selected = state.selected;
            placed.clear();
            for (const [path, lines] of breakpoints) {
                void api.setBreakpoints(path, lines).catch(() => undefined);
            }
            options.breakpointsChanged(null);
            renderBreakpoints();
            reloadConfigurations();
        },
        reloadConfigurations,
        start,
        stop,
        restart,
        step,
        showConsole: () => debugConsole.show(),
        configure,
        toggleBreakpoint(): void {
            const path = options.activeFile();
            const line = options.activeLine();
            if (path && line) {
                decorations.toggle(path, line);
            }
        },
        get active() {
            return session !== null && session.state !== 'ended';
        },
        get paused() {
            return session?.state === 'stopped';
        },
    };
}

function describeReason(reason: string | null): string {
    switch (reason) {
        case 'breakpoint': return 'breakpoint';
        case 'step': return 'step';
        case 'exception': return 'exception';
        case 'entry': return 'entry';
        case 'pause': return 'pause';
        default: return reason ?? 'pause';
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
}

/** The debugger's commands, with VS Code's keys. F5 starts, or continues a paused session. */
export function debugCommands(debug: DebugController, hasFolder: () => boolean, hasActiveEditor: () => boolean, showView: () => void): CommandDefinition[] {
    return [
        { id: 'workbench.view.debug', category: 'View', title: 'Show Run and Debug', keybinding: 'CmdOrCtrl+Shift+D', run: showView },
        { id: 'workbench.action.debug.start', category: 'Debug', title: 'Start Debugging', keybinding: 'F5', enabled: () => hasFolder() && (!debug.active || debug.paused), run: () => debug.start() },
        { id: 'workbench.action.debug.continue', category: 'Debug', title: 'Continue', enabled: () => debug.paused, run: () => debug.step('continue') },
        { id: 'workbench.action.debug.pause', category: 'Debug', title: 'Pause', keybinding: 'F6', enabled: () => debug.active && !debug.paused, run: () => debug.step('pause') },
        { id: 'workbench.action.debug.stepOver', category: 'Debug', title: 'Step Over', keybinding: 'F10', enabled: () => debug.paused, run: () => debug.step('next') },
        { id: 'workbench.action.debug.stepInto', category: 'Debug', title: 'Step Into', keybinding: 'F11', enabled: () => debug.paused, run: () => debug.step('stepIn') },
        { id: 'workbench.action.debug.stepOut', category: 'Debug', title: 'Step Out', keybinding: 'Shift+F11', enabled: () => debug.paused, run: () => debug.step('stepOut') },
        { id: 'workbench.action.debug.stop', category: 'Debug', title: 'Stop Debugging', keybinding: 'Shift+F5', enabled: () => debug.active, run: () => debug.stop() },
        { id: 'workbench.action.debug.restart', category: 'Debug', title: 'Restart Debugging', keybinding: 'CmdOrCtrl+Shift+F5', enabled: () => debug.active, run: () => debug.restart() },
        { id: 'editor.debug.action.toggleBreakpoint', category: 'Debug', title: 'Toggle Breakpoint', keybinding: 'F9', enabled: hasActiveEditor, run: () => debug.toggleBreakpoint() },
        { id: 'workbench.debug.action.toggleRepl', category: 'View', title: 'Debug Console', keybinding: 'CmdOrCtrl+Shift+Y', run: () => debug.showConsole() },
        { id: 'debug.configure', category: 'Debug', title: 'Open launch.json', enabled: hasFolder, run: () => debug.configure() },
    ];
}

export function registerDebugCommands(registry: CommandRegistry, debug: DebugController, hasFolder: () => boolean, hasActiveEditor: () => boolean, showView: () => void): void {
    for (const command of debugCommands(debug, hasFolder, hasActiveEditor, showView)) {
        registry.register(command);
    }
}
