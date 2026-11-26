import { mergeFileMetrics, parseFunctionMetrics, type FileFunctionMetrics, type FunctionMetricsSnapshot } from './functionMetrics';

/**
 * Runs the backend's `functions` mode: over a folder (`directory`, recursive)
 * or one file (`file`, its path reported relative to `root`). Each host
 * supplies its own: the extension goes through ExecutePython, the IDE through
 * its Python environment service, which can also cancel a run.
 */
export type FunctionMetricsRunner = (target: string, kind: 'directory' | 'file', root: string, signal?: AbortSignal) => Promise<unknown>;

export interface FunctionMetricsTrackerHooks {
    /** The metrics changed; null when they were dropped. */
    onChange(snapshot: FunctionMetricsSnapshot | null): void;
    onLog?(level: 'info' | 'warn', message: string): void;
}

/** A burst of saves of one file costs one run. */
const SAVE_DEBOUNCE_MS = 400;

/**
 * The per-function metrics of one folder (#173, #178), for one window of the
 * IDE or one VS Code window. Each analysis of a folder measures every
 * function under it; each save, or change on disk, of a file re-measures
 * that file alone. The checks and lenses are computed from the snapshot by
 * each host, so changing a limit needs no new run.
 */
export class FunctionMetricsTracker {
    private readonly runner: FunctionMetricsRunner;
    private readonly hooks: FunctionMetricsTrackerHooks;
    private root: string | null = null;
    private files: FileFunctionMetrics[] = [];
    private run: AbortController | null = null;
    private readonly saves = new Map<string, ReturnType<typeof setTimeout>>();
    /** Bumped whenever the folder changes, so a late answer for the old one is dropped. */
    private generation = 0;

    constructor(runner: FunctionMetricsRunner, hooks: FunctionMetricsTrackerHooks) {
        this.runner = runner;
        this.hooks = hooks;
    }

    get snapshot(): FunctionMetricsSnapshot | null {
        return this.root === null ? null : { root: this.root, files: this.files };
    }

    /** An analysis of `root` ran: measure every function under it. */
    analyse(root: string): void {
        if (this.root !== root) {
            this.reset();
            this.root = root;
        }
        this.run?.abort();
        const run = new AbortController();
        this.run = run;
        const generation = this.generation;
        const started = Date.now();
        this.runner(root, 'directory', root, run.signal).then((payload) => {
            if (run.signal.aborted || generation !== this.generation) {
                return;
            }
            this.run = null;
            this.files = parseFunctionMetrics(payload).filter((file) => file.functions.length > 0);
            const functions = this.files.reduce((sum, file) => sum + file.functions.length, 0);
            this.hooks.onLog?.('info', `Function metrics: ${functions} functions in ${this.files.length} files of ${root} (${Date.now() - started} ms).`);
            this.hooks.onChange(this.snapshot);
        }, (error: unknown) => {
            if (!run.signal.aborted && generation === this.generation) {
                this.run = null;
                this.hooks.onLog?.('warn', `Could not measure the functions of ${root}: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }

    /** Whether the metrics include this file of `root` (a change on disk then re-measures it). */
    knows(root: string, relativePath: string): boolean {
        return this.root === root && this.files.some((file) => file.path === relativePath);
    }

    /** A file of `root` was saved or changed: re-measure it, once the metrics describe that folder. */
    fileChanged(root: string, relativePath: string, absolutePath: string): void {
        if (this.root !== root) {
            return;
        }
        clearTimeout(this.saves.get(relativePath));
        const generation = this.generation;
        this.saves.set(relativePath, setTimeout(() => {
            this.saves.delete(relativePath);
            this.runner(absolutePath, 'file', root).then((payload) => {
                if (generation !== this.generation) {
                    return;
                }
                const fresh = parseFunctionMetrics(payload).filter((file) => file.path === relativePath);
                this.files = mergeFileMetrics(this.files, fresh, [relativePath]);
                this.hooks.onChange(this.snapshot);
            }, (error: unknown) => this.hooks.onLog?.('warn', `Could not re-measure ${relativePath}: ${error instanceof Error ? error.message : String(error)}`));
        }, SAVE_DEBOUNCE_MS));
    }

    /** The folder changed (or went): the metrics describe nothing any more. */
    clear(): void {
        if (this.root === null) {
            return;
        }
        this.reset();
        this.hooks.onChange(null);
    }

    dispose(): void {
        this.reset();
    }

    private reset(): void {
        this.generation++;
        this.run?.abort();
        this.run = null;
        for (const timer of this.saves.values()) {
            clearTimeout(timer);
        }
        this.saves.clear();
        this.root = null;
        this.files = [];
    }
}
