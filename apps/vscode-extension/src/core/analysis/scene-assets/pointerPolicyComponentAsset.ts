import {
    SINGLE_FILE_RUNTIME_ASSETS,
    resolveRuntimeAssetSourcePath,
    assertRuntimeAssetSourceExists,
    copyRuntimeAssetToOutput,
    readRuntimeAssetContent,
} from './singleFileRuntimeAssets';

const ASSET = SINGLE_FILE_RUNTIME_ASSETS.pointerPolicy;

export const POINTER_POLICY_RUNTIME_OUTPUT_NAME = ASSET.outputName;

export function resolvePointerPolicyRuntimeSourcePath(extensionPath: string): string {
    return resolveRuntimeAssetSourcePath(ASSET, extensionPath);
}

export function assertPointerPolicyRuntimeSourceExists(extensionPath: string): string {
    return assertRuntimeAssetSourceExists(ASSET, extensionPath);
}

export async function copyPointerPolicyRuntimeToOutput(extensionPath: string, outputDirectory: string): Promise<string> {
    return copyRuntimeAssetToOutput(ASSET, extensionPath, outputDirectory);
}

export async function readPointerPolicyRuntimeContent(extensionPath: string): Promise<string> {
    return readRuntimeAssetContent(ASSET, extensionPath);
}
