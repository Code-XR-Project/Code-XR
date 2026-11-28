import type { CollaborationRoomRegistry } from './roomRegistry';
import { send } from './roomMessageCodec';
import type { CollaborationPeer, CollaborationRoomState } from './roomTypes';

/**
 * One person, many views (#352). Every view opened on the machine that runs
 * Code-XR (the IDE's scene pane, a `localhost` browser tab) is the same
 * person: the first local view to join creates the participant, the next
 * ones attach to it, and the participant leaves only with its last view.
 * The local views also share one camera (`self-view`), which never leaves
 * this machine: remote guests only ever see the participant's presence.
 *
 * Pure functions over the room state and the peer map; the room server
 * calls them at join, leave and on a `self-view` message.
 */

/** The participant a socket speaks for: its own id, or the local person's. */
export function participantIdOf(peer: CollaborationPeer): string {
    return peer.participantId || peer.id;
}

/** The local person's participant in `room`, when a local view already created it. */
export function localParticipantOf(room: CollaborationRoomState): string | null {
    const id = room.localParticipantId;
    return id && room.participants.has(id) ? id : null;
}

/** Marks `peer` as the view that created the local person's participant. */
export function claimLocalParticipant(peer: CollaborationPeer, room: CollaborationRoomState): void {
    peer.participantId = peer.id;
    if (peer.local) {
        room.localParticipantId = peer.id;
        room.selfView = null;
    }
}

/**
 * Attaches a further local view to the local person: it gets the person's
 * identity, the room's snapshot and the camera where the person is now.
 */
export function attachLocalView(
    peer: CollaborationPeer,
    room: CollaborationRoomState,
    participantId: string,
    sendSnapshot: () => void,
): void {
    peer.participantId = participantId;
    peer.joinedRoom = true;
    peer.roomId = room.id;
    send(peer, {
        type: 'room-joined',
        peerId: participantId,
        roomId: room.id,
        revision: room.revision,
        payload: { participant: room.participants.get(participantId), localView: true, linkedView: true },
    });
    sendSnapshot();
    if (room.selfView) {
        send(peer, { type: 'self-view', peerId: participantId, roomId: room.id, payload: room.selfView });
    }
}

/** The other sockets in `room` that speak for the same participant as `peer`. */
export function otherViewsOf(
    registry: CollaborationRoomRegistry,
    peer: CollaborationPeer,
    room: CollaborationRoomState,
): CollaborationPeer[] {
    const participantId = participantIdOf(peer);
    return Array.from(registry.peers.values()).filter((other) => other !== peer
        && other.joinedRoom
        && other.roomId === room.id
        && participantIdOf(other) === participantId);
}

/** Forgets the local person once their last view has left `room`. */
export function releaseLocalParticipant(room: CollaborationRoomState, participantId: string): void {
    if (room.localParticipantId === participantId) {
        room.localParticipantId = null;
        room.selfView = null;
    }
}

const MAX_SELF_VIEW_BYTES = 2048;

/**
 * Relays the camera of the view the person is using to their other local
 * views, and keeps it for a view opened later. Only a local view of the
 * local person may send one; it never reaches anyone else.
 */
export function relaySelfView(
    registry: CollaborationRoomRegistry,
    peer: CollaborationPeer,
    payload: Record<string, unknown>,
): void {
    const room = registry.getRoomForPeer(peer);
    if (!room || !peer.local || participantIdOf(peer) !== localParticipantOf(room)) {
        return;
    }
    if (JSON.stringify(payload).length > MAX_SELF_VIEW_BYTES) {
        return;
    }
    room.selfView = payload;
    for (const view of otherViewsOf(registry, peer, room)) {
        send(view, { type: 'self-view', peerId: participantIdOf(peer), roomId: room.id, payload });
    }
}
