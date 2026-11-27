import {
    SINGLE_FILE_RUNTIME_ASSETS,
    resolveRuntimeAssetSourcePath,
    copyRuntimeAssetToOutput,
    readRuntimeAssetContent,
} from './singleFileRuntimeAssets';

const ASSET = SINGLE_FILE_RUNTIME_ASSETS.dependencyVisualBudget;

export const DEPENDENCY_VISUAL_BUDGET_RUNTIME_OUTPUT_NAME = ASSET.outputName;

export function resolveDependencyVisualBudgetRuntimeSourcePath(extensionPath: string): string {
    return resolveRuntimeAssetSourcePath(ASSET, extensionPath);
}

export async function copyDependencyVisualBudgetRuntimeToOutput(extensionPath: string, outputDirectory: string): Promise<string> {
    return copyRuntimeAssetToOutput(ASSET, extensionPath, outputDirectory);
}

export async function readDependencyVisualBudgetRuntimeContent(extensionPath: string): Promise<string> {
    return readRuntimeAssetContent(ASSET, extensionPath);
}
