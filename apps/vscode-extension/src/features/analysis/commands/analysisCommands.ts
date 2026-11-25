/**
 * New Code Analysis Commands
 * Command metadata collector for the new analysis module.
 */

import * as vscode from 'vscode';
import { AnalysisSettingsCommands } from '../sections/settings/analysisSettingsCommands';
import { ActiveAnalysesCommandRegistrations } from '../sections/active-analyses/activeAnalysesCommandRegistrations';
import { ProjectByLanguageCommands } from '../sections/project-by-language/projectByLanguageCommands';
import { FilesByLanguageCommands } from '../sections/files-by-language/filesByLanguageCommands';
import { FileAnalysisCommands } from './file/fileAnalysisCommands';
import { DirectoryAnalysisCommands } from './directory/directoryAnalysisCommands';
import { ProjectAnalysisCommands } from './directory/projectAnalysisCommands';
import { DOMVisualizationCommands } from './dom/domVisualizationCommands';
import { CommandRegistration } from '../sections/settings/analysis-file-mode/analysisFileModeCommands';
import { AnalysisFileSetting } from '../sections/settings/analysis-file-mode/analysisFileMode';
import { AnalysisDirectorySetting } from '../sections/settings/analysis-directory-mode/analysisDirectoryMode';
import { ViewThemeSetting } from '../sections/settings/view-theme/viewTheme';
import { AutoAnalysisDelaySetting } from '../sections/settings/auto-analysis-delay/autoAnalysisDelay';
import { AutoAnalysisEnabledSetting } from '../sections/settings/auto-analysis-enabled/autoAnalysisEnabled';
import { ChartTypeFileSetting } from '../sections/settings/chart-type-file/chartTypeFile';
import { ChartTypeDirectorySetting } from '../sections/settings/chart-type-directory/chartTypeDirectory';
import { DimensionMappingFileSetting } from '../sections/settings/dimension-mapping-file/dimensionMappingFile';
import { DimensionMappingDirectorySetting } from '../sections/settings/dimension-mapping-directory/dimensionMappingDirectory';
import { FilesByLanguageSortingSetting } from '../sections/settings/files-by-language-sorting/filesByLanguageSorting';
import { ProfileConfigurationSetting } from '../sections/settings/profile-configuration/profileConfiguration';
import { AnalysisConfigurationStorage } from '../../../core/analysis/configuration/analysisConfigurationStorage';
import { getLogger } from '../../../platform/logging/sink';

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

