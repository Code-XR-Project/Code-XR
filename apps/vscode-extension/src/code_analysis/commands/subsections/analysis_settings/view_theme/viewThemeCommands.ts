/**
 * View Theme Commands
 * Commands specific to the View Theme setting
 */

import * as vscode from 'vscode';
import { ViewThemeSetting } from '../../../../views/subsections/analysis_settings/view_theme';
import { CommandRegistration } from '../analysis_file_mode';

export class ViewThemeCommands {

    constructor(
        context: vscode.ExtensionContext,
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
            console.log('VIEW_THEME_COMMAND: Starting toggle view theme command');
            const newTheme = await this.viewThemeSetting.toggleTheme();
            
            // Show notification to user
            vscode.window.showInformationMessage(
                `View theme switched to: ${newTheme}`,
                { modal: false }
            );

            console.log('VIEW_THEME_COMMAND: About to call refreshCallback');
            // Refresh the tree view to show updated state
            refreshCallback();
            console.log('VIEW_THEME_COMMAND: refreshCallback executed');

            console.log(`ANALYSIS: Command executed - View theme: ${newTheme}`);
            
        } catch (error) {
            console.error('ANALYSIS: Error toggling view theme:', error);
            vscode.window.showErrorMessage(`Failed to toggle view theme: ${error}`);
        }
    }
}

