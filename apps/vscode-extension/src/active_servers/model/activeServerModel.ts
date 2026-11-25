/**
 * Active Server Model
 * Type definitions for active server tracking
 */

/**
 * Certificate mode used by the server
 */
export type CertMode = 'http' | 'https-default' | 'https-custom';

/**
 * Launch mode for server opening
 */
export type LaunchMode = 'browser' | 'lateralPanel';

/**
 * Server status information
 */
export type ServerStatus = 'running' | 'stopped' | 'error';

/**
 * Active server information
 */
export interface ActiveServer {
    /** Unique identifier for the server */
    id: string;
    
    /** Server port */
    port: number;
    
    /** Complete server URL */
    url: string;
    
    /** Launch mode (browser/lateralPanel) */
    launchMode: LaunchMode;
    
    /** Certificate mode (http/https-default/https-custom) */
    certMode: CertMode;
    
    /** Timestamp when server was launched */
    timestamp: number;
    
    /** Current server status */
    status: ServerStatus;

    /** Optional public tunnel state for this server. */
    remoteAccess?: RemoteAccessState;
    
    /** HTML file being served (if any) */
    htmlFile?: string;
    
    /** Custom display name for the server (overrides default filename display) */
    customName?: string;
    
    /** Server instance reference for control operations */
    serverInstance?: ActiveServerRuntime;
    
    /** Additional metadata */
    metadata?: ActiveServerMetadata;
}

/**
 * The runtime behind a registered server (HttpServer or one of the HTTPS
 * servers). Declared structurally, with only what the extension calls on it,
 * so this model stays free of the server runtime and of vscode.
 */
export interface ActiveServerRuntime {
    stop(): Promise<void>;
    forceStop(): void;
    createAuthenticatedBrowserUrl(baseUrl: string): string;
}

/**
 * Registration metadata, stored as given: the fields the extension reads,
 * plus whatever the launcher records (serverType, originalPort, portChanged,
 * launcherId, ...) and its callers add.
 */
export interface ActiveServerMetadata {
    host?: string;
    staticRoot?: string;
    description?: string;
    /** The analysis session the server serves, when the registration names one. */
    sessionId?: string;
    [field: string]: unknown;
}

/**
 * Server action types for UI interactions
 */
export type ServerAction = 'openBrowser' | 'openPanel' | 'copyUrl' | 'stop' | 'details';

/**
 * Registry event types
 */
export type RegistryEventType = 'serverAdded' | 'serverRemoved' | 'serverUpdated' | 'registryCleared';

/**
 * Registry event data
 */
export interface RegistryEvent {
    type: RegistryEventType;
    serverId?: string;
    server?: ActiveServer;
    timestamp: number;
}
import { RemoteAccessState } from '../../core/remote-access/remoteAccessModel';
