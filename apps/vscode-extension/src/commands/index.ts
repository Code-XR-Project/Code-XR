import * as vscode from 'vscode';
import { getServerCommandRegistrations } from './servers/serverCommands';
import { getActiveServersCommandRegistrations } from './active_servers/activeServersCommands';
import { getBabiaExamplesCommandRegistrations } from './babia_examples/babiaExamplesCommands';
import { getVisualizeDataCommandRegistrations } from './visualize_data/visualizeDataCommands';
import { getAnalysisCommandRegistrations } from './analysis/AnalysisCommands';
import { getPythonEnvCommandRegistrations } from './python_env/pythonEnvCommands';
import { getVisualizationSettingsCommandRegistrations } from './visualization_settings/visualizationSettingsCommands';
import { getLearnMoreCommandRegistrations } from '../features/learn-more/commands/learnMoreCommandRegistrations';
import { getGeneralCommandRegistrations } from './common/generalCommands';
import { getCollaborationCommandRegistrations } from './collaboration/collaborationCommands';
import { ExtensionCommandRegistration, assertUniqueCommandIds } from '../platform/commands/commandRegistry';
import { CommandBuilder } from '../platform/commands/commandBuilder';
import { BabiaExamplesTreeDataProvider } from '../babia_examples/views/babiaExamplesTreeView';
import { CodeXRLogger } from '../platform/logging/logger';
interface RefreshableTreeProvider {
    refresh(): void;
    refreshSection?(sectionName: string): void;
}
const logger = CodeXRLogger.getLogger('COMMAND_REGISTRATION');
export function registerAllCommands(
    context: vscode.ExtensionContext,
    treeDataProvider?: RefreshableTreeProvider,
    babiaExamplesTreeDataProvider?: BabiaExamplesTreeDataProvider,
): void {
    const analysisRefreshCallback = () => {
        if (!treeDataProvider) {
            return;
        }
        if ('getSectionProvider' in treeDataProvider) {
            const sectionProvider = (treeDataProvider as any).getSectionProvider('analysis');
            if (sectionProvider && typeof sectionProvider.refresh === 'function') {
                logger.debug('Refreshing ANALYSIS through its section provider.');
                sectionProvider.refresh();
                return;
            }
        }
        logger.debug('Refreshing the modular tree through the shared tree provider.');
        treeDataProvider.refresh();
    };
    const registrations: ExtensionCommandRegistration[] = [
        ...getGeneralCommandRegistrations(),
        ...getServerCommandRegistrations(context),
        ...getActiveServersCommandRegistrations(treeDataProvider),
        ...getBabiaExamplesCommandRegistrations(context, babiaExamplesTreeDataProvider),
        ...getVisualizeDataCommandRegistrations(context),
        ...getAnalysisCommandRegistrations(context, analysisRefreshCallback),
        ...getPythonEnvCommandRegistrations(context),
        ...getVisualizationSettingsCommandRegistrations(context),
        ...getCollaborationCommandRegistrations(context, treeDataProvider),
        ...getLearnMoreCommandRegistrations(context),
    ];
    assertUniqueCommandIds(registrations);
    CommandBuilder.registerAll(context, registrations);
}

