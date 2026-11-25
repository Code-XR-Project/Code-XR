import {
    SINGLE_FILE_RUNTIME_ASSETS,
    resolveRuntimeAssetSourcePath,
    assertRuntimeAssetSourceExists,
    copyRuntimeAssetToOutput,
    readRuntimeAssetContent,
} from './singleFileRuntimeAssets';

const ASSET = SINGLE_FILE_RUNTIME_ASSETS.gitRefPicker;

export const CODEXR_GIT_REF_PICKER_OUTPUT_NAME = ASSET.outputName;

export function resolveCodeXrGitRefPickerSourcePath(extensionPath: string): string {
    return resolveRuntimeAssetSourcePath(ASSET, extensionPath);
}

export function assertCodeXrGitRefPickerSourceExists(extensionPath: string): string {
    return assertRuntimeAssetSourceExists(ASSET, extensionPath);
}

export async function copyCodeXrGitRefPickerToOutput(extensionPath: string, outputDirectory: string): Promise<string> {
    return copyRuntimeAssetToOutput(ASSET, extensionPath, outputDirectory);
}

export async function readCodeXrGitRefPickerContent(extensionPath: string): Promise<string> {
    return readRuntimeAssetContent(ASSET, extensionPath);
}
