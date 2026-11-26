import * as vscode from 'vscode';
import { registerAllCommands } from './app/commands/registerAllCommands';
import { initializePythonEnvOnStartup } from './features/python-env/commands/pythonEnvCommandRegistrations';
import { XRFieldSchemaService } from './core/analysis/python/xrFieldSchemaService';
import { ModularTreeDataProvider } from './app/sidebar/ModularTreeDataProvider';
import { CommonCommands } from './app/sidebar/commonCommands';
import { ServerSettingsManager } from './core/server/serverSettingsManager';
import { GeneratedHttpsCertificateManager } from './core/server/generatedHttpsCertificateManager';
import { getActiveServerRegistry } from './core/server/registry/activeServerRegistry';
import { ServerControl } from './core/server/serverControl';
import { sseManager } from './core/server/sse/SSEManager';
import { fileToServerMap } from './core/server/fileToServerMap';
import { ServerWatcherIntegration } from './features/analysis/services/serverWatcherIntegration';
import { CleanAnalysisCommands } from './features/analysis/commands/cleanAnalysisCommands';
import { AnalysisConfigurationStorage } from './core/analysis/configuration/analysisConfigurationStorage';
import { handleError, ErrorDomain, ErrorSeverity } from './platform/ui/errorHandler';
import { initializeExtensionContext } from './platform/extensionContext';
import { initializeHost } from './core/host/hostRegistry';
import { createVSCodeHost } from './app/host/vscodeHost';
import { setLaunchNotifier } from './core/server/launchNotifier';
import * as launchNotifications from './features/active-servers/views/launchNotifications';
import { setServerPanelCloser } from './core/server/serverPanels';
import { getPanelManager } from './platform/webview/panelManager';
import { CodeXRLogger } from './platform/logging/logger';
import { StartupCoordinator } from './app/startup/startupCoordinator';
import { CollaborationProfileManager } from './core/collaboration/collaborationProfileManager';
import { RemoteAccessManager } from './core/remote-access/remoteAccessManager';

const startupLogger = CodeXRLogger.getLogger('STARTUP');

let globalModularTreeDataProvider: ModularTreeDataProvider | null = null;

export async function activate(context: vscode.ExtensionContext) {
    const activationStartedAt = Date.now();

    initializeExtensionContext(context);
    initializeHost(createVSCodeHost(context));
    setLaunchNotifier(launchNotifications);
    setServerPanelCloser({ closeServerPanels: (serverIds) => getPanelManager().removePanelsForServers([...serverIds]) });
    CodeXRLogger.initialize(context);

    startupLogger.info('Activating CodeXR.');

    try {
        AnalysisConfigurationStorage.initialize(context);
        CollaborationProfileManager.initialize(context);
        RemoteAccessManager.initialize(context);

        const settingsManager = ServerSettingsManager.getInstance(context);
        getActiveServerRegistry();
        ServerControl.initialize(context);

        const modularTreeDataProvider = new ModularTreeDataProvider(context);
        globalModularTreeDataProvider = modularTreeDataProvider;

        const modularTreeView = vscode.window.createTreeView('codexrTree', {
            treeDataProvider: modularTreeDataProvider,
            showCollapseAll: true,
            canSelectMany: false,
        });

        context.subscriptions.push(modularTreeView);
        CommonCommands.setModularTreeProvider(modularTreeDataProvider);
        registerAllCommands(context, modularTreeDataProvider, undefined);

        const startupCoordinator = new StartupCoordinator(
            CodeXRLogger.getLogger('STARTUP_DEFERRED'),
            undefined,
            { maxConcurrent: 3 },
        );
        
        context.subscriptions.push({
            dispose: () => startupCoordinator.dispose(),
        });
        const xrFieldSchemaService = XRFieldSchemaService.getInstance(context);

        startupCoordinator.schedule({
            id: 'restore-server-settings',
            run: async () => {
                await settingsManager.ensureInitialized();
                await new GeneratedHttpsCertificateManager(context).ensureDefaultCertificatePair();
                modularTreeDataProvider.refreshSection('SERVERS');
            },
        });

        startupCoordinator.schedule({
            id: 'initialize-server-watcher-integration',
            run: async () => {
                ServerWatcherIntegration.initialize(context);
            },
        });

        startupCoordinator.schedule({
            id: 'initialize-python-env',
            run: async () => {
                await initializePythonEnvOnStartup();
                await xrFieldSchemaService.prefetchAll();
                modularTreeDataProvider.refreshSection('pythonEnv');
                modularTreeDataProvider.refreshSection('analysis');
            },
        });

        startupCoordinator.schedule({
            id: 'cleanup-stale-analysis-artifacts',
            run: async () => {
                await CleanAnalysisCommands.executeStartupCleanup(context, activationStartedAt);
            },
        });

        startupCoordinator.start();
        startupLogger.info('CodeXR activation completed. Deferred startup tasks queued.');
    } catch (error) {
        startupLogger.error('Extension activation failed.', error);
        void vscode.window.showErrorMessage(`CodeXR activation failed: ${error}`);
    }
}

export async function deactivate() {
    startupLogger.info('Deactivating CodeXR.');

    try {
        await RemoteAccessManager.getInstance()?.stopAll();
    } catch (error) {
        handleError(ErrorDomain.ActiveServers, 'Remote access cleanup', error, ErrorSeverity.Warn);
    }

    try {
        const registry = getActiveServerRegistry();
        const cleanedCount = registry.cleanupInactiveServers();
        startupLogger.debug(() => `Active server registry cleanup removed ${cleanedCount} inactive servers.`);
    } catch (error) {
        handleError(ErrorDomain.ActiveServers, 'Registry cleanup', error, ErrorSeverity.Warn);
    }

    try {
        sseManager.dispose();
        fileToServerMap.clearAll();
    } catch (error) {
        handleError(ErrorDomain.SSE, 'SSE and file mapping cleanup', error, ErrorSeverity.Warn);
    }

    try {
        if (globalModularTreeDataProvider) {
            globalModularTreeDataProvider.dispose();
            globalModularTreeDataProvider = null;
        }
    } catch (error) {
        handleError(ErrorDomain.UI, 'Modular tree cleanup', error, ErrorSeverity.Warn);
    }
}







