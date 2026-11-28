import * as http from 'http';
import { EventEmitter } from 'events';
import { RawData, WebSocket } from 'ws';
import { AUTO_AVATAR_ID, CollaborationProfile } from '../../collaboration/collaborationProfile';
import { ConnectedParticipantSummary } from '../../collaboration/connectedParticipant';
import {
    AuthenticatedCollaborationSession,
} from '../../remote-access/remoteAccessModel';
import { attachWebSocketEndpoint, WebSocketEndpoint } from '../ws/webSocketEndpoint';
import {
    CollaborationMessage,
    CollaborationPeer,
    CollaborationRole,
    CollaborationRoomState,
    IdentityMode,
    ParticipantRemovalResult,
    ParticipantState,
    SharedEntityState,
} from './roomTypes';
import {
    createId,
    getEntityKey,
    normalizeId,
    parseMessage,
    resolveRoomId,
    send,
    sendError,
} from './roomMessageCodec';
import { CollaborationRoomRegistry } from './roomRegistry';
import * as sharedState from './roomSharedState';
import {
    applyProfileToParticipant,
    createAnonymousName,
    getParticipantPresence,
} from './participantIdentity';

export { CODEXR_AVATAR_IDS } from './participantIdentity';

export type {
    CollaborationMessage,
    CollaborationRole,
    IdentityMode,
    ParticipantRemovalResult,
    ParticipantState,
    SharedEntityState,
    SharedPresenceState,
} from './roomTypes';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('COLLABORATION_ROOM_SERVER');

export interface CollaborationRoomServerOptions {
    authorizeUpgrade?: (request: http.IncomingMessage) => boolean;
    resolveSession?: (request: http.IncomingMessage) => AuthenticatedCollaborationSession | null;
    /** Whether a connection comes from this machine (loopback, no tunnel); false when not given. */
    isLocalRequest?: (request: http.IncomingMessage) => boolean;
    handleApplicationMessage?: (
        context: CollaborationApplicationMessageContext,
        message: CollaborationMessage,
    ) => Promise<boolean> | boolean;
}

export interface CollaborationApplicationMessageContext {
    peerId: string;
    roomId: string;
    /** The sender is on this machine (see `CollaborationPeer.local`). */
    local: boolean;
    send: (payload: Record<string, unknown>) => void;
    broadcast: (payload: Record<string, unknown>) => void;
    upsertSharedEntity: (entity: SharedEntityState) => void;
    removeSharedEntity: (entityKind: string, entityId: string) => void;
}

export class CollaborationRoomServer {
    private readonly endpoint: WebSocketEndpoint;
    private readonly registry = new CollaborationRoomRegistry();
    private readonly events = new EventEmitter();
    private disposed = false;

    constructor(
        server: http.Server,
        path = '/codexr-room',
        private readonly options: CollaborationRoomServerOptions = {},
    ) {
        this.endpoint = attachWebSocketEndpoint(server, path, {
            authorize: (req) => !this.options.authorizeUpgrade || this.options.authorizeUpgrade(req),
            onConnection: (socket, request) => this.handleConnection(socket, request),
        });
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.endpoint.detach();

        for (const peer of this.registry.peers.values()) {
            try {
                // Tell browsers this is a deliberate shutdown, not a network
                // drop, so they can show the session-ended screen instead of
                // reconnecting forever.
                send(peer, {
                    type: 'session-ended',
                    roomId: peer.roomId || undefined,
                    payload: { reason: 'host-closed' },
                });
                peer.socket.close(4002, 'Session closed by host');
            } catch {
                // Best-effort cleanup.
            }
        }

        this.registry.peers.clear();
        this.registry.rooms.clear();
        this.endpoint.socketServer.close();
        this.events.removeAllListeners();
    }

    public onParticipantsChanged(
        listener: (roomId: string, participants: ConnectedParticipantSummary[]) => void,
    ): () => void {
        this.events.on('participants-changed', listener);
        return () => this.events.off('participants-changed', listener);
    }

    public getConnectedParticipants(roomId: string): ConnectedParticipantSummary[] {
        return this.registry.getConnectedParticipants(roomId);
    }

    /**
     * Remove a participant on behalf of the extension that owns this server.
     * No role check applies: the caller *is* the server, not a peer asking it
     * for something. The authenticated session of the removed peer is reported
     * back so the caller can revoke it (this room knows nothing about tokens).
     */
    public removeParticipant(roomId: string, peerId: string): ParticipantRemovalResult {
        const room = this.registry.rooms.get(resolveRoomId(roomId, null));
        const normalizedPeerId = normalizeId(peerId);
        const targetPeer = this.registry.peers.get(normalizedPeerId);
        if (!room || !targetPeer || !room.participants.has(normalizedPeerId)) {
            return { removed: false, sessionId: null, remote: false };
        }

        this.disconnectRemovedPeer(room, targetPeer);
        return {
            removed: true,
            sessionId: targetPeer.session?.sessionId || null,
            remote: targetPeer.session?.remote === true,
        };
    }

    public upsertServerEntity(roomId: string, entity: SharedEntityState): void {
        const room = this.registry.ensureRoom(roomId);
        this.upsertAuthoritativeEntity(room, entity, 'server');
    }

    public getServerEntity(
        roomId: string,
        entityKind: string,
        entityId: string,
    ): SharedEntityState | null {
        const room = this.registry.rooms.get(resolveRoomId(roomId, null));
        const entity = room?.entities.get(getEntityKey(entityKind, entityId));
        return entity ? { ...entity } : null;
    }

    public broadcastServerMessage(roomId: string, payload: Record<string, unknown>): void {
        const room = this.registry.ensureRoom(roomId);
        this.registry.broadcast(room, {
            ...payload,
            roomId: room.id,
            revision: room.revision,
        });
    }

    public updateSessionProfile(sessionId: string, profile: CollaborationProfile): void {
        for (const peer of this.registry.peers.values()) {
            if (peer.session?.sessionId !== sessionId) {
                continue;
            }
            peer.session.profile = { ...profile };
            const room = this.registry.getRoomForPeer(peer);
            const participant = room?.participants.get(peer.id);
            if (!room || !participant) {
                continue;
            }
            applyProfileToParticipant(room, peer, participant, profile);
            this.broadcastParticipantUpdate(room, participant);
            this.emitParticipantsChanged(room);
        }
    }

    private handleConnection(socket: WebSocket, request: http.IncomingMessage): void {
        const peerId = createId('peer');
        const peer: CollaborationPeer = {
            id: peerId,
            socket,
            session: this.options.resolveSession?.(request) ?? null,
            joinedRoom: false,
            roomId: null,
            anonymousDisplayName: '',
            // Tunneled peers arrive from local cloudflared; cf-connecting-ip
            // carries the real client address in that case.
            remoteAddress: String(
                request.headers['cf-connecting-ip'] || request.socket.remoteAddress || 'unknown',
            ).slice(0, 120),
            local: this.options.isLocalRequest?.(request) ?? false,
        };
        if (peer.session?.anonymousAlias) {
            peer.anonymousDisplayName = peer.session.anonymousAlias;
        }

        this.registry.peers.set(peerId, peer);
        socket.on('message', (raw: RawData) => this.handleMessage(peer, raw));
        socket.on('close', () => this.handleDisconnect(peer));
        socket.on('error', () => this.handleDisconnect(peer));
    }

    private handleMessage(peer: CollaborationPeer, raw: RawData): void {
        const message = parseMessage(raw);
        if (!message) {
            sendError(peer, 'invalid-payload', 'Invalid collaboration payload.');
            return;
        }

        switch (message.type) {
            case 'register':
            case 'room-join':
                this.enterRoom(peer, message);
                return;
            case 'host-transfer':
                this.transferHost(peer, message.payload || {});
                return;
            case 'participant-kick':
                this.kickParticipant(peer, message.payload || {});
                return;
            case 'presenter-started':
                sharedState.startPresenter(this.registry, peer);
                return;
            case 'presenter-stopped':
                sharedState.stopPresenter(this.registry, peer, message.payload || {});
                return;
            case 'presence-update':
                sharedState.updatePresence(this.registry, peer, message.payload || {});
                return;
            case 'entity-added':
                sharedState.upsertEntity(this.registry, peer, message, 'entity-added');
                return;
            case 'entity-updated':
                sharedState.upsertEntity(this.registry, peer, message, 'entity-updated');
                return;
            case 'entity-transform':
                sharedState.updateEntityTransform(this.registry, peer, message);
                return;
            case 'entity-removed':
                sharedState.removeEntity(this.registry, peer, message);
                return;
            case 'entity-lock':
                sharedState.updateEntityLock(this.registry, peer, message, true);
                return;
            case 'entity-unlock':
                sharedState.updateEntityLock(this.registry, peer, message, false);
                return;
            default:
                logger.debug(() => `[Code-XR Fix][Room] application message received: ${message.type} (peer: ${peer.id})`);
                void this.handleApplicationMessage(peer, message);
        }
    }

    private async handleApplicationMessage(
        peer: CollaborationPeer,
        message: CollaborationMessage,
    ): Promise<void> {
        const room = this.registry.getRoomForPeer(peer);
        if (!room || !this.options.handleApplicationMessage) {
            sendError(
                peer,
                'unsupported-message',
                `Unsupported collaboration message type: ${message.type}`,
            );
            return;
        }

        try {
            const handled = await this.options.handleApplicationMessage({
                peerId: peer.id,
                roomId: room.id,
                local: peer.local,
                send: (payload) => send(peer, {
                    ...payload,
                    roomId: room.id,
                }),
                broadcast: (payload) => this.registry.broadcast(room, {
                    ...payload,
                    roomId: room.id,
                }),
                upsertSharedEntity: (entity) => this.upsertAuthoritativeEntity(room, entity, peer.id),
                removeSharedEntity: (entityKind, entityId) => this.removeAuthoritativeEntity(room, entityKind, entityId, peer.id),
            }, message);
            if (!handled) {
                sendError(
                    peer,
                    'unsupported-message',
                    `Unsupported collaboration message type: ${message.type}`,
                );
            }
        } catch (error) {
            sendError(
                peer,
                'application-message-failed',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private upsertAuthoritativeEntity(
        room: CollaborationRoomState,
        entity: SharedEntityState,
        peerId: string,
    ): void {
        sharedState.upsertAuthoritativeEntity(this.registry, room, entity, peerId);
    }

    /** A local peer that asks to be a viewer (the IDE's scene pane) joins as one. */
    private enterRoom(peer: CollaborationPeer, message: CollaborationMessage): void {
        const asViewer = message.payload?.viewer === true && peer.local;
        if (!asViewer) {
            this.joinRoom(peer, message);
            return;
        }
        const roomId = resolveRoomId(message.roomId, peer.roomId);
        this.leaveRoom(peer);
        this.joinAsViewer(peer, this.registry.ensureRoom(roomId));
    }

    private joinRoom(peer: CollaborationPeer, message: CollaborationMessage): void {
        const nextRoomId = resolveRoomId(message.roomId, peer.roomId);
        if (peer.joinedRoom && peer.roomId && peer.roomId !== nextRoomId) {
            this.leaveRoom(peer);
        }

        const room = this.registry.ensureRoom(nextRoomId);
        peer.viewer = false;
        const existingParticipant = room.participants.get(peer.id);
        if (!existingParticipant) {
            peer.anonymousDisplayName = peer.anonymousDisplayName || createAnonymousName(room);
        }

        const role: CollaborationRole = room.participants.size === 0 ? 'host' : 'guest';
        const participant = existingParticipant ?? {
            peerId: peer.id,
            displayName: peer.anonymousDisplayName,
            identityMode: 'anonymous' as IdentityMode,
            // Placeholder only: applyProfileToParticipant resolves the real one.
            avatarId: AUTO_AVATAR_ID,
            role,
            isPresenter: false,
            connectedAt: new Date().toISOString(),
        };

        applyProfileToParticipant(
            room,
            peer,
            participant,
            peer.session?.profile ?? {
                identityMode: 'anonymous',
                customName: '',
                // A peer with no session (local browser) never chose a colour.
                avatarId: AUTO_AVATAR_ID,
            },
        );

        peer.joinedRoom = true;
        peer.roomId = nextRoomId;
        room.participants.set(peer.id, participant);
        this.emitParticipantsChanged(room);

        send(peer, {
            type: 'room-joined',
            peerId: peer.id,
            displayName: participant.displayName,
            roomId: room.id,
            revision: room.revision,
            payload: { participant },
        });
        this.sendSnapshot(peer, room);

        room.revision += 1;
        this.registry.broadcast(room, {
            type: 'participant-updated',
            peerId: peer.id,
            roomId: room.id,
            revision: room.revision,
            payload: participant,
        }, peer.id);
    }

    private transferHost(peer: CollaborationPeer, payload: Record<string, unknown>): void {
        const room = this.registry.getRoomForPeer(peer);
        const actor = room?.participants.get(peer.id);
        if (!room || !actor || actor.role !== 'host') {
            sendError(peer, 'forbidden', 'Only the host can transfer the host role.');
            return;
        }

        const targetPeerId = normalizeId(payload.peerId || payload.targetPeerId);
        const target = room.participants.get(targetPeerId);
        if (!target || target.peerId === actor.peerId) {
            sendError(peer, 'invalid-participant', 'Select a connected guest to transfer the host role.');
            return;
        }

        actor.role = 'guest';
        target.role = 'host';
        room.revision += 1;
        this.broadcastRoleUpdate(room, actor);
        this.broadcastRoleUpdate(room, target);
    }

    private kickParticipant(peer: CollaborationPeer, payload: Record<string, unknown>): void {
        const room = this.registry.getRoomForPeer(peer);
        const actor = room?.participants.get(peer.id);
        if (!room || !actor || actor.role !== 'host') {
            sendError(peer, 'forbidden', 'Only the host can remove a participant.');
            return;
        }

        const targetPeerId = normalizeId(payload.peerId || payload.targetPeerId);
        const targetPeer = this.registry.peers.get(targetPeerId);
        const targetParticipant = room.participants.get(targetPeerId);
        if (!targetPeer || !targetParticipant || targetPeerId === peer.id) {
            sendError(peer, 'invalid-participant', 'The selected participant cannot be removed.');
            return;
        }

        this.disconnectRemovedPeer(room, targetPeer, peer.id);
    }

    /**
     * The single wire format for "you were removed": the browser shows its
     * removal screen and stops reconnecting, and the socket close (4001)
     * runs the normal leave path, which republishes the participant list.
     */
    private disconnectRemovedPeer(
        room: CollaborationRoomState,
        targetPeer: CollaborationPeer,
        actorPeerId?: string,
    ): void {
        send(targetPeer, {
            type: 'participant-kick',
            peerId: actorPeerId || targetPeer.id,
            roomId: room.id,
            payload: { peerId: targetPeer.id },
        });
        targetPeer.socket.close(4001, 'Removed by room host');
    }

    private removeAuthoritativeEntity(
        room: CollaborationRoomState,
        rawEntityKind: string,
        rawEntityId: string,
        peerId: string,
    ): void {
        sharedState.removeAuthoritativeEntity(this.registry, room, rawEntityKind, rawEntityId, peerId);
    }

    private handleDisconnect(peer: CollaborationPeer): void {
        if (!this.registry.peers.has(peer.id)) {
            return;
        }
        this.leaveRoom(peer);
        this.registry.peers.delete(peer.id);
    }

    /**
     * The IDE's scene pane beside the code is the same person as the browser
     * or headset on this machine: it gets the room's state and its updates,
     * but takes no participant slot, so it neither shows up as a second
     * avatar nor takes the host role from the person's real view.
     */
    private joinAsViewer(peer: CollaborationPeer, room: CollaborationRoomState): void {
        peer.viewer = true;
        peer.joinedRoom = true;
        peer.roomId = room.id;
        send(peer, { type: 'room-joined', peerId: peer.id, roomId: room.id, revision: room.revision, payload: { viewer: true } });
        this.sendSnapshot(peer, room);
    }

    private sendSnapshot(peer: CollaborationPeer, room: CollaborationRoomState): void {
        send(peer, {
            type: 'room-snapshot',
            peerId: peer.id,
            roomId: room.id,
            revision: room.revision,
            payload: {
                entities: Array.from(room.entities.values()),
                presence: Array.from(room.presence.values()),
                participants: Array.from(room.participants.values()),
                presenterPeerId: room.presenterPeerId,
            },
        });
    }

    private leaveRoom(peer: CollaborationPeer): void {
        const room = this.registry.getRoomForPeer(peer);
        if (!room || peer.viewer) {
            peer.viewer = false;
            peer.joinedRoom = false;
            peer.roomId = null;
            return;
        }

        const participant = room.participants.get(peer.id);
        if (room.presenterPeerId === peer.id) {
            room.presenterPeerId = null;
            if (participant) {
                participant.isPresenter = false;
                room.revision += 1;
                sharedState.broadcastPresenterEvent(this.registry, room, 'presenter-stopped', participant);
            }
        }

        room.presence.delete(peer.id);
        room.participants.delete(peer.id);
        this.emitParticipantsChanged(room);

        sharedState.releaseEntityLocks(this.registry, room, peer.id);

        room.revision += 1;
        this.registry.broadcast(room, {
            type: 'presence-left',
            peerId: peer.id,
            roomId: room.id,
            revision: room.revision,
            payload: { peerId: peer.id },
        }, peer.id);

        if (participant?.role === 'host') {
            this.promoteOldestGuest(room);
        }

        peer.joinedRoom = false;
        peer.roomId = null;
        if (room.participants.size === 0 && room.entities.size === 0) {
            this.registry.rooms.delete(room.id);
        }
    }

    private promoteOldestGuest(room: CollaborationRoomState): void {
        const nextHost = Array.from(room.participants.values())
            .sort((left, right) => left.connectedAt.localeCompare(right.connectedAt))[0];
        if (!nextHost) {
            return;
        }
        nextHost.role = 'host';
        room.revision += 1;
        this.broadcastRoleUpdate(room, nextHost);
    }

    private broadcastRoleUpdate(room: CollaborationRoomState, participant: ParticipantState): void {
        const presence = room.presence.get(participant.peerId);
        if (presence) {
            presence.role = participant.role;
        }
        this.registry.broadcast(room, {
            type: 'role-updated',
            peerId: participant.peerId,
            roomId: room.id,
            revision: room.revision,
            payload: participant,
        });
    }

    private broadcastParticipantUpdate(room: CollaborationRoomState, participant: ParticipantState): void {
        const presence = room.presence.get(participant.peerId);
        if (presence) {
            Object.assign(presence, getParticipantPresence(participant));
        }
        room.revision += 1;
        this.registry.broadcast(room, {
            type: 'participant-updated',
            peerId: participant.peerId,
            roomId: room.id,
            revision: room.revision,
            payload: participant,
        });
    }

    private emitParticipantsChanged(room: CollaborationRoomState): void {
        this.events.emit(
            'participants-changed',
            room.id,
            this.getConnectedParticipants(room.id),
        );
    }

}
