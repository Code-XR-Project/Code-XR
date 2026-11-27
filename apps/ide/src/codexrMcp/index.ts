import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCodexrMcpServer, parseArgs } from './server.ts';

/**
 * Entry of the Code-XR MCP server (AF10), bundled on its own into
 * out/codexrMcp/index.cjs. The IDE hands it to each external agent in ACP
 * `session/new` as a stdio server run by the IDE's own binary with
 * ELECTRON_RUN_AS_NODE=1, so no system Node is needed:
 *
 *   <code-xr-ide> out/codexrMcp/index.cjs --root <project> --analysis <dir>
 *
 * stdout carries the protocol; diagnostics go to stderr only.
 */

async function main(): Promise<void> {
    const server = createCodexrMcpServer(parseArgs(process.argv.slice(2)));
    await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
    process.stderr.write(`[code-xr-mcp] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
