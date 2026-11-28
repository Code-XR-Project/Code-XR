import { assembleRuntimeContent, writeAssembledRuntimeToOutput } from './runtimeAssembly';

export const DRILL_DOWN_RUNTIME_OUTPUT_NAME = 'drillDownRuntime.js';

// The drill-down runtime is a multi-part runtime (see runtimeAssembly.ts): its source
// lives as ordered parts under drill-down/drillDownRuntime/.
export async function copyDrillDownRuntimeToOutput(
    extensionPath: string,
    outputDirectory: string,
): Promise<string> {
    return writeAssembledRuntimeToOutput(
        extensionPath, 'drill-down', DRILL_DOWN_RUNTIME_OUTPUT_NAME, outputDirectory,
    );
}

export async function readDrillDownRuntimeContent(extensionPath: string): Promise<string> {
    return assembleRuntimeContent(extensionPath, 'drill-down', DRILL_DOWN_RUNTIME_OUTPUT_NAME);
}
