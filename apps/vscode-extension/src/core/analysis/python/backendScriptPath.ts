import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Where a Python backend script can be found.
 *
 * `distPath` is the copy webpack ships inside the extension
 * (`dist/code_analysis/python`). `developmentPath` is the monorepo source tree
 * (`<repo>/backend/src`), two levels above `apps/vscode-extension`; it is only
 * offered in `ExtensionMode.Development`. In an installed extension
 * (`~/.vscode/extensions/<publisher>.<name>-<version>`) the same `../..` is the
 * user's home directory, so a production build must never look there.
 */
export interface BackendScriptCandidates {
    distPath: string;
    developmentPath: string | undefined;
}

type BackendScriptContext = Pick<vscode.ExtensionContext, 'extensionPath' | 'extensionMode'>;

export function getBackendScriptCandidates(
    context: BackendScriptContext,
    relativeScriptPath: string,
): BackendScriptCandidates {
    const distPath = path.join(context.extensionPath, 'dist', 'code_analysis', 'python', relativeScriptPath);
    const developmentPath = context.extensionMode === vscode.ExtensionMode.Development
        ? path.join(context.extensionPath, '..', '..', 'backend', 'src', relativeScriptPath)
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
    context: BackendScriptContext,
    relativeScriptPath: string,
    exists: (candidate: string) => boolean = fs.existsSync,
): string {
    const { distPath, developmentPath } = getBackendScriptCandidates(context, relativeScriptPath);
    if (exists(distPath) || developmentPath === undefined) {
        return distPath;
    }
    return developmentPath;
}
