import * as path from 'path';
import type { DrillCrumb, DrillTarget, DrillTargetKind } from './drillDownModels';

/**
 * Path rules of the drill-down (#334). Everything is relative to the
 * BOUNDARY ROOT: the open workspace folder that holds the session's target,
 * else the analysed folder (directory session) or the file's own folder
 * (file session). Nothing above it is ever analysed.
 */

/** True when `candidate` is `root` or inside it. */
export function isInside(root: string, candidate: string, platformPath: typeof path = path): boolean {
    const relative = platformPath.relative(platformPath.resolve(root), platformPath.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !platformPath.isAbsolute(relative));
}

/**
 * The boundary root of a session: the deepest workspace folder containing
 * its target, else the target itself (folder) or its parent (file).
 */
export function resolveBoundaryRoot(
    targetPath: string,
    targetType: DrillTargetKind,
    workspaceFolders: readonly string[],
    platformPath: typeof path = path,
): string {
    const target = platformPath.resolve(targetPath);
    const containing = workspaceFolders
        .map((folder) => platformPath.resolve(folder))
        .filter((folder) => isInside(folder, target, platformPath))
        .sort((left, right) => right.length - left.length);
    if (containing.length) {
        return containing[0];
    }
    return targetType === 'directory' ? target : platformPath.dirname(target);
}

/** `absolutePath` relative to the root with forward slashes ('' for the root), or null when outside. */
export function toRelative(root: string, absolutePath: string, platformPath: typeof path = path): string | null {
    if (!isInside(root, absolutePath, platformPath)) {
        return null;
    }
    const relative = platformPath.relative(platformPath.resolve(root), platformPath.resolve(absolutePath));
    return relative.split(platformPath.sep).join('/');
}

/** The absolute path of a relative target path under the root. */
export function toAbsolute(root: string, relativePath: string, platformPath: typeof path = path): string {
    return relativePath
        ? platformPath.resolve(root, ...relativePath.split('/'))
        : platformPath.resolve(root);
}

/** Leading drive of a Windows path ('C:'), '' elsewhere. */
function driveOf(value: string): string {
    const match = /^([a-zA-Z]:)/.exec(value);
    return match ? match[1] : '';
}

/**
 * Resolves a path the scene sent to an absolute path inside the boundary, or
 * null. The scene only knows what Babia shows: a row's `filePath` (absolute,
 * forward slashes, drive letter stripped on Windows), a district's tree uid
 * (the same path without its leading slash) or a path relative to the root.
 * The absolute reading wins when it lands inside the boundary.
 */
export function resolveScenePath(
    boundaryRoot: string,
    input: string,
    platformPath: typeof path = path,
): string | null {
    const raw = String(input ?? '').trim().replace(/\\/g, '/');
    if (raw.includes('\0')) {
        return null;
    }
    const candidates: string[] = [];
    if (driveOf(raw)) {
        candidates.push(platformPath.resolve(raw));
    } else {
        const drive = driveOf(boundaryRoot);
        const rooted = raw.startsWith('/') ? raw : `/${raw}`;
        candidates.push(platformPath.resolve(drive ? `${drive}${rooted}` : rooted));
        if (!raw.startsWith('/')) {
            candidates.push(toAbsolute(boundaryRoot, raw.replace(/\/+$/, ''), platformPath));
        }
    }
    for (const candidate of candidates) {
        if (isInside(boundaryRoot, candidate, platformPath)) {
            return candidate;
        }
    }
    return null;
}

/** Display name of the root ('' path): the folder's own name. */
export function rootLabelOf(boundaryRoot: string, platformPath: typeof path = path): string {
    return platformPath.basename(platformPath.resolve(boundaryRoot)) || boundaryRoot;
}

/**
 * The breadcrumb from the root down to `target`: one crumb per ancestor
 * folder, then the target itself. `home` marks the session's own target.
 */
export function buildCrumbs(target: DrillTarget, home: DrillTarget, rootLabel: string): DrillCrumb[] {
    const parts = target.relativePath ? target.relativePath.split('/') : [];
    const crumbs: DrillCrumb[] = [];
    const isHome = (kind: DrillTargetKind, relativePath: string): boolean =>
        kind === home.kind && relativePath === home.relativePath;
    crumbs.push({ kind: 'directory', relativePath: '', label: rootLabel, home: isHome('directory', '') });
    for (let index = 0; index < parts.length; index++) {
        const relativePath = parts.slice(0, index + 1).join('/');
        const kind: DrillTargetKind = index === parts.length - 1 ? target.kind : 'directory';
        crumbs.push({ kind, relativePath, label: parts[index], home: isHome(kind, relativePath) });
    }
    return crumbs;
}

/** The folder that holds a target ('' for top-level entries). */
export function parentOf(relativePath: string): string {
    const index = relativePath.lastIndexOf('/');
    return index < 0 ? '' : relativePath.slice(0, index);
}

export function sameTarget(left: DrillTarget | null | undefined, right: DrillTarget | null | undefined): boolean {
    return !!left && !!right && left.kind === right.kind && left.relativePath === right.relativePath;
}
