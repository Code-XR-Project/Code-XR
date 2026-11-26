/**
 * Bridges from the VS Code extension's `ExtensionContext` to the host's plain
 * `HostPaths` while #13 moves the core off `vscode` one module at a time.
 *
 * vscode-free: the context is described structurally, so a core module that
 * still receives an `ExtensionContext` can hand its paths to an already
 * migrated helper without importing `vscode`.
 */
import type { HostMode, HostPaths } from './codeXRHost';

/**
 * The numeric values of `vscode.ExtensionMode`. They are frozen public API
 * (`@types/vscode`: Production = 1, Development = 2, Test = 3), and
 * `test/host/hostPaths.test.cjs` checks them against the installed typings.
 */
export const EXTENSION_MODE = Object.freeze({ Production: 1, Development: 2, Test: 3 });

/** The part of an `ExtensionContext` that `hostPathsFromContext` reads. */
export interface ExtensionContextPaths {
    readonly extensionPath: string;
    readonly extensionMode: number;
    readonly globalStorageUri: { readonly fsPath: string };
    readonly storageUri?: { readonly fsPath: string } | undefined;
}

export function hostModeFromExtensionMode(mode: number): HostMode {
    switch (mode) {
        case EXTENSION_MODE.Development:
            return 'development';
        case EXTENSION_MODE.Test:
            return 'test';
        default:
            return 'production';
    }
}

export function hostPathsFromContext(context: ExtensionContextPaths): HostPaths {
    return {
        installRoot: context.extensionPath,
        globalStorageDir: context.globalStorageUri.fsPath,
        workspaceStorageDir: context.storageUri?.fsPath,
        mode: hostModeFromExtensionMode(context.extensionMode),
    };
}

/**
 * The folder for files that belong to this workspace but must not be written
 * into it (Git snapshots, export staging, dependency datasets): the
 * per-workspace storage, or the per-user one when no folder is open. Replaces
 * five copies of `context.storageUri?.fsPath || context.globalStorageUri.fsPath`;
 * `||` on purpose, so an empty string also falls back, exactly as before.
 */
export function privateStorageRoot(paths: Pick<HostPaths, 'workspaceStorageDir' | 'globalStorageDir'>): string {
    return paths.workspaceStorageDir || paths.globalStorageDir;
}
