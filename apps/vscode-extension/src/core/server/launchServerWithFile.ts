/**
 * Server Runtime Module
 * 
 * This module provides the complete server runtime infrastructure for the CodeXR extension.
 * It includes HTTP/HTTPS servers, port management, and a unified launcher system.
 */

// Core server implementations
export { HttpServer, HttpServerConfig, ParticipantRemovalOutcome } from './httpServer';
export { HttpsDefaultServer, HttpsDefaultServerConfig } from './httpsDefaultServer';
export { HttpsCustomServer, HttpsCustomServerConfig } from './httpsCustomServer';

// Utility classes
export { PortManager } from './portManager';
export { ScreenBroadcastSignalingServer } from './broadcast/screenBroadcastSignalingServer';
export { CollaborationRoomServer } from './collaboration/collaborationRoomServer';

// Main launcher and types
export { 
    MultiServerLauncher,
    MultiServerLaunchResult,
    LaunchResult, // Now exported from multiServerLauncher.ts
    ServerType, 
    ServerInstance
} from './multiServerLauncher';

// Import for use in utility functions
import { MultiServerLauncher, MultiServerLaunchResult } from './multiServerLauncher';

/**
 * Launch server with a specific HTML file
 * @param context - VS Code extension context
 * @param htmlFilePath - Path to HTML file to serve
 * @param customName - Optional custom display name for the server
 * @param sessionId - Optional analysis session ID to link server to analysis
 * @returns Promise<MultiServerLaunchResult>
 */
export async function launchServerWithFile(context: any, htmlFilePath: string, customName?: string, sessionId?: string): Promise<MultiServerLaunchResult> {
    const launcher = new MultiServerLauncher(context);
    const additionalMetadata = sessionId ? { sessionId } : undefined;
    return launcher.launchServer(htmlFilePath, customName, additionalMetadata);
}
