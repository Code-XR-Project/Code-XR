import * as fs from 'fs';
import * as path from 'path';

/**
 * Scene runtimes shipped as one JS file, copied verbatim from
 * `templates/components/<folder...>/<outputName>` (the output name is also the
 * source file name). Multi-part runtimes go through runtimeAssembly.ts instead.
 *
 * Each `*ComponentAsset.ts` keeps its named exports as thin wrappers over this
 * table, so call sites and the customComponents barrel are unchanged.
 */
export interface SingleFileRuntimeAsset {
    readonly outputName: string;
    /** Folders under `templates/components/`. */
    readonly folder: readonly string[];
    /** First words of the "<label> not found at <path>" refusal. */
    readonly label: string;
}

export const SINGLE_FILE_RUNTIME_ASSETS = {
    avatar: { outputName: 'codexrAvatarRuntime.js', folder: ['codexr', 'avatar'], label: 'CodeXR avatar runtime' },
    codexrDebug: { outputName: 'codexrDebugRuntime.js', folder: ['codexr', 'debug'], label: 'CodeXR debug runtime' },
    common: { outputName: 'codexrCommonRuntime.js', folder: ['common'], label: 'CodeXR common runtime' },
    gitRefPicker: {
        outputName: 'codexrGitRefPickerRuntime.js', folder: ['common'], label: 'CodeXR Git ref picker runtime',
    },
    dependencyVisualBudget: {
        outputName: 'dependencyVisualBudgetRuntime.js',
        folder: ['codexr', 'dependency-visual-budget'],
        label: 'Dependency visual budget runtime',
    },
    immersiveRig: {
        outputName: 'codexrImmersiveRigRuntime.js', folder: ['codexr', 'immersive-rig'], label: 'CodeXR immersive-rig runtime',
    },
    pointerPolicy: {
        outputName: 'codexrPointerPolicyRuntime.js', folder: ['codexr', 'pointer-policy'], label: 'CodeXR pointer-policy runtime',
    },
    /** The room also needs its textures/ folder: see codexrRoomComponentAsset.ts. */
    room: { outputName: 'codexrRoomRuntime.js', folder: ['codexr', 'xr-room'], label: 'CodeXR room runtime' },
    renderBudget: { outputName: 'renderBudgetRuntime.js', folder: ['codexr', 'render-budget'], label: 'Render budget runtime' },
} as const satisfies Record<string, SingleFileRuntimeAsset>;

export function resolveRuntimeAssetSourcePath(asset: SingleFileRuntimeAsset, extensionPath: string): string {
    return path.join(extensionPath, 'templates', 'components', ...asset.folder, asset.outputName);
}

export function assertRuntimeAssetSourceExists(asset: SingleFileRuntimeAsset, extensionPath: string): string {
    const sourcePath = resolveRuntimeAssetSourcePath(asset, extensionPath);
    if (!fs.existsSync(sourcePath)) {
        throw new Error(`${asset.label} not found at ${sourcePath}`);
    }
    return sourcePath;
}

export async function copyRuntimeAssetToOutput(
    asset: SingleFileRuntimeAsset,
    extensionPath: string,
    outputDirectory: string,
): Promise<string> {
    const sourcePath = assertRuntimeAssetSourceExists(asset, extensionPath);
    const outputPath = path.join(outputDirectory, asset.outputName);
    await fs.promises.copyFile(sourcePath, outputPath);
    return outputPath;
}

export async function readRuntimeAssetContent(asset: SingleFileRuntimeAsset, extensionPath: string): Promise<string> {
    return fs.promises.readFile(assertRuntimeAssetSourceExists(asset, extensionPath), 'utf8');
}
