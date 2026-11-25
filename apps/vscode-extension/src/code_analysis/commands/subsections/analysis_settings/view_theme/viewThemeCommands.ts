/**
 * View Theme Commands
 * Commands specific to the View Theme setting
 */

import * as vscode from 'vscode';
import { ViewThemeSetting } from '../../../../views/subsections/analysis_settings/view_theme';
import { CommandRegistration } from '../analysis_file_mode';
import { getLogger } from '../../../../../core/logging/sink';

const logger = getLogger('VIEW_THEME_COMMAND');

export class ViewThemeCommands {

    constructor(
        _context: vscode.ExtensionContext,
        private viewThemeSetting: ViewThemeSetting
    ) {}

    /**
     * Get command registrations (don't register them yet)
     * This follows the "nested dolls" architecture pattern
     */
    static getCommandRegistrations(
        context: vscode.ExtensionContext, 
        viewThemeSetting: ViewThemeSetting,
        refreshCallback: () => void
    ): CommandRegistration[] {
        const commands = new ViewThemeCommands(context, viewThemeSetting);

        return [
            {
                commandId: 'codeXR.analysis.toggleViewTheme',
                callback: () => commands.toggleViewTheme(refreshCallback),
                description: 'Toggle View Theme between Dark and Light'
            }
        ];
    }

    /**
     * Toggle view theme command handler
     */
    private async toggleViewTheme(refreshCallback: () => void): Promise<void> {
        try {
            logger.debug('Starting toggle view theme command');
            const newTheme = await this.viewThemeSetting.toggleTheme();
            
            // Show notification to user
            vscode.window.showInformationMessage(
                `View theme switched to: ${newTheme}`,
                { modal: false }
            );

            logger.debug('About to call refreshCallback');
            // Refresh the tree view to show updated state
            refreshCallback();
            logger.debug('refreshCallback executed');

            logger.debug(() => `ANALYSIS: Command executed - View theme: ${newTheme}`);
            
        } catch (error) {
            logger.error('ANALYSIS: Error toggling view theme:', error);
            vscode.window.showErrorMessage(`Failed to toggle view theme: ${error}`);
        }
    }
}

