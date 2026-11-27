import { ANALYSIS_QUERIES, NO_ANALYSIS } from './analysisQueries.ts';
import type { AgentTool, ToolContext } from './toolTypes.ts';

/**
 * Code-XR's analyses as tools of the built-in agent (A10). The queries
 * themselves live in analysisQueries.ts, shared with the Code-XR MCP server
 * that external agents get (AF10); this file only binds them to the window:
 * the analysis folder comes from the ToolContext, and every query is a
 * read-only tool, so it never needs an approval.
 */

export { dependenciesReport, evolutionReport, hotspotsReport, metricsReport } from './analysisQueries.ts';

function outputRoot(context: ToolContext): string {
    if (!context.workspace) {
        throw new Error('No folder is open in the IDE.');
    }
    const root = context.analysisOutput?.() ?? null;
    if (!root) {
        throw new Error(NO_ANALYSIS);
    }
    return root;
}

export const ANALYSIS_TOOLS: readonly AgentTool[] = ANALYSIS_QUERIES.map((query): AgentTool => ({
    name: query.name,
    title: query.title,
    description: query.description,
    risk: 'read',
    parameters: query.parameters,
    preview: (args) => ({ summary: query.summary(args) }),
    // async, so a missing folder rejects like every other tool failure instead of throwing.
    run: async (args, context) => query.run(args, outputRoot(context)),
}));
