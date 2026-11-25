/**
 * Session Server Models
 * Types of the server a launch starts for its session
 */

export interface SessionServerInfo {
    sessionId: string;
    targetPath: string;
    port: number;
    serverUrl: string;
    serverType: 'http' | 'https-default' | 'https-custom';
    serverId: string;
    tempDir: string;
    isActive: boolean;
    startedAt: Date;
}

export interface ServerLaunchRequest {
    sessionId: string;
    targetPath: string;
    preferredPort?: number;
    serverType?: 'http' | 'https-default' | 'https-custom';
}

export interface ServerLaunchResult {
    success: boolean;
    sessionServerInfo?: SessionServerInfo;
    error?: string;
    portChanged?: boolean;
    originalPort?: number;
}
