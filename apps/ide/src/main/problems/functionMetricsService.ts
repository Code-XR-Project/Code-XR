import type { WebContents } from 'electron';
import { FunctionMetricsTracker } from '@codexr/core/metrics/functionMetricsTracker';
import { parseFunctionMetrics, type FileFunctionMetrics, type FunctionMetricsSnapshot } from '@codexr/core/metrics/functionMetrics';
import { IPC_EVENTS } from '../../shared/api.ts';
import { channelLog } from '../log.ts';
import type { PythonEnvironmentService } from '../python/pythonEnvironment.ts';

const log = channelLog('core');

/**
 * The per-function metrics behind the Problems panel (#173) and the editor's
 * lenses (#178), one tracker per window. The tracker (core/metrics, shared
 * with the VS Code extension) runs the backend's functions mode after each
 * analysis of the window's folder and re-measures a file when it is saved or
 * changes on disk; this service only gives it the IDE's Python runner and
 * forwards its snapshots to the window.
 */
export class FunctionMetricsService {
    private readonly python: PythonEnvironmentService;
    private readonly windows = new Map<number, FunctionMetricsTracker>();

    constructor(python: PythonEnvironmentService) {
        this.python = python;
    }

    snapshot(contents: WebContents): FunctionMetricsSnapshot | null {
        return this.windows.get(contents.id)?.snapshot ?? null;
    }

    /** An analysis of `root` opened its scene in this window: measure every function under it. */
    analyse(contents: WebContents, root: string): void {
        this.trackerOf(contents).analyse(root);
    }

    /**
     * #172: one file's functions for its outline: the window's metrics when
     * they cover it, else a run of the backend on that file alone (it does not
     * join the metrics, so the Problems panel still shows only analysed folders).
     * Null when the file cannot be measured (Python not set up, an unreadable file).
     */
    async fileFunctions(contents: WebContents, root: string, relativePath: string, absolutePath: string): Promise<FileFunctionMetrics | null> {
        const snapshot = this.snapshot(contents);
        const known = snapshot?.root === root ? snapshot.files.find((file) => file.path === relativePath) : undefined;
        if (known) {
            return known;
        }
        try {
            const [file] = parseFunctionMetrics(await this.python.functionMetrics(absolutePath, 'file', root));
            return file ? { path: relativePath, functions: file.functions } : null;
        } catch (error) {
            log.info(`Outline: could not measure ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /** Whether the window's metrics include this file (a change on disk then re-measures it). */
    knows(contents: WebContents, root: string, relativePath: string): boolean {
        return this.windows.get(contents.id)?.knows(root, relativePath) ?? false;
    }

    /** A file was written: re-measure it when this window has metrics for its folder. */
    fileSaved(contents: WebContents, root: string, relativePath: string, absolutePath: string): void {
        this.windows.get(contents.id)?.fileChanged(root, relativePath, absolutePath);
    }

    /** The window's folder changed (or the window went): its metrics describe nothing any more. */
    folderChanged(contents: WebContents, root: string | null): void {
        const tracker = this.windows.get(contents.id);
        if (!tracker || tracker.snapshot?.root === root) {
            return;
        }
        if (contents.isDestroyed()) {
            tracker.dispose();
            this.windows.delete(contents.id);
        } else {
            tracker.clear();
        }
    }

    private trackerOf(contents: WebContents): FunctionMetricsTracker {
        let tracker = this.windows.get(contents.id);
        if (!tracker) {
            tracker = new FunctionMetricsTracker(
                (target, kind, root, signal) => this.python.functionMetrics(target, kind, root, signal),
                {
                    onChange: (snapshot) => {
                        if (!contents.isDestroyed()) {
                            contents.send(IPC_EVENTS.metricsChanged, snapshot);
                        }
                    },
                    onLog: (level, message) => log[level](message),
                },
            );
            this.windows.set(contents.id, tracker);
        }
        return tracker;
    }
}
