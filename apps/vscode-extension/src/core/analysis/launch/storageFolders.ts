/**
 * Where each launch kind keeps its generated files in workspace storage.
 *
 * One table read by the launchers (where to write) and by startup cleanup
 * (what to sweep). Cleanup used to sweep `storage/analysis`, a folder nothing
 * writes, so the real folders grew without bound (LAUNCHER-14).
 *
 * Deliberately pure, with zero imports.
 */
export const ANALYSIS_STORAGE_FOLDERS = Object.freeze({
    file: 'fileAnalysis',
    directory: 'directoryAnalysis',
    visualizeDOM: 'visualizeDOMAnalysis',
});

/** An old root nothing writes any more; still swept so it disappears. */
export const LEGACY_ANALYSIS_STORAGE_FOLDER = 'analysis';

/**
 * Per-session historical comparison snapshots (`<root>/<session>/snapshots`).
 * Not a launcher folder, but a crash or kill leaves it behind just the same,
 * so startup cleanup sweeps it too (HIST-8).
 */
export const HISTORICAL_COMPARISON_STORAGE_FOLDER = 'historical-comparisons';

/** Every root startup cleanup sweeps. */
export function getSweptStorageFolders(): string[] {
    return [
        ...Object.values(ANALYSIS_STORAGE_FOLDERS),
        LEGACY_ANALYSIS_STORAGE_FOLDER,
        HISTORICAL_COMPARISON_STORAGE_FOLDER,
    ];
}
