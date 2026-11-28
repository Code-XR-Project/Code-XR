/**
 * Row helpers of the drill-down (#334). A directory analysis row depends on
 * its file alone, so a folder's dataset can be assembled from per-file rows
 * (cached or fresh), with `relativePath` re-rooted at that folder.
 */

type Row = Record<string, unknown>;

/** Forward slashes, no drive letter, no doubled or trailing slash: the shape of a row's `filePath`. */
export function normalizeBabiaPath(value: string): string {
    let normalized = String(value ?? '').replace(/\\/g, '/');
    if (/^[a-zA-Z]:/.test(normalized)) {
        normalized = normalized.slice(2);
    }
    normalized = normalized.replace(/\/{2,}/g, '/');
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/** True when a payload is a directory analysis (file rows, no function rows). */
export function isDirectoryRows(rows: readonly unknown[]): boolean {
    const first = rows.find((row) => row && typeof row === 'object') as Row | undefined;
    return !!first && 'fileName' in first && !('functionName' in first);
}
