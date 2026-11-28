import * as http from 'http';
import type { WebSocket } from 'ws';
import { getLogger } from '../../../platform/logging/sink';
import { attachWebSocketEndpoint, type WebSocketEndpoint } from '../ws/webSocketEndpoint';
import { liveChannelHub, type LiveChannelHub } from './liveChannelHub';
import { LIVE_CHANNEL_PATH, LIVE_CLOSE_NO_ANALYSIS } from './liveChannelProtocol';

const logger = getLogger('LIVE_CHANNEL');

export interface LiveChannelEndpointOptions {
    /** Same policy as the collaboration room: local always, remote with a paired session. */
    authorize: (request: http.IncomingMessage) => boolean;
    /** The channel of the analysis this server serves, or null when it serves none. */
    resolveChannel: () => string | null;
    hub?: LiveChannelHub;
}

/**
 * Serves `/codexr-live` on one analysis server (#343): every socket joins the
 * channel of the analysis that server serves. Replaced the `/events` SSE route.
 * A server with no analysis closes the socket with `LIVE_CLOSE_NO_ANALYSIS`
 * (the SSE route answered 404), and the browser keeps backing off.
 */
export interface LiveChannelEndpoint {
    /** Stops answering upgrades and closes every live socket this server accepted. */
    dispose(): void;
    /** Closes the live sockets whose upgrade request matches (a removed participant's). */
    closeWhere(matches: (request: http.IncomingMessage) => boolean): number;
}

export function attachLiveChannelEndpoint(server: http.Server, options: LiveChannelEndpointOptions): LiveChannelEndpoint {
    const hub = options.hub ?? liveChannelHub;
    const endpoint: WebSocketEndpoint = attachWebSocketEndpoint(server, LIVE_CHANNEL_PATH, {
        authorize: options.authorize,
        onConnection: (socket: WebSocket) => {
            const channel = options.resolveChannel();
            if (!channel) {
                logger.warn('Live socket refused: this server serves no analysis');
                socket.close(LIVE_CLOSE_NO_ANALYSIS, 'no analysis on this server');
                return;
            }
            hub.attach(channel, socket);
        },
    });
    return {
        closeWhere: (matches) => endpoint.closeWhere(matches),
        dispose: () => {
            endpoint.detach();
            // Upgraded sockets escape server.closeAllConnections(); a socket
            // left open would also hold server.close() forever.
            for (const socket of endpoint.socketServer.clients) {
                socket.terminate();
            }
            endpoint.socketServer.close();
        },
    };
}
