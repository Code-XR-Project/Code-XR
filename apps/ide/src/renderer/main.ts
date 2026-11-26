import { renderWorkbench } from './workbench.ts';
import { createExplorer } from './explorer.ts';
import { createPythonView, pythonStatusText } from './pythonView.ts';
import { createAnalysisRunView } from './analysisRunView.ts';
import { createScenePanel } from './scenePanel.ts';
import { createNotificationCenter, type NotificationAction } from './notifications.ts';
import type { OutputChannelId } from '../shared/output.ts';
import { createTerminalPanel } from './terminal/terminalPanel.ts';
import { createOutputView } from './outputPanel/outputView.ts';
import { createPanelHost } from './panel/panelHost.ts';
import { createAgentsView } from './agents/agentsView.ts';
import { createEditReviewer } from './agents/editReview.ts';
import { registerAgentCommands } from './agents/agentCommands.ts';
import { createProblemsView } from './problems/problemsView.ts';
import { metricProblems, type FunctionMetricsSnapshot, type MetricThresholds, type Problem } from '../shared/problems.ts';
import type { EditorGroup } from './editor/editorGroup.ts';
import { createCommandRegistry } from './commands/commandRegistry.ts';
import { installKeybindings } from './commands/keybindingService.ts';
import { formatKeybinding } from './commands/keybindings.ts';
import { COMMAND_PREFIX, LINE_PREFIX, paletteView } from './commands/paletteModel.ts';
import { createQuickOpenFiles } from './quickOpenFiles.ts';
import { createSearchView } from './search/searchView.ts';
import { createQuickInput } from './commands/quickInput.ts';
import { registerWorkbenchCommands } from './commands/workbenchCommands.ts';
import { pickListView, type PickItem } from './commands/paletteModel.ts';
import { createEditorStatus } from './editor/editorStatus.ts';
import { eolChoices, indentationChoices, languageChoices, type Choice } from './editor/editorStatusModel.ts';
import { parseSession, serializeSession, sessionKey } from './editor/tabsModel.ts';
import { showContextMenu, type ContextMenuItem } from './contextMenu.ts';
import { createSettingsView } from './settings/settingsView.ts';
import { createKeybindingsView } from './settings/keybindingsView.ts';
import { menuAccelerators } from './settings/keybindingsModel.ts';
import { COLOR_THEME_SETTING, isColorTheme, settingOf, type ColorTheme } from '../shared/settings.ts';
import { themeChoices } from './settings/settingsModel.ts';
import type { IdeCommand, KeybindingsReport, PythonEnvStatus, SettingsReport, WatchedEntry } from '../shared/api.ts';

const root = document.getElementById('app');
if (!root) {
    throw new Error('Missing #app root element.');
}

const api = window.codexr;
/** Whether this window has a folder open (#18: commands that need one are hidden without it). */
let folderIsOpen = false;
/** The active editor's file, for quick open's recent list (#164). */
let activeFile: string | null = null;
// #169: the layout is remembered in the renderer's storage (inside the IDE's user-data folder).
function layoutStorage(): Storage | null {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}
const workbench = renderWorkbench(root, layoutStorage());
// #153: VS Code-style notifications, kept clear of the scene view (a native view drawn over the page).
const notifications = createNotificationCenter(document.body);
new ResizeObserver(() => notifications.setRightInset(workbench.sceneArea.hidden ? 0 : workbench.sceneArea.getBoundingClientRect().width))
    .observe(workbench.sceneArea);
const appInfo = api.app.getInfo();
appInfo.then(
    (info) => workbench.showInfo(info),
    (error: unknown) => workbench.showError(`Could not reach the main process: ${String(error)}`),
);

// Monaco is loaded on the first file open, in its own chunk, so the window
// and the explorer come up without it.
let editors: EditorGroup | null = null;
let editorsLoading: Promise<EditorGroup> | null = null;
function editorGroup(): Promise<EditorGroup> {
    editorsLoading ??= import('./editor/editorGroup.ts').then(({ createEditorGroup }) => {
        editors = createEditorGroup(workbench.editorArea, api.workspace, {
            onStatus: (message) => workbench.setStatus(message),
            onActiveChange: (path) => {
                document.title = path ? `${path.split('/').pop()} - Code-XR` : 'Code-XR';
                activeFile = path;
                scheduleSessionSave();
                if (path) { quickOpenFiles.opened(path); }
            },
            onUnsavedChange: (count) => void api.workspace.reportUnsaved(count),
            onOpenFilesChange: () => updateWatched(),
            onStatusState: (state) => editorStatus.show(state),
            onSessionChange: () => scheduleSessionSave(),
            copyPath: (path, kind) => copyPath(path, kind),
            revealInExplorer: (path) => void revealInExplorer(path),
            showTabMenu: (path, x, y) => showTabMenu(path, x, y),
            onMarkersChange: () => problemsView.setEditorProblems(editors?.editorProblems() ?? []),
        });
        if (settingsReport) {
            editors.applySettings(settingsReport.effective);
        }
        editors.setMetricProblems(currentMetricProblems);
        return editors;
    });
    return editorsLoading;
}

/** True when nothing unsaved would be lost, or the person agreed to lose it. */
function confirmDiscard(action: string): boolean {
    const dirty = editors?.dirtyPaths() ?? [];
    if (dirty.length === 0) {
        return true;
    }
    const list = dirty.slice(0, 5).join('\n') + (dirty.length > 5 ? `\n… and ${dirty.length - 5} more` : '');
    return window.confirm(`${action} discards unsaved changes in:\n${list}\n\nContinue?`);
}

// What the main process watches: the expanded folders (their listings) and
// the open files. Recomputed on a short debounce, since expanding a folder
// tree or restoring tabs changes it many times in a row.
let watchTimer: ReturnType<typeof setTimeout> | undefined;
function updateWatched(): void {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
        const entries: WatchedEntry[] = [
            ...explorer.expandedFolders().map((path) => ({ path, kind: 'directory' as const })),
            ...(editors?.openPaths() ?? []).map((path) => ({ path, kind: 'file' as const })),
        ];
        api.workspace.setWatched(entries).catch((error: unknown) => workbench.setStatus(`Could not watch the folder: ${String(error)}`));
    }, 100);
}

// #167: the open tabs are a session of the folder, kept in the renderer's
// storage under the folder's path and restored when the folder opens again.
let sessionRoot: string | null = null;
let sessionTimer: ReturnType<typeof setTimeout> | undefined;
function saveSession(): void {
    clearTimeout(sessionTimer);
    if (sessionRoot === null || !editors) {
        return;
    }
    try {
        layoutStorage()?.setItem(sessionKey(sessionRoot), serializeSession(editors.session()));
    } catch {
        // Storage full or unavailable: the tabs are just not remembered.
    }
}
function scheduleSessionSave(): void {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(saveSession, 300);
}
window.addEventListener('beforeunload', saveSession);
/** The tabs follow the folder: the old folder's session is saved, the new one's restored. */
function switchTabsFolder(root: string | null): void {
    if (root === sessionRoot && root !== null) {
        return;
    }
    saveSession();
    sessionRoot = null;
    editors?.reset();
    // #18: the new folder brings its own settings.
    void Promise.resolve().then(loadSettings);
    if (root === null) {
        return;
    }
    let saved;
    try {
        saved = parseSession(layoutStorage()?.getItem(sessionKey(root)) ?? null);
    } catch {
        saved = parseSession(null);
    }
    if (saved.tabs.length === 0) {
        sessionRoot = root;
        return;
    }
    void editorGroup().then(async (group) => {
        await group.restore(saved);
        sessionRoot = root;
        saveSession();
    });
}
function copyPath(path: string, kind: 'absolute' | 'relative'): void {
    api.workspace.copyPath(path, kind).then(
        () => workbench.setStatus(`Copied the ${kind === 'absolute' ? 'path' : 'relative path'} of ${path}`),
        (error: unknown) => workbench.setStatus(`Could not copy the path: ${String(error)}`),
    );
}
async function revealInExplorer(path: string): Promise<void> {
    workbench.showView('explorer');
    if (!(await explorer.reveal(path))) {
        workbench.setStatus(`${path} is not in the explorer.`);
    }
}
function showTabMenu(path: string, x: number, y: number): void {
    const key = (id: string): string => {
        const binding = registry.keybindings(id)[0];
        return binding ? formatKeybinding(binding, platform) : '';
    };
    const items: ContextMenuItem[] = [
        { label: 'Close', keybinding: key('editor.close'), run: () => editors?.closeActive(), testId: 'tab-menu-close' },
        { label: 'Close Others', run: () => editors?.closeGroup('others', path), testId: 'tab-menu-close-others' },
        { label: 'Close to the Right', run: () => editors?.closeGroup('right', path), testId: 'tab-menu-close-right' },
        { label: 'Close Saved', keybinding: key('editor.closeSaved'), run: () => editors?.closeGroup('saved', path), testId: 'tab-menu-close-saved' },
        { label: 'Close All', keybinding: key('editor.closeAll'), run: () => editors?.closeGroup('all', path), testId: 'tab-menu-close-all' },
        { separator: true },
        { label: 'Copy Path', run: () => copyPath(path, 'absolute'), testId: 'tab-menu-copy-path' },
        { label: 'Copy Relative Path', run: () => copyPath(path, 'relative'), testId: 'tab-menu-copy-relative-path' },
        { separator: true },
        { label: 'Keep Open', keybinding: key('editor.keep'), run: () => editors?.keepActive(), testId: 'tab-menu-keep' },
        { label: 'Reveal in Explorer', run: () => void revealInExplorer(path), testId: 'tab-menu-reveal' },
    ];
    showContextMenu(items, x, y, {
        label: `Actions for ${path}`,
        rightInset: () => (workbench.sceneArea.hidden ? 0 : workbench.sceneArea.getBoundingClientRect().width),
    });
}

const explorer = createExplorer(workbench.sideBar, api.workspace, {
    onOpenFile: (path, preview) => void editorGroup().then((group) => group.open(path, { preview })),
    onError: (message) => workbench.setStatus(message),
    confirmOpenFolder: () => confirmDiscard('Opening another folder'),
    onOpened: (workspace) => {
        switchTabsFolder(workspace.root);
        folderOpened(workspace.root);
    },
    onExpandedChange: () => updateWatched(),
    onCreated: (path, kind) => { if (kind === 'file') { void editorGroup().then((group) => group.open(path)); } },
    onRenamed: (from, to) => void editors?.entryMoved(from, to),
    onTrashed: (path) => void editors?.entryMoved(path, null),
});

api.workspace.onDidChangeFiles((paths) => {
    // #18: the folder's settings file saved in the editor (or changed on disk) takes effect.
    if (paths.includes('.codexr/settings.json')) {
        void loadSettings();
    }
    void explorer.refresh(paths);
    void editors?.onDiskChanged(paths);
});

function showWorkspace(workspace: Parameters<typeof explorer.show>[0]): void {
    switchTabsFolder(workspace?.root ?? null);
    void explorer.show(workspace);
}

/** #139: the main process stops the old folder's scene; the panel follows, and the new folder may be analysed. */
function folderOpened(root: string): void {
    folderIsOpen = true;
    quickOpenFiles.reset();
    searchView.reset();
    scenePanel.close();
    runView.setHasFolder(true);
    runView.folderOpened(root);
}

api.workspace.onDidChange((workspace) => {
    if (workspace) {
        folderOpened(workspace.root);
    } else {
        folderIsOpen = false;
        quickOpenFiles.reset();
        searchView.reset();
        scenePanel.close();
        runView.setHasFolder(false);
    }
    showWorkspace(workspace);
});
api.workspace.current().then(
    (workspace) => {
        runView.setHasFolder(workspace !== null);
        folderIsOpen = workspace !== null;
        if (workspace) {
            runView.folderOpened(workspace.root);
        }
        switchTabsFolder(workspace?.root ?? null);
        return explorer.show(workspace);
    },
    (error: unknown) => workbench.showError(`Could not read the open folder: ${String(error)}`),
);

// #165: search across the workspace, in its own side-bar view.
const searchView = createSearchView(workbench.searchView, api.workspace, {
    openMatch: (path, match) => void editorGroup().then((group) => group.openAt(path, match.line, match.column, match.length)),
    replaceInOpenFiles: (paths, replace) => editors?.replaceInOpenFiles(paths, replace) ?? { handled: [], replacements: 0 },
    confirm: (message) => window.confirm(message),
    onStatus: (message) => {
        workbench.setStatus(message);
        notifications.notify('info', message);
    },
});

// #18: settings, user and folder. The main process stores and validates
// them; the renderer shows them and applies the ones in force.
let settingsReport: SettingsReport | null = null;
function applySettings(report: SettingsReport): void {
    settingsReport = report;
    settingsView.show(report);
    editors?.applySettings(report.effective);
    terminal.setFontSize(settingOf<number>(report, 'terminal.integrated.fontSize'));
    metricThresholds = {
        complexity: settingOf<number>(report, 'problems.metrics.maxComplexity'),
        lines: settingOf<number>(report, 'problems.metrics.maxFunctionLines'),
        parameters: settingOf<number>(report, 'problems.metrics.maxParameters'),
    };
    refreshMetricProblems();
}
function loadSettings(): Promise<void> {
    return api.settings.get().then(applySettings, (error: unknown) => workbench.setStatus(`Could not read the settings: ${String(error)}`));
}
function openFolderSettingsFile(): void {
    api.settings.folderFile().then(
        (path) => void editorGroup().then((group) => group.open(path)),
        (error: unknown) => workbench.setStatus(`Could not open the folder settings: ${String(error)}`),
    );
}
const settingsView = createSettingsView(workbench.settingsView, api.settings, {
    onError: (message) => notifications.notify('error', message),
    openFolderFile: openFolderSettingsFile,
    openKeybindings: () => registry.execute('workbench.openKeybindings'),
});
api.settings.onDidChange(applySettings);

// #174: the bottom panel and its views. #137: the terminal; xterm.js loads with the first terminal.
const panelHost = createPanelHost(workbench.panel, { toggleMaximized: () => workbench.layout.togglePanelMaximized() });
workbench.layout.onDidChange(() => panelHost.setMaximized(workbench.layout.panelMaximized));
// #173: the Problems view: the languages' markers and the Code-XR metric checks of the last analysis.
const problemsView = createProblemsView(panelHost, {
    open: (problem) => void editorGroup().then((group) => group.openAt(problem.path, problem.startLine, problem.startColumn, 0)),
    onCounts: (counts) => workbench.setProblemCounts(counts.error, counts.warning),
});
workbench.onProblemsClick(() => (panelHost.isShowing('problems') ? panelHost.hide() : problemsView.show()));
let metricSnapshot: FunctionMetricsSnapshot | null = null;
let metricThresholds: MetricThresholds | null = null;
let currentMetricProblems: Problem[] = [];
/** The thresholds or the measured functions changed: the list and the squiggles follow, with no new run. */
function refreshMetricProblems(): void {
    currentMetricProblems = metricSnapshot && metricThresholds ? metricProblems(metricSnapshot.files, metricThresholds) : [];
    problemsView.setMetricProblems(currentMetricProblems, metricSnapshot !== null);
    editors?.setMetricProblems(currentMetricProblems);
}
function receiveMetrics(snapshot: FunctionMetricsSnapshot | null): void {
    metricSnapshot = snapshot;
    refreshMetricProblems();
}
api.problems.onMetricsChanged(receiveMetrics);
api.problems.functionMetrics().then((snapshot) => { if (snapshot) { receiveMetrics(snapshot); } }, () => undefined);
// The tabs follow VS Code's order: Problems, Output, Terminal.
const output = createOutputView(panelHost, api.output, { onError: (message) => workbench.setStatus(message) });
const terminal = createTerminalPanel(panelHost, api.terminal, appInfo.then((info) => info.platform, () => 'linux'), {
    onError: (message) => workbench.setStatus(message),
});
/** A notification's "Show Output" button, on the channel that explains it. */
const showOutputAction = (channel: OutputChannelId): NotificationAction => ({ label: 'Show Output', run: () => output.show(channel) });
void loadSettings();

// #18: every action is a command in one registry: the palette lists them,
// the menu's accelerators and the workbench's own keys run them.
let platform: string = navigator.userAgent.includes('Macintosh') ? 'darwin' : 'linux';
const registry = createCommandRegistry((id, error) => notifications.notify('error', `Command "${id}" failed: ${String(error)}`), platform);
// #164: the workspace's files, listed by the main process each time quick
// open opens (a stale list is shown meanwhile), and the recently opened ones.
const quickOpenFiles = createQuickOpenFiles(() => api.workspace.listFiles(), () => quickInput.refresh());
const quickInput = createQuickInput(document.body, {
    label: 'Search files by name (> for commands, : for a line, @ for symbols)',
    view: (value) => {
        if (folderIsOpen && quickOpenFiles.files() === null) {
            // Typing a file name after opening the box as the palette: list the files now.
            quickOpenFiles.reload();
        }
        return paletteView(value, {
        commands: registry.list(),
        isEnabled: (id) => registry.isEnabled(id),
        recent: registry.recent(),
        formatKey: (binding) => formatKeybinding(binding, platform),
        keybindingOf: (id) => registry.keybindings(id)[0],
        lineCount: editors?.activeLineCount() ?? null,
        hasFolder: folderIsOpen,
        files: quickOpenFiles.files(),
        filesTruncated: quickOpenFiles.truncated(),
        recentFiles: quickOpenFiles.recent(),
        activeFile,
        });
    },
    accept: (action) => {
        if (action.kind === 'command') {
            registry.execute(action.id);
        } else if (action.kind === 'line') {
            editors?.goToLine(action.line, action.column);
        } else if (action.kind === 'file') {
            void editorGroup().then((group) => group.open(action.path));
        } else if (action.kind === 'symbols') {
            editors?.showSymbols();
        }
    },
    rightInset: () => (workbench.sceneArea.hidden ? 0 : workbench.sceneArea.getBoundingClientRect().width),
});
/** Opens a picker (#166) over `choices`; Enter applies the chosen value. */
function pick<T>(label: string, choices: readonly Choice<T>[], apply: (value: T) => void): void {
    const items: PickItem[] = choices.map(({ id, label: text, description }) => ({ id, label: text, ...(description ? { description } : {}) }));
    quickInput.open('', {
        label,
        view: (value) => pickListView(items, value),
        accept: (action) => {
            const choice = action.kind === 'pick' ? choices.find((candidate) => candidate.id === action.id) : undefined;
            if (choice) {
                apply(choice.value);
            }
        },
    });
}
/**
 * #171: the colour theme picker. Moving through the list previews each theme
 * (the main process switches what every page sees as prefers-color-scheme);
 * Enter stores it in the user's settings, Escape goes back to the stored one.
 */
function selectColorTheme(): void {
    const current = settingsReport ? settingOf<ColorTheme>(settingsReport, COLOR_THEME_SETTING) : 'system';
    const choices = themeChoices(isColorTheme(current) ? current : 'system');
    const items: PickItem[] = choices.map(({ id, label, description }) => ({ id, label, ...(description ? { description } : {}) }));
    let previewed: string | undefined = current;
    const preview = (theme: ColorTheme | null): void => {
        api.settings.previewTheme(theme).catch((error: unknown) => workbench.setStatus(`Could not preview the theme: ${String(error)}`));
    };
    quickInput.open('', {
        label: 'Select color theme',
        initialId: current,
        view: (value) => pickListView(items, value),
        onActive: (id) => {
            if (isColorTheme(id) && id !== previewed) {
                previewed = id;
                preview(id);
            }
        },
        onClose: (accepted) => {
            if (!accepted && previewed !== current) {
                preview(null);
            }
        },
        accept: (action) => {
            if (action.kind !== 'pick' || !isColorTheme(action.id)) {
                return;
            }
            api.settings.update('user', COLOR_THEME_SETTING, action.id === 'system' ? null : action.id).then(applySettings, (error: unknown) => {
                preview(null);
                notifications.notify('error', `Could not change the theme: ${String(error)}`);
            });
        },
    });
}
const pickIndentation = (): void => {
    const state = editors?.statusState();
    if (state) { pick('Select indentation', indentationChoices(state), (value) => editors?.setIndentation(value)); }
};
const pickEndOfLine = (): void => {
    const state = editors?.statusState();
    if (state) { pick('Select end of line sequence', eolChoices(state.eol), (value) => editors?.setEndOfLine(value)); }
};
const pickLanguage = (): void => {
    const state = editors?.statusState();
    if (state && editors) { pick('Select language mode', languageChoices(editors.languages(), state.languageId), (value) => editors?.setLanguage(value)); }
};
// #166: the active editor's items in the status bar.
const editorStatus = createEditorStatus(workbench.editorStatus, {
    goToLine: () => { registry.execute('editor.goToLine'); },
    pickIndentation,
    pickEndOfLine,
    pickLanguage,
});
registerAgentCommands(registry, { showAgents: () => workbench.showView('agents'), addProvider: () => agentsView.addProvider(), newChat: () => void agentsView.newChat() });
registerWorkbenchCommands(registry, {
    openCommandPalette: () => quickInput.open(COMMAND_PREFIX),
    goToLine: () => quickInput.open(LINE_PREFIX),
    quickOpen: () => {
        quickOpenFiles.reload();
        quickInput.open('');
    },
    goToSymbol: () => editors?.showSymbols(),
    hasActiveEditor: () => (editors?.activeLineCount() ?? null) !== null,
    changeIndentation: pickIndentation,
    changeEndOfLine: pickEndOfLine,
    changeLanguageMode: pickLanguage,
    openFolder: () => explorer.openFolder(),
    hasFolder: () => folderIsOpen,
    newFile: () => void explorer.newFile(),
    newFolder: () => void explorer.newFolder(),
    save: () => void editors?.save(),
    saveAll: () => void editors?.saveAll(),
    closeEditor: () => editors?.closeActive(),
    toggleTerminal: () => terminal.toggle(),
    newTerminal: () => void terminal.newTerminal(),
    closeTerminalPanel: () => terminal.hide(),
    showOutput: () => output.show(),
    showProblems: () => problemsView.focusFilter(),
    showView: (view) => workbench.showView(view),
    showSearch: () => {
        workbench.showView('search');
        searchView.focus(editors?.selectedText());
    },
    analyseProject: () => void runView.analyse(),
    canAnalyse: () => runView.canAnalyse(),
    setUpPython: () => void api.python.setUp(),
    closeScene: () => {
        scenePanel.close();
        api.analysis.closeScene().catch((reason: unknown) => workbench.setStatus(String(reason)));
    },
    hasScene: () => !workbench.sceneArea.hidden,
    toggleSideBar: () => workbench.layout.toggleSideBar(),
    togglePanel: () => {
        if (panelHost.visible) {
            panelHost.hide();
        } else if (panelHost.activeView === 'terminal') {
            terminal.show();
        } else {
            panelHost.show();
        }
    },
    toggleMaximizedPanel: () => workbench.layout.togglePanelMaximized(),
    hasPanel: () => panelHost.visible,
    toggleZenMode: () => workbench.layout.toggleZen(),
    resetLayout: () => workbench.layout.reset(),
    openSettings: () => {
        workbench.showView('settings');
        settingsView.focus();
    },
    openFolderSettingsFile: () => openFolderSettingsFile(),
    selectColorTheme,
    formatDocument: () => {
        void editors?.formatDocument().then((formatted) => {
            if (!formatted) {
                workbench.setStatus(`No formatter for ${editors?.statusState()?.languageName ?? 'this file'}.`);
            }
        });
    },
    openKeybindings: () => {
        workbench.showView('keybindings');
        keybindingsView.focus();
        // A hand edit of keybindings.json shows up when the view opens.
        void loadKeybindings();
    },
    closeEditors: (kind) => editors?.closeGroup(kind),
    cycleEditor: (delta) => editors?.cycle(delta),
    keepEditor: () => editors?.keepActive(),
    copyActivePath: (kind) => { if (activeFile) { copyPath(activeFile, kind); } },
    revealActiveFile: () => { if (activeFile) { void revealInExplorer(activeFile); } },
    hasEditors: () => (editors?.openPaths().length ?? 0) > 0,
});
api.commands.onCommand((command: IdeCommand) => {
    registry.execute(command);
});
void appInfo.then((info) => { platform = info.platform; }, () => undefined).finally(() => installKeybindings(registry, platform));

// #18, part 3: the user's keybindings. The main process stores the rules;
// the registry applies them, and the menu is told which keys it now owns.
function pushMenuAccelerators(suspended = false): void {
    api.keybindings.setMenuAccelerators(menuAccelerators(registry, suspended)).catch((error: unknown) => workbench.setStatus(`Could not update the menu keys: ${String(error)}`));
}
function applyKeybindings(report: KeybindingsReport): void {
    registry.setUserKeybindings(report.entries);
    pushMenuAccelerators();
    keybindingsView.show(report);
}
function loadKeybindings(): Promise<void> {
    return api.keybindings.get().then(applyKeybindings, (error: unknown) => workbench.setStatus(`Could not read the keybindings: ${String(error)}`));
}
const keybindingsView = createKeybindingsView(workbench.keybindingsView, api.keybindings, registry, platform, {
    onError: (message) => notifications.notify('error', message),
    openSettings: () => {
        workbench.showView('settings');
        settingsView.focus();
    },
    onRecording: (recording) => pushMenuAccelerators(recording),
    formatKey: (key) => formatKeybinding(key, platform),
});
api.keybindings.onDidChange(applyKeybindings);
void loadKeybindings();

// #15: the Python environment, in the Analysis view and the status bar.
// The AI agent hub: providers configured with the person's own keys.
const reviewEdit = createEditReviewer(workbench.editorArea.parentElement ?? document.body, {
    applyInEditor: async (path, expected, text) => {
        if (!editors?.openPaths().includes(path)) {
            return 'not-open';
        }
        return editors.applyAgentEdit(path, expected, text);
    },
    writeFile: (path, text, expectedMtimeMs) => api.workspace.writeFile(path, text, expectedMtimeMs),
    createFile: (parent, name) => api.workspace.createEntry(parent, name, 'file'),
    onStatus: (message) => workbench.setStatus(message),
});
const agentsView = createAgentsView(workbench.agentsView, api.agents, {
    onStatus: (message) => workbench.setStatus(message),
    reviewEdit,
    listFiles: async () => (await api.workspace.listFiles()).files,
    activeSelection: () => {
        const selection = editors?.activeSelection();
        return selection ? { kind: 'selection', ...selection } : null;
    },
});
agentsView.refresh().catch((error: unknown) => workbench.setStatus(`Agents unavailable: ${String(error)}`));

const pythonView = createPythonView(workbench.analysisView, api.python, {
    onStatus: (status) => {
        workbench.setPythonStatus(pythonStatusText(status), status.message, status.state);
        runView.setPython(status);
    },
    onError: (message) => workbench.setStatus(message),
});

// #16: analyses of the open folder, and their scene beside the code.
const runView = createAnalysisRunView(workbench.analysisView, api.analysis, {
    onStatus: (message) => workbench.setStatus(message),
    onStarted: (title) => notifications.progress('analysis', { title }),
    onFinished: (ok, message) => {
        notifications.endProgress('analysis');
        // A launched scene is announced by the core itself ("... Server running on port N").
        if (!ok) {
            notifications.notify('error', message, { actions: [showOutputAction('core')] });
        }
    },
});
const scenePanel = createScenePanel(workbench.sceneArea, api.analysis, {
    setVisible: (visible) => {
        workbench.setSceneVisible(visible);
        notifications.setRightInset(visible ? workbench.sceneArea.getBoundingClientRect().width : 0);
    },
    onError: (message) => workbench.setStatus(message),
});
api.analysis.onDidOpenScene((scene) => scenePanel.show(scene));
// #16: "Open in editor" on a dependency-graph node, a LivePanel row. The
// path was resolved and checked against the open folder by the main process.
api.analysis.onDidRequestOpenInEditor(({ path, line }) => {
    void editorGroup().then((group) => line === undefined ? group.open(path) : group.openAt(path, line, 1, 0));
});
api.python.onDidChangeStatus((status) => {
    pythonView.show(status);
    notifyPython(status);
});
api.python.status().then((status) => {
    pythonView.show(status);
    notifyPython(status);
}, (error: unknown) => workbench.setStatus(`Could not check Python: ${String(error)}`));
api.app.onNotification((notification) => {
    workbench.setStatus(notification.message);
    notifications.notify(notification.severity, notification.message, notification.severity === 'error' ? { actions: [showOutputAction('core')] } : {});
});
// #153: the core's long tasks (the Python set-up steps, the language parsers...) as progress notifications.
api.app.onProgress((progress) => {
    const key = `core-${progress.id}`;
    if (lastPythonState === 'installing') {
        // The Python set-up's own steps already move its single notification.
        return;
    }
    if (progress.done) {
        notifications.endProgress(key);
    } else {
        notifications.progress(key, { title: progress.title, message: progress.message, percent: progress.percent });
    }
});

/**
 * #154: the Python environment installs itself at start-up; its progress
 * shows as a notification while it runs, then one notification says how it
 * ended (with Retry on a failure). A missing Python is said once.
 */
let lastPythonState: PythonEnvStatus['state'] | null = null;
function notifyPython(status: PythonEnvStatus): void {
    const previous = lastPythonState;
    lastPythonState = status.state;
    if (status.state === 'installing') {
        notifications.progress('python', { title: 'Installing the analysis dependencies', message: status.message, percent: status.progress });
        return;
    }
    notifications.endProgress('python');
    if (previous === 'installing') {
        if (status.state === 'ready') {
            notifications.notify('info', 'The analysis dependencies are installed.');
        } else {
            notifications.notify('error', 'The analysis dependencies could not be installed.', {
                detail: status.detail ?? status.message,
                actions: [{ label: 'Retry', run: () => void api.python.setUp() }, showOutputAction('python')],
            });
        }
    } else if (status.state === 'missing-python' && previous !== 'missing-python') {
        notifications.notify('warning', status.message, { detail: status.detail });
    }
}
