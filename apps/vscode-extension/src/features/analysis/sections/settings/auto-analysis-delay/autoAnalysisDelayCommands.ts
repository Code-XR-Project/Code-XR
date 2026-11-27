/**
 * Auto-Analysis Delay Commands
 * Commands specific to the Auto-Analysis Delay setting
 */

import * as vscode from 'vscode';
import { AutoAnalysisDelaySetting } from './autoAnalysisDelay';
import { CommandRegistration } from '../analysis-file-mode/analysisFileModeCommands';
import { SessionWatcherManager } from '../../../../../core/analysis/watchers/sessionWatcherManager';
import { getLogger } from '../../../../../platform/logging/sink';

const logger = getLogger('ANALYSIS');

export class AutoAnalysisDelayCommands {

    constructor(
        private context: vscode.ExtensionContext,
        private autoAnalysisDelaySetting: AutoAnalysisDelaySetting
    ) {}

    /**
     * Get command registrations (don't register them yet)
     * This follows the "nested dolls" architecture pattern
     */
    static getCommandRegistrations(
        context: vscode.ExtensionContext, 
        autoAnalysisDelaySetting: AutoAnalysisDelaySetting,
        refreshCallback: () => void
    ): CommandRegistration[] {
        const commands = new AutoAnalysisDelayCommands(context, autoAnalysisDelaySetting);

        return [
            {
                commandId: 'codeXR.analysis.selectAutoAnalysisDelay',
                callback: () => commands.selectAutoAnalysisDelay(refreshCallback),
                description: 'Select Auto-Analysis Delay from options'
            }
        ];
    }

    /**
     * Select auto-analysis delay from QuickPick command handler
     */
    private async selectAutoAnalysisDelay(refreshCallback: () => void): Promise<void> {
        try {
            const predefinedItems = [
                {
                    label: 'Real Time (0s)',
                    description: 'Instant analysis as you type',
                    detail: 'No delay - immediate response',
                    value: 'RealTime' as const
                },
                {
                    label: '1 Second',
                    description: 'Short delay for quick feedback',
                    detail: '1000ms delay',
                    value: '1s' as const
                },
                {
                    label: '3 Seconds',
                    description: 'Balanced delay for most users',
                    detail: '3000ms delay',
                    value: '3s' as const
                },
                {
                    label: '5 Seconds',
                    description: 'Longer delay for complex analysis',
                    detail: '5000ms delay',
                    value: '5s' as const
                },
                {
                    label: '10 Seconds',
                    description: 'Maximum predefined delay',
                    detail: '10000ms delay',
                    value: '10s' as const
                },
                {
                    label: 'Custom Value...',
                    description: 'Set your own delay (0-20000ms)',
                    detail: 'Enter custom milliseconds',
                    value: 'Custom' as const
                }
            ];

            const selectedItem = await vscode.window.showQuickPick(predefinedItems, {
                placeHolder: 'Select auto-analysis delay timing',
                title: 'Auto-Analysis Delay Configuration',
                matchOnDescription: true,
                matchOnDetail: true
            });

            if (!selectedItem) {
                return;
            }

            if (selectedItem.value === 'Custom') {
                await this.setCustomAutoAnalysisDelay(refreshCallback);
            } else {
                await this.setAutoAnalysisDelay(selectedItem.value, refreshCallback);
            }
        } catch (error) {
            logger.error('Error selecting auto-analysis delay:', error);
            void vscode.window.showErrorMessage(`Failed to select auto-analysis delay: ${error}`);
        }
    }

    private async refreshActiveWatchers(): Promise<void> {
        await SessionWatcherManager.refreshActiveWatcherConfigurations(this.context);
    }

    /**
     * Set custom auto-analysis delay command handler
     */
    private async setCustomAutoAnalysisDelay(refreshCallback: () => void): Promise<void> {
        try {
            const input = await vscode.window.showInputBox({
                prompt: 'Enter custom auto-analysis delay in milliseconds (0-20000)',
                placeHolder: '1000',
                validateInput: (value) => {
                    const num = parseInt(value);
                    if (isNaN(num)) {
                        return 'Please enter a valid number';
                    }
                    if (num < 0 || num > 20000) {
                        return 'Delay must be between 0 and 20000 milliseconds (20 seconds)';
                    }
                    return null;
                }
            });

            if (input === undefined) {
                return;
            }

            const customMs = parseInt(input);
            await this.autoAnalysisDelaySetting.setCustomDelay(customMs);
            await this.refreshActiveWatchers();

            void vscode.window.showInformationMessage(
                `Auto-analysis delay set to custom: ${customMs}ms`,
                { modal: false }
            );

            refreshCallback();

            logger.debug(() => `Command executed - Custom auto-analysis delay: ${customMs}ms`);
        } catch (error) {
            logger.error('Error setting custom auto-analysis delay:', error);
            void vscode.window.showErrorMessage(`Failed to set custom auto-analysis delay: ${error}`);
        }
    }

    /**
     * Set specific auto-analysis delay command handler
     */
    private async setAutoAnalysisDelay(
        delayType: 'RealTime' | '1s' | '3s' | '5s' | '10s', 
        refreshCallback: () => void
    ): Promise<void> {
        try {
            await this.autoAnalysisDelaySetting.setDelay(delayType);
            await this.refreshActiveWatchers();

            void vscode.window.showInformationMessage(
                `Auto-analysis delay set to: ${delayType}`,
                { modal: false }
            );

            refreshCallback();

            logger.debug(() => `Command executed - Auto-analysis delay set to: ${delayType}`);
        } catch (error) {
            logger.error(`Error setting auto-analysis delay to ${delayType}:`, error);
            void vscode.window.showErrorMessage(`Failed to set auto-analysis delay to ${delayType}: ${error}`);
        }
    }
}
