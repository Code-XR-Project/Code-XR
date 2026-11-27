/**
 * Server-Watcher Integration Service
 * Coordinates watcher cleanup when servers or analysis sessions are closed.
 */

import * as vscode from 'vscode';
import { UnifiedSessionRegistry } from '../../../core/analysis/session/sessionRegistry';
import { SessionWatcherManager } from '../../../core/analysis/watchers/sessionWatcherManager';
import { getActiveServerRegistry } from '../../../core/server/registry/activeServerRegistry';
import { ServerControl } from '../../../core/server/serverControl';
import { LaunchControl } from '../../../core/analysis/launch/launchControl';
import * as fs from 'fs';
import { getLogger } from '../../../platform/logging/sink';
import type { ActiveServer, RegistryEvent } from '../../../core/server/registry/activeServerModel';
import type { UnifiedAnalysisSession } from '../../../core/analysis/session/analysisSession';

const logger = getLogger('SERVER_WATCHER_INTEGRATION');

export class ServerWatcherIntegration {
    private static instance: ServerWatcherIntegration;
    private context: vscode.ExtensionContext;
    private sessionWatcherManager: SessionWatcherManager;

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.sessionWatcherManager = new SessionWatcherManager(context);
        logger.debug('Initializing service');
        this.setupServerEventListeners();
    }

    public static getInstance(context?: vscode.ExtensionContext): ServerWatcherIntegration {
        if (!ServerWatcherIntegration.instance) {
            if (!context) {
                throw new Error('ServerWatcherIntegration: ExtensionContext required for first initialization');
            }
            ServerWatcherIntegration.instance = new ServerWatcherIntegration(context);
        }
        return ServerWatcherIntegration.instance;
    }

    private setupServerEventListeners(): void {
        try {
            const serverRegistry = getActiveServerRegistry();
            serverRegistry.onRegistryChange((event: RegistryEvent) => {
                if (event.type === 'serverRemoved') {
                    void this.handleServerRemoved(event.serverId!, event.server!);
                }
            });
        } catch (error) {
            logger.error('Error setting up server event listeners:', error);
        }
    }

    private async handleServerRemoved(serverId: string, server: ActiveServer): Promise<void> {
        try {
            const sessionRegistry = UnifiedSessionRegistry.getInstance(this.context);
            // By session id only: ports are reused, and a port match closed
            // sessions that belonged to another server (LAUNCHER-8).
            const ownerSessionId = server.metadata?.sessionId;
            const affectedSessions = ownerSessionId
                ? sessionRegistry.getAllSessions().filter((session: UnifiedAnalysisSession) => session.id === ownerSessionId)
                : [];

            logger.debug(() => `Found ${affectedSessions.length} affected sessions for server ${serverId}`);
            for (const session of affectedSessions) {
                await this.cleanupSessionAfterServerClosure(session.id, server.port);
            }
        } catch (error) {
            logger.error('Error handling server removal:', error);
        }
    }

    private async cleanupSessionAfterServerClosure(sessionId: string, serverPort: number): Promise<void> {
        try {
            const sessionRegistry = UnifiedSessionRegistry.getInstance(this.context);
            const session = sessionRegistry.getSession(sessionId);
            // Only a session that was being served: a launch rolling back (or
            // one already being closed) undoes its own resources and reports
            // once, without a second "cleaned up" message.
            if (!session || session.status !== 'monitoring') {
                return;
            }

            // The server is already gone; this releases the launch record and
            // stops its watcher (teardown steps are idempotent).
            await LaunchControl.getInstance().close(sessionId);
            await this.stopFileWatcherForSession(sessionId, session.targetPath);
            await this.cleanupAnalysisFiles(session.outputPath);
            sessionRegistry.updateSessionStatus(sessionId, 'closed');

            void vscode.window.showInformationMessage(
                `Analysis cleaned up: ${session.targetName} - ${session.analysisMode} (server on port ${serverPort} was closed)`,
            );
        } catch (error) {
            logger.error(`Error cleaning up session ${sessionId}:`, error);
        }
    }

    private async stopFileWatcherForSession(sessionId: string, filePath: string): Promise<void> {
        try {
            logger.debug(() => `Stopping watchers for session ${sessionId}, target: ${filePath}`);
            const sessionWatcherStopped = await this.sessionWatcherManager.stopWatchingSession(sessionId);

            if (sessionWatcherStopped) {
                logger.debug(() => `Stopped session watcher for session ${sessionId}`);
            } else {
                logger.debug(() => `No active session watcher found for session ${sessionId}`);
            }
        } catch (error) {
            logger.error(`Error stopping watcher for session ${sessionId}:`, error);
        }
    }

    private async cleanupAnalysisFiles(outputPath: string): Promise<void> {
        try {
            if (outputPath && fs.existsSync(outputPath)) {
                logger.debug(() => `Cleaning up analysis files at: ${outputPath}`);
            }
        } catch (error) {
            logger.error('Error cleaning up analysis files:', error);
        }
    }

    public async triggerManualCleanup(sessionId: string): Promise<boolean> {
        try {
            const sessionRegistry = UnifiedSessionRegistry.getInstance(this.context);
            const session = sessionRegistry.getSession(sessionId);
            if (!session) {
                return false;
            }

            // Aborts a launch still in progress (Python is killed, no server
            // or watcher is started afterwards) and undoes what a finished
            // launch started (LAUNCHER-7). Mark it closed first so the
            // server-removed listener does not announce a second cleanup.
            sessionRegistry.updateSessionStatus(sessionId, 'closed');
            await LaunchControl.getInstance().close(sessionId);
            await this.stopServerForSession(sessionId);
            await this.stopFileWatcherForSession(sessionId, session.targetPath);
            await this.cleanupAnalysisFiles(session.outputPath);
            return sessionRegistry.updateSessionStatus(sessionId, 'closed');
        } catch (error) {
            logger.error('Error in manual cleanup:', error);
            return false;
        }
    }

    /**
     * Stops the server that was started for this session, matched by the
     * session id it was launched with and by nothing else. The old fallbacks
     * (any server whose name contained "Analysis", or whose file path
     * contained the output path) stopped unrelated servers (LAUNCHER-8).
     */
    private async stopServerForSession(sessionId: string): Promise<void> {
        try {
            const serverRegistry = getActiveServerRegistry();
            const matchingServer = serverRegistry.getAllServers()
                .find((server: ActiveServer) => server.metadata?.sessionId === sessionId);
            if (matchingServer) {
                await ServerControl.stopServer(matchingServer.id, { silent: true });
            }
        } catch (error) {
            logger.error(`Error stopping the server of session ${sessionId}:`, error);
        }
    }

    public static initialize(context: vscode.ExtensionContext): void {
        ServerWatcherIntegration.getInstance(context);
        logger.debug('Service initialized');
    }
}
