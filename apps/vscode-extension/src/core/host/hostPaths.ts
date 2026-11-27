/**
 * Bridges from the VS Code extension's `ExtensionContext` to the host's plain
 * `HostPaths` while #13 moves the core off `vscode` one module at a time.
 *
 * vscode-free: the context is described structurally, so a core module that
 * still receives an `ExtensionContext` can hand its paths to an already
 * migrated helper without importing `vscode`.
 */
import type { HostKeyValueStore, HostMode, HostPaths } from './codeXRHost';

/**
 * The numeric values of `vscode.ExtensionMode`. They are frozen public API
 * (`@types/vscode`: Production = 1, Development = 2, Test = 3), and
 * `test/host/hostPaths.test.cjs` checks them against the installed typings.
 */
export const EXTENSION_MODE = Object.freeze({ Production: 1, Development: 2, Test: 3 });

/** A file location as the core reads it: `vscode.Uri` fits, so does any `{ fsPath }`. */
export interface FileLocation {
    readonly fsPath: string;
}

/** The part of an `ExtensionContext` that `hostPathsFromContext` reads. */
export interface ExtensionContextPaths {
    readonly extensionPath: string;
    readonly extensionMode: number;
    readonly globalStorageUri: FileLocation;
    readonly storageUri?: FileLocation | undefined;
}

/** What a module that only keeps per-user files needs from the context. */
export type GlobalStorageContext = Pick<ExtensionContextPaths, 'globalStorageUri'>;

/**
 * What settings-style modules read from an `ExtensionContext`: the per-user
 * storage folder and the key-value store. A real context fits as it is, and so
 * does a `CodeXRHost`-backed object in the IDE.
 */
export type GlobalStateContext = GlobalStorageContext & {
    readonly globalState: HostKeyValueStore;
};

/**
 * Everything the core reads from the application's start-up context (#13,
 * step 9): the paths of `ExtensionContextPaths` and the key-value store of
 * `GlobalStateContext`. A `vscode.ExtensionContext` fits as it is; the IDE
 * builds one from its `CodeXRHost`. Modules that need less take the narrower
 * types above.
 */
export type CoreContext = ExtensionContextPaths & GlobalStateContext;

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
