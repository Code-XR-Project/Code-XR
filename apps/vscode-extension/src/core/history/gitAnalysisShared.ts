import * as crypto from 'crypto';
import * as path from 'path';
import { buildBabiaStyleFilePath } from './historicalComparisonModels';

/**
 * Pure helpers shared by the Git-backed analyses: historical comparison,
 * project evolution and the export-time Git pre-analysis.
 *
 * Deliberately vscode-free (path, crypto and the models): gitRevisionExportCore.ts
 * imports it and must stay require()-able from out/ without a vscode stub.
 */

/**
 * The analyzed path of a payload entry, relative to the analyzed target and
 * in POSIX form, so the same file matches across revisions that were
 * materialized in different places.
 *
 * - '' -> 'unknown'; a relative path is cleaned ('./a//b/' -> 'a/b',
 *   'a\\b' -> 'a/b') and falls back to 'unknown' when nothing is left;
 * - an absolute path inside the root -> its POSIX relative path; the root
 *   itself -> '' (a quirk the callers rely on staying as it is);
 * - an absolute path outside the root -> its basename.
 */
export function toPortableRelativePath(root: string, candidate: string): string {
    if (!candidate) {
        return 'unknown';
    }
    if (!isAbsoluteOnAnyPlatform(candidate)) {
        return candidate
            .replace(/\\/g, '/')
            .replace(/^\.\/+/, '')
            .replace(/\/+/g, '/')
            .replace(/^\/|\/$/g, '') || 'unknown';
    }
    // Both sides in the drive-less POSIX form the Python side already uses
    // (normalize_path_for_babia). Resolving the drive-less `/work/proj/a.ts`
    // with the host's `path` put it on the cwd's drive (C:), so a working copy
    // on D: fell back to basenames and same-named files collided (HIST-6).
    const normalizedCandidate = path.posix.resolve('/', withoutDrive(candidate));
    const normalizedRoot = path.posix.resolve('/', withoutDrive(root));
    const relativePath = path.posix.relative(normalizedRoot, normalizedCandidate);
    if (!relativePath.startsWith('..') && !path.posix.isAbsolute(relativePath)) {
        return relativePath;
    }
    // Windows and macOS file systems ignore case: `C:\Work` and `c:\work` are one folder.
    const caseless = path.posix.relative(normalizedRoot.toLowerCase(), normalizedCandidate.toLowerCase());
    if (caseless && !caseless.startsWith('..') && !path.posix.isAbsolute(caseless)) {
        return normalizedCandidate.slice(normalizedCandidate.length - caseless.length);
    }
    return path.posix.basename(normalizedCandidate);
}

/** `/x`, `\x`, `C:\x`, `C:/x` and `\\server\share` are absolute, whatever the host OS. */
function isAbsoluteOnAnyPlatform(value: string): boolean {
    return /^(?:[A-Za-z]:)?[\\/]/.test(value);
}

/** Forward slashes, no drive letter, no doubled separators. */
function withoutDrive(value: string): string {
    return value.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/\/+/g, '/') || '/';
}

/**
 * Directory payload decoration, identical for every Git mode except the name
 * of the identity field(s) it writes.
 *
 * filePath is the field the boats tree splits, with the same shape the
 * normal analysis publishes: it is rebuilt against the ORIGINAL target, so a
 * materialized copy's temp location never shapes the quarters and every
 * revision paints the same tree as the normal analysis. The identity key
 * stays RELATIVE (`file:<relativePath>`, lower-cased) so the same file
 * matches across sides, frames and revisions wherever each was analyzed.
 * Entry fields are kept; an existing key field is overwritten in place.
 */
export function decorateDirectoryEntries(
    entries: Record<string, unknown>[],
    originalTargetPath: string,
    analyzedTargetPath: string,
    keyFields: readonly string[],
): Record<string, unknown>[] {
    return entries.map((entry) => {
        const sourcePath = String(entry.filePath || entry.relativePath || entry.fileName || '');
        const relativePath = toPortableRelativePath(analyzedTargetPath, sourcePath);
        const key = `file:${relativePath.toLocaleLowerCase()}`;
        const decorated: Record<string, unknown> = {
            ...entry,
            filePath: buildBabiaStyleFilePath(originalTargetPath, relativePath),
            relativePath,
        };
        for (const field of keyFields) {
            decorated[field] = key;
        }
        return decorated;
    });
}

/** The session fields that decide what an analysis of one commit produces. */
export interface AnalyzerCacheKeySession {
    targetPath: string;
    targetType: string;
    isDeep?: boolean;
}

/**
 * Cache key of one analyzed commit. Each service passes its own
 * `cacheVersion` literal, which keeps the historical and evolution caches in
 * distinct namespaces.
 */
export function buildAnalyzerCacheKey(
    cacheVersion: string,
    commitSha: string,
    session: AnalyzerCacheKeySession,
): string {
    return crypto.createHash('sha256')
        .update([
            cacheVersion,
            commitSha,
            session.targetPath,
            session.targetType,
            session.isDeep ? 'deep' : 'shallow',
        ].join('\0'))
        .digest('hex');
}
