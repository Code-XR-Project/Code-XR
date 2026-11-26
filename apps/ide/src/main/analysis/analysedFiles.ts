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
