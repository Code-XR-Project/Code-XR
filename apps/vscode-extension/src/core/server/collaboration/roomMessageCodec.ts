import { RawData, WebSocket } from 'ws';
import { DEFAULT_ROOM_ID } from '../ws/webSocketEndpoint';
import {
    CollaborationMessage,
    CollaborationPeer,
    SharedEntityState,
    TransformState,
    Vector3Like,
} from './roomTypes';

/**
 * Stateless helpers of the collaboration room: parsing and sending wire
 * messages, normalizing ids, transforms and entities. None of them touches
 * the room registry.
 */

export function parseMessage(raw: RawData): CollaborationMessage | null {
    try {
        const parsed = JSON.parse(raw.toString('utf8'));
        return parsed && typeof parsed === 'object' ? parsed as CollaborationMessage : null;
    } catch {
        return null;
    }
}

export function send(peer: CollaborationPeer, payload: Record<string, unknown>): void {
    if (peer.socket.readyState === WebSocket.OPEN) {
        peer.socket.send(JSON.stringify(payload));
    }
}

export function sendError(peer: CollaborationPeer, code: string, message: string): void {
    send(peer, {
        type: 'error',
        roomId: peer.roomId || undefined,
        payload: { code, message },
    });
}

export function normalizeEntityState(value: unknown): (SharedEntityState & { entityKind: string; entityId: string }) | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const entityKind = normalizeId((value as SharedEntityState).entityKind);
    const entityId = normalizeId((value as SharedEntityState).entityId);
    if (!entityKind || !entityId) {
        return null;
    }
    return {
        ...(value as SharedEntityState),
        entityKind,
        entityId,
        gestureOwnerPeerId: normalizeOptionalId((value as SharedEntityState).gestureOwnerPeerId),
        transform: normalizeTransform((value as SharedEntityState).transform),
        updatedAt: new Date().toISOString(),
    };
}

export function normalizeTransform(value: unknown): TransformState | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as TransformState;
    return {
        position: normalizeVector(record.position),
        rotation: normalizeVector(record.rotation),
    };
}

function normalizeVector(value: unknown): Vector3Like | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const vector = value as Vector3Like;
    return {
        x: Number.isFinite(vector.x) ? vector.x : 0,
        y: Number.isFinite(vector.y) ? vector.y : 0,
        z: Number.isFinite(vector.z) ? vector.z : 0,
    };
}

export function resolveRoomId(preferred: unknown, fallback: string | null): string {
    return normalizeId(preferred) || normalizeId(fallback) || DEFAULT_ROOM_ID;
}

export function normalizeId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalId(value: unknown): string | null {
    return normalizeId(value) || null;
}

export function getEntityKey(entityKind: string, entityId: string): string {
    return `${entityKind}:${entityId}`;
}

export function createId(prefix: string): string {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
