/**
 * #339: "Code-XR: Analyze in XR Scene" in the VS Code extension. The editor,
 * its tab and the explorer offer it on a file or folder while an analysis
 * server runs; the core (core/server/analysis/sceneDrillDown.ts, shared with
 * the Code-XR IDE) asks every running scene that can reach the target to
 * switch its table to that target's analysis in place (drill-down, #333).
 */
import * as vscode from 'vscode';
import { drillDownInScenes } from '../../../core/server/analysis/sceneDrillDown';
import { ExtensionCommandRegistration } from '../../../platform/commands/commandRegistry';

export const ANALYZE_IN_SCENE_COMMAND = 'codeXR.analysis.analyzeInScene';

export const NO_DRILL_SCENE_MESSAGE = 'No running Code-XR scene can analyse this. Start an XR analysis of a folder that holds it.';

function targetPath(resource: unknown): string | undefined {
    const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === 'file' ? uri.fsPath : undefined;
}

/** The context key the menus read is published by revealInSceneCommand.ts. */
export function getAnalyzeInSceneRegistrations(): ExtensionCommandRegistration[] {
    return [{
        id: ANALYZE_IN_SCENE_COMMAND,
        module: 'ANALYSIS',
        description: 'Switch the running XR scenes to the analysis of a file or folder',
        handler: async (resource?: unknown) => {
            const target = targetPath(resource);
            if (!target || drillDownInScenes(target) === 0) {
                void vscode.window.showInformationMessage(NO_DRILL_SCENE_MESSAGE);
            }
        },
        errorMessage: 'Failed to analyse the target in the XR scene',
    }];
}
