import fs from 'node:fs';
import path from 'node:path';
import { EXCLUDED_NAMES } from './ignoreRules.ts';
import { childPath, isInside, parseWorkspacePath } from './workspacePath.ts';

/**
 * Watches what a window shows (#14): the folders expanded in the explorer and
 * the folders that hold its open files. One non-recursive `fs.watch` per
 * folder, so a large project costs only what is on screen, and watching the
 * folder rather than the file survives editors that save by rename. Changes
 * are reported as workspace-relative paths, batched over `delayMs`: the entry
 * that changed and the folder whose listing it belongs to.
 */

/** The folders to watch for a set of open entries: each folder itself, and each file's parent. */
export function foldersToWatch(entries: readonly { path: string; kind: 'file' | 'directory' }[]): string[] {
    const folders = new Set<string>();
    for (const entry of entries) {
        const segments = parseWorkspacePath(entry.path);
        folders.add(entry.kind === 'directory' ? segments.join('/') : segments.slice(0, -1).join('/'));
    }
    return [...folders].sort();
}

export class WorkspaceWatcher {
    private readonly watchers = new Map<string, fs.FSWatcher>();
    private pending = new Set<string>();
    private timer: NodeJS.Timeout | null = null;
    private readonly root: string;
    private readonly realRoot: string;
    private readonly onChange: (paths: readonly string[]) => void;
    private readonly delayMs: number;

    /** `realRoot` is the root with symlinks resolved: a folder whose real path leaves it is never watched. */
    constructor(root: string, realRoot: string, onChange: (paths: readonly string[]) => void, delayMs = 150) {
        this.root = root;
        this.realRoot = realRoot;
        this.onChange = onChange;
        this.delayMs = delayMs;
    }

    /** Replaces the watched folders (workspace-relative; `''` is the root). */
    setFolders(folders: readonly string[]): void {
        const wanted = new Set(folders.map((folder) => parseWorkspacePath(folder).join('/')));
        for (const [folder, watcher] of this.watchers) {
            if (!wanted.has(folder)) {
                watcher.close();
                this.watchers.delete(folder);
            }
        }
        for (const folder of wanted) {
            if (!this.watchers.has(folder)) {
                this.watch(folder);
            }
        }
    }

    get watchedFolders(): string[] {
        return [...this.watchers.keys()].sort();
    }

    dispose(): void {
        for (const watcher of this.watchers.values()) {
            watcher.close();
        }
        this.watchers.clear();
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.pending.clear();
    }

    private watch(folder: string): void {
        let watcher: fs.FSWatcher;
        try {
            const real = fs.realpathSync(path.join(this.root, ...parseWorkspacePath(folder)));
            if (!isInside(this.realRoot, real)) {
                return;
            }
            watcher = fs.watch(real, { persistent: false }, (_event, filename) => {
                const name = filename?.toString();
                if (name && EXCLUDED_NAMES.has(name.split(/[\\/]/)[0] ?? '')) {
                    return;
                }
                this.pending.add(folder);
                if (name) {
                    this.pending.add(childPath(folder, name.split(path.sep).join('/')));
                }
                this.schedule();
            });
        } catch {
            return; // gone, or not a folder: nothing to watch
        }
        watcher.on('error', () => {
            // The folder was deleted or became unreadable: report it and stop watching.
            watcher.close();
            this.watchers.delete(folder);
            this.pending.add(folder);
            this.schedule();
        });
        this.watchers.set(folder, watcher);
    }

    private schedule(): void {
        if (this.timer) {
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            const paths = [...this.pending].sort();
            this.pending = new Set();
            this.onChange(paths);
        }, this.delayMs);
    }
}
