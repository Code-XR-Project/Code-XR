import { renderWorkbench } from './workbench.ts';

const root = document.getElementById('app');
if (!root) {
    throw new Error('Missing #app root element.');
}

const workbench = renderWorkbench(root);
window.codexr.app.getInfo().then(
    (info) => workbench.showInfo(info),
    (error: unknown) => workbench.showError(`Could not reach the main process: ${String(error)}`),
);
