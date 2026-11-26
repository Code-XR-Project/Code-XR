import { renderWorkbench } from './workbench.ts';
import { createExplorer } from './explorer.ts';
import { createPythonView, pythonStatusText } from './pythonView.ts';
import { createAnalysisRunView } from './analysisRunView.ts';
import { createScenePanel } from './scenePanel.ts';
import { createNotificationCenter } from './notifications.ts';
import { createTerminalPanel } from './terminal/terminalPanel.ts';
import type { EditorGroup } from './editor/editorGroup.ts';
import { createCommandRegistry } from './commands/commandRegistry.ts';
import { installKeybindings } from './commands/keybindingService.ts';
import { formatKeybinding } from './commands/keybindings.ts';
import { COMMAND_PREFIX, LINE_PREFIX, paletteView } from './commands/paletteModel.ts';
import { createQuickOpenFiles } from './quickOpenFiles.ts';
import { createQuickInput } from './commands/quickInput.ts';
import { registerWorkbenchCommands } from './commands/workbenchCommands.ts';
import { pickListView, type PickItem } from './commands/paletteModel.ts';
import { createEditorStatus } from './editor/editorStatus.ts';
import { eolChoices, indentationChoices, languageChoices, type Choice } from './editor/editorStatusModel.ts';
import type { IdeCommand, PythonEnvStatus, WatchedEntry } from '../shared/api.ts';

const root = document.getElementById('app');
if (!root) {
    throw new Error('Missing #app root element.');
}

const api = window.codexr;
/** Whether this window has a folder open (#18: commands that need one are hidden without it). */
let folderIsOpen = false;
/** The active editor's file, for quick open's recent list (#164). */
let activeFile: string | null = null;
const workbench = renderWorkbench(root);
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
                if (path) { quickOpenFiles.opened(path); }
            },
            onUnsavedChange: (count) => void api.workspace.reportUnsaved(count),
            onOpenFilesChange: () => updateWatched(),
            onStatusState: (state) => editorStatus.show(state),
        });
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

const explorer = createExplorer(workbench.sideBar, api.workspace, {
    onOpenFile: (path) => void editorGroup().then((group) => group.open(path)),
    onError: (message) => workbench.setStatus(message),
    confirmOpenFolder: () => confirmDiscard('Opening another folder'),
    onOpened: (workspace) => {
        editors?.reset();
        folderOpened(workspace.root);
    },
    onExpandedChange: () => updateWatched(),
    onCreated: (path, kind) => { if (kind === 'file') { void editorGroup().then((group) => group.open(path)); } },
    onRenamed: (from, to) => void editors?.entryMoved(from, to),
    onTrashed: (path) => void editors?.entryMoved(path, null),
});

api.workspace.onDidChangeFiles((paths) => {
    void explorer.refresh(paths);
    void editors?.onDiskChanged(paths);
});

function showWorkspace(workspace: Parameters<typeof explorer.show>[0]): void {
    editors?.reset();
    void explorer.show(workspace);
}

/** #139: the main process stops the old folder's scene; the panel follows, and the new folder may be analysed. */
function folderOpened(root: string): void {
    folderIsOpen = true;
    quickOpenFiles.reset();
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
        return explorer.show(workspace);
    },
    (error: unknown) => workbench.showError(`Could not read the open folder: ${String(error)}`),
);

// #137: the terminal panel; xterm.js loads with the first terminal.
const terminal = createTerminalPanel(workbench.panel, api.terminal, appInfo.then((info) => info.platform, () => 'linux'), {
    onError: (message) => workbench.setStatus(message),
});

// #18: every action is a command in one registry: the palette lists them,
// the menu's accelerators and the workbench's own keys run them.
let platform: string = navigator.userAgent.includes('Macintosh') ? 'darwin' : 'linux';
const registry = createCommandRegistry((id, error) => notifications.notify('error', `Command "${id}" failed: ${String(error)}`));
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
    showView: (view) => workbench.showView(view),
    analyseProject: () => void runView.analyse(),
    canAnalyse: () => runView.canAnalyse(),
    setUpPython: () => void api.python.setUp(),
    closeScene: () => {
        scenePanel.close();
        api.analysis.closeScene().catch((reason: unknown) => workbench.setStatus(String(reason)));
    },
    hasScene: () => !workbench.sceneArea.hidden,
});
api.commands.onCommand((command: IdeCommand) => {
    registry.execute(command);
});
void appInfo.then((info) => { platform = info.platform; }, () => undefined).finally(() => installKeybindings(registry, platform));

// #15: the Python environment, in the Analysis view and the status bar.
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
            notifications.notify('error', message);
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
    notifications.notify(notification.severity, notification.message);
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
                actions: [{ label: 'Retry', run: () => void api.python.setUp() }],
            });
        }
    } else if (status.state === 'missing-python' && previous !== 'missing-python') {
        notifications.notify('warning', status.message, { detail: status.detail });
    }
}
