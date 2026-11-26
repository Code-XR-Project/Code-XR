import type { ToolInfo } from '../../../shared/agents.ts';
import type { AgentTool } from './toolTypes.ts';
import { ANALYSIS_TOOLS } from './analysisTools.ts';
import { runCommandTool, type CommandRunner } from './commandTool.ts';
import { delegateTaskTool } from './delegateTool.ts';
import { EDIT_TOOLS } from './editTools.ts';
import { WORKSPACE_TOOLS } from './workspaceTools.ts';

/**
 * Every tool an agent can be given: the read-only workspace tools (A7),
 * the Code-XR analysis tools (A10), propose_edit (A8), run_command (A9)
 * when a command runner is given, delegate_task (A11); MCP tools (A12)
 * come from a source asked on every lookup, since servers come and go.
 */
export class ToolCatalog {
    private readonly tools = new Map<string, AgentTool>();
    private readonly sources: (() => readonly AgentTool[])[] = [];

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
        return new ToolCatalog([...WORKSPACE_TOOLS, ...ANALYSIS_TOOLS, ...EDIT_TOOLS, ...(runner ? [runCommandTool(runner)] : []), delegateTaskTool]);
    }

    /** Tools that change at run time (MCP servers); a name clashing with a built-in is dropped. */
    addSource(source: () => readonly AgentTool[]): void {
        this.sources.push(source);
    }

    get(name: string): AgentTool | undefined {
        return this.all().find((tool) => tool.name === name);
    }

    list(): readonly ToolInfo[] {
        return this.all().map(({ name, title, description, risk }) => ({ name, title, description, risk }));
    }

    /** The tools an agent may use, in catalogue order; unknown names are ignored. */
    forAgent(names: readonly string[]): readonly AgentTool[] {
        const allowed = new Set(names);
        return this.all().filter((tool) => allowed.has(tool.name));
    }

    private all(): readonly AgentTool[] {
        const result = [...this.tools.values()];
        const seen = new Set(this.tools.keys());
        for (const source of this.sources) {
            for (const tool of source()) {
                if (!seen.has(tool.name)) {
                    seen.add(tool.name);
                    result.push(tool);
                }
            }
        }
        return result;
    }
}
