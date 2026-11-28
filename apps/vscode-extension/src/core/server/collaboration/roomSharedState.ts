import { participantIdOf } from './localDevice';
import { getParticipantPresence } from './participantIdentity';
import { getEntityKey, normalizeEntityState, normalizeId, normalizeTransform, send, sendError } from './roomMessageCodec';
import { CollaborationRoomRegistry } from './roomRegistry';
import {
    CollaborationMessage,
    CollaborationPeer,
    CollaborationRoomState,
    ParticipantState,
    SharedEntityState,
    SharedPresenceState,
} from './roomTypes';

/** What the shared-state handlers need from the room: the peer's room and the broadcast. */
export type RoomContext = Pick<CollaborationRoomRegistry, 'getRoomForPeer' | 'broadcast'>;

/**
 * The shared state of a collaboration room and its transitions: entities
 * (authoritative upserts and removals, peer edits, transforms, gesture
 * locks), presence, and the single presenter. Each transition bumps the
 * room revision and broadcasts the change through the context.
 */

/**
 * Entity kinds only the server writes, through its feature bridges. A peer
 * that tried to write one used to be obeyed (COLLAB-SYNC-1): one guest could
 * switch everyone's analysis mode while the server believed another, or point
 * everyone's Agent Flow at a foreign dataset URL.
 */
export const SERVER_OWNED_ENTITY_KINDS: ReadonlySet<string> = new Set([
    'analysis-view',
    'dependency-graph',
    'historical-comparison',
    'project-evolution',
    'agent-flow',
    'drill-down',
]);

/** Shared entities a room may hold; a peer cannot add more (COLLAB-ROOM-5). */
export const MAX_ENTITIES_PER_ROOM = 256;

function refuseServerOwned(peer: CollaborationPeer, entityKind: string): boolean {
    if (!SERVER_OWNED_ENTITY_KINDS.has(entityKind)) {
        return false;
    }
    sendError(peer, 'forbidden-entity', `Entities of kind "${entityKind}" are owned by the server.`);
    return true;
}

/** Whether another participant holds the gesture lock on this entity. */
function lockedByOther(entity: SharedEntityState | null | undefined, peer: CollaborationPeer): boolean {
    const owner = normalizeId(entity?.gestureOwnerPeerId);
    return !!owner && owner !== peer.id;
}

/** The ids a peer may appear under: its own socket id and its participant id (#352). */
function idsOf(peer: CollaborationPeer): Set<string> {
    return new Set([peer.id, participantIdOf(peer)]);
}

type ScreenBroadcast = { active?: unknown; broadcasterPeerId?: unknown } | null | undefined;

/**
 * A screen's broadcast fields belong to its broadcaster. Every screen update
 * carries them, and a participant who was not broadcasting used to publish
 * `active: false` with a mere resize, stopping the share for the whole room
 * (COLLAB-SCREEN-5). While a broadcast is live, only its broadcaster changes them.
 */
function keepForeignBroadcast(
    previous: SharedEntityState | null,
    next: SharedEntityState,
    peer: CollaborationPeer,
): SharedEntityState {
    if (!previous || next.entityKind !== 'screen') {
        return next;
    }
    const live = previous.broadcast as ScreenBroadcast;
    const owner = normalizeId(live?.broadcasterPeerId);
    if (live?.active !== true || !owner || idsOf(peer).has(owner)) {
        return next;
    }
    return {
        ...next,
        broadcast: previous.broadcast,
        broadcastStatus: previous.broadcastStatus,
        hasAudio: previous.hasAudio,
    };
}

/**
 * Mark every screen broadcast by one of these ids as ended. The broadcast
 * server stops a share when its sender's socket closes, but the room entity
 * outlived it and kept saying "live": every later joiner, and the next
 * person to share, waited on that screen forever (COLLAB-SCREEN-8).
 */
export function endBroadcastsOf(context: RoomContext, room: CollaborationRoomState, broadcasterIds: Iterable<string>): void {
    const ids = new Set(Array.from(broadcasterIds).filter(Boolean));
    if (ids.size === 0) {
        return;
    }
    for (const [key, entity] of room.entities) {
        const broadcast = entity.broadcast as ScreenBroadcast;
        if (entity.entityKind !== 'screen' || broadcast?.active !== true || !ids.has(normalizeId(broadcast.broadcasterPeerId))) {
            continue;
        }
        const nextEntity: SharedEntityState = {
            ...entity,
            broadcast: { ...(entity.broadcast as Record<string, unknown>), active: false, broadcasterPeerId: '', hasAudio: false },
            broadcastStatus: 'idle',
            hasAudio: false,
            updatedAt: new Date().toISOString(),
        };
        room.entities.set(key, nextEntity);
        room.revision += 1;
        context.broadcast(room, {
            type: 'entity-updated',
            peerId: normalizeId(broadcast.broadcasterPeerId),
            roomId: room.id,
            revision: room.revision,
            payload: nextEntity,
        });
    }
}

export function upsertAuthoritativeEntity(
    context: RoomContext,
    room: CollaborationRoomState,
    entity: SharedEntityState,
    peerId: string,
): void {
    const normalized = normalizeEntityState(entity);
    if (!normalized) {
        throw new Error('invalid-authoritative-entity');
    }
    const key = getEntityKey(normalized.entityKind, normalized.entityId);
    const nextEntity = {
        ...(room.entities.get(key) ?? {}),
        ...normalized,
        updatedAt: new Date().toISOString(),
    };
    room.entities.set(key, nextEntity);
    room.revision += 1;
    context.broadcast(room, {
        type: 'entity-updated',
        peerId,
        roomId: room.id,
        revision: room.revision,
        payload: nextEntity,
    });
}

export function removeAuthoritativeEntity(
    context: RoomContext,
    room: CollaborationRoomState,
    rawEntityKind: string,
    rawEntityId: string,
    peerId: string,
): void {
    const entityKind = normalizeId(rawEntityKind);
    const entityId = normalizeId(rawEntityId);
    if (!entityKind || !entityId || !room.entities.delete(getEntityKey(entityKind, entityId))) {
        return;
    }

    room.revision += 1;
    context.broadcast(room, {
        type: 'entity-removed',
        peerId,
        roomId: room.id,
        revision: room.revision,
        payload: { entityKind, entityId },
    }, peerId);
}

export function upsertEntity(
    context: RoomContext,
    peer: CollaborationPeer,
    message: CollaborationMessage,
    eventType: 'entity-added' | 'entity-updated',
): void {
    const room = context.getRoomForPeer(peer);
    if (!room) {
        return;
    }

    const entity = normalizeEntityState(message.payload || message);
    if (!entity) {
        sendError(peer, 'invalid-entity', 'Entity updates require entityKind and entityId.');
        return;
    }

    if (refuseServerOwned(peer, entity.entityKind)) {
        return;
    }

    const key = getEntityKey(entity.entityKind, entity.entityId);
    const previous = room.entities.get(key) ?? null;
    if (!previous && room.entities.size >= MAX_ENTITIES_PER_ROOM) {
        sendError(peer, 'too-many-entities', 'This room cannot hold more shared objects.');
        return;
    }
    const nextEntity: SharedEntityState = keepForeignBroadcast(previous, {
        ...(previous ?? {}),
        ...entity,
        entityKind: entity.entityKind,
        entityId: entity.entityId,
        updatedAt: new Date().toISOString(),
    }, peer);

    room.entities.set(key, nextEntity);
    room.revision += 1;
    context.broadcast(room, {
        type: eventType,
        peerId: peer.id,
        roomId: room.id,
        revision: room.revision,
        payload: nextEntity,
    }, peer.id);
}

export function updateEntityTransform(context: RoomContext, peer: CollaborationPeer, message: CollaborationMessage): void {
    const room = context.getRoomForPeer(peer);
    if (!room) {
        return;
    }

    const entityKind = normalizeId(message.entityKind || message.payload?.entityKind);
    const entityId = normalizeId(message.entityId || message.payload?.entityId);
    if (!entityKind || !entityId) {
        return;
    }

    if (refuseServerOwned(peer, entityKind)) {
        return;
    }

    const key = getEntityKey(entityKind, entityId);
    const previous = room.entities.get(key);
    if (previous && lockedByOther(previous, peer)) {
        // Someone else is dragging it: their gesture wins until they let go.
        return;
    }
    if (!previous) {
        // Never resurrect an entity from a bare transform: the rebuilt
        // record would lack its typed fields (contentKind, screen config…)
        // and clients would materialize a broken copy. Entity-added always
        // precedes transforms in every runtime.
        return;
    }
    const nextEntity: SharedEntityState = {
        ...previous,
        entityKind,
        entityId,
        transform: normalizeTransform(message.payload?.transform),
        updatedAt: new Date().toISOString(),
    };

    room.entities.set(key, nextEntity);
    room.revision += 1;
    context.broadcast(room, {
        type: 'entity-transform',
        peerId: peer.id,
        roomId: room.id,
        revision: room.revision,
        payload: nextEntity,
    }, peer.id);
}

export function removeEntity(context: RoomContext, peer: CollaborationPeer, message: CollaborationMessage): void {
    const room = context.getRoomForPeer(peer);
    if (!room) {
        return;
    }

    const entityKind = normalizeId(message.entityKind || message.payload?.entityKind);
    const entityId = normalizeId(message.entityId || message.payload?.entityId);
    if (refuseServerOwned(peer, entityKind)) {
        return;
    }
    if (lockedByOther(room.entities.get(getEntityKey(entityKind, entityId)), peer)) {
        sendError(peer, 'entity-locked', 'Another participant is moving this object.');
        return;
    }
    removeAuthoritativeEntity(context, room, entityKind, entityId, peer.id);
}

export function updateEntityLock(context: RoomContext, peer: CollaborationPeer, message: CollaborationMessage, isLock: boolean): void {
    const room = context.getRoomForPeer(peer);
    if (!room) {
        return;
    }

    const entityKind = normalizeId(message.entityKind || message.payload?.entityKind);
    const entityId = normalizeId(message.entityId || message.payload?.entityId);
    if (!entityKind || !entityId) {
        return;
    }

    if (refuseServerOwned(peer, entityKind)) {
        return;
    }
    const entity = room.entities.get(getEntityKey(entityKind, entityId));
    if (!entity) {
        return;
    }

    const heldByOther = lockedByOther(entity, peer);
    if (isLock && heldByOther) {
        send(peer, {
            type: 'entity-lock-denied',
            peerId: peer.id,
            roomId: room.id,
            revision: room.revision,
            payload: { entityKind, entityId, gestureOwnerPeerId: normalizeId(entity.gestureOwnerPeerId) },
        });
        return;
    }
    if (!heldByOther) {
        entity.gestureOwnerPeerId = isLock ? peer.id : null;
    }

    entity.updatedAt = new Date().toISOString();
    room.revision += 1;
    context.broadcast(room, {
        type: isLock ? 'entity-lock' : 'entity-unlock',
        peerId: peer.id,
        roomId: room.id,
        revision: room.revision,
        payload: entity,
    }, peer.id);
}

export function updatePresence(context: RoomContext, peer: CollaborationPeer, payload: Record<string, unknown>): void {
    const room = context.getRoomForPeer(peer);
    const participant = room?.participants.get(participantIdOf(peer));
    if (!room || !participant) {
        return;
    }

    const previous = room.presence.get(participant.peerId) ?? null;
    const nextPresence: SharedPresenceState = {
        ...(previous ?? {}),
        ...payload,
        ...getParticipantPresence(participant),
        peerId: participant.peerId,
        lastSeenAt: new Date().toISOString(),
    };

    room.presence.set(participant.peerId, nextPresence);
    room.revision += 1;
    context.broadcast(room, {
        type: previous ? 'presence-updated' : 'presence-joined',
        peerId: participant.peerId,
        roomId: room.id,
        revision: room.revision,
        payload: nextPresence,
    }, peer.id);
}

export function startPresenter(context: RoomContext, peer: CollaborationPeer): void {
    const room = context.getRoomForPeer(peer);
    const participant = room?.participants.get(participantIdOf(peer));
    if (!room || !participant) {
        return;
    }
    if (room.presenterPeerId === participant.peerId) {
        return;
    }

    if (room.presenterPeerId) {
        const previous = room.participants.get(room.presenterPeerId);
        if (previous) {
            previous.isPresenter = false;
            room.revision += 1;
            broadcastPresenterEvent(context, room, 'presenter-stopped', previous);
        }
    }

    participant.isPresenter = true;
    room.presenterPeerId = participant.peerId;
    room.revision += 1;
    broadcastPresenterEvent(context, room, 'presenter-started', participant);
}

export function stopPresenter(context: RoomContext, peer: CollaborationPeer, payload: Record<string, unknown>): void {
    const room = context.getRoomForPeer(peer);
    const actor = room?.participants.get(participantIdOf(peer));
    if (!room || !actor || !room.presenterPeerId) {
        return;
    }

    const requestedPeerId = normalizeId(payload.peerId || payload.targetPeerId);
    const targetPeerId = requestedPeerId || actor.peerId;
    if (targetPeerId !== room.presenterPeerId) {
        return;
    }
    if (targetPeerId !== actor.peerId && actor.role !== 'host') {
        sendError(peer, 'forbidden', 'Only the host can stop another participant presentation.');
        return;
    }

    const presenter = room.participants.get(room.presenterPeerId);
    room.presenterPeerId = null;
    if (presenter) {
        presenter.isPresenter = false;
        room.revision += 1;
        broadcastPresenterEvent(context, room, 'presenter-stopped', presenter);
    }
}

export function broadcastPresenterEvent(
    context: RoomContext,
    room: CollaborationRoomState,
    type: 'presenter-started' | 'presenter-stopped',
    participant: ParticipantState,
): void {
    const presence = room.presence.get(participant.peerId);
    if (presence) {
        presence.isPresenter = participant.isPresenter;
    }
    context.broadcast(room, {
        type,
        peerId: participant.peerId,
        roomId: room.id,
        revision: room.revision,
        payload: participant,
    });
}

/** A leaving peer drops every gesture lock it held; each release is broadcast. */
export function releaseEntityLocks(context: RoomContext, room: CollaborationRoomState, peerId: string): void {
    for (const entity of room.entities.values()) {
        if (entity.gestureOwnerPeerId !== peerId) {
            continue;
        }
        entity.gestureOwnerPeerId = null;
        entity.updatedAt = new Date().toISOString();
        room.revision += 1;
        context.broadcast(room, {
            type: 'entity-unlock',
            peerId,
            roomId: room.id,
            revision: room.revision,
            payload: entity,
        }, peerId);
    }
}
