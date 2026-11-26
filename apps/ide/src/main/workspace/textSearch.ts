import { open } from 'node:fs/promises';
import path from 'node:path';
import type { SearchMatch, SearchQuery } from '../../shared/api.ts';
import { findInText, MAX_MATCHES_PER_FILE, type CompiledQuery } from '../../shared/searchText.ts';
import { listWorkspaceFiles } from './fileIndex.ts';
import { isIgnored, parseGitignore, type IgnoreRule } from './ignoreRules.ts';

/**
 * Search across the workspace (#165), in the main process: the renderer
 * never reads the disk. Pure Node, no native binary (a bundled ripgrep can
 * replace the walk later if very large repositories need it). Files are those
 * quick open lists (no `.git`, `node_modules`, gitignored entries or symbolic
 * links), minus binary and very large files. Matching is per line, as in
 * VS Code, so `^` and `$` mean the start and end of a line.
 */

/** Files above this are skipped (minified bundles, data dumps). */
export const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** The search stops after this many matches and says so. */
export const SEARCH_MAX_MATCHES = 20_000;
const BINARY_SNIFF_BYTES = 8000;

/** "src/**, *.ts" as rules, or null when the field is empty. */
export function compileGlobs(text: string): readonly IgnoreRule[] | null {
    const patterns = text.split(',').map((pattern) => pattern.trim()).filter((pattern) => pattern !== '');
    return patterns.length === 0 ? null : parseGitignore(patterns.join('\n'));
}

/** A file matches when it, or one of its folders, matches a pattern ("src" covers everything under src/). */
export function pathMatches(relativePath: string, rules: readonly IgnoreRule[]): boolean {
    if (isIgnored(relativePath, false, rules)) {
        return true;
    }
    const parts = relativePath.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
        if (isIgnored(parts.slice(0, depth).join('/'), true, rules)) {
            return true;
        }
    }
    return false;
}

export interface SearchStats {
    readonly files: number;
    readonly matches: number;
    readonly limitHit: boolean;
    readonly cancelled: boolean;
}

/** Reads a text file for searching; null for binary, too large or unreadable files. */
async function readSearchable(absolute: string): Promise<string | null> {
    let handle;
    try {
        handle = await open(absolute, 'r');
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > SEARCH_MAX_FILE_BYTES) {
            return null;
        }
        const bytes = await handle.readFile();
        if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
            return null;
        }
        return bytes.toString('utf8');
    } catch {
        return null;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

/**
 * Searches every file under `root`, reporting each file with matches as soon
 * as it is read. Stops when `signal` aborts or after SEARCH_MAX_MATCHES.
 */
export async function searchWorkspace(
    root: string,
    rules: readonly IgnoreRule[],
    query: SearchQuery,
    compiled: CompiledQuery,
    onFile: (relativePath: string, matches: SearchMatch[], total: number) => void,
    signal: AbortSignal,
    maxMatches = SEARCH_MAX_MATCHES,
): Promise<SearchStats> {
    const include = compileGlobs(query.include);
    const exclude = compileGlobs(query.exclude);
    const index = await listWorkspaceFiles(root, rules, 200_000);
    const candidates = index.files.filter((file) => (!include || pathMatches(file, include)) && !(exclude && pathMatches(file, exclude)));
    let files = 0;
    let matches = 0;
    const PARALLEL = 8;
    for (let start = 0; start < candidates.length; start += PARALLEL) {
        if (signal.aborted) {
            return { files, matches, limitHit: false, cancelled: true };
        }
        const batch = candidates.slice(start, start + PARALLEL);
        const texts = await Promise.all(batch.map((file) => readSearchable(path.join(root, ...file.split('/')))));
        for (let i = 0; i < batch.length; i++) {
            const text = texts[i];
            const file = batch[i];
            if (text === null || text === undefined || file === undefined) {
                continue;
            }
            const regex = new RegExp(compiled.regex.source, compiled.regex.flags);
            const found = findInText(text, regex, Math.min(MAX_MATCHES_PER_FILE, maxMatches - matches));
            if (found.total === 0) {
                continue;
            }
            files++;
            matches += found.matches.length;
            onFile(file, found.matches, found.total);
            if (matches >= maxMatches) {
                return { files, matches, limitHit: true, cancelled: false };
            }
        }
    }
    return { files, matches, limitHit: false, cancelled: signal.aborted };
}
