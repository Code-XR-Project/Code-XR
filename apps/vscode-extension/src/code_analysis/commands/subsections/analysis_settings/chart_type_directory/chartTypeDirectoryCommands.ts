/**
 * Chart Type Directory Commands
 * Commands specific to the Chart Type (Directory) setting
 */

import * as vscode from 'vscode';
import { ChartTypeDirectorySetting } from '../../../../views/subsections/analysis_settings/chart_type_directory';
import { CommandRegistration } from '../analysis_file_mode';
import { createChartTypeCommands } from '../chart_type_shared/chartTypeCommandFactory';
import { getLogger } from '../../../../../core/logging/sink';

const logger = getLogger('CHART_TYPE_DIRECTORY_COMMANDS');

export class ChartTypeDirectoryCommands {
    /**
     * Get command registrations (don't register them yet)
     * This follows the "nested dolls" architecture pattern
     */
    static getCommandRegistrations(
        _context: vscode.ExtensionContext,
        chartTypeDirectorySetting: ChartTypeDirectorySetting,
        refreshCallback: () => void
    ): CommandRegistration[] {
        return createChartTypeCommands({
            commandId: 'codeXR.analysis.selectChartTypeDirectory',
            description: 'Select chart type for directory analysis visualization',
            showSelection: () => chartTypeDirectorySetting.showChartTypeSelection(),
            refreshCallback,
            logger,
            reportError: (error) => {
                logger.error('Error in chart type selection:', error);
                void vscode.window.showErrorMessage(`Failed to select chart type: ${error instanceof Error ? error.message : String(error)}`);
            },
        });
    }
}
