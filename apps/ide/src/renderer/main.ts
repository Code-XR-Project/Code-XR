import { renderWorkbench } from './workbench.ts';
import { createExplorer } from './explorer.ts';
import type { EditorGroup } from './editor/editorGroup.ts';
import type { IdeCommand, WatchedEntry } from '../shared/api.ts';

const root = document.getElementById('app');
if (!root) {
    throw new Error('Missing #app root element.');
}

const api = window.codexr;
const workbench = renderWorkbench(root);
api.app.getInfo().then(
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
            onActiveChange: (path) => { document.title = path ? `${path.split('/').pop()} - Code-XR` : 'Code-XR'; },
            onUnsavedChange: (count) => void api.workspace.reportUnsaved(count),
            onOpenFilesChange: () => updateWatched(),
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
    onOpened: () => editors?.reset(),
    onExpandedChange: () => updateWatched(),
});

api.workspace.onDidChangeFiles((paths) => {
    void explorer.refresh(paths);
    void editors?.onDiskChanged(paths);
});

function showWorkspace(workspace: Parameters<typeof explorer.show>[0]): void {
    editors?.reset();
    void explorer.show(workspace);
}

api.workspace.onDidChange(showWorkspace);
api.workspace.current().then(
    (workspace) => explorer.show(workspace),
    (error: unknown) => workbench.showError(`Could not read the open folder: ${String(error)}`),
);

const commands: Record<IdeCommand, () => void> = {
    'workspace.openFolder': () => explorer.openFolder(),
    'file.save': () => void editors?.save(),
    'file.saveAll': () => void editors?.saveAll(),
    'editor.close': () => editors?.closeActive(),
};
api.commands.onCommand((command) => commands[command]());
