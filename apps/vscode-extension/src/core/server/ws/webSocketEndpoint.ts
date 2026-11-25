import * as http from 'http';
import * as net from 'net';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * The room every browser joins when it names none. It is part of the wire
 * contract: the collaboration room and the broadcast server must agree on it.
 */
export const DEFAULT_ROOM_ID = 'codexr-session:default';

export interface WebSocketEndpointHandlers {
    /** Decides an upgrade on this path; a refused one has its socket destroyed. */
    authorize: (request: http.IncomingMessage) => boolean;
    onConnection: (socket: WebSocket, request: http.IncomingMessage) => void;
}

export interface WebSocketEndpoint {
    readonly socketServer: WebSocketServer;
    /** Stops answering upgrades on the shared HTTP server. */
    detach(): void;
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
): WebSocketEndpoint {
    const endpointPath = path.startsWith('/') ? path : `/${path}`;
    const socketServer = new WebSocketServer({ noServer: true });
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
        handlers.onConnection(socket, request);
    });

    return {
        socketServer,
        detach: () => {
            server.off('upgrade', upgradeHandler);
        },
    };
}
