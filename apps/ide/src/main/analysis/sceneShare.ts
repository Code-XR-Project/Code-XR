import type { SceneShareState, SceneShareStatus } from '../../shared/api.ts';

/**
 * Pure pieces of sharing a scene through a Cloudflare quick tunnel (#155),
 * kept free of Electron and of the core so they are unit-tested. The tunnel
 * itself is the core's `RemoteAccessManager`, as in the extension.
 */

const STATUSES: ReadonlySet<string> = new Set<SceneShareStatus>(['stopped', 'starting', 'shared', 'error']);
const MAX_ERROR_LENGTH = 500;

export const STOPPED: SceneShareState = Object.freeze({ status: 'stopped' });

/** A quick tunnel's address: `https://<name>.trycloudflare.com`, nothing else. */
export function isQuickTunnelUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048) {
        return false;
    }
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    return parsed.protocol === 'https:'
        && /^[a-z0-9-]+\.trycloudflare\.com$/i.test(parsed.hostname)
        && parsed.port === ''
        && parsed.username === '' && parsed.password === '';
}

/**
 * The header's view of the core's `RemoteAccessState` (or of nothing: a
 * server never shared). Anything unexpected reads as `stopped`; a public URL
 * is only passed on while shared and only when it is a quick tunnel's.
 */
export function toSceneShareState(remote: unknown): SceneShareState {
    if (typeof remote !== 'object' || remote === null) {
        return STOPPED;
    }
    const record = remote as Record<string, unknown>;
    const status = record['status'];
    if (typeof status !== 'string' || !STATUSES.has(status)) {
        return STOPPED;
    }
    if (status === 'shared') {
        const publicUrl = record['publicUrl'];
        return isQuickTunnelUrl(publicUrl) ? { status, publicUrl: new URL(publicUrl).origin } : STOPPED;
    }
    if (status === 'error') {
        const error = typeof record['error'] === 'string' && record['error'] !== '' ? record['error'] : 'The remote connection failed.';
        return { status, error: error.slice(0, MAX_ERROR_LENGTH) };
    }
    return { status: status as SceneShareStatus };
}

export function sameShareState(a: SceneShareState, b: SceneShareState): boolean {
    return a.status === b.status && a.publicUrl === b.publicUrl && a.error === b.error;
}

/**
 * Runs tasks one after another. The IDE turns the core's "cross-network
 * connections" setting on only while the person's own share request runs
 * (see `startShareOnce`); serialising that with analysis launches means no
 * server is ever launched while it is on, so the core never shares a new
 * server on its own.
 */
export class SerialQueue {
    private tail: Promise<unknown> = Promise.resolve();

    run<T>(task: () => Promise<T>): Promise<T> {
        const result = this.tail.then(task, task);
        this.tail = result.catch(() => undefined);
        return result;
    }
}

export interface ShareOnceDeps {
    /** Turns the core's `remoteAccess.enabled` setting on or off. */
    setEnabled(enabled: boolean): Promise<void>;
    /** `RemoteAccessManager.startSharing(serverId)`. */
    start(): Promise<unknown>;
}

/**
 * One explicit share: the core refuses `startSharing` unless cross-network
 * connections are enabled, and while they are enabled it shares every server
 * that starts. The IDE keeps the setting off and turns it on for exactly the
 * duration of the request the person clicked for.
 */
export async function startShareOnce(deps: ShareOnceDeps): Promise<SceneShareState> {
    await deps.setEnabled(true);
    try {
        return toSceneShareState(await deps.start());
    } finally {
        await deps.setEnabled(false);
    }
}
