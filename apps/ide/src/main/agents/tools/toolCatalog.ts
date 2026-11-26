import type { ToolInfo } from '../../../shared/agents.ts';
import type { AgentTool } from './toolTypes.ts';
import { WORKSPACE_TOOLS } from './workspaceTools.ts';

/**
 * Every tool an agent can be given. Later stories add the risky ones
 * (propose_edit A8, run_command A9, Code-XR analyses A10, MCP A12).
 */
export class ToolCatalog {
    private readonly tools = new Map<string, AgentTool>();

    constructor(tools: readonly AgentTool[] = WORKSPACE_TOOLS) {
        for (const tool of tools) {
            this.add(tool);
        }
    }

    add(tool: AgentTool): void {
        if (this.tools.has(tool.name)) {
            throw new Error(`Duplicate tool ${tool.name}.`);
        }
        this.tools.set(tool.name, tool);
    }

    get(name: string): AgentTool | undefined {
        return this.tools.get(name);
    }

    list(): readonly ToolInfo[] {
        return [...this.tools.values()].map(({ name, title, description, risk }) => ({ name, title, description, risk }));
    }

    /** The tools an agent may use, in catalogue order; unknown names are ignored. */
    forAgent(names: readonly string[]): readonly AgentTool[] {
        const allowed = new Set(names);
        return [...this.tools.values()].filter((tool) => allowed.has(tool.name));
    }
}
