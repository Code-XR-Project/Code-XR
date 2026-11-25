import * as http from 'http';
import { WebSocket, RawData } from 'ws';
import { attachWebSocketEndpoint, DEFAULT_ROOM_ID, WebSocketEndpoint } from '../ws/webSocketEndpoint';
import {
    BroadcastClient,
    BroadcastClientScope,
    BroadcastMessage,
    BroadcastScreenState,
} from './broadcastTypes';
import { toFrameBuffer } from './mediaFrame';
import {
    promoteViewerToRelay,
    publishRelayAudience,
    RelayContext,
    relayFrameToViewers,
    removeRelayViewer,
} from './relayPolicy';

export type { BroadcastClientScope } from './broadcastTypes';

export class ScreenBroadcastSignalingServer {
    private readonly endpoint: WebSocketEndpoint;
    private readonly clients = new Map<string, BroadcastClient>();
    private readonly screens = new Map<string, BroadcastScreenState>();
    private readonly relayContext: RelayContext = {
        clients: this.clients,
        send: (client, payload) => this.send(client, payload),
        ensureScreenState: (roomId, screenId) => this.ensureScreenState(roomId, screenId),
    };
    private disposed = false;

    constructor(
        server: http.Server,
        path = '/codexr-broadcast',
        private readonly authorizeUpgrade: (request: http.IncomingMessage) => boolean = () => true,
        private readonly resolveScope: (request: http.IncomingMessage) => BroadcastClientScope = () => 'local',
    ) {
        this.endpoint = attachWebSocketEndpoint(server, path, {
            authorize: (req) => this.authorizeUpgrade(req),
            onConnection: (socket, request) => this.handleConnection(socket, this.resolveScope(request)),
        });
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;

        this.endpoint.detach();

        for (const client of this.clients.values()) {
            try {
                client.socket.close();
            } catch {
                // Best-effort cleanup.
            }
        }
        this.clients.clear();
        this.screens.clear();
        this.endpoint.socketServer.close();
    }

    private handleConnection(socket: WebSocket, scope: BroadcastClientScope): void {
        const clientId = this.createId('client');
        const client: BroadcastClient = {
            id: clientId,
            roomId: null,
            socket,
            screenId: null,
            role: 'none',
            hasAudio: false,
            scope,
        };

        this.clients.set(clientId, client);

        socket.on('message', (raw: RawData, isBinary: boolean) => {
            if (isBinary) {
                this.forwardMediaFrame(client, raw);
                return;
            }
            this.handleMessage(client, raw);
        });

        socket.on('close', () => {
            this.handleDisconnect(client);
        });

        socket.on('error', () => {
            this.handleDisconnect(client);
        });
    }

    private handleMessage(client: BroadcastClient, raw: RawData): void {
        const message = this.parseMessage(raw);
        if (!message) {
            this.send(client, {
                type: 'error',
                message: 'Invalid broadcast signaling payload.',
            });
            return;
        }

        switch (message.type) {
            case 'register':
                this.registerClient(client, message);
                return;
            case 'broadcast-start':
                this.startBroadcast(client, message);
                return;
            case 'broadcast-stop':
                this.stopBroadcast(client, message.reason || 'sender-stopped');
                return;
            case 'viewer-join':
                this.registerViewer(client);
                return;
            case 'relay-request':
                // A viewer whose direct connection never delivered media asks
                // to be served through the relay instead.
                promoteViewerToRelay(this.relayContext, client);
                return;
            case 'viewer-leave':
                this.removeViewer(client);
                return;
            case 'signal-offer':
            case 'signal-answer':
            case 'signal-ice':
                this.forwardSignal(client, message);
                return;
            default:
                this.send(client, {
                    type: 'error',
                    message: `Unsupported broadcast message type: ${message.type}`,
                });
        }
    }

    private registerClient(client: BroadcastClient, message: BroadcastMessage): void {
        const requestedId = this.normalizeId(message.clientId);
        if (requestedId && requestedId !== client.id && !this.clients.has(requestedId)) {
            this.clients.delete(client.id);
            client.id = requestedId;
            this.clients.set(client.id, client);
        }

        client.screenId = this.normalizeScreenId(message.screenId);
        client.roomId = this.normalizeRoomId(message.roomId);
        client.role = 'none';
        client.hasAudio = false;

        this.send(client, {
            type: 'registered',
            clientId: client.id,
            roomId: client.roomId,
            screenId: client.screenId,
        });

        const screen = this.getScreenState(client.roomId, client.screenId);
        if (screen?.broadcasterId && screen.broadcasterId !== client.id) {
            this.send(client, {
                type: 'broadcast-available',
                roomId: screen.roomId,
                screenId: screen.screenId,
                broadcasterId: screen.broadcasterId,
                hasAudio: screen.hasAudio,
            });
        }
    }

    private startBroadcast(client: BroadcastClient, message: BroadcastMessage): void {
        const roomId = this.requireRoomId(client, message);
        if (!roomId) {
            return;
        }
        const screenId = this.requireScreenId(client, message);
        if (!screenId) {
            return;
        }

        const screen = this.ensureScreenState(roomId, screenId);
        const previousBroadcasterId = screen.broadcasterId;

        if (previousBroadcasterId && previousBroadcasterId !== client.id) {
            const previousBroadcaster = this.clients.get(previousBroadcasterId);
            // One screen, one broadcaster: a live broadcast cannot be taken
            // over. The screen only frees up if its holder's socket is dead
            // (a half-finished reconnect must not lock the screen forever).
            if (previousBroadcaster && previousBroadcaster.socket.readyState === WebSocket.OPEN) {
                this.send(client, {
                    type: 'broadcast-denied',
                    roomId,
                    screenId,
                    broadcasterId: previousBroadcasterId,
                });
                return;
            }
            if (previousBroadcaster) {
                previousBroadcaster.role = 'none';
                previousBroadcaster.hasAudio = false;
            }
        }

        client.role = 'sender';
        client.hasAudio = !!message.hasAudio;
        screen.broadcasterId = client.id;
        screen.hasAudio = client.hasAudio;

        this.send(client, {
            type: 'broadcast-live',
            roomId,
            screenId,
            hasAudio: client.hasAudio,
        });

        // Serve the viewers that were parked before this broadcast existed.
        // Direct-path viewers get the deferred viewer-join the broadcaster
        // never saw; relay viewers need the encoder started AND their own
        // relay-ready, or their receivers never come up.
        for (const viewerId of screen.viewers) {
            if (viewerId !== client.id) {
                this.send(client, {
                    type: 'viewer-join',
                    roomId,
                    screenId,
                    viewerId,
                });
            }
        }
        if (screen.relayViewers.size > 0) {
            this.send(client, {
                type: 'relay-start',
                roomId,
                screenId,
                relayViewerCount: screen.relayViewers.size,
            });
            for (const viewerId of screen.relayViewers) {
                const relayViewer = this.clients.get(viewerId);
                if (relayViewer) {
                    this.send(relayViewer, {
                        type: 'relay-ready',
                        roomId,
                        screenId,
                        broadcasterId: client.id,
                        hasAudio: client.hasAudio,
                    });
                }
            }
            publishRelayAudience(this.relayContext, screen);
        }

        for (const candidate of this.clients.values()) {
            if (
                candidate.id === client.id
                || candidate.roomId !== roomId
                || candidate.screenId !== screenId
            ) {
                continue;
            }
            this.send(candidate, {
                type: 'broadcast-available',
                roomId,
                screenId,
                broadcasterId: client.id,
                hasAudio: client.hasAudio,
            });
        }
    }

    private stopBroadcast(client: BroadcastClient, reason: string): void {
        const roomId = client.roomId;
        const screenId = client.screenId;
        if (!roomId || !screenId) {
            return;
        }

        const screen = this.getScreenState(roomId, screenId);
        if (!screen || screen.broadcasterId !== client.id) {
            return;
        }

        for (const viewerId of [...screen.viewers, ...screen.relayViewers]) {
            const viewer = this.clients.get(viewerId);
            if (viewer) {
                viewer.role = 'none';
                this.send(viewer, {
                    type: 'broadcast-stopped',
                    roomId,
                    screenId,
                    reason,
                });
            }
        }

        client.role = 'none';
        client.hasAudio = false;
        screen.broadcasterId = null;
        screen.hasAudio = false;
        screen.viewers.clear();
        screen.relayViewers.clear();
        this.pruneScreen(roomId, screenId);
    }

    private registerViewer(client: BroadcastClient): void {
        const roomId = client.roomId;
        const screenId = client.screenId;
        if (!roomId || !screenId) {
            this.send(client, {
                type: 'error',
                message: 'Viewer cannot join without a screenId.',
            });
            return;
        }

        const screen = this.ensureScreenState(roomId, screenId);
        client.role = 'viewer';

        if (!screen.broadcasterId) {
            // The screen entity travels over the room socket and routinely
            // announces the broadcast before broadcast-start reaches this
            // socket. An early viewer waits to be served, instead of being
            // told a broadcast that is about to exist has stopped.
            this.parkViewer(screen, client);
            return;
        }

        const broadcaster = this.clients.get(screen.broadcasterId);

        // Viewers on this network get direct WebRTC; the ones arriving through
        // the tunnel get the media relayed, because peer-to-peer cannot reach
        // them and they would otherwise sit on a black screen.
        if (client.scope === 'remote') {
            const wasIdle = screen.relayViewers.size === 0;
            screen.relayViewers.add(client.id);
            this.send(client, {
                type: 'relay-ready',
                roomId,
                screenId,
                broadcasterId: screen.broadcasterId,
                hasAudio: screen.hasAudio,
            });
            if (broadcaster) {
                this.send(broadcaster, {
                    // Starting the encoder is the expensive part, so it only
                    // happens for the first relay viewer; later ones just need
                    // a keyframe to be able to decode mid-stream.
                    type: wasIdle ? 'relay-start' : 'relay-keyframe',
                    roomId,
                    screenId,
                    viewerId: client.id,
                    relayViewerCount: screen.relayViewers.size,
                });
            }
            publishRelayAudience(this.relayContext, screen);
            return;
        }

        screen.viewers.add(client.id);
        if (broadcaster) {
            this.send(broadcaster, {
                type: 'viewer-join',
                roomId,
                screenId,
                viewerId: client.id,
            });
        }
    }

    /** Park a viewer that arrived before the broadcast it is waiting for. */
    private parkViewer(screen: BroadcastScreenState, client: BroadcastClient): void {
        if (client.scope === 'remote') {
            screen.relayViewers.add(client.id);
        } else {
            screen.viewers.add(client.id);
        }
        this.send(client, {
            type: 'viewer-waiting',
            roomId: screen.roomId,
            screenId: screen.screenId,
        });
    }

    /** Move a viewer off the direct path and onto the relay. */
    /**
     * Relay one encoded media frame from the broadcaster to the viewers that
     * cannot be reached peer-to-peer. The payload is never inspected beyond
     * its header: this server is a pipe, not a transcoder.
     */
    private forwardMediaFrame(client: BroadcastClient, raw: RawData): void {
        const frame = toFrameBuffer(raw);
        if (!frame) {
            return;
        }

        const screen = this.getScreenState(client.roomId, client.screenId);
        if (!screen || screen.broadcasterId !== client.id || screen.relayViewers.size === 0) {
            return;
        }

        relayFrameToViewers(this.relayContext, screen, frame);
    }

    private removeViewer(client: BroadcastClient): void {
        const roomId = client.roomId;
        const screenId = client.screenId;
        if (!roomId || !screenId) {
            return;
        }

        const screen = this.getScreenState(roomId, screenId);
        if (!screen) {
            client.role = 'none';
            return;
        }

        if (screen.viewers.delete(client.id) && screen.broadcasterId) {
            const broadcaster = this.clients.get(screen.broadcasterId);
            if (broadcaster) {
                this.send(broadcaster, {
                    type: 'viewer-left',
                    roomId,
                    screenId,
                    viewerId: client.id,
                });
            }
        }
        removeRelayViewer(this.relayContext, screen, client.id);

        client.role = 'none';
        this.pruneScreen(roomId, screenId);
    }

    private forwardSignal(client: BroadcastClient, message: BroadcastMessage): void {
        const roomId = client.roomId;
        const screenId = client.screenId;
        const targetId = this.normalizeId(message.targetId);
        if (!roomId || !screenId || !targetId) {
            return;
        }

        const target = this.clients.get(targetId);
        if (!target || target.roomId !== roomId || target.screenId !== screenId) {
            return;
        }

        this.send(target, {
            type: message.type,
            roomId,
            screenId,
            clientId: client.id,
            description: message.description,
            candidate: message.candidate,
        });
    }

    private handleDisconnect(client: BroadcastClient): void {
        if (!this.clients.has(client.id)) {
            return;
        }

        if (client.role === 'sender') {
            this.stopBroadcast(client, 'sender-disconnected');
        } else if (client.role === 'viewer') {
            this.removeViewer(client);
        }

        this.clients.delete(client.id);
    }

    private send(client: BroadcastClient, payload: Record<string, unknown>): void {
        if (client.socket.readyState !== WebSocket.OPEN) {
            return;
        }

        client.socket.send(JSON.stringify(payload));
    }

    private parseMessage(raw: RawData): BroadcastMessage | null {
        try {
            const text = typeof raw === 'string'
                ? raw
                : Array.isArray(raw)
                    ? Buffer.concat(raw).toString('utf8')
                : raw instanceof Buffer
                    ? raw.toString('utf8')
                    : Buffer.from(raw as ArrayBufferLike).toString('utf8');
            const parsed = JSON.parse(text);
            return parsed && typeof parsed === 'object' ? parsed as BroadcastMessage : null;
        } catch {
            return null;
        }
    }

    private createId(prefix: string): string {
        return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
    }

    private normalizeId(value: unknown): string {
        return typeof value === 'string' ? value.trim() : '';
    }

    private normalizeScreenId(value: unknown): string {
        const normalized = typeof value === 'string' ? value.trim() : '';
        return normalized || 'default';
    }

    private normalizeRoomId(value: unknown): string {
        const normalized = typeof value === 'string' ? value.trim() : '';
        return normalized || DEFAULT_ROOM_ID;
    }

    private requireScreenId(client: BroadcastClient, message: BroadcastMessage): string | null {
        const screenId = this.normalizeScreenId(message.screenId || client.screenId);
        if (!screenId) {
            this.send(client, {
                type: 'error',
                message: 'Broadcast signaling requires a screenId.',
            });
            return null;
        }

        client.screenId = screenId;
        return screenId;
    }

    private requireRoomId(client: BroadcastClient, message: BroadcastMessage): string | null {
        const roomId = this.normalizeRoomId(message.roomId || client.roomId);
        if (!roomId) {
            this.send(client, {
                type: 'error',
                message: 'Broadcast signaling requires a roomId.',
            });
            return null;
        }
        client.roomId = roomId;
        return roomId;
    }

    private getScreenKey(roomId: string, screenId: string): string {
        return `${roomId}::${screenId}`;
    }

    private ensureScreenState(roomId: string, screenId: string): BroadcastScreenState {
        const key = this.getScreenKey(roomId, screenId);
        const existing = this.screens.get(key);
        if (existing) {
            return existing;
        }

        const created: BroadcastScreenState = {
            roomId,
            screenId,
            broadcasterId: null,
            hasAudio: false,
            viewers: new Set<string>(),
            relayViewers: new Set<string>(),
        };
        this.screens.set(key, created);
        return created;
    }

    private getScreenState(roomId: string | null, screenId: string | null): BroadcastScreenState | null {
        if (!roomId || !screenId) {
            return null;
        }
        return this.screens.get(this.getScreenKey(roomId, screenId)) || null;
    }

    private pruneScreen(roomId: string, screenId: string): void {
        const key = this.getScreenKey(roomId, screenId);
        const screen = this.screens.get(key);
        if (!screen) {
            return;
        }

        if (!screen.broadcasterId && screen.viewers.size === 0 && screen.relayViewers.size === 0) {
            this.screens.delete(key);
        }
    }
}
