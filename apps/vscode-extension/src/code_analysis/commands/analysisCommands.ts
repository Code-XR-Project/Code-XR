/**
 * New Code Analysis Commands
 * Command metadata collector for the new analysis module.
 */

import * as vscode from 'vscode';
import { AnalysisSettingsCommands } from './subsections/analysis_settings/analysisSettingsCommands';
import { ActiveAnalysesCommandRegistrations } from './subsections/active_analyses/activeAnalysesCommands';
import { ProjectByLanguageCommands } from './subsections/project_by_language/projectByLanguageCommands';
import { FilesByLanguageCommands } from './subsections/files_by_language/filesByLanguageCommands';
import { FileAnalysisCommands } from './file_analysis/fileAnalysisCommands';
import { DirectoryAnalysisCommands } from './directory_analysis/directoryAnalysisCommands';
import { ProjectAnalysisCommands } from './directory_analysis/projectAnalysisCommands';
import { DOMVisualizationCommands } from './dom_visualization/domVisualizationCommands';
import { CommandRegistration } from './subsections/analysis_settings/analysis_file_mode/analysisFileModeCommands';
import { AnalysisFileSetting } from '../views/subsections/analysis_settings/analysis_file_mode/analysisFileMode';
import { AnalysisDirectorySetting } from '../views/subsections/analysis_settings/analysis_directory_mode/analysisDirectoryMode';
import { ViewThemeSetting } from '../views/subsections/analysis_settings/view_theme/viewTheme';
import { AutoAnalysisDelaySetting } from '../views/subsections/analysis_settings/auto_analysis_delay/autoAnalysisDelay';
import { AutoAnalysisEnabledSetting } from '../views/subsections/analysis_settings/auto_analysis_enabled/autoAnalysisEnabled';
import { ChartTypeFileSetting } from '../views/subsections/analysis_settings/chart_type_file/chartTypeFile';
import { ChartTypeDirectorySetting } from '../views/subsections/analysis_settings/chart_type_directory/chartTypeDirectory';
import { DimensionMappingFileSetting } from '../views/subsections/analysis_settings/dimension_mapping_file/dimensionMappingFile';
import { DimensionMappingDirectorySetting } from '../views/subsections/analysis_settings/dimension_mapping_directory/dimensionMappingDirectory';
import { FilesByLanguageSortingSetting } from '../views/subsections/analysis_settings/files_by_language_sorting/filesByLanguageSorting';
import { ProfileConfigurationSetting } from '../views/subsections/analysis_settings/profile_configuration/profileConfiguration';
import { AnalysisConfigurationStorage } from '../configuration/analysisConfigurationStorage';
import { getLogger } from '../../platform/logging/sink';

const logger = getLogger('ANALYSIS');

export class CodeAnalysisCommands {
    static getCommandRegistrations(
        context: vscode.ExtensionContext,
        refreshCallback?: () => void,
    ): CommandRegistration[] {
        logger.debug('Collecting all command registrations');

        const defaultRefreshCallback = refreshCallback ?? (() => {
            logger.debug('Default refresh callback executed');
        });

        const tempAnalysisFileSetting = new AnalysisFileSetting(context);
        const tempAnalysisDirectorySetting = new AnalysisDirectorySetting(context);
        const tempViewThemeSetting = new ViewThemeSetting(context);
        const tempAutoAnalysisDelaySetting = new AutoAnalysisDelaySetting(context);
        const tempAutoAnalysisEnabledSetting = new AutoAnalysisEnabledSetting(context);
        const tempChartTypeFileSetting = new ChartTypeFileSetting(context);
        const tempChartTypeDirectorySetting = new ChartTypeDirectorySetting(context);
        const tempDimensionMappingFileSetting = new DimensionMappingFileSetting(context);
        const tempDimensionMappingDirectorySetting = new DimensionMappingDirectorySetting(context);
        const tempFilesByLanguageSortingSetting = new FilesByLanguageSortingSetting(context);
        const storage = AnalysisConfigurationStorage.getInstance(context);
        const tempProfileConfigurationSetting = new ProfileConfigurationSetting(context, storage);

        const registrations: CommandRegistration[] = [];
        registrations.push(...AnalysisSettingsCommands.getCommandRegistrations(
            context,
            tempAnalysisFileSetting,
            tempAnalysisDirectorySetting,
            tempViewThemeSetting,
            tempAutoAnalysisDelaySetting,
            tempAutoAnalysisEnabledSetting,
            tempChartTypeFileSetting,
            tempChartTypeDirectorySetting,
            tempDimensionMappingFileSetting,
            tempDimensionMappingDirectorySetting,
            tempFilesByLanguageSortingSetting,
            tempProfileConfigurationSetting,
            defaultRefreshCallback,
        ));
        registrations.push(...ActiveAnalysesCommandRegistrations.getCommandRegistrations(context, defaultRefreshCallback));
        registrations.push(...ProjectByLanguageCommands.getCommandRegistrations(context, defaultRefreshCallback));
        registrations.push(...FilesByLanguageCommands.getCommandRegistrations(context));
        registrations.push(...FileAnalysisCommands.getCommandRegistrations(context));
        registrations.push(...DirectoryAnalysisCommands.getCommandRegistrations(context));
        registrations.push(...ProjectAnalysisCommands.getCommandRegistrations(context));
        registrations.push(...DOMVisualizationCommands.getCommandRegistrations(context, defaultRefreshCallback));

        return registrations;
    }
}

