/**
 * Auto-Analysis Enabled Commands
 * Commands specific to the Auto-Analysis Enabled setting
 */

import * as vscode from 'vscode';
import { AutoAnalysisEnabledSetting } from '../../../../views/subsections/analysis_settings/auto_analysis_enabled/autoAnalysisEnabled';
import { CommandRegistration } from '../analysis_file_mode/analysisFileModeCommands';
import { SessionWatcherManager } from '../../../../engine/watchers/sessionWatcherManager';
import { getLogger } from '../../../../../platform/logging/sink';

const logger = getLogger('ANALYSIS');

export class AutoAnalysisEnabledCommands {

    constructor(
        private context: vscode.ExtensionContext,
        private autoAnalysisEnabledSetting: AutoAnalysisEnabledSetting
    ) {}

    /**
     * Get command registrations (don't register them yet)
     * This follows the "nested dolls" architecture pattern
     */
    static getCommandRegistrations(
        context: vscode.ExtensionContext, 
        autoAnalysisEnabledSetting: AutoAnalysisEnabledSetting,
        refreshCallback: () => void
    ): CommandRegistration[] {
        const commands = new AutoAnalysisEnabledCommands(context, autoAnalysisEnabledSetting);

        return [
            {
                commandId: 'codeXR.analysis.toggleAutoAnalysisEnabled',
                callback: () => commands.toggleAutoAnalysisEnabled(refreshCallback),
                description: 'Toggle Auto-Analysis Enabled/Disabled state'
            }
        ];
    }

    private async refreshActiveWatchers(): Promise<void> {
        await SessionWatcherManager.refreshActiveWatcherConfigurations(this.context);
    }

    /**
     * Toggle auto-analysis enabled state command handler
     */
    private async toggleAutoAnalysisEnabled(refreshCallback: () => void): Promise<void> {
        try {
            logger.debug('Toggling auto-analysis enabled state');
            
            const newState = await this.autoAnalysisEnabledSetting.toggleEnabled();
            await this.refreshActiveWatchers();
            logger.debug(() => `Auto-analysis enabled toggled to: ${newState}`);
            
            refreshCallback();
            
        } catch (error) {
            logger.error('Error toggling auto-analysis enabled state:', error);
            void vscode.window.showErrorMessage(`Failed to toggle auto-analysis state: ${error}`);
        }
    }
}
