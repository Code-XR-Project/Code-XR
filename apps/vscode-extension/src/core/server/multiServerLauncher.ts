import { PortManager } from './portManager';
import { getServerBindHost } from './serverBindHost';
import { ServerSettingsManager } from './serverSettingsManager';
import { LaunchMode, CertMode } from './registry/activeServerModel';
import { getServerRegistrar } from './registry/serverRegistrar';
import { getLaunchNotifier, type LaunchNotifier } from './launchNotifier';
import {
    determineCertMode,
    determineLaunchMode,
    launchServerByType,
    resolveServerTypeForOpenMode,
    ServerInstance,
    ServerType,
} from './serverFactory';
import { getLogger } from '../../platform/logging/sink';
import type { CoreContext } from '../host/hostPaths';

const logger = getLogger('SERVER');

export type { ServerInstance, ServerType } from './serverFactory';

/**
 * Launch result interface (consolidated from launcher.ts)
 */
export interface LaunchResult {
    success: boolean;
    serverUrl?: string;
    serverType?: ServerType;
    error?: string;
    port?: number;
    httpsOverridden?: boolean; // Indicates if HTTPS was overridden to HTTP for lateral panel compatibility
}

/**
 * Multi-server launch result interface
 */
export interface MultiServerLaunchResult {
    success: boolean;
    serverUrl?: string;
    serverType?: ServerType;
    serverId?: string;
    activeServerId?: string;
    error?: string;
    port?: number;
    httpsOverridden?: boolean;
    portChanged?: boolean;
    originalPort?: number;
}

/**
 * Running server info
 */
interface RunningServerInfo {
    id: string;
    server: ServerInstance;
    serverType: ServerType;
    port: number;
    htmlFile?: string;
    activeServerId: string;
}

/**
 * Multi-Server Launcher
 * Manages multiple HTTP/HTTPS servers running concurrently with dynamic port allocation
 */
export class MultiServerLauncher {
    private servers: Map<string, RunningServerInfo> = new Map();
    private settingsManager: ServerSettingsManager;

    constructor(private context: CoreContext) {
        this.settingsManager = ServerSettingsManager.getInstance(context);
        logger.debug('Multi-server launcher initialized');
    }

    /** Logs (and, when it differs, announces) the port a server bound; returns whether it changed. */
    private reportBoundPort(requestedPort: number, boundPort: number): boolean {
        if (boundPort === requestedPort) {
            logger.debug(() => `Using requested port ${boundPort}`);
            return false;
        }
        logger.debug(() => `Port ${requestedPort} already in use. Using port ${boundPort} instead.`);
        getLaunchNotifier().notifyPortChanged(requestedPort, boundPort);
        return true;
    }

    /** Opens a freshly launched server per the settings; a failure is logged, never thrown. */
    private async openLaunchedServer(
        settings: Parameters<LaunchNotifier['handleAutoOpening']>[0],
        serverUrl: string,
        htmlFile: string | undefined,
        activeServerId: string
    ): Promise<void> {
        try {
            await getLaunchNotifier().handleAutoOpening(settings, serverUrl, htmlFile, determineLaunchMode(settings), activeServerId);
        } catch (error) {
            logger.error('Failed to open the launched server:', error);
        }
    }

    /** Stops a server that started but could not be registered, falling back to forceStop. */
    private async discardUnregisteredServer(instance: { stop?: () => Promise<void>; forceStop?: () => void } | undefined): Promise<void> {
        try {
            if (typeof instance?.stop === 'function') {
                await instance.stop();
            }
        } catch (stopError) {
            logger.warn('Stopping the unregistered server failed; forcing it closed:', stopError);
            try {
                instance?.forceStop?.();
            } catch (forceError) {
                logger.warn('Forcing the unregistered server closed failed:', forceError);
            }
        }
    }

    /**
     * Launch a new server instance with dynamic port allocation
     * @param htmlFile Optional HTML file to serve
     * @param customName Optional custom display name for the server
     * @returns Promise<MultiServerLaunchResult>
     */
    public async launchServer(
        htmlFile?: string,
        customName?: string,
        additionalMetadata?: Record<string, any>,
    ): Promise<MultiServerLaunchResult> {
        try {
            logger.debug('Starting multi-server launch process...');
            logger.debug('launchServer called with parameters:', { htmlFile, customName });

            // Load current settings
            await this.settingsManager.ensureInitialized();
            const settings = this.settingsManager.getServerSettings();
            logger.debug('Loaded settings:', {
                ...settings,
                https: settings.https ? {
                    ...settings.https,
                    certPath: settings.https.certPath ? '***REDACTED***' : undefined,
                    keyPath: settings.https.keyPath ? '***REDACTED***' : undefined
                } : undefined
            });

            // Check for HTTPS + lateral panel conflict and handle appropriately
            const serverTypeResult = resolveServerTypeForOpenMode(settings);
            const serverType = serverTypeResult.serverType;
            const isHttpsOverridden = serverTypeResult.isOverridden;
            if (isHttpsOverridden) {
                getLaunchNotifier().warnHttpsOverriddenForPanel();
            }

            logger.debug('Determined server type:', serverType);
            if (isHttpsOverridden) {
                logger.debug('*** IMPORTANT *** Temporarily overriding HTTPS to HTTP for lateral panel compatibility');
            }

            // Find available port using dynamic allocation
            const requestedPort = settings.defaultPort;
            const finalPort = await this.findAvailablePortWithLogging(requestedPort);

            // Every interface (LAN headsets) unless the host restricted it (serverBindHost.ts).
            const host = getServerBindHost();
            logger.debug(() => `DEBUG - Configuring server to listen on ${host}:${finalPort} for network access`);
            const result = await launchServerByType(
                this.context,
                serverType,
                settings,
                finalPort,
                host,
                htmlFile,
                additionalMetadata,
            );
            
            if (result.success && result.serverUrl) {
                // The port the server really listens on. Everything below
                // (registry, session, toasts, LAN URL) uses it, never the port
                // that was only requested.
                const boundPort = result.port ?? finalPort;
                const portChanged = this.reportBoundPort(requestedPort, boundPort);
                logger.debug(() => `Successfully launched ${serverType} server on port ${boundPort}`);
                
                // Generate unique server ID
                const serverId = this.generateServerId();
                
                // Store server info
                const serverInfo: RunningServerInfo = {
                    id: serverId,
                    server: result.serverInstance!,
                    serverType: serverType,
                    port: boundPort,
                    htmlFile: htmlFile,
                    activeServerId: ''
                };

                // Register server in active servers registry
                try {
                    const launchMode: LaunchMode = determineLaunchMode(settings);
                    const certMode: CertMode = determineCertMode(serverType, result.httpsOverridden);
                    
                    logger.debug('DEBUG - About to register server with the following details:');
                    logger.debug('DEBUG - customName:', customName);
                    logger.debug('DEBUG - port:', boundPort);
                    logger.debug('DEBUG - url:', result.serverUrl);
                    
                    const registrar = getServerRegistrar();
                    const activeServer = registrar.registerServer({
                        port: boundPort,
                        url: result.serverUrl,
                        launchMode: launchMode,
                        certMode: certMode,
                        timestamp: Date.now(),
                        htmlFile: htmlFile,
                        customName: customName,
                        serverInstance: result.serverInstance,
                        metadata: {
                            serverType: serverType,
                            originalPort: requestedPort,
                            portChanged: portChanged,
                            httpsOverridden: isHttpsOverridden,
                            launcherId: 'multi-server',
                            serverInstanceId: serverId,
                            ...additionalMetadata // Add any additional metadata passed in
                        }
                    });
                    
                    logger.debug('Successfully registered server with registry:');
                    logger.debug('Registered server ID:', activeServer.id);
                    logger.debug('Registered server customName:', activeServer.customName);
                    
                    serverInfo.activeServerId = activeServer.id;
                    this.servers.set(serverId, serverInfo);
                    
                    logger.debug(() => `Successfully registered server ${serverId} (active ID: ${activeServer.id}) via registrar service`);
                    logger.debug(() => `Currently managing ${this.servers.size} server(s)`);
                } catch (error) {
                    // A server nobody registered cannot be found, listed or
                    // stopped again: stop it now and report the launch as failed
                    // instead of leaving an unreachable listener on 0.0.0.0.
                    logger.error('Failed to register server in registry:', error);
                    this.servers.delete(serverId);
                    await this.discardUnregisteredServer(result.serverInstance);
                    return {
                        success: false,
                        error: `Failed to register the server: ${error instanceof Error ? error.message : String(error)}`,
                        httpsOverridden: isHttpsOverridden
                    };
                }

                // Handle auto-opening based on configuration. A failure to open
                // the page does not undo a server that is running and listed.
                await this.openLaunchedServer(settings, result.serverUrl, htmlFile, serverInfo.activeServerId);

                return {
                    success: true,
                    serverUrl: result.serverUrl,
                    serverType: serverType,
                    serverId: serverId,
                    activeServerId: serverInfo.activeServerId || undefined,
                    port: boundPort,
                    httpsOverridden: isHttpsOverridden,
                    portChanged: portChanged,
                    originalPort: requestedPort
                };
            } else {
                return {
                    success: false,
                    error: result.error || 'Unknown server launch error',
                    httpsOverridden: isHttpsOverridden
                };
            }

        } catch (error) {
            logger.error('Error during multi-server launch:', error);
            return {
                success: false,
                error: `Failed to launch server: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Get count of running servers
     * @returns number
     */
    public getRunningServerCount(): number {
        return this.servers.size;
    }

    /**
     * Find available port with enhanced logging
     * @private
     */
    private async findAvailablePortWithLogging(requestedPort: number): Promise<number> {
        logger.debug(() => `Checking availability of port ${requestedPort}...`);
        
        const isAvailable = await PortManager.isPortAvailable(requestedPort);
        if (isAvailable) {
            logger.debug(() => `Port ${requestedPort} is available`);
            return requestedPort;
        }

        logger.debug(() => `Port ${requestedPort} already in use. Searching for next available port (${requestedPort + 1})...`);
        
        try {
            // The search window follows the requested port: the default end port
            // (8080) made a busy 8080 (allowed by the settings) fail every launch.
            const availablePort = await PortManager.findAvailablePort(
                requestedPort + 1,
                Math.min(65535, requestedPort + 100),
            );
            logger.debug(() => `Free port found at ${availablePort}. Launching server...`);
            return availablePort;
        } catch (error) {
            logger.error(`Failed to find available port starting from ${requestedPort + 1}:`, error);
            throw new Error(`No available ports found starting from ${requestedPort}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Generate unique server ID
     * @private
     */
    private generateServerId(): string {
        const timestamp = Date.now();
        const random = Math.random().toString(36).slice(2, 7);
        return `server_${timestamp}_${random}`;
    }
}

