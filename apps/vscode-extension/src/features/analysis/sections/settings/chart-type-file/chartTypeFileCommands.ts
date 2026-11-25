/**
 * Chart Type File Commands
 * Commands specific to the Chart Type (File) setting
 */

import * as vscode from 'vscode';
import { ChartTypeFileSetting } from './chartTypeFile';
import { CommandRegistration } from '../analysis-file-mode/analysisFileModeCommands';
import { createChartTypeCommands } from '../chartTypeCommandFactory';
import { getLogger } from '../../../../../platform/logging/sink';

const logger = getLogger('CHART_TYPE_FILE_COMMANDS');

export class ChartTypeFileCommands {
    /**
     * Get command registrations (don't register them yet)
     * This follows the "nested dolls" architecture pattern
     */
    static getCommandRegistrations(
        _context: vscode.ExtensionContext,
        chartTypeFileSetting: ChartTypeFileSetting,
        refreshCallback: () => void
    ): CommandRegistration[] {
        return createChartTypeCommands({
            commandId: 'codeXR.analysis.selectChartTypeFile',
            description: 'Select chart type for file analysis visualization',
            showSelection: () => chartTypeFileSetting.showChartTypeSelection(),
            refreshCallback,
            logger,
            reportError: (error) => {
                logger.error('Error selecting chart type:', error);
                void vscode.window.showErrorMessage(`Failed to select chart type: ${error}`);
            },
        });
    }
}
