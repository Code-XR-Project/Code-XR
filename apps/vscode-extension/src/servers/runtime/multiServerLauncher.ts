import type * as vscode from 'vscode';
import { PortManager } from './portManager';
import { ServerSettingsManager } from '../storage/serverSettingsManager';
import { LaunchMode, CertMode } from '../../active_servers/model/activeServerModel';
import { getServerRegistrar } from '../../active_servers/services/serverRegistrar';
import { handleAutoOpening, notifyPortChanged, warnHttpsOverriddenForPanel } from '../views/interactions/launchNotifications';
import {
    determineCertMode,
    determineLaunchMode,
    launchServerByType,
    resolveServerTypeForOpenMode,
    ServerInstance,
    ServerType,
} from './serverFactory';

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

    constructor(private context: vscode.ExtensionContext) {
        this.settingsManager = ServerSettingsManager.getInstance(context);
        console.log('SERVER: Multi-server launcher initialized');
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
            console.log('SERVER: Starting multi-server launch process...');
            console.log('SERVER: launchServer called with parameters:', { htmlFile, customName });

            // Load current settings
            await this.settingsManager.ensureInitialized();
            const settings = this.settingsManager.getServerSettings();
            console.log('SERVER: Loaded settings:', {
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
                warnHttpsOverriddenForPanel();
            }

            console.log('SERVER: Determined server type:', serverType);
            if (isHttpsOverridden) {
                console.log('SERVER: *** IMPORTANT *** Temporarily overriding HTTPS to HTTP for lateral panel compatibility');
            }

            // Find available port using dynamic allocation
            const requestedPort = settings.defaultPort;
            const finalPort = await this.findAvailablePortWithLogging(requestedPort);
            const portChanged = finalPort !== requestedPort;

            if (portChanged) {
                console.log(`SERVER: Port ${requestedPort} already in use. Using port ${finalPort} instead.`);
                notifyPortChanged(requestedPort, finalPort);
            } else {
                console.log(`SERVER: Using requested port ${finalPort}`);
            }

            // Launch the server - Use 0.0.0.0 to listen on all network interfaces for external access
            const host = '0.0.0.0';
            console.log(`SERVER: DEBUG - Configuring server to listen on ${host}:${finalPort} for network access`);
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
                console.log(`SERVER: Successfully launched ${serverType} server on port ${finalPort}`);
                
                // Generate unique server ID
                const serverId = this.generateServerId();
                
                // Store server info
                const serverInfo: RunningServerInfo = {
                    id: serverId,
                    server: result.serverInstance!,
                    serverType: serverType,
                    port: finalPort,
                    htmlFile: htmlFile,
                    activeServerId: ''
                };

                // Register server in active servers registry
                try {
                    const launchMode: LaunchMode = determineLaunchMode(settings);
                    const certMode: CertMode = determineCertMode(serverType, result.httpsOverridden);
                    
                    console.log('SERVER:  DEBUG - About to register server with the following details:');
                    console.log('SERVER:  DEBUG - customName:', customName);
                    console.log('SERVER:  DEBUG - port:', finalPort);
                    console.log('SERVER:  DEBUG - url:', result.serverUrl);
                    
                    const registrar = getServerRegistrar();
                    const activeServer = registrar.registerServer({
                        port: finalPort,
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
                    
                    console.log('SERVER:  Successfully registered server with registry:');
                    console.log('SERVER:  Registered server ID:', activeServer.id);
                    console.log('SERVER:  Registered server customName:', activeServer.customName);
                    
                    serverInfo.activeServerId = activeServer.id;
                    this.servers.set(serverId, serverInfo);
                    
                    console.log(`SERVER: Successfully registered server ${serverId} (active ID: ${activeServer.id}) via registrar service`);
                    console.log(`SERVER: Currently managing ${this.servers.size} server(s)`);
                    
                    // Handle auto-opening based on configuration
                    await handleAutoOpening(settings, result.serverUrl, htmlFile, launchMode, serverInfo.activeServerId);
                    
                } catch (error) {
                    console.error('SERVER: Failed to register server in registry:', error);
                    // Don't fail the launch if registry registration fails
                }

                return {
                    success: true,
                    serverUrl: result.serverUrl,
                    serverType: serverType,
                    serverId: serverId,
                    activeServerId: serverInfo.activeServerId || undefined,
                    port: finalPort,
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
            console.error('SERVER: Error during multi-server launch:', error);
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
        console.log(`SERVER: Checking availability of port ${requestedPort}...`);
        
        const isAvailable = await PortManager.isPortAvailable(requestedPort);
        if (isAvailable) {
            console.log(`SERVER: Port ${requestedPort} is available`);
            return requestedPort;
        }

        console.log(`SERVER: Port ${requestedPort} already in use. Searching for next available port (${requestedPort + 1})...`);
        
        try {
            const availablePort = await PortManager.findAvailablePort(requestedPort + 1);
            console.log(`SERVER: Free port found at ${availablePort}. Launching server...`);
            return availablePort;
        } catch (error) {
            console.error(`SERVER: Failed to find available port starting from ${requestedPort + 1}:`, error);
            throw new Error(`No available ports found starting from ${requestedPort}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Generate unique server ID
     * @private
     */
    private generateServerId(): string {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substr(2, 5);
        return `server_${timestamp}_${random}`;
    }
}

