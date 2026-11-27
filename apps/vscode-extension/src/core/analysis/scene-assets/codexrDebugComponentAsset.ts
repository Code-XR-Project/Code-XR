import {
    SINGLE_FILE_RUNTIME_ASSETS,
    resolveRuntimeAssetSourcePath,
    copyRuntimeAssetToOutput,
    readRuntimeAssetContent,
} from './singleFileRuntimeAssets';

const ASSET = SINGLE_FILE_RUNTIME_ASSETS.codexrDebug;

export const CODEXR_DEBUG_RUNTIME_OUTPUT_NAME = ASSET.outputName;

export function resolveCodeXrDebugRuntimeSourcePath(extensionPath: string): string {
    return resolveRuntimeAssetSourcePath(ASSET, extensionPath);
}

export async function copyCodeXrDebugRuntimeToOutput(extensionPath: string, outputDirectory: string): Promise<string> {
    return copyRuntimeAssetToOutput(ASSET, extensionPath, outputDirectory);
}

export async function readCodeXrDebugRuntimeContent(extensionPath: string): Promise<string> {
    return readRuntimeAssetContent(ASSET, extensionPath);
}
