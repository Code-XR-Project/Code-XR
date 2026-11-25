/**
 * One long job at a time per service (a historical comparison, a project
 * evolution movie, a dependency graph), with an id, a state, a deadline and a
 * cancel that reaches the child processes.
 *
 * It replaces `SingleJobGate`, which had none of that (S6, issue #78):
 *
 * - **Atomic start.** `tryReserve()` takes the slot synchronously, so a
 *   bridge reserves BEFORE its first `await` and two starts can never both
 *   pass a check-then-act `isBusy()` (LAUNCHER-11, HIST-9).
 * - **Cancel kills.** The work runs under `runWithLaunchSignal`, so the
 *   Python spawner (`executePython.ts`) and the Git runner
 *   (`gitRepositoryService.ts`) see the job's signal and kill their child on
 *   abort, on Windows, macOS and Linux alike (EVO-2, HIST-7, DEPGRAPH-9).
 * - **Deadline.** A job past `timeoutMs` is aborted the same way (EVO-3).
 * - **Late results are discarded.** A job aborted while its work was
 *   finishing rejects with `JobCancelledError`; its result is never returned
 *   to be published (EVO-4).
 * - **The slot is held until the work really ends**, so a new job never runs
 *   beside the orphans of a cancelled one; after an abort it is released
 *   anyway once `graceMs` passes, so a step that ignores the signal cannot
 *   block the service for the rest of the session.
 *
 * Deliberately free of vscode imports, so it is unit-testable from `out/`.
 */
import { runWithLaunchSignal } from './launchControl';

export type JobState = 'queued' | 'running' | 'cancelled' | 'failed' | 'done';

export interface JobStatus {
    id: string;
    state: JobState;
    startedAt: string;
    endedAt?: string;
    /** For a failed job: its error message; for a cancelled one: the reason. */
    error?: string;
}

export type JobCancelReason = 'cancelled' | 'timeout' | 'disposed';

export class JobCancelledError extends Error {
    constructor(public readonly reason: JobCancelReason, code: string) {
        super(code);
        this.name = 'JobCancelledError';
    }
}

export interface JobTicket<TResult> {
    readonly id: string;
    readonly signal: AbortSignal;
    /** Runs the reserved job; call it once. */
    execute(work: (signal: AbortSignal) => Promise<TResult>): Promise<TResult>;
    /** Gives the slot back when the job is abandoned before `execute`. */
    release(): void;
}

export interface JobRunnerOptions {
    /** Error message of a refused start. */
    busyCode: string;
    /** Error message of a job that was cancelled (or disposed). */
    cancelledCode: string;
    /** Error message of a job that ran past its deadline. */
    timeoutCode: string;
    /** Deadline of one job; 0 disables it. */
    timeoutMs: number;
    /** How long an aborted job may keep the slot while its work unwinds. */
    graceMs?: number;
    /** Called on every state change (to share it with the room). */
    onStateChange?: (status: JobStatus) => void;
}

const DEFAULT_GRACE_MS = 5_000;

interface ActiveJob<TResult> {
    status: JobStatus;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout> | null;
    promise: Promise<TResult> | null;
    executed: boolean;
    /** Releases the slot; idempotent. */
    free: () => void;
}

let nextJobNumber = 0;

function newJobId(): string {
    nextJobNumber += 1;
    return `job-${Date.now().toString(36)}-${nextJobNumber}`;
}

export class JobRunner<TRequest extends object, TResult> {
    private active: ActiveJob<TResult> | null = null;
    private completedRequest: TRequest | null = null;
    private latestStatus: JobStatus | null = null;
    /** Settles when the active job's slot is released. */
    private released: Promise<void> = Promise.resolve();

    public constructor(private readonly options: JobRunnerOptions) {}

    public isBusy(): boolean {
        return this.active !== null;
    }

    /** The current job's status, or the last one's once it ended. */
    public get status(): JobStatus | null {
        return this.latestStatus ? { ...this.latestStatus } : null;
    }

    /** The request of the last job that finished successfully, or null. */
    public get lastRequest(): TRequest | null {
        return this.completedRequest;
    }

    public forgetLastRequest(): void {
        this.completedRequest = null;
    }

    /** The running job's result promise (for callers that join it), or null. */
    public current(): Promise<TResult> | null {
        return this.active?.promise ?? null;
    }

    /**
     * Takes the slot synchronously, or returns null when a job holds it.
     * The returned ticket must be executed or released.
     */
    public tryReserve(request: TRequest): JobTicket<TResult> | null {
        if (this.active) {
            return null;
        }
        const job: ActiveJob<TResult> = {
            status: { id: newJobId(), state: 'queued', startedAt: new Date().toISOString() },
            controller: new AbortController(),
            timer: null,
            promise: null,
            executed: false,
            free: () => undefined,
        };
        let releaseSlot!: () => void;
        this.released = new Promise<void>((resolve) => {
            releaseSlot = resolve;
        });
        const free = () => {
            if (job.timer) {
                clearTimeout(job.timer);
                job.timer = null;
            }
            if (this.active === job) {
                this.active = null;
            }
            releaseSlot();
        };
        job.free = free;
        this.active = job;
        this.publish(job.status);

        return {
            id: job.status.id,
            signal: job.controller.signal,
            release: () => {
                if (!job.executed && this.active === job) {
                    this.finish(job, 'cancelled', 'released');
                    free();
                }
            },
            execute: (work) => {
                if (job.executed) {
                    return Promise.reject(new Error('job-already-executed'));
                }
                job.executed = true;
                job.promise = this.runJob(job, request, work, free);
                return job.promise;
            },
        };
    }

    /** Takes the slot and runs `work`, or throws the busy code. */
    public run(request: TRequest, work: (signal: AbortSignal) => Promise<TResult>): Promise<TResult> {
        const ticket = this.tryReserve(request);
        if (!ticket) {
            return Promise.reject(new Error(this.options.busyCode));
        }
        return ticket.execute(work);
    }

    /** Aborts the running job, if any. Returns whether there was one. */
    public cancel(reason: JobCancelReason = 'cancelled'): boolean {
        const job = this.active;
        if (!job || job.controller.signal.aborted) {
            return false;
        }
        job.controller.abort(reason);
        if (!job.executed) {
            this.finish(job, 'cancelled', reason);
            job.free();
        }
        return true;
    }

    /** Cancels the running job and waits until its slot is free. */
    public async cancelAndWait(reason: JobCancelReason = 'cancelled'): Promise<void> {
        this.cancel(reason);
        await this.released;
    }

    private async runJob(
        job: ActiveJob<TResult>,
        request: TRequest,
        work: (signal: AbortSignal) => Promise<TResult>,
        free: () => void,
    ): Promise<TResult> {
        const signal = job.controller.signal;
        if (signal.aborted) {
            free();
            throw this.cancelledError(signal);
        }
        job.status = { ...job.status, state: 'running' };
        this.publish(job.status);
        if (this.options.timeoutMs > 0) {
            job.timer = setTimeout(() => {
                if (!signal.aborted) {
                    job.controller.abort('timeout');
                }
            }, this.options.timeoutMs);
            (job.timer as { unref?: () => void }).unref?.();
        }

        const workPromise = runWithLaunchSignal(signal, () => work(signal));
        const settled = workPromise.then(() => undefined, () => undefined);
        // The slot is freed when the work ends; after an abort, at the latest
        // once the grace period has passed.
        void settled.then(free);
        const onAbort = () => {
            const grace = setTimeout(free, this.options.graceMs ?? DEFAULT_GRACE_MS);
            (grace as { unref?: () => void }).unref?.();
            void settled.then(() => clearTimeout(grace));
        };
        signal.addEventListener('abort', onAbort, { once: true });

        try {
            const result = await raceAbort(workPromise, signal, () => this.cancelledError(signal));
            if (signal.aborted) {
                // The work finished after it was cancelled: discard the result.
                throw this.cancelledError(signal);
            }
            this.completedRequest = { ...request };
            this.finish(job, 'done');
            return result;
        } catch (error) {
            if (signal.aborted) {
                const cancelled = error instanceof JobCancelledError ? error : this.cancelledError(signal);
                this.finish(job, 'cancelled', cancelled.reason);
                throw cancelled;
            }
            this.finish(job, 'failed', error instanceof Error ? error.message : String(error));
            throw error;
        } finally {
            signal.removeEventListener('abort', onAbort);
            if (job.timer) {
                clearTimeout(job.timer);
                job.timer = null;
            }
        }
    }

    private cancelledError(signal: AbortSignal): JobCancelledError {
        const reason = (signal.reason as JobCancelReason) || 'cancelled';
        return new JobCancelledError(
            reason,
            reason === 'timeout' ? this.options.timeoutCode : this.options.cancelledCode,
        );
    }

    private finish(job: ActiveJob<TResult>, state: JobState, error?: string): void {
        if (job.status.state === 'done' || job.status.state === 'failed' || job.status.state === 'cancelled') {
            return;
        }
        job.status = { ...job.status, state, endedAt: new Date().toISOString(), ...(error ? { error } : {}) };
        this.publish(job.status);
    }

    private publish(status: JobStatus): void {
        this.latestStatus = { ...status };
        try {
            this.options.onStateChange?.({ ...status });
        } catch {
            // A listener must never break the job.
        }
    }
}

/** Settles with `work`, or rejects as soon as `signal` aborts. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal, onAbort: () => Error): Promise<T> {
    if (signal.aborted) {
        work.catch(() => undefined);
        return Promise.reject(onAbort());
    }
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(onAbort());
        signal.addEventListener('abort', abort, { once: true });
        work.then(
            (value) => { signal.removeEventListener('abort', abort); resolve(value); },
            (error) => { signal.removeEventListener('abort', abort); reject(error); },
        );
    });
}

/**
 * A signal that aborts when `parent` does or after `timeoutMs`, whichever
 * comes first; `dispose()` clears the timer. Used for per-step watchdogs
 * inside a job (one revision's analysis, one Git command).
 */
export function withTimeout(
    parent: AbortSignal | undefined,
    timeoutMs: number,
    reason = 'timeout',
): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(parent?.reason);
    if (parent?.aborted) {
        controller.abort(parent.reason);
    } else {
        parent?.addEventListener('abort', onParentAbort, { once: true });
    }
    const timer = timeoutMs > 0
        ? setTimeout(() => controller.abort(reason), timeoutMs)
        : null;
    (timer as { unref?: () => void } | null)?.unref?.();
    return {
        signal: controller.signal,
        dispose: () => {
            if (timer) {
                clearTimeout(timer);
            }
            parent?.removeEventListener('abort', onParentAbort);
        },
    };
}
