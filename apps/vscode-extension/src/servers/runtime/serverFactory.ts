import * as path from 'path';
import type { ExtensionContext } from 'vscode';
import { HttpServer } from './httpServer';
import { HttpsDefaultServer } from './httpsDefaultServer';
import { HttpsCustomServer } from './httpsCustomServer';
import type { ServerSettings } from '../storage/serverSettingsManager';
import type { LaunchMode, CertMode } from '../../active_servers/model/activeServerModel';

/*
 * The server factory behind MultiServerLauncher: which server class a set of
 * settings asks for, and building and starting it. It stays in runtime/
 * because the no-scene static root is resolved from this file's __dirname.
 */

/**
 * Server types supported by the launcher
 */
export type ServerType = 'http' | 'https-default' | 'https-custom';

/**
 * Server instance type for the running server
 */
export type ServerInstance = HttpServer | HttpsDefaultServer | HttpsCustomServer;

/** What launchServerByType reports back to the launcher. */
export interface ServerFactoryResult {
    success: boolean;
    serverUrl?: string;
    serverType?: ServerType;
    port?: number;
    error?: string;
    httpsOverridden?: boolean;
    serverInstance?: ServerInstance;
}

/**
 * Determine server type based on settings
 */
export function determineServerType(settings: ServerSettings): ServerType {
    if (settings.mode === 'HTTP') {
        return 'http';
    } else if (settings.mode === 'HTTPS') {
        return settings.https.certSource === 'default' ? 'https-default' : 'https-custom';
    }
    
    throw new Error(`Invalid server mode: ${settings.mode}`);
}

/**
 * Check for lateral panel + HTTPS conflict and provide fallback. The
 * launcher tells the user (warnHttpsOverriddenForPanel) when it is overridden.
 * @param settings - Server settings
 * @returns Modified server type if fallback needed, original type otherwise
 */
export function resolveServerTypeForOpenMode(settings: ServerSettings): {
    serverType: ServerType;
    isOverridden: boolean;
} {
    const originalServerType = determineServerType(settings);
    
    // Check if we have lateral panel + HTTPS combination
    const isLateralPanel = settings.launch.openMode === 'lateralPanel';
    const isHttps = originalServerType === 'https-default' || originalServerType === 'https-custom';
    
    if (isLateralPanel && isHttps) {
        console.log('SERVER: HTTPS + Lateral Panel conflict detected - overriding to HTTP for compatibility');
        console.log(`SERVER: Original server type would have been: ${originalServerType}`);
        console.log('SERVER: VS Code webview panels do not support HTTPS content, using HTTP fallback');
        
        return {
            serverType: 'http',
            isOverridden: true
        };
    }
    
    return {
        serverType: originalServerType,
        isOverridden: false
    };
}

/**
 * Determine launch mode based on settings
 */
export function determineLaunchMode(settings: ServerSettings): LaunchMode {
    return settings.launch.openMode === 'lateralPanel' ? 'lateralPanel' as LaunchMode : 'browser' as LaunchMode;
}

/**
 * Determine certificate mode based on server type and overrides
 */
export function determineCertMode(serverType: ServerType, httpsOverridden?: boolean): CertMode {
    if (httpsOverridden) {
        return 'http';
    }
    
    switch (serverType) {
        case 'http':
            return 'http';
        case 'https-default':
            return 'https-default';
        case 'https-custom':
            return 'https-custom';
        default:
            return 'http';
    }
}

/**
 * Launch server by type - delegates to existing server implementations
 */
export async function launchServerByType(
    context: ExtensionContext,
    serverType: ServerType,
    settings: ServerSettings,
    port: number,
    host: string,
    htmlFile?: string,
    additionalMetadata?: Record<string, any>,
): Promise<ServerFactoryResult> {
    try {
        let server: ServerInstance;
        let serverUrl: string;

        // Default server configuration
        const staticRoot = htmlFile ? path.dirname(htmlFile) : path.join(__dirname, '../../../templates');
        const mainFile = htmlFile ? path.basename(htmlFile) : undefined;
        const enableCors = true;
        const allowedOrigins = ['*'];

        console.log(`SERVER: Using static root: ${staticRoot}`);
        if (mainFile) {
            console.log(`SERVER: Main file configured: ${mainFile}`);
        }

        switch (serverType) {
            case 'http':
                console.log('SERVER: Creating HTTP server...');
                server = new HttpServer({
                    port,
                    host,
                    staticRoot,
                    enableCors,
                    allowedOrigins,
                    mainFile,
                    extensionContext: context,
                    analysisSessionId: typeof additionalMetadata?.sessionId === 'string'
                        ? additionalMetadata.sessionId
                        : undefined,
                });
                break;

            case 'https-default':
                console.log('SERVER: Creating HTTPS server with generated local certificates...');
                server = new HttpsDefaultServer({
                    port,
                    host,
                    staticRoot,
                    enableCors,
                    allowedOrigins,
                    mainFile,
                    extensionContext: context,
                    analysisSessionId: typeof additionalMetadata?.sessionId === 'string'
                        ? additionalMetadata.sessionId
                        : undefined,
                });
                break;

            case 'https-custom':
                console.log('SERVER: Creating HTTPS server with custom certificates...');
                if (!settings.https?.certPath || !settings.https.keyPath) {
                    throw new Error('Custom certificate paths are required for custom HTTPS server');
                }
                server = new HttpsCustomServer({
                    port,
                    host,
                    staticRoot,
                    enableCors,
                    allowedOrigins,
                    mainFile,
                    certPath: settings.https.certPath,
                    keyPath: settings.https.keyPath,
                    extensionContext: context,
                    analysisSessionId: typeof additionalMetadata?.sessionId === 'string'
                        ? additionalMetadata.sessionId
                        : undefined,
                });
                break;

            default:
                throw new Error(`Unsupported server type: ${serverType}`);
        }

        // Start the server
        console.log(`SERVER: Starting ${serverType} server...`);
        serverUrl = await server.start();

        return {
            success: true,
            serverUrl,
            serverType,
            port,
            serverInstance: server
        };

    } catch (error) {
        console.error(`SERVER: Error launching ${serverType} server:`, error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            serverType
        };
    }
}
