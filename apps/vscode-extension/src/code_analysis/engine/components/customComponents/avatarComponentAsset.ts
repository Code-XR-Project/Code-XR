import {
    SINGLE_FILE_RUNTIME_ASSETS,
    resolveRuntimeAssetSourcePath,
    assertRuntimeAssetSourceExists,
    copyRuntimeAssetToOutput,
    readRuntimeAssetContent,
} from './singleFileRuntimeAssets';

const ASSET = SINGLE_FILE_RUNTIME_ASSETS.avatar;

export const CODEXR_AVATAR_RUNTIME_OUTPUT_NAME = ASSET.outputName;

export function resolveCodeXrAvatarRuntimeSourcePath(extensionPath: string): string {
    return resolveRuntimeAssetSourcePath(ASSET, extensionPath);
}

export function assertCodeXrAvatarRuntimeSourceExists(extensionPath: string): string {
    return assertRuntimeAssetSourceExists(ASSET, extensionPath);
}

export async function copyCodeXrAvatarRuntimeToOutput(extensionPath: string, outputDirectory: string): Promise<string> {
    return copyRuntimeAssetToOutput(ASSET, extensionPath, outputDirectory);
}

export async function readCodeXrAvatarRuntimeContent(extensionPath: string): Promise<string> {
    return readRuntimeAssetContent(ASSET, extensionPath);
}
