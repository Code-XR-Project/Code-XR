import type { WebSocket } from 'ws';

/** Client, screen and message shapes of the screen broadcast server. */

export type BroadcastRole = 'none' | 'sender' | 'viewer';

/**
 * Where a client reached this server from. Peer-to-peer WebRTC only survives
 * inside one network: across the tunnel the two browsers sit behind different
 * NATs and, with no TURN server, ICE never connects. Remote viewers therefore
 * take their media through this server, which they can always reach.
 */
export type BroadcastClientScope = 'local' | 'remote';

export interface BroadcastClient {
    id: string;
    roomId: string | null;
    socket: WebSocket;
    screenId: string | null;
    role: BroadcastRole;
    hasAudio: boolean;
    scope: BroadcastClientScope;
}

export interface BroadcastScreenState {
    roomId: string;
    screenId: string;
    broadcasterId: string | null;
    hasAudio: boolean;
    /** Viewers served by direct WebRTC. */
    viewers: Set<string>;
    /** Viewers served by media relayed through this server. */
    relayViewers: Set<string>;
}

export interface BroadcastMessage {
    type: string;
    roomId?: string;
    clientId?: string;
    screenId?: string;
    hasAudio?: boolean;
    targetId?: string;
    viewerId?: string;
    broadcasterId?: string;
    reason?: string;
    description?: unknown;
    candidate?: unknown;
}
