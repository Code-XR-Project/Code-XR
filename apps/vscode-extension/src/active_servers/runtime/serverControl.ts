import * as vscode from 'vscode';
import { ActiveServer } from '../model/activeServerModel';
import { getActiveServerRegistry } from '../registry/activeServerRegistry';
import { getPanelManager } from '../services/panelManager';
import { fileToServerMap } from '../../utils/fileToServerMap';
import { sseManager } from '../../servers/runtime/sse/SSEManager';
import { UnifiedSessionRegistry } from '../../code_analysis/engine/core/sessionRegistry';
import { handleError, ErrorDomain, ErrorSeverity } from '../../utils/errorHandler';

/** How long a graceful shutdown may take before it is forced. */
const STOP_TIMEOUT_MS = 4000;

/**
 * Server Control
 * Runtime operations for managing active servers
 */
export class ServerControl {
    private static extensionContext: vscode.ExtensionContext;
    
    /**
     * Initialize with extension context
     */
    public static initialize(context: vscode.ExtensionContext): void {
        ServerControl.extensionContext = context;
    }
    
    /**
     * Stop an active server
     */
    public static async stopServer(serverId: string): Promise<boolean> {
        console.log(`ACTIVE_SERVERS:  DEBUG - Attempting to stop server ${serverId}`);
        
        const registry = getActiveServerRegistry();
        const server = registry.getServer(serverId);
        
        if (!server) {
            console.error(`ACTIVE_SERVERS:  Server ${serverId} not found in registry`);
            vscode.window.showErrorMessage(`Server not found: ${serverId}`);
            return false;
        }

        console.log(`ACTIVE_SERVERS:  DEBUG - Server found:`, {
            id: server.id,
            port: server.port,
            url: server.url,
            status: server.status,
            launchMode: server.launchMode,
            customName: server.customName,
            htmlFile: server.htmlFile,
            metadata: server.metadata
        });

        try {
            // Close associated lateral panel if it exists
            const panelManager = getPanelManager();
            if (server.launchMode === 'lateralPanel' && panelManager.hasPanel(serverId)) {
                console.log(`ACTIVE_SERVER_PANEL:  DEBUG - Closing lateral panel for server ${serverId}`);
                panelManager.removePanel(serverId);
            }

            // Check if this server is associated with an analysis file and clean up
            console.log(`ACTIVE_SERVERS:  DEBUG - Checking for file-to-server mapping for server on port ${server.port}`);
            const fileUri = fileToServerMap.findFileByPort(server.port);
            if (fileUri) {
                console.log(`ACTIVE_SERVERS:  Found associated analysis file: ${fileUri}`);
                
                // Clean up SSE clients for this file
                console.log(`ACTIVE_SERVERS:  DEBUG - Cleaning up SSE clients for ${fileUri}`);
                sseManager.removeAllClients(fileUri);
                
                // Remove the file-to-server mapping
                console.log(`ACTIVE_SERVERS:  DEBUG - Removing file-to-server mapping for ${fileUri}`);
                fileToServerMap.unregisterMapping(fileUri);
            } else {
                console.log(`ACTIVE_SERVERS:  No associated analysis file found for server on port ${server.port}`);
            }

            // Close associated analysis session if it exists
            console.log(`ACTIVE_SERVERS:  DEBUG - Attempting to close associated analysis session`);
            await this.closeAssociatedAnalysisSession(serverId, server);

            // Update status to indicate stopping
            console.log(`ACTIVE_SERVERS:  DEBUG - Updating server status to 'stopped'`);
            registry.updateServerStatus(serverId, 'stopped');

            // Stop the actual server instance if available
            let cleanShutdown = true;
            if (server.serverInstance && typeof server.serverInstance.stop === 'function') {
                console.log(`ACTIVE_SERVERS:  DEBUG - Stopping server instance for ${serverId}`);
                cleanShutdown = await this.stopInstanceOrForce(serverId, server.serverInstance);
            } else {
                console.log(`ACTIVE_SERVERS:  No server instance or stop method for ${serverId}`);
            }

            console.log(`ACTIVE_SERVERS:  Stopped server ${serverId} (${server.url}), clean: ${cleanShutdown}`);
            if (cleanShutdown) {
                vscode.window.showInformationMessage(`Server stopped: ${server.url}`);
            }

            return cleanShutdown;

        } catch (error) {
            handleError(ErrorDomain.ActiveServers, `Failed to stop server ${server.url}`, error, ErrorSeverity.User);
            return false;
        } finally {
            // The row always leaves the list: a runtime that refuses to shut
            // down must never leave a zombie entry behind.
            console.log(`ACTIVE_SERVERS:  DEBUG - Removing server from registry`);
            registry.unregisterServer(serverId);
        }
    }

    /**
     * Await the instance's graceful stop, falling back to a forced socket close
     * if it hangs or fails. Returns false when the shutdown was not clean.
     */
    private static async stopInstanceOrForce(serverId: string, instance: any): Promise<boolean> {
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                Promise.resolve(instance.stop()),
                new Promise((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`Shutdown timed out after ${STOP_TIMEOUT_MS} ms`)),
                        STOP_TIMEOUT_MS,
                    );
                }),
            ]);
            console.log(`ACTIVE_SERVERS:  Server instance stopped for ${serverId}`);
            return true;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.error(`ACTIVE_SERVERS:  Graceful stop failed for ${serverId}: ${reason}`);
            if (typeof instance.forceStop === 'function') {
                try {
                    instance.forceStop();
                    console.log(`ACTIVE_SERVERS:  Forced shutdown for ${serverId}`);
                } catch (forceError) {
                    console.error(`ACTIVE_SERVERS:  Forced shutdown failed for ${serverId}:`, forceError);
                }
            }
            vscode.window.showWarningMessage(
                `Server removed from the list, but its runtime did not shut down cleanly: ${reason}`,
            );
            return false;
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    /**
     * Stop all active servers
     */
    public static async stopAllServers(): Promise<number> {
        console.log('ACTIVE_SERVERS: Stopping all active servers');
        
        const registry = getActiveServerRegistry();
        const runningServers = registry.getServersByStatus('running');
        
        if (runningServers.length === 0) {
            console.log('ACTIVE_SERVERS: No running servers to stop');
            vscode.window.showInformationMessage('No active servers to stop');
            return 0;
        }

        // First, close all lateral panels for servers that have them
        const panelManager = getPanelManager();
        const lateralPanelServers = runningServers.filter(server => server.launchMode === 'lateralPanel');
        
        if (lateralPanelServers.length > 0) {
            console.log(`ACTIVE_SERVER_PANEL: Closing ${lateralPanelServers.length} lateral panels before stopping servers`);
            const serverIdsWithPanels = lateralPanelServers.map(server => server.id);
            const closedPanelCount = panelManager.removePanelsForServers(serverIdsWithPanels);
            console.log(`ACTIVE_SERVER_PANEL: Closed ${closedPanelCount}/${lateralPanelServers.length} lateral panels`);
        }

        let stoppedCount = 0;
        const stopPromises = runningServers.map(async (server) => {
            const success = await this.stopServer(server.id);
            if (success) {
                stoppedCount++;
            }
            return success;
        });

        await Promise.all(stopPromises);

        console.log(`ACTIVE_SERVERS: Stopped ${stoppedCount}/${runningServers.length} servers`);
        
        if (stoppedCount === runningServers.length) {
            vscode.window.showInformationMessage(`All ${stoppedCount} servers stopped successfully`);
        } else {
            vscode.window.showWarningMessage(
                `Stopped ${stoppedCount}/${runningServers.length} servers. Some servers may require manual intervention.`
            );
        }

        return stoppedCount;
    }

    /**
     * Close analysis session associated with a server
     */
    private static async closeAssociatedAnalysisSession(serverId: string, server: ActiveServer): Promise<void> {
        try {
            console.log(`ACTIVE_SERVERS:  DEBUG - Looking for analysis session associated with server ${serverId}`);
            console.log(`ACTIVE_SERVERS:  DEBUG - Server details:`, {
                id: serverId,
                port: server.port,
                htmlFile: server.htmlFile,
                metadata: server.metadata
            });
            
            const sessionRegistry = UnifiedSessionRegistry.getInstance(ServerControl.extensionContext);
            const allSessions = sessionRegistry.getAllSessions();
            
            console.log(`ACTIVE_SERVERS:  DEBUG - Found ${allSessions.length} active analysis sessions`);
            allSessions.forEach((session: any, index: number) => {
                console.log(`ACTIVE_SERVERS:  DEBUG - Session ${index + 1}:`, {
                    id: session.id,
                    targetPath: session.targetPath,
                    outputPath: session.outputPath,
                    status: session.status
                });
            });
            
            // Find session that matches this server
            let associatedSession = null;
            
            // Try to find by sessionId in server metadata (when implemented)
            if (server.metadata && (server.metadata as any).sessionId) {
                const sessionId = (server.metadata as any).sessionId;
                console.log(`ACTIVE_SERVERS:  DEBUG - Trying to find session by metadata sessionId: ${sessionId}`);
                associatedSession = sessionRegistry.getSession(sessionId);
                if (associatedSession) {
                    console.log(`ACTIVE_SERVERS:  Found session by metadata sessionId: ${sessionId}`);
                } else {
                    console.log(`ACTIVE_SERVERS:  No session found with sessionId: ${sessionId}`);
                }
            }
            
            // If not found, try to find by matching output directory or static root
            if (!associatedSession) {
                const serverRoot = server.metadata?.staticRoot || server.htmlFile;
                console.log(`ACTIVE_SERVERS:  DEBUG - Trying to find session by server root: ${serverRoot}`);
                
                for (const session of allSessions) {
                    console.log(`ACTIVE_SERVERS:  DEBUG - Checking session ${session.id} with outputPath: ${session.outputPath}`);
                    
                    if (session.outputPath && serverRoot && (
                        session.outputPath === serverRoot ||
                        serverRoot.includes(session.outputPath) ||
                        session.outputPath.includes(serverRoot)
                    )) {
                        associatedSession = session;
                        console.log(`ACTIVE_SERVERS:  Found session by output directory match: ${session.id}`);
                        break;
                    }
                }
                
                if (!associatedSession) {
                    console.log(`ACTIVE_SERVERS:  No session found by directory matching`);
                }
            }
            
            // If found, close the session
            if (associatedSession) {
                console.log(`ACTIVE_SERVERS:  DEBUG - Closing associated analysis session ${associatedSession.id}`);
                
                const success = sessionRegistry.closeSession(associatedSession.id);
                
                if (success) {
                    console.log(`ACTIVE_SERVERS:  Successfully closed associated analysis session ${associatedSession.id}`);
                } else {
                    console.warn(`ACTIVE_SERVERS:  Failed to close associated analysis session ${associatedSession.id}`);
                }
            } else {
                console.log(`ACTIVE_SERVERS:  No associated analysis session found for server ${serverId}`);
            }
            
        } catch (error) {
            handleError(ErrorDomain.ActiveServers, `Closing associated analysis session for server ${serverId}`, error, ErrorSeverity.Warn);
        }
    }
}

