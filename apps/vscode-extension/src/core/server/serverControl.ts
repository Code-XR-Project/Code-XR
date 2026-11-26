import * as vscode from 'vscode';
import { ActiveServer, ActiveServerRuntime } from './registry/activeServerModel';
import type { UnifiedAnalysisSession } from '../analysis/session/analysisSession';
import { getActiveServerRegistry } from './registry/activeServerRegistry';
import { closeServerPanels } from './serverPanels';
import { fileToServerMap } from './fileToServerMap';
import { sseManager } from './sse/SSEManager';
import { UnifiedSessionRegistry } from '../analysis/session/sessionRegistry';
import { getLogger } from '../../platform/logging/sink';
import { getHost } from '../host/hostRegistry';

const logger = getLogger('ACTIVE_SERVERS');

/** A server that failed to stop: logged, and shown to the person (what `handleError(..., User)` did before #13 step 7). */
function reportStopFailure(url: string, error: unknown): void {
    const prefix = `ACTIVE_SERVERS: Failed to stop server ${url}`;
    logger.error(prefix, error);
    void getHost().notifier.notify('error', `${prefix}: ${error instanceof Error ? error.message : String(error)}`);
}

/** How long a graceful shutdown may take before it is forced. */
const STOP_TIMEOUT_MS = 4000;

/**
 * Server Control
 * Runtime operations for managing active servers
 */
/** What a bulk stop did: how many running servers it tried, and how many stopped cleanly. */
export interface StopAllServersResult {
    requested: number;
    stopped: number;
}

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
    public static async stopServer(serverId: string, options: { silent?: boolean } = {}): Promise<boolean> {
        logger.debug(() => `DEBUG - Attempting to stop server ${serverId}`);
        
        const registry = getActiveServerRegistry();
        const server = registry.getServer(serverId);
        
        if (!server) {
            logger.error(`Server ${serverId} not found in registry`);
            void getHost().notifier.notify('error', `Server not found: ${serverId}`);
            return false;
        }

        logger.debug(`DEBUG - Server found:`, {
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
            if (server.launchMode === 'lateralPanel' && closeServerPanels([serverId]) > 0) {
                logger.debug(() => `ACTIVE_SERVER_PANEL: Closed lateral panel for server ${serverId}`);
            }

            // Check if this server is associated with an analysis file and clean up
            logger.debug(() => `DEBUG - Checking for file-to-server mapping for server on port ${server.port}`);
            const fileUri = fileToServerMap.findFileByPort(server.port);
            if (fileUri) {
                logger.debug(() => `Found associated analysis file: ${fileUri}`);
                
                // Clean up SSE clients for this file
                logger.debug(() => `DEBUG - Cleaning up SSE clients for ${fileUri}`);
                sseManager.removeAllClients(fileUri);
                
                // Remove the file-to-server mapping
                logger.debug(() => `DEBUG - Removing file-to-server mapping for ${fileUri}`);
                fileToServerMap.unregisterMapping(fileUri);
            } else {
                logger.debug(() => `No associated analysis file found for server on port ${server.port}`);
            }

            // Close associated analysis session if it exists
            logger.debug(`DEBUG - Attempting to close associated analysis session`);
            await this.closeAssociatedAnalysisSession(serverId, server);

            // Update status to indicate stopping
            logger.debug(`DEBUG - Updating server status to 'stopped'`);
            registry.updateServerStatus(serverId, 'stopped');

            // Stop the actual server instance if available
            let cleanShutdown = true;
            if (server.serverInstance && typeof server.serverInstance.stop === 'function') {
                logger.debug(() => `DEBUG - Stopping server instance for ${serverId}`);
                cleanShutdown = await this.stopInstanceOrForce(serverId, server.serverInstance);
            } else {
                logger.debug(() => `No server instance or stop method for ${serverId}`);
            }

            logger.debug(() => `Stopped server ${serverId} (${server.url}), clean: ${cleanShutdown}`);
            if (cleanShutdown && !options.silent) {
                void getHost().notifier.notify('info', `Server stopped: ${server.url}`);
            }

            return cleanShutdown;

        } catch (error) {
            reportStopFailure(server.url, error);
            return false;
        } finally {
            // The row always leaves the list: a runtime that refuses to shut
            // down must never leave a zombie entry behind.
            logger.debug(`DEBUG - Removing server from registry`);
            registry.unregisterServer(serverId);
        }
    }

    /**
     * Await the instance's graceful stop, falling back to a forced socket close
     * if it hangs or fails. Returns false when the shutdown was not clean.
     */
    private static async stopInstanceOrForce(serverId: string, instance: ActiveServerRuntime): Promise<boolean> {
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
            logger.debug(() => `Server instance stopped for ${serverId}`);
            return true;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            logger.error(`Graceful stop failed for ${serverId}: ${reason}`);
            if (typeof instance.forceStop === 'function') {
                try {
                    instance.forceStop();
                    logger.debug(() => `Forced shutdown for ${serverId}`);
                } catch (forceError) {
                    logger.error(`Forced shutdown failed for ${serverId}:`, forceError);
                }
            }
            void getHost().notifier.notify('warning',
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
     * Stop every running server. Shows no message of its own: the caller
     * reports one summary from the returned counts. (It used to return a bare
     * count that its caller read as a yes/no, and both layers toasted, so a
     * partial failure showed "Stopped 2/3" followed by "Stopped all 3".)
     */
    public static async stopAllServers(): Promise<StopAllServersResult> {
        logger.debug('Stopping all active servers');

        const registry = getActiveServerRegistry();
        const runningServers = registry.getServersByStatus('running');

        if (runningServers.length === 0) {
            logger.debug('No running servers to stop');
            return { requested: 0, stopped: 0 };
        }

        // First, close all lateral panels for servers that have them
        const lateralPanelServers = runningServers.filter(server => server.launchMode === 'lateralPanel');

        if (lateralPanelServers.length > 0) {
            logger.debug(() => `ACTIVE_SERVER_PANEL: Closing ${lateralPanelServers.length} lateral panels before stopping servers`);
            const serverIdsWithPanels = lateralPanelServers.map(server => server.id);
            const closedPanelCount = closeServerPanels(serverIdsWithPanels);
            logger.debug(() => `ACTIVE_SERVER_PANEL: Closed ${closedPanelCount}/${lateralPanelServers.length} lateral panels`);
        }

        const results = await Promise.all(
            runningServers.map(server => this.stopServer(server.id, { silent: true })),
        );
        const stopped = results.filter(Boolean).length;

        logger.debug(() => `Stopped ${stopped}/${runningServers.length} servers`);
        return { requested: runningServers.length, stopped };
    }

    /**
     * Close analysis session associated with a server
     */
    private static async closeAssociatedAnalysisSession(serverId: string, server: ActiveServer): Promise<void> {
        try {
            logger.debug(() => `DEBUG - Looking for analysis session associated with server ${serverId}`);
            logger.debug(`DEBUG - Server details:`, {
                id: serverId,
                port: server.port,
                htmlFile: server.htmlFile,
                metadata: server.metadata
            });
            
            const sessionRegistry = UnifiedSessionRegistry.getInstance(ServerControl.extensionContext);
            const allSessions = sessionRegistry.getAllSessions();
            
            logger.debug(() => `DEBUG - Found ${allSessions.length} active analysis sessions`);
            allSessions.forEach((session: UnifiedAnalysisSession, index: number) => {
                logger.debug(() => `DEBUG - Session ${index + 1}:`, {
                    id: session.id,
                    targetPath: session.targetPath,
                    outputPath: session.outputPath,
                    status: session.status
                });
            });
            
            // Find session that matches this server
            let associatedSession = null;
            
            // Try to find by sessionId in server metadata (when implemented)
            if (server.metadata?.sessionId) {
                const sessionId = server.metadata.sessionId;
                logger.debug(() => `DEBUG - Trying to find session by metadata sessionId: ${sessionId}`);
                associatedSession = sessionRegistry.getSession(sessionId);
                if (associatedSession) {
                    logger.debug(() => `Found session by metadata sessionId: ${sessionId}`);
                } else {
                    logger.debug(() => `No session found with sessionId: ${sessionId}`);
                }
            }
            
            // Only by session id: matching output paths by substring in both
            // directions closed sessions that belonged to other servers
            // (LAUNCHER-8).

            // If found, close the session
            if (associatedSession) {
                logger.debug(() => `DEBUG - Closing associated analysis session ${associatedSession.id}`);
                
                const success = sessionRegistry.closeSession(associatedSession.id);
                
                if (success) {
                    logger.debug(() => `Successfully closed associated analysis session ${associatedSession.id}`);
                } else {
                    logger.warn(`Failed to close associated analysis session ${associatedSession.id}`);
                }
            } else {
                logger.debug(() => `No associated analysis session found for server ${serverId}`);
            }
            
        } catch (error) {
            logger.warn(`ACTIVE_SERVERS: Closing associated analysis session for server ${serverId}`, error);
        }
    }
}

