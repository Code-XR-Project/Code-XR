import type { WebContents } from 'electron';
import { IPC_EVENTS } from '../../shared/api.ts';
import { mergeFileMetrics, parseFunctionMetrics, type FileFunctionMetrics, type FunctionMetricsSnapshot } from '../../shared/problems.ts';
import { channelLog } from '../log.ts';
import type { PythonEnvironmentService } from '../python/pythonEnvironment.ts';

const log = channelLog('core');

/** A burst of saves of one file costs one run. */
const SAVE_DEBOUNCE_MS = 400;

interface WindowMetrics {
    readonly root: string;
    files: FileFunctionMetrics[];
    /** The folder-wide run in flight, stopped when a newer one starts or the folder changes. */
    run: AbortController | null;
    readonly saves: Map<string, ReturnType<typeof setTimeout>>;
}

/**
 * The per-function metrics behind the Problems panel (#173), per window.
 * Each analysis of the window's folder is followed by a run of the
 * backend's functions mode over the folder (the scene's data keeps only one
 * summary per file); each save of a file it knows re-measures that file. The
 * renderer applies the thresholds, so changing one needs no new run.
 */
export class FunctionMetricsService {
    private readonly python: PythonEnvironmentService;
    private readonly windows = new Map<number, WindowMetrics>();

    constructor(python: PythonEnvironmentService) {
        this.python = python;
    }

    snapshot(contents: WebContents): FunctionMetricsSnapshot | null {
        const metrics = this.windows.get(contents.id);
        return metrics ? { root: metrics.root, files: metrics.files } : null;
    }

    /** An analysis of `root` opened its scene in this window: measure every function under it. */
    analyse(contents: WebContents, root: string): void {
        const previous = this.windows.get(contents.id);
        previous?.run?.abort();
        const metrics: WindowMetrics = previous?.root === root
            ? previous
            : { root, files: [], run: null, saves: new Map() };
        if (previous && previous !== metrics) {
            this.forget(contents.id);
        }
        this.windows.set(contents.id, metrics);
        const run = new AbortController();
        metrics.run = run;
        const started = Date.now();
        this.python.functionMetrics(root, 'directory', root, run.signal).then((payload) => {
            if (run.signal.aborted || this.windows.get(contents.id) !== metrics) {
                return;
            }
            metrics.run = null;
            metrics.files = parseFunctionMetrics(payload).filter((file) => file.functions.length > 0);
            const functions = metrics.files.reduce((sum, file) => sum + file.functions.length, 0);
            log.info(`Function metrics: ${functions} functions in ${metrics.files.length} files of ${root} (${Date.now() - started} ms).`);
            this.publish(contents, metrics);
        }, (error: unknown) => {
            if (!run.signal.aborted) {
                metrics.run = null;
                log.warn(`Could not measure the functions of ${root}: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }

    /** A file was written: re-measure it when this window has metrics for its folder. */
    fileSaved(contents: WebContents, root: string, relativePath: string, absolutePath: string): void {
        const metrics = this.windows.get(contents.id);
        if (!metrics || metrics.root !== root) {
            return;
        }
        clearTimeout(metrics.saves.get(relativePath));
        metrics.saves.set(relativePath, setTimeout(() => {
            metrics.saves.delete(relativePath);
            this.python.functionMetrics(absolutePath, 'file', root).then((payload) => {
                if (this.windows.get(contents.id) !== metrics) {
                    return;
                }
                const fresh = parseFunctionMetrics(payload).filter((file) => file.path === relativePath);
                metrics.files = mergeFileMetrics(metrics.files, fresh, [relativePath]);
                this.publish(contents, metrics);
            }, (error: unknown) => log.warn(`Could not re-measure ${relativePath}: ${error instanceof Error ? error.message : String(error)}`));
        }, SAVE_DEBOUNCE_MS));
    }

    /** The window's folder changed (or the window went): its metrics describe nothing any more. */
    folderChanged(contents: WebContents, root: string | null): void {
        const metrics = this.windows.get(contents.id);
        if (!metrics || metrics.root === root) {
            return;
        }
        this.forget(contents.id);
        if (!contents.isDestroyed()) {
            contents.send(IPC_EVENTS.metricsChanged, null);
        }
    }

    private forget(id: number): void {
        const metrics = this.windows.get(id);
        metrics?.run?.abort();
        for (const timer of metrics?.saves.values() ?? []) {
            clearTimeout(timer);
        }
        this.windows.delete(id);
    }

    private publish(contents: WebContents, metrics: WindowMetrics): void {
        if (!contents.isDestroyed()) {
            contents.send(IPC_EVENTS.metricsChanged, { root: metrics.root, files: metrics.files } satisfies FunctionMetricsSnapshot);
        }
    }
}
