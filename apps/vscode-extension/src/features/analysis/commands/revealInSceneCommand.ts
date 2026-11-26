/**
 * #178: "CodeXR: Reveal in XR Scene" in the VS Code extension. The editor, its
 * tab and the explorer offer it on a file while an analysis server runs; the
 * core (core/server/analysis/sceneReveal.ts, shared with the Code-XR IDE)
 * asks every running scene whose analysed folder holds the file to mark it.
 */
import * as vscode from 'vscode';
import { revealInScene } from '../../../core/server/analysis/sceneReveal';
import { getActiveServerRegistry } from '../../../core/server/registry/activeServerRegistry';
import { ExtensionCommandRegistration } from '../../../platform/commands/commandRegistry';

export const REVEAL_IN_SCENE_COMMAND = 'codeXR.analysis.revealInScene';
/** True while an analysis server runs: the menus offer the command only then. */
const SCENE_RUNNING_CONTEXT_KEY = 'codeXR.analysis.sceneRunning';

export const NO_SCENE_MESSAGE = 'No running Code-XR scene shows this file. Start an XR analysis of a folder that holds it.';

function targetPath(resource: unknown): string | undefined {
    const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === 'file' ? uri.fsPath : undefined;
}

function publishSceneRunning(): void {
    void vscode.commands.executeCommand('setContext', SCENE_RUNNING_CONTEXT_KEY, getActiveServerRegistry().getRunningServerCount() > 0);
}

export function getRevealInSceneRegistrations(context: vscode.ExtensionContext): ExtensionCommandRegistration[] {
    publishSceneRunning();
    context.subscriptions.push(getActiveServerRegistry().onRegistryChange(publishSceneRunning));
    return [{
        id: REVEAL_IN_SCENE_COMMAND,
        module: 'ANALYSIS',
        description: 'Mark a file in the running XR scenes',
        handler: async (resource?: unknown) => {
            const file = targetPath(resource);
            if (!file || revealInScene(file) === 0) {
                void vscode.window.showInformationMessage(NO_SCENE_MESSAGE);
            }
        },
        errorMessage: 'Failed to reveal the file in the XR scene',
    }];
}
