import * as vscode from 'vscode';
import { getServerCommandRegistrations } from '../../features/servers/commands/serverCommandRegistrations';
import { getActiveServersCommandRegistrations } from '../../features/active-servers/commands/activeServersCommandRegistrations';
import { getBabiaExamplesCommandRegistrations } from '../../features/examples/commands/babiaExamplesCommandRegistrations';
import { getVisualizeDataCommandRegistrations } from '../../features/visualize-data/commands/visualizeDataCommandRegistrations';
import { getAnalysisCommandRegistrations } from '../../features/analysis/commands/analysisCommandRegistrations';
import { getPythonEnvCommandRegistrations } from '../../features/python-env/commands/pythonEnvCommandRegistrations';
import { getVisualizationSettingsCommandRegistrations } from '../../features/visualization-settings/commands/visualizationSettingsCommandRegistrations';
import { getLearnMoreCommandRegistrations } from '../../features/learn-more/commands/learnMoreCommandRegistrations';
import { getAgentFlowCommandRegistrations } from '../../features/ai-agents/commands/agentFlowCommands';
import { getGeneralCommandRegistrations } from './generalCommands';
import { getCollaborationCommandRegistrations } from '../../features/collaboration/commands/collaborationCommands';
import { ExtensionCommandRegistration, assertUniqueCommandIds } from '../../platform/commands/commandRegistry';
import { CommandBuilder } from '../../platform/commands/commandBuilder';
import { BabiaExamplesTreeDataProvider } from '../../features/examples/views/babiaExamplesTreeView';
import { CodeXRLogger } from '../../platform/logging/logger';
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
        ...getAgentFlowCommandRegistrations(),
    ];
    assertUniqueCommandIds(registrations);
    CommandBuilder.registerAll(context, registrations);
}

