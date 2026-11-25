/**
 * Analysis Settings Commands Coordinator
 * Coordinates all commands for the Analysis Settings subsection
 */

import * as vscode from 'vscode';
import { AnalysisFileSetting } from './analysis-file-mode/analysisFileMode';
import { AnalysisDirectorySetting } from './analysis-directory-mode/analysisDirectoryMode';
import { ViewThemeSetting } from './view-theme/viewTheme';
import { AutoAnalysisDelaySetting } from './auto-analysis-delay/autoAnalysisDelay';
import { AutoAnalysisEnabledSetting } from './auto-analysis-enabled/autoAnalysisEnabled';
import { ChartTypeFileSetting } from './chart-type-file/chartTypeFile';
import { ChartTypeDirectorySetting } from './chart-type-directory/chartTypeDirectory';
import { DimensionMappingFileSetting } from './dimension-mapping-file/dimensionMappingFile';
import { DimensionMappingDirectorySetting } from './dimension-mapping-directory/dimensionMappingDirectory';
import { FilesByLanguageSortingSetting } from './files-by-language-sorting/filesByLanguageSorting';
import { ProfileConfigurationSetting } from './profile-configuration/profileConfiguration';
import { AnalysisFileModeCommands, CommandRegistration } from './analysis-file-mode/analysisFileModeCommands';
import { AnalysisDirectoryModeCommands } from './analysis-directory-mode/analysisDirectoryModeCommands';
import { ViewThemeCommands } from './view-theme/viewThemeCommands';
import { AutoAnalysisDelayCommands } from './auto-analysis-delay/autoAnalysisDelayCommands';
import { AutoAnalysisEnabledCommands } from './auto-analysis-enabled/autoAnalysisEnabledCommands';
import { ChartTypeFileCommands } from './chart-type-file/chartTypeFileCommands';
import { ChartTypeDirectoryCommands } from './chart-type-directory/chartTypeDirectoryCommands';
import { DimensionMappingFileCommands } from './dimension-mapping-file/dimensionMappingFileCommands';
import { DimensionMappingDirectoryCommands } from './dimension-mapping-directory/dimensionMappingDirectoryCommands';
import { FilesByLanguageSortingCommands } from './files-by-language-sorting/filesByLanguageSortingCommands';
import { ProfileConfigurationCommands } from './profile-configuration/profileConfigurationCommands';
import { getLogger } from '../../../../platform/logging/sink';

const logger = getLogger('ANALYSIS');

export class AnalysisSettingsCommands {

    constructor(_context: vscode.ExtensionContext) {}

    /**
     * Get all analysis settings command registrations (nested dolls pattern)
     * Collects commands from all sub-components without registering them
     */
    static getCommandRegistrations(
        context: vscode.ExtensionContext, 
        analysisFileSetting: AnalysisFileSetting,
        analysisDirectorySetting: AnalysisDirectorySetting,
        viewThemeSetting: ViewThemeSetting,
        autoAnalysisDelaySetting: AutoAnalysisDelaySetting,
        autoAnalysisEnabledSetting: AutoAnalysisEnabledSetting,
        chartTypeFileSetting: ChartTypeFileSetting,
        chartTypeDirectorySetting: ChartTypeDirectorySetting,
        dimensionMappingFileSetting: DimensionMappingFileSetting,
        dimensionMappingDirectorySetting: DimensionMappingDirectorySetting,
        filesByLanguageSortingSetting: FilesByLanguageSortingSetting,
        profileConfigurationSetting: ProfileConfigurationSetting,
        refreshCallback: () => void
    ): CommandRegistration[] {
        logger.debug('Collecting Analysis Settings command registrations');

        const commandRegistrations: CommandRegistration[] = [];

        // Collect analysis file mode command registrations
        const fileModeCommands = AnalysisFileModeCommands.getCommandRegistrations(
            context, 
            analysisFileSetting, 
            refreshCallback
        );
        commandRegistrations.push(...fileModeCommands);

        // Collect analysis directory mode command registrations
        const directoryModeCommands = AnalysisDirectoryModeCommands.getCommandRegistrations(
            context,
            analysisDirectorySetting,
            refreshCallback
        );
        commandRegistrations.push(...directoryModeCommands);

        // Collect view theme command registrations
        const viewThemeCommands = ViewThemeCommands.getCommandRegistrations(
            context,
            viewThemeSetting,
            refreshCallback
        );
        commandRegistrations.push(...viewThemeCommands);

        // Collect chart type file command registrations
        const chartTypeFileCommands = ChartTypeFileCommands.getCommandRegistrations(
            context,
            chartTypeFileSetting,
            refreshCallback
        );
        commandRegistrations.push(...chartTypeFileCommands);

        // Collect chart type directory command registrations
        const chartTypeDirectoryCommands = ChartTypeDirectoryCommands.getCommandRegistrations(
            context,
            chartTypeDirectorySetting,
            refreshCallback
        );
        commandRegistrations.push(...chartTypeDirectoryCommands);

        // Collect dimension mapping file command registrations
        const dimensionMappingFileCommands = DimensionMappingFileCommands.getCommandRegistrations(
            context,
            dimensionMappingFileSetting,
            refreshCallback
        );
        commandRegistrations.push(...dimensionMappingFileCommands);

        // Collect dimension mapping directory command registrations
        const dimensionMappingDirectoryCommands = DimensionMappingDirectoryCommands.getCommandRegistrations(
            context,
            dimensionMappingDirectorySetting,
            refreshCallback
        );
        logger.debug(() => `ANALYSIS_SETTINGS_COMMANDS: Got ${dimensionMappingDirectoryCommands.length} dimension mapping directory commands`);
        commandRegistrations.push(...dimensionMappingDirectoryCommands);

        // Collect auto-analysis delay command registrations
        const autoAnalysisDelayCommands = AutoAnalysisDelayCommands.getCommandRegistrations(
            context,
            autoAnalysisDelaySetting,
            refreshCallback
        );
        commandRegistrations.push(...autoAnalysisDelayCommands);

        // Collect auto-analysis enabled command registrations
        const autoAnalysisEnabledCommands = AutoAnalysisEnabledCommands.getCommandRegistrations(
            context,
            autoAnalysisEnabledSetting,
            refreshCallback
        );
        commandRegistrations.push(...autoAnalysisEnabledCommands);

        // Collect files by language sorting command registrations
        const filesByLanguageSortingCommands = FilesByLanguageSortingCommands.getCommandRegistrations(
            context,
            filesByLanguageSortingSetting,
            refreshCallback
        );
        commandRegistrations.push(...filesByLanguageSortingCommands);

        // Collect profile configuration command registrations
        const profileConfigurationCommands = ProfileConfigurationCommands.getCommandRegistrations(
            context,
            profileConfigurationSetting,
            refreshCallback
        );
        commandRegistrations.push(...profileConfigurationCommands);

        logger.debug(() => `Collected ${commandRegistrations.length} Analysis Settings command registrations`);
        return commandRegistrations;
    }
}

