import * as fs from 'fs';
import * as path from 'path';
import { DrillFileCache } from './drillDownFileCache';
import type { FileCacheIo, FreshnessReport, SeedEntry } from './drillDownFileCache';
import { isDirectoryRows, normalizeBabiaPath } from './drillDownDataset';
import type { DrillTargetKind } from './drillDownModels';

/**
 * What the drill-down needs from the analysis backend. Folder datasets are
 * assembled file by file, so only files without a current result are sent
 * to Python (the same per-file summaries the incremental re-analysis uses).
 */
export interface DrillAnalyzer {
    /** The files a folder analysis covers (the analyzer's own file policy). */
    listFolderFiles(folderAbsolutePath: string, deep: boolean): Promise<string[]>;
    /** Per-file summary rows (the directory analysis' row shape) for these files. */
    analyzeFiles(absolutePaths: readonly string[], signal: AbortSignal): Promise<unknown[]>;
    /** Function rows of one file (the file analysis). */
    analyzeFunctions(absolutePath: string, signal: AbortSignal): Promise<unknown[]>;
    /** Stat and SHA-256 of a file, for the cache. */
    readonly io: FileCacheIo;
}

/** What the session already knows: its rows and the hashes they were computed from. */
export interface DrillSessionSeed {
    readonly rows: readonly unknown[];
    readonly hashes: ReadonlyArray<{ filePath: string; hash: string; size?: number; mtimeMs?: number }>;
}

/** A dataset ready to draw. */
export interface DrillDataset {
    readonly rows: unknown[];
    readonly source: 'cache' | 'analysis';
    readonly analyzed: number;
    readonly reused: number;
}

export interface DrillDatasetBuilderOptions {
    readonly analyzer: DrillAnalyzer;
    readonly readSessionSeed?: () => DrillSessionSeed | null;
    /** Folder analyses walk sub-folders (the session's own depth). */
    readonly deep: boolean;
    readonly batchSize: number;
    readonly caseInsensitive: boolean;
    /** The server's static root; datasets go to `<staticRoot>/drilldown/`. */
    readonly staticRoot: string;
}

const DATASET_FOLDER = 'drilldown';

/**
 * The rows of a drilled target (#334), analysing only what the caches
 * cannot answer: files with no result yet, or whose content hash changed.
 */
export class DrillDatasetBuilder {
    private readonly options: DrillDatasetBuilderOptions;
    /** Directory-analysis row of each file, by content hash. */
    private readonly fileRows: DrillFileCache<unknown>;
    /** Function rows of each file analysed on its own, by content hash. */
    private readonly functionRows: DrillFileCache<unknown[]>;
    private seeded = false;
    private datasetRevision = 0;

    constructor(options: DrillDatasetBuilderOptions) {
        this.options = options;
        this.fileRows = new DrillFileCache<unknown>(options.analyzer.io, { caseInsensitive: options.caseInsensitive });
        this.functionRows = new DrillFileCache<unknown[]>(options.analyzer.io, { caseInsensitive: options.caseInsensitive, maxEntries: 200 });
    }

    /** The session re-analysed: its rows and hashes are read again before the next jump. */
    public invalidateSeed(): void {
        this.seeded = false;
    }

    public clear(): void {
        this.fileRows.clear();
        this.functionRows.clear();
    }

    public async compute(absolutePath: string, kind: DrillTargetKind, signal: AbortSignal): Promise<DrillDataset> {
        this.seedFromSession();
        return kind === 'file'
            ? this.computeFile(absolutePath, signal)
            : this.computeFolder(absolutePath, signal);
    }

    /** Writes a dataset under the static root and returns its URL. */
    public async write(rows: unknown[]): Promise<string> {
        const revision = ++this.datasetRevision;
        const folder = path.join(this.options.staticRoot, DATASET_FOLDER);
        await fs.promises.mkdir(folder, { recursive: true });
        const name = `drill-${revision}.json`;
        await fs.promises.writeFile(path.join(folder, name), JSON.stringify(rows), 'utf8');
        // Keep the previous dataset: a peer may still be fetching it.
        const stale = path.join(folder, `drill-${revision - 2}.json`);
        await fs.promises.rm(stale, { force: true }).catch(() => undefined);
        return `/${DATASET_FOLDER}/${name}`;
    }

    private async computeFile(absolutePath: string, signal: AbortSignal): Promise<DrillDataset> {
        const report = await this.functionRows.check([absolutePath]);
        const cached = report.reused.get(absolutePath) as unknown[] | undefined;
        if (cached) {
            return { rows: cached, source: 'cache', analyzed: 0, reused: 1 };
        }
        const rows = await this.options.analyzer.analyzeFunctions(absolutePath, signal);
        if (!Array.isArray(rows)) {
            throw new Error('The analysis returned no rows.');
        }
        await this.functionRows.store([{ filePath: absolutePath, value: rows }]);
        return { rows, source: 'analysis', analyzed: 1, reused: 0 };
    }

    private async computeFolder(absolutePath: string, signal: AbortSignal): Promise<DrillDataset> {
        const files = await this.options.analyzer.listFolderFiles(absolutePath, this.options.deep);
        const report = await this.fileRows.check(files);
        const fresh = await this.analyzeStale(report.stale, signal);
        return {
            rows: assembleFolderRows(absolutePath, files, fresh, report),
            source: report.stale.length ? 'analysis' : 'cache',
            analyzed: report.stale.length,
            reused: report.reused.size,
        };
    }

    /** Sends the stale files to Python in batches and caches each result by hash. */
    private async analyzeStale(stale: readonly string[], signal: AbortSignal): Promise<Map<string, unknown>> {
        const fresh = new Map<string, unknown>();
        const batchSize = Math.max(1, this.options.batchSize);
        for (let index = 0; index < stale.length; index += batchSize) {
            if (signal.aborted) {
                throw new Error('Superseded by a newer request.');
            }
            const batch = stale.slice(index, index + batchSize);
            const rows = await this.options.analyzer.analyzeFiles(batch, signal);
            const byKey = new Map<string, unknown>();
            for (const row of Array.isArray(rows) ? rows : []) {
                const filePath = rowFilePath(row);
                if (filePath) {
                    byKey.set(this.fileRows.keyOf(filePath), row);
                }
            }
            const results: Array<{ filePath: string; value: unknown }> = [];
            for (const file of batch) {
                const row = byKey.get(this.fileRows.keyOf(file));
                if (row) {
                    fresh.set(file, row);
                    results.push({ filePath: file, value: row });
                }
            }
            await this.fileRows.store(results);
        }
        return fresh;
    }

    /**
     * Seeds the file cache with the rows the table already has: every file of
     * a directory session's analysis, with the hash the session tracks for it.
     * Read again after each re-analysis, so a saved file is never served stale.
     */
    private seedFromSession(): void {
        if (this.seeded) {
            return;
        }
        this.seeded = true;
        const seed = this.options.readSessionSeed?.();
        if (seed && Array.isArray(seed.rows) && isDirectoryRows(seed.rows)) {
            this.fileRows.seed(this.seedEntries(seed));
        }
    }

    private seedEntries(seed: DrillSessionSeed): Array<SeedEntry<unknown>> {
        const hashes = new Map<string, { hash: string; size?: number; mtimeMs?: number }>();
        for (const entry of seed.hashes ?? []) {
            if (entry?.filePath && entry.hash) {
                hashes.set(this.fileRows.keyOf(entry.filePath), entry);
            }
        }
        const entries: Array<SeedEntry<unknown>> = [];
        for (const row of seed.rows) {
            const filePath = rowFilePath(row);
            if (filePath) {
                const known = hashes.get(this.fileRows.keyOf(filePath));
                entries.push({ filePath, value: row, hash: known?.hash ?? null, size: known?.size ?? null, mtimeMs: known?.mtimeMs ?? null });
            }
        }
        return entries;
    }
}

/** The folder's rows in file order, `relativePath` re-rooted at the folder as its own analysis writes it, plus `drillPath` (the tree path). */
function assembleFolderRows(
    folderAbsolutePath: string,
    files: readonly string[],
    fresh: ReadonlyMap<string, unknown>,
    report: FreshnessReport,
): unknown[] {
    const folderKey = normalizeBabiaPath(folderAbsolutePath);
    const prefix = folderKey === '/' ? '/' : `${folderKey}/`;
    const folderName = folderKey.slice(folderKey.lastIndexOf('/') + 1) || 'root';
    const rows: unknown[] = [];
    for (const file of files) {
        const row = fresh.get(file) ?? report.reused.get(file);
        if (!row || typeof row !== 'object') {
            continue;
        }
        const normalized = normalizeBabiaPath(rowFilePath(row) || file);
        const relativePath = normalized.toLowerCase().startsWith(prefix.toLowerCase())
            ? normalized.slice(prefix.length)
            : normalized;
        // The tree path of the drilled city: the folder itself is its one top
        // district, so files at the folder's top level still stand in a district.
        rows.push({ ...(row as Record<string, unknown>), relativePath, drillPath: `${folderName}/${relativePath}` });
    }
    return rows;
}

/** A row's file path (directory rows carry `filePath`; legacy ones `file_path`). */
export function rowFilePath(row: unknown): string | null {
    if (!row || typeof row !== 'object') {
        return null;
    }
    const record = row as Record<string, unknown>;
    const value = typeof record.filePath === 'string' ? record.filePath : record.file_path;
    return typeof value === 'string' && value ? value : null;
}
