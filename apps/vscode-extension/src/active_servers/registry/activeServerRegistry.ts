import { EventEmitter } from 'events';
import { ActiveServer, ActiveServerMetadata, ActiveServerRuntime, RegistryEvent, RegistryEventType, LaunchMode, CertMode } from '../model/activeServerModel';
import { RemoteAccessState } from '../../remote_access/model/remoteAccessModel';
import { getLogger } from '../../core/logging/sink';

const logger = getLogger('ACTIVE_SERVERS');

const REGISTRY_CHANGE = 'change';

/** What a subscription returns: structurally a `vscode.Disposable`. */
export interface RegistrySubscription {
    dispose(): void;
}

/** Same call shape as `vscode.Event<RegistryEvent>`, without depending on vscode. */
export type RegistryChangeEvent = (
    listener: (event: RegistryEvent) => unknown,
    thisArgs?: unknown,
    disposables?: RegistrySubscription[],
) => RegistrySubscription;

/**
 * Active Server Registry
 * Centralized tracking and management of all active servers
 */
export class ActiveServerRegistry {
    private static instance: ActiveServerRegistry | null = null;
    private servers: Map<string, ActiveServer> = new Map();
    private readonly eventEmitter = new EventEmitter();
    private disposed = false;

    /**
     * Event fired when registry changes. Keeps the `vscode.Event` contract:
     * listeners run in subscription order, a throwing listener is reported and
     * does not stop the others, and nothing is delivered after `dispose()`.
     */
    public readonly onRegistryChange: RegistryChangeEvent = (listener, thisArgs, disposables) => {
        const bound = (event: RegistryEvent): void => {
            try {
                listener.call(thisArgs, event);
            } catch (error) {
                logger.error('Registry change listener failed:', error);
            }
        };
        if (!this.disposed) {
            this.eventEmitter.on(REGISTRY_CHANGE, bound);
        }
        const subscription: RegistrySubscription = {
            dispose: () => {
                this.eventEmitter.off(REGISTRY_CHANGE, bound);
            },
        };
        disposables?.push(subscription);
        return subscription;
    };

    private constructor() {
        // No leak warning: the tree, the watcher integration and remote access subscribe once each.
        this.eventEmitter.setMaxListeners(0);
        logger.debug('Registry initialized');
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): ActiveServerRegistry {
        if (!ActiveServerRegistry.instance) {
            ActiveServerRegistry.instance = new ActiveServerRegistry();
        }
        return ActiveServerRegistry.instance;
    }

    /**
     * Register a new active server
     */
    public registerServer(config: {
        port: number;
        url: string;
        launchMode: LaunchMode;
        certMode: CertMode;
        timestamp: number;
        htmlFile?: string;
        customName?: string;
        serverInstance?: ActiveServerRuntime;
        metadata?: ActiveServerMetadata;
    }): ActiveServer {
        logger.debug('SERVER: registerServer called with config:', {
            port: config.port,
            htmlFile: config.htmlFile,
            customName: config.customName,
            url: config.url
        });
        
        const serverId = this.generateServerId(config.port, config.timestamp);
        
        const server: ActiveServer = {
            id: serverId,
            port: config.port,
            url: config.url,
            launchMode: config.launchMode,
            certMode: config.certMode,
            timestamp: config.timestamp,
            status: 'running',
            htmlFile: config.htmlFile,
            customName: config.customName,
            serverInstance: config.serverInstance,
            metadata: config.metadata
        };

        this.servers.set(serverId, server);
        
        // Enhanced logging for custom names
        logger.debug(() => `Registered server ${serverId} at ${config.url} (${config.certMode}/${config.launchMode})`);
        if (config.customName && config.customName.trim().length > 0) {
            logger.debug(() => `Received custom name from launcher: ${config.customName}`);
            logger.debug(() => `Registering server with name: ${config.customName}`);
        } else {
            const fallbackName = `localhost:${config.port}`;
            logger.debug(() => `No custom name provided. Using default name: ${fallbackName}`);
        }
        
        this.emitEvent('serverAdded', serverId, server);
        
        return server;
    }

    /**
     * Remove a server from the registry
     */
    public unregisterServer(serverId: string): boolean {
        const server = this.servers.get(serverId);
        if (!server) {
            logger.warn(`Attempted to unregister non-existent server: ${serverId}`);
            return false;
        }

        this.servers.delete(serverId);
        
        logger.debug(() => `Unregistered server ${serverId} (${server.url})`);
        
        this.emitEvent('serverRemoved', serverId, server);
        
        return true;
    }

    /**
     * Update server status
     */
    public updateServerStatus(serverId: string, status: 'running' | 'stopped' | 'error'): boolean {
        const server = this.servers.get(serverId);
        if (!server) {
            logger.warn(`Attempted to update status of non-existent server: ${serverId}`);
            return false;
        }

        server.status = status;
        
        logger.debug(() => `Updated server ${serverId} status to ${status}`);
        
        this.emitEvent('serverUpdated', serverId, server);
        
        return true;
    }

    public updateRemoteAccessState(serverId: string, state: RemoteAccessState): boolean {
        const server = this.servers.get(serverId);
        if (!server) {
            return false;
        }
        server.remoteAccess = { ...state };
        this.emitEvent('serverUpdated', serverId, server);
        return true;
    }

    /**
     * Get server by ID
     */
    public getServer(serverId: string): ActiveServer | undefined {
        return this.servers.get(serverId);
    }

    /**
     * Get all active servers
     */
    public getAllServers(): ActiveServer[] {
        return Array.from(this.servers.values());
    }

    /**
     * Get servers by status
     */
    public getServersByStatus(status: 'running' | 'stopped' | 'error'): ActiveServer[] {
        return this.getAllServers().filter(server => server.status === status);
    }

    /**
     * Get servers by port
     */
    public getServerByPort(port: number): ActiveServer | undefined {
        return this.getAllServers().find(server => server.port === port);
    }

    /**
     * Check if a server is registered
     */
    public hasServer(serverId: string): boolean {
        return this.servers.has(serverId);
    }

    /**
     * Get count of active servers
     */
    public getServerCount(): number {
        return this.servers.size;
    }

    /**
     * Get count of running servers
     */
    public getRunningServerCount(): number {
        return this.getServersByStatus('running').length;
    }

    /**
     * Clear all servers from registry
     */
    public clearAll(): void {
        const count = this.servers.size;
        this.servers.clear();
        
        logger.debug(() => `Cleared all servers (${count} removed)`);
        
        this.emitEvent('registryCleared');
    }

    /**
     * Cleanup stopped/error servers
     */
    public cleanupInactiveServers(): number {
        const inactiveServers = this.getAllServers().filter(server => 
            server.status === 'stopped' || server.status === 'error'
        );

        let removedCount = 0;
        for (const server of inactiveServers) {
            if (this.unregisterServer(server.id)) {
                removedCount++;
            }
        }

        if (removedCount > 0) {
            logger.debug(() => `Cleaned up ${removedCount} inactive servers`);
        }

        return removedCount;
    }

    /**
     * Get registry statistics
     */
    public getStats(): {
        total: number;
        running: number;
        stopped: number;
        error: number;
        byMode: { [mode: string]: number };
        byCertMode: { [mode: string]: number };
    } {
        const servers = this.getAllServers();
        
        const stats = {
            total: servers.length,
            running: 0,
            stopped: 0,
            error: 0,
            byMode: {} as { [mode: string]: number },
            byCertMode: {} as { [mode: string]: number }
        };

        for (const server of servers) {
            // Count by status
            stats[server.status]++;
            
            // Count by launch mode
            stats.byMode[server.launchMode] = (stats.byMode[server.launchMode] || 0) + 1;
            
            // Count by cert mode
            stats.byCertMode[server.certMode] = (stats.byCertMode[server.certMode] || 0) + 1;
        }

        return stats;
    }

    /**
     * Dispose of the registry
     */
    public dispose(): void {
        this.disposed = true;
        this.eventEmitter.removeAllListeners();
        this.clearAll();
        logger.debug('Registry disposed');
    }

    /**
     * Generate unique server ID
     * @private
     */
    private generateServerId(port: number, timestamp: number): string {
        return `server-${port}-${timestamp}`;
    }

    /**
     * Emit registry event
     * @private
     */
    private emitEvent(type: RegistryEventType, serverId?: string, server?: ActiveServer): void {
        const event: RegistryEvent = {
            type,
            serverId,
            server,
            timestamp: Date.now()
        };
        
        this.eventEmitter.emit(REGISTRY_CHANGE, event);
    }
}

/**
 * Convenience function to get the registry instance
 */
export function getActiveServerRegistry(): ActiveServerRegistry {
    return ActiveServerRegistry.getInstance();
}

/**
 * Convenience function to register a server
 */
export function registerActiveServer(config: {
    port: number;
    url: string;
    launchMode: LaunchMode;
    certMode: CertMode;
    timestamp: number;
    htmlFile?: string;
    customName?: string;
    serverInstance?: ActiveServerRuntime;
    metadata?: ActiveServerMetadata;
}): ActiveServer {
    return getActiveServerRegistry().registerServer(config);
}
