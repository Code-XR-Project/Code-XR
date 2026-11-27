import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { listLocalModels, unreachableMessage, type FetchFn } from '@codexr/local-models/discovery.ts';
import { isLocalServerId } from '@codexr/local-models/servers.ts';
import type { ChatEvent, ChatRequest, ModelClient } from '@codexr/local-models/agentLoop.ts';
import { OpenAiAdapter } from '../main/agents/providers/openai.ts';
import { ProviderError } from '../main/agents/providers/types.ts';
import { McpClient } from '../main/agents/mcp/mcpClient.ts';
import { stdioTransport } from '../main/agents/mcp/mcpTransports.ts';
import { createLocalAgent, type McpLink } from './localAgent.ts';

/**
 * Entry of the local-model agent (#312), bundled on its own into
 * out/localAgent/index.cjs and started by the IDE per chat with its own
 * binary in Node mode (ELECTRON_RUN_AS_NODE=1). Its configuration comes in the
 * environment the IDE builds (agentCatalog.ts): the key, when there is one,
 * never appears on a command line, and it is removed from this process's
 * environment before any child (an MCP server) can inherit it.
 *
 *   CODEXR_LOCAL_AGENT_NAME, CODEXR_LOCAL_BASE_URL, CODEXR_LOCAL_MODEL,
 *   CODEXR_LOCAL_SERVER (a preset id), CODEXR_LOCAL_API_KEY (optional)
 *
 * stdout carries ACP; diagnostics go to stderr only.
 */

function takeEnv(name: string): string {
    const value = process.env[name] ?? '';
    delete process.env[name];
    return value.trim();
}

const name = takeEnv('CODEXR_LOCAL_AGENT_NAME') || 'Local model';
const baseUrl = takeEnv('CODEXR_LOCAL_BASE_URL');
const model = takeEnv('CODEXR_LOCAL_MODEL');
const server = takeEnv('CODEXR_LOCAL_SERVER');
const apiKey = takeEnv('CODEXR_LOCAL_API_KEY') || undefined;
const serverId = isLocalServerId(server) ? server : undefined;

const log = (line: string): void => {
    process.stderr.write(`[code-xr-local-agent] ${line}\n`);
};

if (!baseUrl || !model) {
    log('Missing CODEXR_LOCAL_BASE_URL or CODEXR_LOCAL_MODEL.');
    process.exit(2);
}

const adapter = new OpenAiAdapter({ baseUrl, apiKey });

/** The adapter, with "could not reach the provider" told in local-server words. */
const client: ModelClient = {
    async *stream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
        try {
            yield* adapter.stream(request, signal);
        } catch (error) {
            if (error instanceof ProviderError && error.kind === 'network') {
                throw new Error(unreachableMessage(baseUrl, serverId, error.message.replace(/^Could not reach the provider: /, '')));
            }
            if (error instanceof ProviderError && error.kind === 'not-found') {
                throw new Error(`The server does not know the model ${request.model}. Pick another one in the model menu, or pull it first (Ollama: ollama pull ${request.model}).`);
            }
            throw error;
        }
    },
};

const fetchFn: FetchFn = (input, init) => fetch(input, init);

const agentApp = createLocalAgent({ name, baseUrl, model, ...(serverId ? { serverId } : {}) }, {
    client,
    async listModels() {
        const result = await listLocalModels(baseUrl, { fetch: fetchFn, apiKey, ...(serverId ? { serverId } : {}) });
        if (!result.ok) {
            throw new Error(result.error);
        }
        return result.models.map((entry) => entry.id);
    },
    async connectMcp(spec, cwd): Promise<McpLink | null> {
        // Only stdio servers: the IDE passes the Code-XR analysis that way (AF10).
        if (!('command' in spec) || typeof spec.command !== 'string') {
            return null;
        }
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
                env[key] = value;
            }
        }
        for (const pair of spec.env ?? []) {
            env[pair.name] = pair.value;
        }
        const mcp = new McpClient(stdioTransport(spec.command, spec.args ?? [], { cwd, env }));
        const timer = setTimeout(() => void mcp.close(), 20_000);
        try {
            await mcp.connect();
            const tools = await mcp.listTools();
            return {
                name: spec.name,
                tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
                callTool: (toolName, args, signal) => mcp.callTool(toolName, args, signal),
                close: () => mcp.close(),
            };
        } finally {
            clearTimeout(timer);
        }
    },
    log,
});

const connection = agentApp.connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
void connection.closed.then(() => process.exit(0));
