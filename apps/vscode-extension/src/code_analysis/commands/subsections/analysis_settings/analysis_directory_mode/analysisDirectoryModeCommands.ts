/**
 * Analysis Directory Mode Commands
 * Command handlers for the analysis directory mode setting
 */

import * as vscode from 'vscode';
import { AnalysisDirectorySetting } from '../../../../views/subsections/analysis_settings/analysis_directory_mode/analysisDirectoryMode';
import { CommandRegistration } from '../analysis_file_mode/analysisFileModeCommands';
import { getLogger } from '../../../../../core/logging/sink';

const logger = getLogger('ANALYSIS');

export class AnalysisDirectoryModeCommands {

    /**
     * Get command registrations for analysis directory mode (nested dolls pattern)
     */
    static getCommandRegistrations(
        _context: vscode.ExtensionContext,
        analysisDirectorySetting: AnalysisDirectorySetting,
        refreshCallback: () => void
    ): CommandRegistration[] {
        logger.debug('Collecting Analysis Directory Mode command registrations');

        const commandRegistrations: CommandRegistration[] = [
            {
                commandId: 'codeXR.analysis.selectAnalysisDirectoryMode',
                callback: async () => {
                    try {
                        logger.debug('Select Analysis Directory Mode command executed');
                        
                        const selectedMode = await analysisDirectorySetting.selectMode();
                        
                        if (selectedMode) {
                            const modeText = selectedMode.includes('Deep') 
                                ? `${selectedMode.replace('Deep', '')} Deep`
                                : selectedMode;
                            
                            void vscode.window.showInformationMessage(
                                `Directory analysis mode set to: ${modeText}`, 
                                'OK'
                            );
                            
                            // Refresh tree to show updated state
                            refreshCallback();
                        }
                        
                    } catch (error) {
                        logger.error('Error selecting analysis directory mode:', error);
                        void vscode.window.showErrorMessage(
                            `Failed to select directory analysis mode: ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                },
                description: 'Select between LivePanel, LivePanelDeep, XR, and XRDeep modes for directory analysis'
            }
        ];

        logger.debug(() => `Collected ${commandRegistrations.length} Analysis Directory Mode command registrations`);
        return commandRegistrations;
    }
}

