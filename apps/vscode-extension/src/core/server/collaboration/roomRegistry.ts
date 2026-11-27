import { ConnectedParticipantSummary } from '../../collaboration/connectedParticipant';
import { resolveRoomId, send } from './roomMessageCodec';
import {
    CollaborationPeer,
    CollaborationRoomState,
    ParticipantState,
    SharedEntityState,
    SharedPresenceState,
} from './roomTypes';

/**
 * Who is connected and which rooms exist: the peer and room maps of one
 * collaboration server, the lookups over them and the room-wide broadcast.
 * It is the narrow context the room's handlers work against; it knows
 * nothing about sockets beyond sending to them, and nothing about the
 * message protocol.
 */
export class CollaborationRoomRegistry {
    public readonly peers = new Map<string, CollaborationPeer>();
    public readonly rooms = new Map<string, CollaborationRoomState>();

    public ensureRoom(roomId: string): CollaborationRoomState {
        const normalizedRoomId = resolveRoomId(roomId, null);
        const existing = this.rooms.get(normalizedRoomId);
        if (existing) {
            return existing;
        }

        const created: CollaborationRoomState = {
            id: normalizedRoomId,
            revision: 0,
            entities: new Map<string, SharedEntityState>(),
            presence: new Map<string, SharedPresenceState>(),
            participants: new Map<string, ParticipantState>(),
            presenterPeerId: null,
            nextDisplayNameIndex: 0,
        };
        this.rooms.set(normalizedRoomId, created);
        return created;
    }

    public getRoomForPeer(peer: CollaborationPeer): CollaborationRoomState | null {
        if (!peer.joinedRoom || !peer.roomId) {
            return null;
        }
        return this.rooms.get(peer.roomId) ?? null;
    }

    public broadcast(room: CollaborationRoomState, payload: Record<string, unknown>, excludedPeerId?: string): void {
        for (const peer of this.peers.values()) {
            if (!peer.joinedRoom || peer.roomId !== room.id || peer.id === excludedPeerId) {
                continue;
            }
            send(peer, payload);
        }
    }

    public getConnectedParticipants(roomId: string): ConnectedParticipantSummary[] {
        const room = this.rooms.get(resolveRoomId(roomId, null));
        if (!room) {
            return [];
        }
        return Array.from(room.participants.values())
            .map((participant) => this.toConnectedParticipantSummary(participant))
            .sort((left, right) => left.connectedAt.localeCompare(right.connectedAt));
    }

    private toConnectedParticipantSummary(participant: ParticipantState): ConnectedParticipantSummary {
        const peer = this.peers.get(participant.peerId);
        return {
            peerId: participant.peerId,
            displayName: participant.displayName,
            avatarId: participant.avatarId,
            clientKind: peer?.session?.clientKind || 'browser',
            connectionScope: peer?.session?.remote ? 'remote' : 'local',
            connectedAt: participant.connectedAt,
            role: participant.role,
            remoteAddress: peer?.remoteAddress || 'unknown',
        };
    }
}
