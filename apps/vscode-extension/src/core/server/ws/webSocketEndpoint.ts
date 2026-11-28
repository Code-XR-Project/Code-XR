import * as http from 'http';
import * as net from 'net';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * The room every browser joins when it names none. It is part of the wire
 * contract: the collaboration room and the broadcast server must agree on it.
 */
export const DEFAULT_ROOM_ID = 'codexr-session:default';

/**
 * How often every socket is pinged. Two jobs: a socket that misses a pong is
 * dead (a phone that changed network, a laptop that slept) and is terminated,
 * so its participant leaves instead of lingering as a frozen avatar; and the
 * traffic keeps a Cloudflare tunnel, which closes WebSockets idle for 100 s,
 * from dropping a quiet guest (COLLAB-ROOM-1).
 */
export const WEBSOCKET_HEARTBEAT_MS = 25_000;

/**
 * The largest message a client may send on these sockets. Room and signaling
 * messages are small JSON; relayed media frames are capped at 4 MiB by the
 * relay itself. Without a cap, `ws` accepted 100 MiB per message (COLLAB-ROOM-5).
 */
export const WEBSOCKET_MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

export interface WebSocketEndpointHandlers {
    /** Decides an upgrade on this path; a refused one has its socket destroyed. */
    authorize: (request: http.IncomingMessage) => boolean;
    onConnection: (socket: WebSocket, request: http.IncomingMessage) => void;
    /** A tighter per-message cap than the default, for endpoints that carry only JSON. */
    maxPayloadBytes?: number;
}

export interface WebSocketEndpoint {
    readonly socketServer: WebSocketServer;
    /** Stops answering upgrades on the shared HTTP server. */
    detach(): void;
    /**
     * Closes every open socket whose upgrade request matches, e.g. all the
     * sockets of a removed participant's session (COLLAB-ROOM-3). Returns how many.
     */
    closeWhere(matches: (request: http.IncomingMessage) => boolean, code?: number, reason?: string): number;
}

/**
 * Serves one WebSocket path on an existing HTTP(S) server. Several endpoints
 * share the server's 'upgrade' event, so each one ignores every other path
 * (leaving it to its owner) instead of rejecting it.
 */
export function attachWebSocketEndpoint(
    server: http.Server,
    path: string,
    handlers: WebSocketEndpointHandlers,
    heartbeatMs: number = WEBSOCKET_HEARTBEAT_MS,
): WebSocketEndpoint {
    const endpointPath = path.startsWith('/') ? path : `/${path}`;
    const socketServer = new WebSocketServer({
        noServer: true,
        maxPayload: handlers.maxPayloadBytes ?? WEBSOCKET_MAX_PAYLOAD_BYTES,
    });
    const alive = new WeakSet<WebSocket>();
    const upgradeRequests = new WeakMap<WebSocket, http.IncomingMessage>();
    const heartbeat = setInterval(() => {
        for (const client of socketServer.clients) {
            if (!alive.has(client)) {
                client.terminate();
                continue;
            }
            alive.delete(client);
            try {
                client.ping();
            } catch {
                client.terminate();
            }
        }
    }, heartbeatMs);
    heartbeat.unref?.();
    const upgradeHandler = (req: http.IncomingMessage, socket: net.Socket, head: Buffer): void => {
        const pathname = new URL(req.url || '/', 'http://codexr.local').pathname;
        if (pathname !== endpointPath) {
            return;
        }
        if (!handlers.authorize(req)) {
            socket.destroy();
            return;
        }

        socketServer.handleUpgrade(req, socket, head, (ws: WebSocket) => {
            socketServer.emit('connection', ws, req);
        });
    };

    server.on('upgrade', upgradeHandler);
    socketServer.on('connection', (socket: WebSocket, request: http.IncomingMessage) => {
        alive.add(socket);
        upgradeRequests.set(socket, request);
        // An oversized message or a protocol error closes the socket (1009,
        // 1002); without a listener the 'error' event would crash the host.
        socket.on('error', () => undefined);
        socket.on('pong', () => alive.add(socket));
        handlers.onConnection(socket, request);
    });
    socketServer.on('close', () => clearInterval(heartbeat));

    return {
        socketServer,
        detach: () => {
            server.off('upgrade', upgradeHandler);
            clearInterval(heartbeat);
        },
        closeWhere: (matches, code = 4001, reason = 'Removed by room host') => {
            let closed = 0;
            for (const client of socketServer.clients) {
                const request = upgradeRequests.get(client);
                if (request && matches(request)) {
                    client.close(code, reason);
                    closed += 1;
                }
            }
            return closed;
        },
    };
}
