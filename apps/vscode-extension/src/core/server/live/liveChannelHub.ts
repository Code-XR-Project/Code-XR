import { randomBytes } from 'crypto';
import { getLogger } from '../../../platform/logging/sink';
import {
    LIVE_CLOSE_GOING_AWAY,
    LIVE_CLOSE_NORMAL,
    LIVE_HEARTBEAT_INTERVAL_MS,
    encodeLiveMessage,
    type LiveMessageType,
} from './liveChannelProtocol';

const logger = getLogger('LIVE_CHANNEL');

/** `WebSocket.OPEN`, without importing `ws` here (tests pass fakes). */
const SOCKET_OPEN = 1;

/** The part of a `ws` WebSocket the hub uses. */
export interface LiveSocket {
    readonly readyState: number;
    send(data: string): void;
    ping(): void;
    terminate(): void;
    close(code?: number, reason?: string): void;
    on(event: 'pong' | 'close' | 'error', listener: (...args: unknown[]) => void): unknown;
}

interface ChannelState {
    readonly sockets: Set<LiveSocket>;
    revision: number;
}

export interface LiveChannelHubOptions {
    heartbeatIntervalMs?: number;
    /** Timer seam for the tests. */
    setInterval?: (callback: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
    epoch?: string;
}

/**
 * Fans live updates out to every page of an analysis over WebSocket (#342).
 *
 * Sockets are grouped by channel: the session id (or file URI) of the analysis
 * the serving port belongs to, the same key the re-analysis watchers publish
 * on. Replaced `SSEManager` + `SSEClientRegistry`, and adds what SSE only gave
 * implicitly:
 *  - liveness: a ping per heartbeat, a socket that missed the previous pong is
 *    terminated; plus an application `heartbeat` the browser can observe;
 *  - continuity: every non-heartbeat publish bumps the channel's revision, and
 *    the greeting carries it with the hub's epoch so a reconnecting page knows
 *    whether it missed an update (see `needsResync`).
 *
 * One hub per process (the singleton below), shared by every analysis server
 * of the VS Code extension or the IDE. The heartbeat timer only runs while at
 * least one socket is attached, and is unref'd.
 */
export class LiveChannelHub {
    private readonly channels = new Map<string, ChannelState>();
    private readonly alive = new WeakMap<LiveSocket, boolean>();
    private readonly heartbeatIntervalMs: number;
    private readonly startTimer: (callback: () => void, ms: number) => unknown;
    private readonly stopTimer: (handle: unknown) => void;
    private heartbeatTimer: unknown = null;
    public readonly epoch: string;

    constructor(options: LiveChannelHubOptions = {}) {
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? LIVE_HEARTBEAT_INTERVAL_MS;
        this.startTimer = options.setInterval ?? ((callback, ms) => {
            const handle = setInterval(callback, ms);
            handle.unref?.();
            return handle;
        });
        this.stopTimer = options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
        this.epoch = options.epoch ?? randomBytes(8).toString('hex');
    }

    /** Adds a socket to a channel and greets it with the channel's revision and the hub epoch. */
    attach(channel: string, socket: LiveSocket): void {
        const state = this.channelState(channel);
        state.sockets.add(socket);
        this.alive.set(socket, true);
        socket.on('pong', () => this.alive.set(socket, true));
        socket.on('close', () => this.detach(channel, socket));
        socket.on('error', (error) => {
            logger.debug(() => `Live socket error on ${channel}: ${String(error)}`);
            this.detach(channel, socket);
        });
        this.sendTo(socket, channel, 'connected', state.revision, {});
        this.ensureHeartbeat();
        logger.debug(() => `Live socket attached to ${channel} (${state.sockets.size} open)`);
    }

    /**
     * Sends one message to every socket of a channel. Returns how many sockets
     * received it. Bumps the channel's revision even when nobody listens, so a
     * page that connects later still compares against the true count.
     */
    publish(channel: string, type: LiveMessageType, payload: Readonly<Record<string, unknown>> = {}): number {
        const state = this.channelState(channel);
        if (type !== 'heartbeat' && type !== 'connected') {
            state.revision += 1;
        }
        let delivered = 0;
        for (const socket of [...state.sockets]) {
            if (this.sendTo(socket, channel, type, state.revision, payload)) {
                delivered += 1;
            }
        }
        logger.debug(() => `Live '${type}' on ${channel}: ${delivered} socket(s), revision ${state.revision}`);
        return delivered;
    }

    /** The analysis data was regenerated (XR scenes and LivePanel reload it). */
    publishAnalysisUpdated(channel: string): number {
        return this.publish(channel, 'analysis-updated', { action: 'reload-data' });
    }

    /** XR scenes: reload the chart data sources. */
    publishDataRefresh(channel: string): number {
        return this.publish(channel, 'dataRefresh', { action: 'xr-data-refresh' });
    }

    clientCount(channel: string): number {
        return this.channels.get(channel)?.sockets.size ?? 0;
    }

    revision(channel: string): number {
        return this.channels.get(channel)?.revision ?? 0;
    }

    activeChannels(): string[] {
        return [...this.channels.entries()].filter(([, state]) => state.sockets.size > 0).map(([channel]) => channel);
    }

    /** Closes every socket of a channel and forgets it (its server stopped). */
    closeChannel(channel: string): void {
        const state = this.channels.get(channel);
        if (!state) {
            return;
        }
        this.channels.delete(channel);
        for (const socket of state.sockets) {
            this.closeSocket(socket, LIVE_CLOSE_GOING_AWAY, 'analysis stopped');
        }
        this.stopHeartbeatIfIdle();
    }

    /** Closes everything (deactivation). */
    dispose(): void {
        for (const state of this.channels.values()) {
            for (const socket of state.sockets) {
                this.closeSocket(socket, LIVE_CLOSE_NORMAL, 'server shutting down');
            }
        }
        this.channels.clear();
        this.stopHeartbeat();
    }

    /** One heartbeat round; exposed for the tests. */
    heartbeat(): void {
        for (const [channel, state] of this.channels) {
            for (const socket of [...state.sockets]) {
                if (this.alive.get(socket) === false) {
                    logger.debug(() => `Live socket on ${channel} missed a pong; terminating`);
                    this.detach(channel, socket);
                    try {
                        socket.terminate();
                    } catch {
                        // already gone
                    }
                    continue;
                }
                this.alive.set(socket, false);
                try {
                    socket.ping();
                } catch {
                    this.detach(channel, socket);
                    continue;
                }
                this.sendTo(socket, channel, 'heartbeat', state.revision, {});
            }
        }
    }

    private channelState(channel: string): ChannelState {
        let state = this.channels.get(channel);
        if (!state) {
            state = { sockets: new Set(), revision: 0 };
            this.channels.set(channel, state);
        }
        return state;
    }

    private detach(channel: string, socket: LiveSocket): void {
        const state = this.channels.get(channel);
        if (state?.sockets.delete(socket)) {
            logger.debug(() => `Live socket detached from ${channel} (${state.sockets.size} open)`);
        }
        this.stopHeartbeatIfIdle();
    }

    private sendTo(
        socket: LiveSocket,
        channel: string,
        type: LiveMessageType,
        revision: number,
        payload: Readonly<Record<string, unknown>>,
    ): boolean {
        if (socket.readyState !== SOCKET_OPEN) {
            this.detach(channel, socket);
            return false;
        }
        try {
            socket.send(encodeLiveMessage({ type, channel, revision, epoch: this.epoch, payload }));
            return true;
        } catch (error) {
            logger.debug(() => `Live send failed on ${channel}: ${String(error)}`);
            this.detach(channel, socket);
            return false;
        }
    }

    private closeSocket(socket: LiveSocket, code: number, reason: string): void {
        try {
            socket.close(code, reason);
        } catch {
            // already closed
        }
    }

    private ensureHeartbeat(): void {
        if (this.heartbeatTimer === null) {
            this.heartbeatTimer = this.startTimer(() => this.heartbeat(), this.heartbeatIntervalMs);
        }
    }

    private stopHeartbeatIfIdle(): void {
        for (const state of this.channels.values()) {
            if (state.sockets.size > 0) {
                return;
            }
        }
        this.stopHeartbeat();
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer !== null) {
            this.stopTimer(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}

/** The process-wide hub every analysis server and watcher publishes through. */
export const liveChannelHub = new LiveChannelHub();
