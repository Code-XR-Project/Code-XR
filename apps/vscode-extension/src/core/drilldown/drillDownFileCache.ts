import { normalizeBabiaPath } from './drillDownDataset';

/**
 * Per-file analysis cache of the drill-down (#334), keyed by content hash,
 * the same rule as the incremental re-analysis (FileHashTracker): a file
 * whose size and mtime are unchanged is trusted at once; otherwise its
 * SHA-256 decides, so a touch without an edit costs a hash, not a Python run.
 * A jump then analyses only what has no result yet or whose hash changed.
 *
 * It is seeded with the rows the table already has (the session's data.json
 * and the hashes the session keeps in `filesToHash`), so files of the
 * project analysis are never analysed again.
 */

export interface FileStat {
    readonly size: number;
    readonly mtimeMs: number;
}

export interface FileCacheIo {
    stat(absolutePath: string): Promise<FileStat | null>;
    hash(absolutePath: string): Promise<string>;
}

interface Entry<T> {
    hash: string | null;
    size: number | null;
    mtimeMs: number | null;
    value: T;
}

export interface SeedEntry<T> {
    readonly filePath: string;
    readonly value: T;
    readonly hash?: string | null;
    readonly size?: number | null;
    readonly mtimeMs?: number | null;
}

export interface FreshnessReport {
    /** Files whose cached value still holds, with that value. */
    readonly reused: Map<string, unknown>;
    /** Files to analyse: no value yet, or the content changed. */
    readonly stale: string[];
    /** Files that vanished while checking. */
    readonly missing: string[];
}

export class DrillFileCache<T> {
    private readonly entries = new Map<string, Entry<T>>();
    private readonly io: FileCacheIo;
    private readonly caseInsensitive: boolean;
    private readonly maxEntries: number;

    constructor(io: FileCacheIo, options: { caseInsensitive?: boolean; maxEntries?: number } = {}) {
        this.io = io;
        this.caseInsensitive = options.caseInsensitive ?? false;
        this.maxEntries = Math.max(1, options.maxEntries ?? 20000);
    }

    public get size(): number {
        return this.entries.size;
    }

    public keyOf(absolutePath: string): string {
        const normalized = normalizeBabiaPath(absolutePath);
        return this.caseInsensitive ? normalized.toLowerCase() : normalized;
    }

    /** Seeds values known to be current (rows already on the table); never overwrites a fresher entry. */
    public seed(entries: Iterable<SeedEntry<T>>): number {
        let added = 0;
        for (const entry of entries) {
            const key = this.keyOf(entry.filePath);
            const existing = this.entries.get(key);
            if (existing?.hash && entry.hash && existing.hash === entry.hash) {
                continue;
            }
            this.entries.set(key, {
                hash: entry.hash ?? null,
                size: entry.size ?? null,
                mtimeMs: entry.mtimeMs ?? null,
                value: entry.value,
            });
            added++;
        }
        this.trim();
        return added;
    }

    /**
     * Sorts `files` into the ones whose cached value holds and the ones to
     * analyse. Unchanged size and mtime: reused without reading the file.
     * Otherwise the hash is compared (and the stat refreshed when it matches).
     */
    public async check(files: readonly string[]): Promise<FreshnessReport> {
        const reused = new Map<string, unknown>();
        const stale: string[] = [];
        const missing: string[] = [];
        for (const file of files) {
            const entry = this.entries.get(this.keyOf(file));
            const stat = await this.io.stat(file);
            if (!stat) {
                missing.push(file);
                continue;
            }
            if (!entry) {
                stale.push(file);
                continue;
            }
            if (entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) {
                reused.set(file, entry.value);
                continue;
            }
            let hash: string;
            try {
                hash = await this.io.hash(file);
            } catch {
                missing.push(file);
                continue;
            }
            if (entry.hash && entry.hash === hash) {
                entry.size = stat.size;
                entry.mtimeMs = stat.mtimeMs;
                reused.set(file, entry.value);
            } else {
                stale.push(file);
            }
        }
        return { reused, stale, missing };
    }

    /** Stores fresh results, with the stat and hash they were computed from. */
    public async store(results: Iterable<{ filePath: string; value: T }>): Promise<void> {
        for (const result of results) {
            const stat = await this.io.stat(result.filePath);
            let hash: string | null = null;
            try {
                hash = await this.io.hash(result.filePath);
            } catch {
                hash = null;
            }
            const key = this.keyOf(result.filePath);
            this.entries.delete(key);
            this.entries.set(key, { hash, size: stat?.size ?? null, mtimeMs: stat?.mtimeMs ?? null, value: result.value });
        }
        this.trim();
    }

    public get(absolutePath: string): T | undefined {
        return this.entries.get(this.keyOf(absolutePath))?.value;
    }

    public clear(): void {
        this.entries.clear();
    }

    private trim(): void {
        while (this.entries.size > this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value as string);
        }
    }
}
