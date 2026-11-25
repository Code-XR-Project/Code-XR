import {
    SINGLE_FILE_RUNTIME_ASSETS,
    resolveRuntimeAssetSourcePath,
    assertRuntimeAssetSourceExists,
    copyRuntimeAssetToOutput,
    readRuntimeAssetContent,
} from './singleFileRuntimeAssets';

const ASSET = SINGLE_FILE_RUNTIME_ASSETS.common;

export const CODEXR_COMMON_RUNTIME_OUTPUT_NAME = ASSET.outputName;

export function resolveCodeXrCommonRuntimeSourcePath(extensionPath: string): string {
    return resolveRuntimeAssetSourcePath(ASSET, extensionPath);
}

export function assertCodeXrCommonRuntimeSourceExists(extensionPath: string): string {
    return assertRuntimeAssetSourceExists(ASSET, extensionPath);
}

export async function copyCodeXrCommonRuntimeToOutput(extensionPath: string, outputDirectory: string): Promise<string> {
    return copyRuntimeAssetToOutput(ASSET, extensionPath, outputDirectory);
}

export async function readCodeXrCommonRuntimeContent(extensionPath: string): Promise<string> {
    return readRuntimeAssetContent(ASSET, extensionPath);
}
