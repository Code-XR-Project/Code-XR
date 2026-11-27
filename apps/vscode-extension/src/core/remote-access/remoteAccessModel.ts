import { CollaborationProfile } from '../collaboration/collaborationProfile';
import type { CollaborationClientKind } from '../collaboration/connectedParticipant';

export type { CollaborationClientKind };

export type RemoteAccessProvider = 'cloudflare-quick';
export type RemoteAccessStatus = 'stopped' | 'starting' | 'shared' | 'error';

export interface RemoteAccessSettings {
    enabled: boolean;
    provider: RemoteAccessProvider;
    /**
     * One-shot migration marker: cross-network became enabled by default, and
     * settings persisted before that carried `enabled: false` (saved values
     * win over defaults on merge). Its absence means the stored value predates
     * the new default and gets flipped once; once sealed, the user's own
     * choice always wins.
     */
    enabledByDefaultApplied?: boolean;
}

export interface RemoteAccessState {
    status: RemoteAccessStatus;
    publicUrl?: string;
    invitationUrl?: string;
    pendingRequests: number;
    error?: string;
}

export interface AuthenticatedCollaborationSession {
    sessionId: string;
    installationId: string;
    profile: CollaborationProfile;
    clientKind: CollaborationClientKind;
    anonymousAlias?: string;
    remote: boolean;
    expiresAt: number;
}

export const DEFAULT_REMOTE_ACCESS_SETTINGS: RemoteAccessSettings = {
    enabled: true,
    provider: 'cloudflare-quick',
    enabledByDefaultApplied: true,
};

export const DEFAULT_REMOTE_ACCESS_STATE: RemoteAccessState = {
    status: 'stopped',
    pendingRequests: 0,
};

/**
 * The origin cloudflared forwards to. Servers listen on 0.0.0.0 (IPv4 only),
 * and on Windows `localhost` resolves to `::1` first, where nothing listens:
 * the tunnel then comes up but every request through it fails (#159). The
 * IPv4 loopback is always where the server is.
 */
export function tunnelOriginUrl(serverUrl: string): string {
    try {
        const url = new URL(serverUrl);
        if (url.hostname === 'localhost' || url.hostname === '[::1]') {
            url.hostname = '127.0.0.1';
        }
        return url.toString().replace(/\/$/, '');
    } catch {
        return serverUrl;
    }
}

/** The last lines cloudflared printed, appended to a failure so it says why (#159). */
export function withCloudflaredOutput(message: string, output: string, maxLines = 6): string {
    const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-maxLines);
    return lines.length > 0 ? `${message}\ncloudflared said:\n${lines.join('\n')}` : message;
}
