import { participantIdOf } from './localDevice';
import { CollaborationRoomRegistry } from './roomRegistry';
import {
    interimHostOf,
    markInterimHost,
    normalizeResumeToken,
    participantHoldingToken,
    ResumableParticipant,
    takeResumable,
} from './roomResume';
import { CollaborationPeer, CollaborationRole, CollaborationRoomState, ParticipantState } from './roomTypes';

/**
 * The join-time half of coming back after a dropped connection (#360): finds
 * and drops the ghost of the same tab, takes back the identity kept under its
 * resume token, and decides the role. The room server owns the sockets and
 * the messages; these helpers only decide.
 */

/** Every socket that speaks for a participant (all their views, #352). */
export function socketsOf(
    registry: CollaborationRoomRegistry,
    room: CollaborationRoomState,
    participantId: string,
): CollaborationPeer[] {
    return Array.from(registry.peers.values()).filter((candidate) => candidate.joinedRoom
        && candidate.roomId === room.id
        && participantIdOf(candidate) === participantId);
}

export interface RejoinHooks {
    /** Drops a participant's sockets at once and runs the leave path. */
    evict(room: CollaborationRoomState, participantId: string): void;
    /** Tells the room a participant's role changed. */
    announceRole(room: CollaborationRoomState, participant: ParticipantState): void;
}

export interface RejoinOutcome {
    room: CollaborationRoomState;
    resumeToken: string | null;
    resumed: ResumableParticipant | null;
    role: CollaborationRole;
}

export function resolveRejoin(
    registry: CollaborationRoomRegistry,
    peer: CollaborationPeer,
    roomId: string,
    rawToken: unknown,
    hooks: RejoinHooks,
): RejoinOutcome {
    let room = registry.ensureRoom(roomId);
    const resumeToken = normalizeResumeToken(rawToken);
    if (room.participants.has(peer.id)) {
        return { room, resumeToken, resumed: null, role: room.participants.get(peer.id)!.role };
    }
    // The same tab rejoining while its previous socket still counts as
    // joined (half-open after a network change): that one is a ghost.
    const ghostId = participantHoldingToken(room, resumeToken);
    if (ghostId && ghostId !== peer.id) {
        hooks.evict(room, ghostId);
        room = registry.ensureRoom(roomId);
    }
    const resumed = takeResumable(room, resumeToken);
    let role: CollaborationRole = room.participants.size === 0 ? 'host' : 'guest';
    if (resumed?.wasHost && reclaimHostRole(room, hooks)) {
        role = 'host';
    }
    return { room, resumeToken, resumed, role };
}

/**
 * A returning host takes the role back from the guest the server promoted
 * while they were away; a role handed over on purpose is never taken back.
 * True when the returning participant should be host.
 */
function reclaimHostRole(room: CollaborationRoomState, hooks: RejoinHooks): boolean {
    const interim = interimHostOf(room);
    markInterimHost(room, null);
    if (interim) {
        const holder = room.participants.get(interim);
        if (holder && holder.role === 'host') {
            holder.role = 'guest';
            room.revision += 1;
            hooks.announceRole(room, holder);
        }
        return true;
    }
    return !Array.from(room.participants.values()).some((participant) => participant.role === 'host');
}
