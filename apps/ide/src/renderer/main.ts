import { renderWorkbench } from './workbench.ts';
import { createExplorer } from './explorer.ts';

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

const explorer = createExplorer(workbench.sideBar, api.workspace, {
    // The editor (Monaco) opens files in the next part of #14.
    onOpenFile: (path) => workbench.setStatus(path),
    onError: (message) => workbench.setStatus(message),
});
api.workspace.onDidChange((workspace) => void explorer.show(workspace));
api.workspace.current().then(
    (workspace) => explorer.show(workspace),
    (error: unknown) => workbench.showError(`Could not read the open folder: ${String(error)}`),
);
