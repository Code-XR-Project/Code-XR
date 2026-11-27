/**
 * File Analysis XR Commands
 * Commands for analyzing individual files in XR mode.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getLanguageForFile } from '../../../../core/analysis/languages/languageMetadata';
import { AnalysisOrchestrator } from '../../../../core/analysis/analysisOrchestrator';
import { CommandRegistration } from '../../sections/settings/analysis-file-mode/analysisFileModeCommands';
import { getLogger } from '../../../../platform/logging/sink';

const logger = getLogger('FILE_ANALYSIS_XR_COMMANDS');

export class FileAnalysisXRCommands {
    constructor(private context: vscode.ExtensionContext) {}

    static getCommandRegistrations(context: vscode.ExtensionContext): CommandRegistration[] {
        const commands = new FileAnalysisXRCommands(context);
        return [
            {
                commandId: 'codeXR.analysis.analyzeFileXR',
                callback: (uri?: vscode.Uri) => commands.analyzeFileXR(uri),
                description: 'Analyze file in XR mode',
                module: 'ANALYSIS',
                errorMessage: 'Failed to analyze file in XR mode'
            }
        ];
    }

    private async analyzeFileXR(uri?: vscode.Uri): Promise<void> {
        try {
            let filePath: string;

            if (uri) {
                filePath = uri.fsPath;
            } else {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor) {
                    void vscode.window.showWarningMessage('Code-XR: No file selected for XR analysis');
                    return;
                }
                filePath = activeEditor.document.fileName;
            }

            const languageInfo = getLanguageForFile(filePath);
            if (!languageInfo) {
                void vscode.window.showWarningMessage(
                    `Code-XR: File "${path.basename(filePath)}" - Language not supported for XR analysis`,
                );
                return;
            }

            await AnalysisOrchestrator.orchestrateAnalysis(filePath, 'XR', 'file', this.context, false);
        } catch (error) {
            logger.error('Error in XR file analysis:', error);
            void vscode.window.showErrorMessage(`Code-XR: XR analysis failed - ${error}`);
        }
    }
}

