import {
    SINGLE_FILE_RUNTIME_ASSETS,
    resolveRuntimeAssetSourcePath,
    assertRuntimeAssetSourceExists,
    copyRuntimeAssetToOutput,
    readRuntimeAssetContent,
} from './singleFileRuntimeAssets';

const ASSET = SINGLE_FILE_RUNTIME_ASSETS.immersiveRig;

export const IMMERSIVE_RIG_RUNTIME_OUTPUT_NAME = ASSET.outputName;

export function resolveImmersiveRigRuntimeSourcePath(extensionPath: string): string {
    return resolveRuntimeAssetSourcePath(ASSET, extensionPath);
}

export function assertImmersiveRigRuntimeSourceExists(extensionPath: string): string {
    return assertRuntimeAssetSourceExists(ASSET, extensionPath);
}

export async function copyImmersiveRigRuntimeToOutput(extensionPath: string, outputDirectory: string): Promise<string> {
    return copyRuntimeAssetToOutput(ASSET, extensionPath, outputDirectory);
}

export async function readImmersiveRigRuntimeContent(extensionPath: string): Promise<string> {
    return readRuntimeAssetContent(ASSET, extensionPath);
}
