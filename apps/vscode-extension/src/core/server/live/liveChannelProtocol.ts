/**
 * The live channel's wire contract (epic #341).
 *
 * Every analysis server pushes its live updates (live reload of XR scenes and
 * DOM pages, LivePanel feature updates) over ONE WebSocket per page, on
 * {@link LIVE_CHANNEL_PATH}. It replaced the `/events` Server-Sent Events
 * stream; the collaboration room keeps its own endpoint (`/codexr-room`)
 * because it carries identity and authority, while the live channel is a
 * broadcast with none.
 *
 * The browser half of this contract is `templates/components/live/liveChannel.js`
 * (a classic script, so it cannot import this module): the constants below are
 * mirrored there and a unit test keeps the two in step.
 *
 * Pure module: no `vscode`, no `ws`, so the IDE and the tests import it as is.
 */

/** The WebSocket path every analysis server answers for live updates. */
export const LIVE_CHANNEL_PATH = '/codexr-live';

/** Envelope version, bumped on an incompatible change. */
export const LIVE_CHANNEL_PROTOCOL_VERSION = 1;

/** How often the server pings each socket and sends the application heartbeat. */
export const LIVE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * A client that heard nothing (not even a heartbeat) for this long treats the
 * socket as half-open (laptop slept, Wi-Fi changed) and reconnects.
 */
export const LIVE_CLIENT_SILENCE_TIMEOUT_MS = LIVE_HEARTBEAT_INTERVAL_MS * 3;

/** Reconnect back-off: first retry after the minimum, doubling up to the maximum. */
export const LIVE_RECONNECT_MIN_DELAY_MS = 1_000;
export const LIVE_RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Close codes. 1000/1001 are the standard ones; the 4xxx range is ours.
 * `NO_ANALYSIS`: this server serves no analysis (the old SSE route answered
 * 404); the client keeps backing off instead of spinning.
 */
export const LIVE_CLOSE_NORMAL = 1000;
export const LIVE_CLOSE_GOING_AWAY = 1001;
export const LIVE_CLOSE_NO_ANALYSIS = 4404;

/** Every message type the server sends on the live channel. */
export const LIVE_MESSAGE_TYPES = [
    /** Greeting, first message of every socket: carries `revision` and `epoch` for resync. */
    'connected',
    /** Application keep-alive the browser can observe (it cannot see WebSocket pings). */
    'heartbeat',
    /** The analysis data was regenerated (XR scenes, LivePanel). */
    'analysis-updated',
    /** XR scenes: reload the chart data sources. */
    'dataRefresh',
    /** DOM visualisation: the generated HTML changed; carries `htmlContent`. */
    'htmlUpdated',
    /** LivePanel: the dependency dataset was rewritten. */
    'dependency-updated',
    /** LivePanel: historical comparison progress. */
    'historical-progress',
    /** LivePanel: a historical comparison finished or was refreshed. */
    'historical-updated',
] as const;

export type LiveMessageType = typeof LIVE_MESSAGE_TYPES[number];

/** What every message on the wire looks like. */
export interface LiveChannelEnvelope {
    readonly v: number;
    readonly type: LiveMessageType;
    readonly channel: string;
    /** Count of non-heartbeat messages published on this channel by this hub. */
    readonly revision: number;
    /** Random id of the hub instance; a new one means the server restarted. */
    readonly epoch: string;
    readonly timestamp: string;
    readonly [field: string]: unknown;
}

/** Fields reserved by the envelope; a payload cannot override them. */
const RESERVED_FIELDS = new Set(['v', 'type', 'channel', 'revision', 'epoch', 'timestamp']);

export function isLiveMessageType(value: unknown): value is LiveMessageType {
    return typeof value === 'string' && (LIVE_MESSAGE_TYPES as readonly string[]).includes(value);
}

/** Builds the envelope for one message. Reserved fields in `payload` are ignored. */
export function encodeLiveMessage(input: {
    type: LiveMessageType;
    channel: string;
    revision: number;
    epoch: string;
    payload?: Readonly<Record<string, unknown>>;
    now?: Date;
}): string {
    const envelope: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.payload ?? {})) {
        if (!RESERVED_FIELDS.has(key)) {
            envelope[key] = value;
        }
    }
    envelope.v = LIVE_CHANNEL_PROTOCOL_VERSION;
    envelope.type = input.type;
    envelope.channel = input.channel;
    envelope.revision = input.revision;
    envelope.epoch = input.epoch;
    envelope.timestamp = (input.now ?? new Date()).toISOString();
    return JSON.stringify(envelope);
}

/**
 * Reconnect delay after `previousDelayMs` (0 for the first retry): doubles from
 * the minimum up to the maximum. `random` in [0, 1) adds up to 20% jitter so a
 * room full of headsets does not reconnect in lockstep after a restart.
 */
export function nextReconnectDelay(previousDelayMs: number, random: number = Math.random()): number {
    const base = previousDelayMs > 0
        ? Math.min(LIVE_RECONNECT_MAX_DELAY_MS, previousDelayMs * 2)
        : LIVE_RECONNECT_MIN_DELAY_MS;
    return Math.min(LIVE_RECONNECT_MAX_DELAY_MS, Math.round(base * (1 + 0.2 * random)));
}

/**
 * Whether a client that last saw (`epoch`, `revision`) missed something,
 * judged from a fresh greeting (any change of revision counts). A new epoch means the server restarted, so the
 * revision count started over and everything may have changed.
 */
export function needsResync(
    last: { epoch: string; revision: number } | null,
    greeting: { epoch: string; revision: number },
): boolean {
    if (!last) {
        return false;
    }
    // A lower revision under the same epoch means the channel was closed and
    // opened again (server stopped and restarted in this process): resync too.
    return last.epoch !== greeting.epoch || greeting.revision !== last.revision;
}
