import * as fs from 'fs';
import * as path from 'path';
import type { HostPaths } from './codeXRHost';

/**
 * Where a Python backend script can be found.
 *
 * `distPath` is the copy webpack ships inside the extension
 * (`dist/code_analysis/python`). `developmentPath` is the monorepo source tree
 * (`<repo>/backend/src`), two levels above `apps/vscode-extension`; it is only
 * offered in development mode (the extension: `ExtensionMode.Development`). In an installed extension
 * (`~/.vscode/extensions/<publisher>.<name>-<version>`) the same `../..` is the
 * user's home directory, so a production build must never look there.
 */
export interface BackendScriptCandidates {
    distPath: string;
    developmentPath: string | undefined;
}

/** The host paths this needs (#13): callers holding an ExtensionContext pass `hostPathsFromContext(context)`. */
type BackendScriptPaths = Pick<HostPaths, 'installRoot' | 'mode'>;

export function getBackendScriptCandidates(
    paths: BackendScriptPaths,
    relativeScriptPath: string,
): BackendScriptCandidates {
    const distPath = path.join(paths.installRoot, 'dist', 'code_analysis', 'python', relativeScriptPath);
    const developmentPath = paths.mode === 'development'
        ? path.join(paths.installRoot, '..', '..', 'backend', 'src', relativeScriptPath)
        : undefined;
    return { distPath, developmentPath };
}

/**
 * Resolves a backend script: the shipped `dist` copy when it exists, otherwise
 * the monorepo source in development. In any other mode a missing `dist` copy
 * resolves to the `dist` path itself, so the caller reports it as missing
 * instead of running a file outside the extension folder.
 */
export function resolveBackendScriptPath(
    paths: BackendScriptPaths,
    relativeScriptPath: string,
    exists: (candidate: string) => boolean = fs.existsSync,
): string {
    const { distPath, developmentPath } = getBackendScriptCandidates(paths, relativeScriptPath);
    if (exists(distPath) || developmentPath === undefined) {
        return distPath;
    }
    return developmentPath;
}
