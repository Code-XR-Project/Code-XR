import { opendir } from 'node:fs/promises';
import path from 'node:path';
import { EXCLUDED_NAMES, isIgnored, type IgnoreRule } from './ignoreRules.ts';

/**
 * Every file of the workspace, for quick open (#164). Breadth first, so a
 * huge tree that hits `limit` still has its shallow files, which are the ones
 * people open most. It skips what the explorer never lists (`.git`,
 * `node_modules`) and what the root `.gitignore` ignores, as VS Code's quick
 * open does by default, and it does not follow symbolic links (no cycles, no
 * leaving the folder). Unreadable folders are skipped.
 */

export const QUICK_OPEN_FILE_LIMIT = 50_000;

export interface FileIndex {
    /** Workspace-relative paths with `/` separators, on every platform. */
    readonly files: readonly string[];
    /** True when the walk stopped at the limit. */
    readonly truncated: boolean;
}

export async function listWorkspaceFiles(root: string, rules: readonly IgnoreRule[], limit = QUICK_OPEN_FILE_LIMIT): Promise<FileIndex> {
    const files: string[] = [];
    let queue: string[] = [''];
    while (queue.length > 0) {
        const next: string[] = [];
        for (const relative of queue) {
            let handle;
            try {
                handle = await opendir(relative === '' ? root : path.join(root, ...relative.split('/')));
            } catch {
                continue;
            }
            for await (const entry of handle) {
                if (EXCLUDED_NAMES.has(entry.name)) {
                    continue;
                }
                const entryPath = relative === '' ? entry.name : `${relative}/${entry.name}`;
                if (entry.isDirectory()) {
                    if (!isIgnored(entryPath, true, rules)) {
                        next.push(entryPath);
                    }
                } else if (entry.isFile() && !isIgnored(entryPath, false, rules)) {
                    files.push(entryPath);
                    if (files.length >= limit) {
                        return { files, truncated: true };
                    }
                }
            }
        }
        queue = next;
    }
    return { files, truncated: false };
}
