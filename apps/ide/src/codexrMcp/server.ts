import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { ANALYSIS_QUERIES, NO_ANALYSIS, type AnalysisQuery } from '../main/agents/tools/analysisQueries.ts';

/**
 * The Code-XR MCP server (AF10): the analysis queries of the built-in agent
 * (get_metrics, get_hotspots, get_dependencies, get_evolution), offered over
 * the Model Context Protocol to the external agents the IDE starts (Claude
 * Code, Codex, Gemini CLI over ACP), so they reason over the same
 * measurements the person sees in XR.
 *
 * Kept apart from the stdio entry (index.ts) so the tests can drive it over
 * the SDK's in-memory transport. It is read-only by construction: the only
 * files it opens are those the shared queries read inside the analysis
 * folder (data.json, dependency-graph.json, evolution/revision-N/), it never
 * starts an analysis, and it has no network listener.
 */

export const CODEXR_MCP_NAME = 'code-xr';
export const CODEXR_MCP_VERSION = '0.1.0';

export interface CodexrMcpOptions {
    /** The project open in the IDE (absolute). Paths in the tools' arguments are relative to it. */
    readonly root: string;
    /** The static folder of the project's XR analysis (absolute), or null when none has run yet. */
    readonly analysisDir: string | null;
}

/** The descriptions external agents see: the built-in agent's, saying where they come from. */
export function mcpDescription(query: AnalysisQuery): string {
    return `[Code-XR] ${query.description}`;
}

/** The zod shape the SDK wants, built from the query's JSON Schema so both surfaces stay identical. */
function inputShape(query: AnalysisQuery): Record<string, z.ZodType> {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, property] of Object.entries(query.parameters.properties)) {
        shape[key] = (property.type === 'integer' ? z.number().int() : z.string()).optional().describe(property.description);
    }
    return shape;
}

/** Parses `--root <dir> --analysis <dir>`; an empty analysis argument means "no analysis yet". */
export function parseArgs(argv: readonly string[]): CodexrMcpOptions {
    const value = (flag: string): string | undefined => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    const root = value('--root');
    if (!root || !path.isAbsolute(root)) {
        throw new Error('--root must be an absolute path.');
    }
    const analysis = value('--analysis') ?? '';
    if (analysis && !path.isAbsolute(analysis)) {
        throw new Error('--analysis must be an absolute path or empty.');
    }
    return { root: path.resolve(root), analysisDir: analysis ? path.resolve(analysis) : null };
}

export function createCodexrMcpServer(options: CodexrMcpOptions): McpServer {
    const server = new McpServer(
        { name: CODEXR_MCP_NAME, title: 'Code-XR analysis', version: CODEXR_MCP_VERSION },
        { instructions: `Read-only Code-XR code metrics of the project at ${options.root}: per-file metrics, complexity hot spots, the dependency graph and the Git evolution, from the analysis the person ran in the Code-XR IDE. Paths are relative to the project root.` },
    );
    for (const query of ANALYSIS_QUERIES) {
        server.registerTool(query.name, {
            title: query.title,
            description: mcpDescription(query),
            inputSchema: inputShape(query),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, async (args: Record<string, unknown>) => {
            try {
                if (!options.analysisDir) {
                    throw new Error(NO_ANALYSIS);
                }
                return { content: [{ type: 'text' as const, text: await query.run(args, options.analysisDir) }] };
            } catch (error) {
                return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
            }
        });
    }
    return server;
}
