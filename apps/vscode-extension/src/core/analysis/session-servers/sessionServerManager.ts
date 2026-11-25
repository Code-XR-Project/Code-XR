/**
 * Session Server Manager
 * Maneja servidores por sesión siguiendo el patrón muñecas rusas
 */

import * as vscode from 'vscode';
import { ServerLaunchOrchestrator } from './serverLaunchOrchestrator';
import { SSENotificationManager } from './sseNotificationManager';
import { UnifiedAnalysisSession } from '../session/analysisSession';
import { 
    SessionServerInfo, 
    ServerLaunchRequest, 
    SessionServerStatus 
} from './sessionServerModels';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('SESSION_SERVER_MANAGER');

export class SessionServerManager {
    private serverOrchestrator: ServerLaunchOrchestrator;
    private sseManager: SSENotificationManager;
    private activeSessions: Map<string, SessionServerInfo> = new Map();

    constructor(context: vscode.ExtensionContext) {
        logger.debug('Initializing manager');
        this.serverOrchestrator = new ServerLaunchOrchestrator(context);
        this.sseManager = new SSENotificationManager();
    }

    /**
     * Inicia un servidor para una sesión de análisis
     */
    async startServerForSession(session: UnifiedAnalysisSession): Promise<SessionServerStatus> {
        try {
            logger.debug(() => `Starting server for session ${session.id}`);

            // Verificar si ya hay un servidor activo para esta sesión
            if (this.activeSessions.has(session.id)) {
                const existing = this.activeSessions.get(session.id)!;
                if (existing.isActive) {
                    logger.debug(() => `Server already active for session ${session.id}`);
                    return this.getSessionStatus(session.id);
                }
            }

            // Crear request de lanzamiento
            const launchRequest: ServerLaunchRequest = {
                sessionId: session.id,
                targetPath: session.targetPath,
                serverType: 'http' // Por defecto HTTP para LivePanels
            };

            // Lanzar servidor pasando la sesión completa para obtener savedFilesPath
            const launchResult = await this.serverOrchestrator.launchServerForSession(launchRequest, session);

            if (launchResult.success && launchResult.sessionServerInfo) {
                // Registrar sesión activa
                this.activeSessions.set(session.id, launchResult.sessionServerInfo);

                // Actualizar la sesión con el puerto asignado
                session.assignedPort = launchResult.sessionServerInfo.port;
                session.serverUrl = launchResult.sessionServerInfo.serverUrl;

                logger.debug(() => `Server started for session ${session.id} on port ${session.assignedPort}`);

                // Enviar notificación SSE
                await this.sseManager.notifyServerStarted(launchResult.sessionServerInfo);

                return {
                    sessionId: session.id,
                    isServerActive: true,
                    isWatcherActive: true, // Asumimos que el watcher ya está activo
                    port: launchResult.sessionServerInfo.port,
                    serverUrl: launchResult.sessionServerInfo.serverUrl,
                    lastUpdate: new Date()
                };
            } else {
                logger.error(`Failed to start server:`, launchResult.error);
                throw new Error(launchResult.error || 'Unknown server launch error');
            }

        } catch (error) {
            logger.error(`Error starting server for session ${session.id}:`, error);
            return {
                sessionId: session.id,
                isServerActive: false,
                isWatcherActive: false
            };
        }
    }

    /**
     * Detiene un servidor para una sesión específica
     */
    async stopServerForSession(sessionId: string): Promise<boolean> {
        try {
            logger.debug(() => `Stopping server for session ${sessionId}`);

            const sessionInfo = this.activeSessions.get(sessionId);
            if (!sessionInfo) {
                logger.debug(() => `No active server found for session ${sessionId}`);
                return true; // Ya estaba detenido
            }

            // Detener servidor usando orchestrator
            const success = await this.serverOrchestrator.stopServerForSession(
                sessionId, 
                sessionInfo.targetPath
            );

            if (success) {
                // Remover de sesiones activas
                this.activeSessions.delete(sessionId);

                // Enviar notificación SSE
                await this.sseManager.notifyServerStopped(sessionInfo);

                logger.debug(() => `Server stopped for session ${sessionId}`);
            }

            return success;

        } catch (error) {
            logger.error(`Error stopping server for session ${sessionId}:`, error);
            return false;
        }
    }

    /**
     * Notifica que el análisis se ha actualizado (para SSE)
     */
    async notifyAnalysisUpdated(sessionId: string): Promise<void> {
        const sessionInfo = this.activeSessions.get(sessionId);
        if (sessionInfo) {
            await this.sseManager.notifyAnalysisUpdated(sessionInfo);
        }
    }

    /**
     * Obtiene el estado de una sesión
     */
    getSessionStatus(sessionId: string): SessionServerStatus {
        const sessionInfo = this.activeSessions.get(sessionId);
        
        if (sessionInfo) {
            return {
                sessionId,
                isServerActive: sessionInfo.isActive,
                isWatcherActive: true, // TODO: conectar con SessionWatcherManager
                port: sessionInfo.port,
                serverUrl: sessionInfo.serverUrl,
                lastUpdate: new Date()
            };
        }

        return {
            sessionId,
            isServerActive: false,
            isWatcherActive: false
        };
    }

    /**
     * Obtiene todas las sesiones activas
     */
    getAllActiveSessions(): SessionServerInfo[] {
        return Array.from(this.activeSessions.values());
    }

    /**
     * Obtiene información del servidor por puerto
     */
    getSessionByPort(port: number): SessionServerInfo | null {
        for (const sessionInfo of this.activeSessions.values()) {
            if (sessionInfo.port === port) {
                return sessionInfo;
            }
        }
        return null;
    }

    /**
     * Limpia todas las sesiones activas
     */
    async cleanup(): Promise<void> {
        logger.debug(() => `Cleaning up ${this.activeSessions.size} active sessions`);

        const cleanupPromises = Array.from(this.activeSessions.keys()).map(sessionId => 
            this.stopServerForSession(sessionId)
        );

        await Promise.all(cleanupPromises);
        this.activeSessions.clear();

        logger.debug(`Cleanup completed`);
    }
}

export default SessionServerManager;
