/**
 * Analysis File Mode Commands
 * Commands specific to the Analysis File Mode setting
 */

import * as vscode from 'vscode';
import { AnalysisFileSetting } from './analysisFileMode';
import { getLogger } from '../../../../../platform/logging/sink';

const logger = getLogger('ANALYSIS');

export interface CommandRegistration {
    commandId: string;
    callback: (...args: any[]) => Promise<void> | void;
    description: string;
    module?: string;
    errorMessage?: string;
    silentErrors?: boolean;
}

export class AnalysisFileModeCommands {
    constructor(
        _context: vscode.ExtensionContext,
        private analysisFileSetting: AnalysisFileSetting,
    ) {}

    static getCommandRegistrations(
        context: vscode.ExtensionContext,
        analysisFileSetting: AnalysisFileSetting,
        refreshCallback: () => void,
    ): CommandRegistration[] {
        const commands = new AnalysisFileModeCommands(context, analysisFileSetting);

        return [
            {
                commandId: 'codeXR.analysis.toggleAnalysisFileMode',
                callback: () => commands.toggleAnalysisFileMode(refreshCallback),
                description: 'Toggle analysis file mode between XR and LivePanel',
                module: 'ANALYSIS',
                errorMessage: 'Failed to toggle analysis file mode'
            }
        ];
    }

    private async toggleAnalysisFileMode(refreshCallback: () => void): Promise<void> {
        try {
            const newMode = await this.analysisFileSetting.toggleMode();
            void vscode.window.showInformationMessage(`Analysis File mode switched to: ${newMode}`, { modal: false });
            refreshCallback();
            logger.debug(() => `Command executed - Analysis file mode: ${newMode}`);
        } catch (error) {
            logger.error('Error toggling analysis file mode:', error);
            void vscode.window.showErrorMessage(`Failed to toggle analysis file mode: ${error}`);
        }
    }
}

