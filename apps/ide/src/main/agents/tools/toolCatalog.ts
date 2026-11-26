import type { ToolInfo } from '../../../shared/agents.ts';
import type { AgentTool } from './toolTypes.ts';
import { runCommandTool, type CommandRunner } from './commandTool.ts';
import { EDIT_TOOLS } from './editTools.ts';
import { WORKSPACE_TOOLS } from './workspaceTools.ts';

/**
 * Every tool an agent can be given: the read-only workspace tools (A7),
 * propose_edit (A8), run_command (A9) when a command runner is given;
 * later stories add the Code-XR analyses (A10) and MCP tools (A12).
 */
export class ToolCatalog {
    private readonly tools = new Map<string, AgentTool>();

    constructor(tools: readonly AgentTool[] = [...WORKSPACE_TOOLS, ...EDIT_TOOLS]) {
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

    /** The catalogue of the running IDE: every built-in tool, with commands run by `runner`. */
    static standard(runner: CommandRunner | null): ToolCatalog {
        return new ToolCatalog([...WORKSPACE_TOOLS, ...EDIT_TOOLS, ...(runner ? [runCommandTool(runner)] : [])]);
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
