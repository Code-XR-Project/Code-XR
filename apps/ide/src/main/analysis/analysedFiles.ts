import fs from 'node:fs';
import path from 'node:path';

/**
 * How many files an analysis took (#203), read from its own output: the
 * directory analysis writes one record per analysed file to `data.json`,
 * next to the scene's `index.html`. The number therefore always matches the
 * analyser's filters, unlike a separate walk of the folder.
 */
export function countAnalysedRecords(dataJson: string): number | undefined {
    try {
        const data: unknown = JSON.parse(dataJson);
        return Array.isArray(data) ? data.length : undefined;
    } catch {
        return undefined;
    }
}

/** Reads the count for a server serving `htmlFile`; undefined when there is no record file. */
export async function readAnalysedFileCount(htmlFile: string | undefined): Promise<number | undefined> {
    if (!htmlFile) {
        return undefined;
    }
    try {
        return countAnalysedRecords(await fs.promises.readFile(path.join(path.dirname(htmlFile), 'data.json'), 'utf8'));
    } catch {
        return undefined;
    }
}

const RECOUNT_DELAY_MS = 400;

/**
 * Keeps the count current while the scene is open (#16): the core re-runs
 * the analysis on save and rewrites `data.json`, so the header recounts
 * after each burst of writes and reports a changed count only. Returns the
 * function that stops watching. A folder that cannot be watched simply keeps
 * the count it opened with.
 */
export function watchAnalysedFileCount(htmlFile: string | undefined, initial: number | undefined, onChange: (files: number) => void): () => void {
    if (!htmlFile) {
        return () => undefined;
    }
    let last = initial;
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const recount = (): void => {
        timer = undefined;
        void readAnalysedFileCount(htmlFile).then((files) => {
            if (!stopped && files !== undefined && files !== last) {
                last = files;
                onChange(files);
            }
        });
    };
    let watcher: fs.FSWatcher;
    try {
        watcher = fs.watch(path.dirname(htmlFile), (_event, name) => {
            if (name !== null && name !== 'data.json') {
                return;
            }
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(recount, RECOUNT_DELAY_MS);
        });
        watcher.on('error', () => undefined);
    } catch {
        return () => undefined;
    }
    return () => {
        stopped = true;
        if (timer) {
            clearTimeout(timer);
        }
        watcher.close();
    };
}
