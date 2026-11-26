import { opendir } from 'node:fs/promises';
import path from 'node:path';

/** Folders that are never part of what a person would call "the project". */
const SKIPPED = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'out', 'build', '.next', 'target']);

/**
 * Counts the files under `root`, stopping as soon as the count passes
 * `limit` (#139: the IDE only needs to know whether a project is too big to
 * analyse unasked, so a huge tree is never walked to the end). Unreadable
 * folders count as empty and symbolic links are not followed.
 */
export async function countFilesUpTo(root: string, limit: number): Promise<number> {
    let count = 0;
    const pending = [root];
    while (pending.length > 0 && count <= limit) {
        const dir = pending.pop()!;
        let handle;
        try {
            handle = await opendir(dir);
        } catch {
            continue;
        }
        for await (const entry of handle) {
            if (entry.isDirectory()) {
                if (!SKIPPED.has(entry.name)) {
                    pending.push(path.join(dir, entry.name));
                }
            } else if (entry.isFile()) {
                count++;
                if (count > limit) {
                    break;
                }
            }
        }
    }
    return count;
}
