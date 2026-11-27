/**
 * Dimension Mapping Directory Commands
 * Commands specific to the Dimension Mapping (Directory) setting
 */

import * as vscode from 'vscode';
import { DimensionMappingDirectorySetting } from './dimensionMappingDirectory';
import { CommandRegistration } from '../analysis-file-mode/analysisFileModeCommands';
import { getLogger } from '../../../../../platform/logging/sink';

const logger = getLogger('DIMENSION_MAPPING_DIRECTORY_COMMANDS');

export class DimensionMappingDirectoryCommands {
    constructor(private readonly dimensionMappingDirectorySetting: DimensionMappingDirectorySetting) {}

    static getCommandRegistrations(
        context: vscode.ExtensionContext,
        dimensionMappingDirectorySetting: DimensionMappingDirectorySetting,
        refreshCallback: () => void,
    ): CommandRegistration[] {
        void context;
        const commands = new DimensionMappingDirectoryCommands(dimensionMappingDirectorySetting);

        return [
            {
                commandId: 'codeXR.analysis.selectDimensionMappingDirectory',
                callback: async (dimensionName: string) => {
                    await commands.selectDimensionMapping(dimensionName);
                    refreshCallback();
                },
                description: 'Select dimension mapping for directory analysis visualization',
            },
        ];
    }

    private async selectDimensionMapping(dimensionName: string): Promise<void> {
        try {
            await this.dimensionMappingDirectorySetting.showDimensionMappingSelection(dimensionName);
        } catch (error) {
            logger.error('Error in selectDimensionMapping:', error);
            void vscode.window.showErrorMessage(`Failed to show dimension mapping selection: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
