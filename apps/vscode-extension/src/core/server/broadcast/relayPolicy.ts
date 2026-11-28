import { WebSocket } from 'ws';
import { BroadcastClient, BroadcastScreenState } from './broadcastTypes';
import { readFrameHeader } from './mediaFrame';

/**
 * The media relay for viewers peer-to-peer cannot reach: who is served by
 * it, what the broadcaster is told about that audience, and how one encoded
 * stream is thinned per congested viewer. The server hands it a narrow
 * context; it never sees the signalling protocol.
 */
export interface RelayContext {
    readonly clients: ReadonlyMap<string, BroadcastClient>;
    send(client: BroadcastClient, payload: Record<string, unknown>): void;
    ensureScreenState(roomId: string, screenId: string): BroadcastScreenState;
}

/**
 * Backlog thresholds per viewer socket. A viewer that falls behind loses the
 * top temporal layer first (fewer frames per second, still a moving picture)
 * and only then every delta, until its next keyframe puts it back together.
 * Nobody else is affected, and nobody is ever refused.
 */
export const RELAY_THIN_TOP_LAYER_BYTES = 512 * 1024;
export const RELAY_THIN_ALL_DELTAS_BYTES = 2 * 1024 * 1024;

export function promoteViewerToRelay(context: RelayContext, client: BroadcastClient): void {
    if (!client.roomId || !client.screenId) {
        return;
    }
    const screen = context.ensureScreenState(client.roomId, client.screenId);
    if (screen.relayViewers.has(client.id)) {
        return;
    }
    if (!screen.broadcasterId) {
        // No broadcast yet: the viewer asked for the relay, so it waits on
        // the relay side (whatever its scope) rather than vanishing.
        screen.viewers.delete(client.id);
        screen.relayViewers.add(client.id);
        client.role = 'viewer';
        context.send(client, {
            type: 'viewer-waiting',
            roomId: screen.roomId,
            screenId: screen.screenId,
        });
        return;
    }

    const wasIdle = screen.relayViewers.size === 0;
    const wasDirect = screen.viewers.delete(client.id);
    screen.relayViewers.add(client.id);
    client.role = 'viewer';

    const broadcasterForLeave = context.clients.get(screen.broadcasterId);
    if (wasDirect && broadcasterForLeave) {
        // The direct peer connection is abandoned: let the broadcaster close
        // it instead of feeding tracks and ICE into it (COLLAB-SCREEN-11).
        context.send(broadcasterForLeave, {
            type: 'viewer-left',
            roomId: screen.roomId,
            screenId: screen.screenId,
            viewerId: client.id,
        });
    }

    context.send(client, {
        type: 'relay-ready',
        roomId: screen.roomId,
        screenId: screen.screenId,
        broadcasterId: screen.broadcasterId,
        hasAudio: screen.hasAudio,
    });

    const broadcaster = context.clients.get(screen.broadcasterId);
    if (broadcaster) {
        context.send(broadcaster, {
            type: wasIdle ? 'relay-start' : 'relay-keyframe',
            roomId: screen.roomId,
            screenId: screen.screenId,
            viewerId: client.id,
            relayViewerCount: screen.relayViewers.size,
        });
    }
    publishRelayAudience(context, screen);
}

/**
 * Tell the broadcaster how many viewers it is feeding, so it can pick a
 * quality the host's uplink can actually carry. One encoding serves them
 * all — the audience only changes how that single encoding is configured.
 */
export function publishRelayAudience(context: RelayContext, screen: BroadcastScreenState): void {
    const broadcaster = screen.broadcasterId ? context.clients.get(screen.broadcasterId) : null;
    if (!broadcaster) {
        return;
    }
    context.send(broadcaster, {
        type: 'relay-audience',
        roomId: screen.roomId,
        screenId: screen.screenId,
        relayViewerCount: screen.relayViewers.size,
    });
}

/**
 * Relay one validated frame to the screen's relay viewers, skipping a
 * droppable frame for each viewer that is too far behind.
 */
export function relayFrameToViewers(context: RelayContext, screen: BroadcastScreenState, frame: Buffer): void {
    const { droppable, temporalLayer } = readFrameHeader(frame);

    for (const viewerId of screen.relayViewers) {
        const viewer = context.clients.get(viewerId);
        if (!viewer || viewer.socket.readyState !== WebSocket.OPEN) {
            continue;
        }
        if (droppable && shouldThinFrame(viewer.socket.bufferedAmount, temporalLayer)) {
            continue;
        }
        viewer.socket.send(frame, { binary: true });
    }
}

/**
 * Whether a viewer this far behind should skip a droppable frame of this
 * layer. Thinning is per viewer and per layer: one congested guest drops to a
 * lower frame rate while everybody else keeps the full stream from the same
 * encoding.
 */
export function shouldThinFrame(backlogBytes: number, temporalLayer: number): boolean {
    if (backlogBytes > RELAY_THIN_ALL_DELTAS_BYTES) {
        return true;
    }
    return backlogBytes > RELAY_THIN_TOP_LAYER_BYTES && temporalLayer > 0;
}

export function removeRelayViewer(context: RelayContext, screen: BroadcastScreenState, clientId: string): void {
    if (!screen.relayViewers.delete(clientId)) {
        return;
    }
    if (screen.relayViewers.size > 0) {
        // A smaller audience may allow better quality again.
        publishRelayAudience(context, screen);
        return;
    }
    // Nobody left to relay to: tell the broadcaster to shut the encoder
    // down instead of encoding into the void.
    const broadcaster = screen.broadcasterId ? context.clients.get(screen.broadcasterId) : null;
    if (broadcaster) {
        context.send(broadcaster, {
            type: 'relay-stop',
            roomId: screen.roomId,
            screenId: screen.screenId,
        });
    }
}
