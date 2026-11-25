import * as crypto from 'crypto';
import * as path from 'path';

/**
 * Pure helpers shared by the Git-backed analyses: historical comparison,
 * project evolution and the export-time Git pre-analysis.
 *
 * Deliberately vscode-free (path and crypto only): gitRevisionExportCore.ts
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
    if (!path.isAbsolute(candidate)) {
        return candidate
            .replace(/\\/g, '/')
            .replace(/^\.\/+/, '')
            .replace(/\/+/g, '/')
            .replace(/^\/|\/$/g, '') || 'unknown';
    }
    const normalizedCandidate = path.resolve(candidate);
    const normalizedRoot = path.resolve(root);
    const relativePath = path.relative(normalizedRoot, normalizedCandidate);
    if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
        return relativePath.split(path.sep).join('/');
    }
    return path.basename(candidate);
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
