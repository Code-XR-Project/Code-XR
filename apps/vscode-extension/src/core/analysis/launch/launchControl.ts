/**
 * Per-launch control: one AbortController, one deadline and one teardown
 * stack for every analysis launch, keyed by session id.
 *
 * Before this, nothing on the launch path could be cancelled or timed out
 * (LAUNCHER-10), closing an analysis while it was still analysing let the
 * pipeline go on to start a server and a watcher nobody could reach
 * (LAUNCHER-7), and a launch that failed at the server step left its watcher
 * running (LAUNCHER-5). Each step that starts something pushes how to undo
 * it; a failure, a timeout or a Close disposes the stack in reverse, exactly
 * once.
 *
 * The Python backend is reached many calls deep from the pipeline. Rather
 * than thread a signal through every processor, the pipeline runs inside
 * `runWithLaunchSignal`, and the Python spawner reads the signal from the
 * async context (`currentLaunchSignal`) and kills its child on abort.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('LAUNCH_CONTROL');

/** Default time a launch may take before it is aborted: 10 minutes. */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 10 * 60 * 1000;

export type LaunchAbortReason = 'closed' | 'timeout' | 'failed' | 'superseded';

export class LaunchAbortedError extends Error {
    constructor(public readonly reason: LaunchAbortReason, message?: string) {
        super(message || describeAbortReason(reason));
        this.name = 'LaunchAbortedError';
    }
}

export function describeAbortReason(reason: LaunchAbortReason | string | undefined): string {
    switch (reason) {
        case 'closed': return 'The analysis was closed before it finished.';
        case 'timeout': return 'The analysis took too long and was stopped.';
        case 'superseded': return 'The analysis was replaced by a newer launch.';
        default: return 'The analysis launch was stopped.';
    }
}

interface TeardownStep {
    name: string;
    dispose: () => unknown | Promise<unknown>;
}

interface LaunchRecord {
    sessionId: string;
    controller: AbortController;
    teardown: TeardownStep[];
    timer: ReturnType<typeof setTimeout> | null;
    disposed: boolean;
}

const signalContext = new AsyncLocalStorage<AbortSignal>();

export class LaunchControl {
    private static instance: LaunchControl | null = null;
    private readonly records = new Map<string, LaunchRecord>();

    static getInstance(): LaunchControl {
        if (!LaunchControl.instance) {
            LaunchControl.instance = new LaunchControl();
        }
        return LaunchControl.instance;
    }

    /** Test seam: a fresh instance, without touching the shared one. */
    static createForTesting(): LaunchControl {
        return new LaunchControl();
    }

    /**
     * Opens the control record of a launch. `timeoutMs <= 0` disables the
     * deadline. Beginning a session that already has a record aborts the old
     * one first: there is never more than one launch per session.
     */
    begin(sessionId: string, timeoutMs: number = DEFAULT_LAUNCH_TIMEOUT_MS): AbortSignal {
        const previous = this.records.get(sessionId);
        if (previous) {
            void this.abort(sessionId, 'superseded');
        }
        const record: LaunchRecord = {
            sessionId,
            controller: new AbortController(),
            teardown: [],
            timer: null,
            disposed: false,
        };
        if (timeoutMs > 0) {
            record.timer = setTimeout(() => {
                logger.warn(`Launch ${sessionId} timed out after ${timeoutMs} ms`);
                void this.abort(sessionId, 'timeout');
            }, timeoutMs);
            // A pending launch deadline must not keep the extension host alive.
            (record.timer as { unref?: () => void }).unref?.();
        }
        this.records.set(sessionId, record);
        return record.controller.signal;
    }

    signal(sessionId: string): AbortSignal | undefined {
        return this.records.get(sessionId)?.controller.signal;
    }

    /** Records how to undo a step that just succeeded. */
    push(sessionId: string, name: string, dispose: () => unknown | Promise<unknown>): void {
        const record = this.records.get(sessionId);
        if (!record || record.disposed) {
            // The launch is already gone: undo immediately rather than leak.
            void Promise.resolve().then(dispose).catch((error) => logger.error(`Teardown of ${name} failed:`, error));
            return;
        }
        record.teardown.push({ name, dispose });
    }

    /** Throws when the launch was aborted; call it between steps. */
    throwIfAborted(sessionId: string): void {
        const signal = this.signal(sessionId);
        if (signal?.aborted) {
            throw new LaunchAbortedError((signal.reason as LaunchAbortReason) || 'closed');
        }
    }

    /** The launch reached its final state: the deadline no longer applies. */
    settle(sessionId: string): void {
        const record = this.records.get(sessionId);
        if (record?.timer) {
            clearTimeout(record.timer);
            record.timer = null;
        }
    }

    /**
     * Aborts the launch (if still running) and undoes everything it started,
     * newest first. Safe to call more than once and for unknown sessions.
     * Returns the names of the steps that were undone.
     */
    async abort(sessionId: string, reason: LaunchAbortReason): Promise<string[]> {
        const record = this.records.get(sessionId);
        if (!record) {
            return [];
        }
        if (!record.controller.signal.aborted) {
            record.controller.abort(reason);
        }
        return this.dispose(record);
    }

    /** Closes a finished launch: same teardown, recorded as 'closed'. */
    close(sessionId: string): Promise<string[]> {
        return this.abort(sessionId, 'closed');
    }

    has(sessionId: string): boolean {
        return this.records.has(sessionId);
    }

    private async dispose(record: LaunchRecord): Promise<string[]> {
        if (record.timer) {
            clearTimeout(record.timer);
            record.timer = null;
        }
        if (record.disposed) {
            return [];
        }
        record.disposed = true;
        this.records.delete(record.sessionId);
        const undone: string[] = [];
        while (record.teardown.length) {
            const step = record.teardown.pop()!;
            try {
                await step.dispose();
                undone.push(step.name);
            } catch (error) {
                logger.error(`Teardown of ${step.name} for ${record.sessionId} failed:`, error);
            }
        }
        return undone;
    }
}

/** Runs `fn` with `signal` visible to `currentLaunchSignal()` below it. */
export function runWithLaunchSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    if (!signal) {
        return fn();
    }
    return signalContext.run(signal, fn);
}

/** The abort signal of the launch this call runs under, if any. */
export function currentLaunchSignal(): AbortSignal | undefined {
    return signalContext.getStore();
}
