/**
 * Which files of a revision a snapshot copies, and the limits it enforces.
 * Pure helpers split out of GitRepositoryService (no Git, no file system).
 */
import * as path from 'path';
import {
    isDirectoryAnalysisFile,
    shouldIgnoreDirectoryName,
} from '../analysis/watchers/analysisFilePolicy';
import { PARTIAL_CLONE_MISSING_MESSAGE } from './gitOfflineEnvironment';

export const MAX_SNAPSHOT_FILES = 5000;
export const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;
export const MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024;

/** A repository path relative to the analyzed target (POSIX). */
export function relativeToTarget(targetRelativePath: string, repositoryPath: string): string {
    return targetRelativePath === '.'
        ? repositoryPath
        : path.posix.relative(targetRelativePath, repositoryPath);
}

/** Whether a directory analysis would read this file (same rules as the live watcher). */
export function shouldMaterializeDirectoryFile(relativePath: string): boolean {
    if (
        !relativePath
        || relativePath.startsWith('../')
        || path.posix.isAbsolute(relativePath)
    ) {
        return false;
    }
    const pathParts = relativePath.split('/').filter(Boolean);
    const directoryParts = pathParts.slice(0, -1);
    if (directoryParts.some((part) => shouldIgnoreDirectoryName(part))) {
        return false;
    }
    return isDirectoryAnalysisFile(relativePath);
}

/** One `ls-tree -l` entry: a file to copy, a warning, or null when it is not read. */
function planTreeEntry(
    entry: string,
    targetRelativePath: string,
    recursive: boolean,
): { repositoryPath: string; size: number } | { warning: string } | null {
    const match = entry.match(/^(\d+)\s+(\w+)\s+([0-9a-f]{40})\s+(-|\d+)\t(.+)$/);
    if (!match) {
        return null;
    }
    const [, mode, type, , rawSize, repositoryPath] = match;
    const relativePath = relativeToTarget(targetRelativePath, repositoryPath);
    if (!recursive && relativePath.includes('/')) {
        // A shallow analysis reads only the target's own files (HIST-5).
        return null;
    }
    if (type !== 'blob' || mode === '160000') {
        return { warning: `Skipped unsupported Git entry: ${repositoryPath}` };
    }
    if (!shouldMaterializeDirectoryFile(relativePath)) {
        return null;
    }
    if (rawSize === '-') {
        // Git lists a blob it does not have (a partial clone) with no size.
        // Skipping it would analyze the revision silently without this file.
        throw new Error(PARTIAL_CLONE_MISSING_MESSAGE);
    }
    const size = Number(rawSize);
    if (!Number.isFinite(size) || size > MAX_SINGLE_FILE_BYTES) {
        return { warning: `Skipped oversized file: ${repositoryPath}` };
    }
    return { repositoryPath, size };
}

/**
 * The blobs of an `ls-tree -r -z -l` listing to copy, with the warnings for
 * the entries skipped. Throws when the snapshot would exceed the file or byte
 * limit, before anything is written.
 */
export function planDirectorySnapshot(
    rawTree: Buffer,
    targetRelativePath: string,
    recursive = true,
): { repositoryPaths: string[]; warnings: string[] } {
    let totalBytes = 0;
    const warnings: string[] = [];
    const repositoryPaths: string[] = [];
    for (const entry of rawTree.toString('utf8').split('\0').filter(Boolean)) {
        const planned = planTreeEntry(entry, targetRelativePath, recursive);
        if (!planned) {
            continue;
        }
        if ('warning' in planned) {
            warnings.push(planned.warning);
            continue;
        }
        if (repositoryPaths.length >= MAX_SNAPSHOT_FILES) {
            throw new Error('comparison-snapshot-file-limit');
        }
        totalBytes += planned.size;
        if (totalBytes > MAX_SNAPSHOT_BYTES) {
            throw new Error('comparison-snapshot-size-limit');
        }
        repositoryPaths.push(planned.repositoryPath);
    }
    return { repositoryPaths, warnings };
}
