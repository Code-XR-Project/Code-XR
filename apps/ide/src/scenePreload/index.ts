import { contextBridge, ipcRenderer } from 'electron';
import { SCENE_OPEN_IN_EDITOR_CHANNEL, toSceneEditorTarget } from '../shared/sceneBridge.ts';

/**
 * The preload of the scene view (#16): the only thing an analysis page
 * served by the core gets from the IDE. `CodeXRHostBridge.openInEditor`
 * asks the IDE to open a file of the analysed project (a dependency-graph
 * node, a LivePanel row) in the editor beside the scene. The argument is
 * checked here and again in the main process, which only opens a path
 * inside the open folder. Nothing else crosses.
 */
contextBridge.exposeInMainWorld('CodeXRHostBridge', Object.freeze({
    openInEditor(target: unknown): void {
        const checked = toSceneEditorTarget(target);
        if (checked) {
            ipcRenderer.send(SCENE_OPEN_IN_EDITOR_CHANNEL, checked);
        }
    },
}));
