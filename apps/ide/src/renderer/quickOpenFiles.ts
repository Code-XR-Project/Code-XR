import type { WorkspaceFileList } from '../shared/api.ts';

/**
 * The files quick open searches (#164) and the recently opened ones. The
 * list is fetched again every time quick open opens, because the watcher
 * only follows expanded folders and open files: a file created in a closed
 * folder would otherwise never show up. The previous list is used while the
 * new one arrives, so the box answers at once.
 */
export interface QuickOpenFiles {
    files(): readonly string[] | null;
    truncated(): boolean;
    /** Newest first, at most RECENT_FILES_LIMIT. */
    recent(): readonly string[];
    opened(path: string): void;
    reload(): void;
    /** Another folder opened: forget both lists. */
    reset(): void;
}

const RECENT_FILES_LIMIT = 30;

export function createQuickOpenFiles(list: () => Promise<WorkspaceFileList>, onLoaded: () => void): QuickOpenFiles {
    let files: readonly string[] | null = null;
    let truncated = false;
    let recentFiles: string[] = [];
    let generation = 0;
    let loading = false;

    return {
        files: () => files,
        truncated: () => truncated,
        recent: () => recentFiles,
        opened(path) {
            recentFiles = [path, ...recentFiles.filter((other) => other !== path)].slice(0, RECENT_FILES_LIMIT);
        },
        reload() {
            if (loading) {
                return;
            }
            loading = true;
            const current = generation;
            list().then((result) => {
                if (current === generation) {
                    files = result.files;
                    truncated = result.truncated;
                    onLoaded();
                }
            }, () => {
                // No folder (or it went away): quick open says so instead of listing.
                if (current === generation) {
                    files = [];
                    onLoaded();
                }
            }).finally(() => { loading = false; });
        },
        reset() {
            generation++;
            loading = false;
            files = null;
            truncated = false;
            recentFiles = [];
        },
    };
}
