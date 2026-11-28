import { assembleRuntimeContent, writeAssembledRuntimeToOutput } from './runtimeAssembly';

export const AGENT_FLOW_RUNTIME_OUTPUT_NAME = 'agentFlowRuntime.js';

// The Agent Flow runtime is a multi-part runtime (see runtimeAssembly.ts): its source
// lives as ordered parts under agent-flow/agentFlowRuntime/.
export async function copyAgentFlowRuntimeToOutput(
    extensionPath: string,
    outputDirectory: string,
): Promise<string> {
    return writeAssembledRuntimeToOutput(
        extensionPath, 'agent-flow', AGENT_FLOW_RUNTIME_OUTPUT_NAME, outputDirectory,
    );
}

export async function readAgentFlowRuntimeContent(extensionPath: string): Promise<string> {
    return assembleRuntimeContent(extensionPath, 'agent-flow', AGENT_FLOW_RUNTIME_OUTPUT_NAME);
}
