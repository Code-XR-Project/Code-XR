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

    const key = getEntityKey(entity.entityKind, entity.entityId);
    const previous = room.entities.get(key) ?? null;
    const nextEntity: SharedEntityState = {
        ...(previous ?? {}),
        ...entity,
        entityKind: entity.entityKind,
        entityId: entity.entityId,
        updatedAt: new Date().toISOString(),
    };

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

    const key = getEntityKey(entityKind, entityId);
    const previous = room.entities.get(key);
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

    removeAuthoritativeEntity(context, 
        room,
        String(message.entityKind || message.payload?.entityKind || ''),
        String(message.entityId || message.payload?.entityId || ''),
        peer.id,
    );
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

    const entity = room.entities.get(getEntityKey(entityKind, entityId));
    if (!entity) {
        return;
    }

    const currentOwner = normalizeId(entity.gestureOwnerPeerId);
    if (isLock) {
        if (currentOwner && currentOwner !== peer.id) {
            send(peer, {
                type: 'entity-lock-denied',
                peerId: peer.id,
                roomId: room.id,
                revision: room.revision,
                payload: { entityKind, entityId, gestureOwnerPeerId: currentOwner },
            });
            return;
        }
        entity.gestureOwnerPeerId = peer.id;
    } else if (!currentOwner || currentOwner === peer.id) {
        entity.gestureOwnerPeerId = null;
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
    const participant = room?.participants.get(peer.id);
    if (!room || !participant) {
        return;
    }

    const previous = room.presence.get(peer.id) ?? null;
    const nextPresence: SharedPresenceState = {
        ...(previous ?? {}),
        ...payload,
        ...getParticipantPresence(participant),
        peerId: peer.id,
        lastSeenAt: new Date().toISOString(),
    };

    room.presence.set(peer.id, nextPresence);
    room.revision += 1;
    context.broadcast(room, {
        type: previous ? 'presence-updated' : 'presence-joined',
        peerId: peer.id,
        roomId: room.id,
        revision: room.revision,
        payload: nextPresence,
    }, peer.id);
}

export function startPresenter(context: RoomContext, peer: CollaborationPeer): void {
    const room = context.getRoomForPeer(peer);
    const participant = room?.participants.get(peer.id);
    if (!room || !participant) {
        return;
    }
    if (room.presenterPeerId === peer.id) {
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
    room.presenterPeerId = peer.id;
    room.revision += 1;
    broadcastPresenterEvent(context, room, 'presenter-started', participant);
}

export function stopPresenter(context: RoomContext, peer: CollaborationPeer, payload: Record<string, unknown>): void {
    const room = context.getRoomForPeer(peer);
    const actor = room?.participants.get(peer.id);
    if (!room || !actor || !room.presenterPeerId) {
        return;
    }

    const requestedPeerId = normalizeId(payload.peerId || payload.targetPeerId);
    const targetPeerId = requestedPeerId || peer.id;
    if (targetPeerId !== room.presenterPeerId) {
        return;
    }
    if (targetPeerId !== peer.id && actor.role !== 'host') {
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
