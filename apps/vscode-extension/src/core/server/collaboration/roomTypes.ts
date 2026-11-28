import type { WebSocket } from 'ws';
import type { AuthenticatedCollaborationSession } from '../../remote-access/remoteAccessModel';

/**
 * Wire and state types of the collaboration room. The public ones are
 * re-exported by collaborationRoomServer.ts, which consumers import.
 */

export interface Vector3Like {
    x: number;
    y: number;
    z: number;
}

export interface TransformState {
    position?: Vector3Like | null;
    rotation?: Vector3Like | null;
}

export type CollaborationRole = 'host' | 'guest';
export type IdentityMode = 'anonymous' | 'custom';

export interface ParticipantState {
    peerId: string;
    displayName: string;
    identityMode: IdentityMode;
    avatarId: string;
    role: CollaborationRole;
    isPresenter: boolean;
    connectedAt: string;
}

export interface SharedEntityState extends Record<string, unknown> {
    entityKind?: string;
    entityId?: string;
    gestureOwnerPeerId?: string | null;
    transform?: TransformState | null;
    updatedAt?: string;
}

export interface SharedPresenceState extends Record<string, unknown> {
    peerId: string;
    displayName: string;
    identityMode: IdentityMode;
    avatarId: string;
    role: CollaborationRole;
    isPresenter: boolean;
    head?: unknown;
    body?: unknown;
    leftHand?: unknown;
    rightHand?: unknown;
    ray?: unknown;
    cursor?: unknown;
    viewport?: unknown;
    lastSeenAt?: string;
}

export interface CollaborationPeer {
    id: string;
    socket: WebSocket;
    session: AuthenticatedCollaborationSession | null;
    joinedRoom: boolean;
    roomId: string | null;
    anonymousDisplayName: string;
    remoteAddress: string;
    /** On this machine, not through a tunnel or the LAN: the only peers that may act on the host's editor. */
    local: boolean;
    /**
     * The participant this socket speaks for. Its own id, except for a further
     * local view of the person on this machine, which shares theirs (#352).
     */
    participantId?: string;
}

export interface CollaborationRoomState {
    id: string;
    revision: number;
    entities: Map<string, SharedEntityState>;
    presence: Map<string, SharedPresenceState>;
    participants: Map<string, ParticipantState>;
    presenterPeerId: string | null;
    nextDisplayNameIndex: number;
    /** The participant of the person on this machine, shared by all their local views (#352). */
    localParticipantId?: string | null;
    /** That person's camera as their last active view left it, for a view opened later. */
    selfView?: Record<string, unknown> | null;
}

/** Outcome of an extension-initiated participant removal. */
export interface ParticipantRemovalResult {
    removed: boolean;
    /** Authenticated session behind the removed peer, when it had one. */
    sessionId: string | null;
    remote: boolean;
}

export interface CollaborationMessage {
    type: string;
    roomId?: string;
    peerId: string;
    entityKind: string;
    entityId: string;
    payload?: Record<string, unknown>;
}
