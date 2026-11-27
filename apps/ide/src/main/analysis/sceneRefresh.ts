/**
 * Following the core's re-analysis of an open scene (AF8 #273, AF9 #274).
 *
 * The core already re-analyses a project scene when its files change on disk,
 * whoever wrote them (the editor, a terminal, an agent's CLI): every launch
 * starts a session watcher (`fs.watch` per folder of the project), whose
 * changes go through the core's `analysisRefreshCoordinator`, which runs one
 * refresh at a time per mode and once more if changes arrived meanwhile. So
 * the IDE does not watch the folder itself. What it needs is to know when a
 * refresh finished (to tell the renderer) and to wait for the analysis to
 * catch up with the disk (to measure an agent's turn). Both read the
 * coordinator's view state, through this pure, Electron-free module.
 */

/** The fields of the core's `AnalysisViewState` this module reads. */
export interface RefreshView {
    readonly mode: string;
    readonly status: string;
    readonly sourceRevision: number;
    readonly appliedRevision: Readonly<Partial<Record<string, number>>>;
    readonly modeRevision: Readonly<Partial<Record<string, number>>>;
}

/**
 * - `settled`: `data.json` reflects every change the core has seen;
 * - `pending`: a refresh is running or queued;
 * - `paused`: the scene shows another mode (dependency graph, history,
 *   evolution, the mode menu), where the core leaves `data.json` alone until
 *   the classic view comes back, so waiting would not help.
 */
export type RefreshState = 'settled' | 'pending' | 'paused';

/** `data.json` is the classic view's dataset, the coordinator's `single` mode. */
const DATA_MODE = 'single';

export function refreshState(view: RefreshView): RefreshState {
    if (view.mode !== DATA_MODE) {
        return 'paused';
    }
    if (view.status === 'error') {
        // A failed refresh keeps its changes pending and waits for the next one: nothing to wait for now.
        return 'settled';
    }
    const applied = view.appliedRevision[DATA_MODE] ?? 0;
    return applied >= view.sourceRevision && view.status !== 'updating' && view.status !== 'loading' ? 'settled' : 'pending';
}

/** The classic view's refresh count, which the core bumps once per finished refresh. */
export function dataRevision(view: RefreshView): number {
    return view.modeRevision[DATA_MODE] ?? 0;
}

/** How the IDE reaches one session's refresh state (the core in the app, a fake in the tests). */
export interface RefreshPort {
    view(): RefreshView;
    /** Calls `listener` on every state change; returns the function that stops it. */
    onChange(listener: () => void): () => void;
}

export type SettleResult = RefreshState | 'timeout';

/**
 * Resolves once the session is no longer `pending` (settled or paused), or
 * with `timeout` after `timeoutMs`. Never rejects.
 */
export function waitUntilSettled(port: RefreshPort, timeoutMs: number): Promise<SettleResult> {
    return new Promise((resolve) => {
        let done = false;
        let stop: () => void = () => undefined;
        let timer: NodeJS.Timeout | undefined;
        const finish = (result: SettleResult): void => {
            if (done) {
                return;
            }
            done = true;
            stop();
            if (timer) {
                clearTimeout(timer);
            }
            resolve(result);
        };
        const check = (): void => {
            const state = refreshState(port.view());
            if (state !== 'pending') {
                finish(state);
            }
        };
        stop = port.onChange(check);
        timer = setTimeout(() => finish('timeout'), timeoutMs);
        check();
    });
}

/**
 * Calls `onRefreshed(revision)` each time the classic view finishes a refresh
 * (its revision moves past the last one seen). Returns the function that stops it.
 */
export function followRefreshes(port: RefreshPort, onRefreshed: (revision: number) => void): () => void {
    let last = dataRevision(port.view());
    return port.onChange(() => {
        const revision = dataRevision(port.view());
        if (revision > last) {
            last = revision;
            onRefreshed(revision);
        }
    });
}

/**
 * Sent to the window when its scene's analysis was refreshed after a change
 * on disk (to be declared in shared/api.ts as `SceneUpdatedEvent` with the
 * IPC event `codexr:analysis:scene-updated` when it is wired).
 */
export interface SceneUpdatedEvent {
    /** The scene's local URL, like the other scene events, to drop a stale one. */
    readonly url: string;
    /** The refresh count of the classic view: increases by at least 1 per event. */
    readonly revision: number;
    /** How many files the analysis holds now, when known. */
    readonly files?: number;
}
