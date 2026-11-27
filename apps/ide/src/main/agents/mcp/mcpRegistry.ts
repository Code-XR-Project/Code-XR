import { randomUUID } from 'node:crypto';
import type { McpServerInput, McpServerStatus, McpServerView, McpTransport as TransportKind, ToolInfo } from '../../../shared/agents.ts';
import type { JsonKeyValueStore } from '../../core/jsonStore.ts';
import type { KeyVault } from '../keyVault.ts';
import { clip, type AgentTool } from '../tools/toolTypes.ts';
import { McpClient, type McpToolDescription, type McpTransport } from './mcpClient.ts';
import { httpTransport, stdioTransport, type Fetch, type SpawnProcess } from './mcpTransports.ts';

/**
 * The person's MCP servers (A12): their settings (tokens in the OS secret
 * store, under `mcp:<id>`), one connection each, and their tools exposed to
 * agents as `mcp__<server>__<tool>`, all with risk `network` so every call
 * goes through the approval card. Nothing connects at start-up: a server is
 * contacted when it is saved or refreshed, and when an agent calls one of its
 * tools. A local command only ever runs after the person confirmed that
 * exact command line.
 */

const KEY = 'servers';
const MAX_SERVERS = 32;
const MAX_ARGS = 64;
const MAX_TEXT = 2000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

interface StoredServer {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly transport: TransportKind;
    readonly command: string;
    readonly args: readonly string[];
    readonly url: string;
    readonly enabled: boolean;
    /** The tools as last listed, so agent forms show them without connecting. */
    readonly tools: readonly McpToolDescription[];
}

interface Connection {
    status: McpServerStatus;
    error?: string;
    client?: McpClient;
    connecting?: Promise<McpClient>;
}

export interface McpRegistryOptions {
    readonly store: JsonKeyValueStore;
    readonly vault: KeyVault;
    /** Asks the person before a new or changed local command is saved; resolves true to go on. */
    confirmCommand(server: { readonly name: string; readonly commandLine: string }): Promise<boolean>;
    /** Where stdio servers start, and their environment. */
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly spawn?: SpawnProcess;
    readonly fetch?: Fetch;
    /** Builds the transport; tests replace it. */
    readonly transport?: (server: StoredServer, token: () => string | undefined) => McpTransport;
}

export class McpRegistry {
    private readonly options: McpRegistryOptions;
    private readonly connections = new Map<string, Connection>();

    constructor(options: McpRegistryOptions) {
        this.options = options;
    }

    list(): readonly McpServerView[] {
        return this.stored().map((server) => this.view(server));
    }

    async save(input: unknown, id?: unknown): Promise<McpServerView> {
        const servers = this.stored();
        const existing = id === undefined || id === null ? undefined : servers.find((server) => server.id === id);
        if (id !== undefined && id !== null && !existing) {
            throw new Error('Unknown MCP server.');
        }
        if (!existing && servers.length >= MAX_SERVERS) {
            throw new Error(`At most ${MAX_SERVERS} MCP servers.`);
        }
        const parsed = parseInput(input);
        if (parsed.transport === 'stdio' && (!existing || existing.transport !== 'stdio' || commandLine(existing) !== commandLine(parsed))) {
            const confirmed = await this.options.confirmCommand({ name: parsed.name, commandLine: commandLine(parsed) });
            if (!confirmed) {
                throw new Error('Cancelled: the command was not approved.');
            }
        }
        const serverId = existing?.id ?? randomUUID();
        const sameEndpoint = existing !== undefined && existing.transport === parsed.transport && commandLine(existing) === commandLine(parsed) && existing.url === parsed.url;
        const server: StoredServer = {
            id: serverId,
            name: parsed.name,
            slug: uniqueSlug(parsed.name, servers.filter((other) => other.id !== serverId)),
            transport: parsed.transport,
            command: parsed.command,
            args: parsed.args,
            url: parsed.url,
            enabled: parsed.enabled,
            tools: sameEndpoint ? existing.tools : [],
        };
        if (parsed.token !== undefined) {
            await this.options.vault.set(`mcp:${serverId}`, parsed.transport === 'http' ? parsed.token : '');
        } else if (parsed.transport !== 'http') {
            await this.options.vault.delete(`mcp:${serverId}`);
        }
        await this.write(existing ? servers.map((other) => (other.id === serverId ? server : other)) : [...servers, server]);
        await this.disconnect(serverId);
        return server.enabled ? this.refresh(serverId) : this.view(server);
    }

    async remove(id: unknown): Promise<void> {
        const servers = this.stored();
        if (!servers.some((server) => server.id === id)) {
            return;
        }
        await this.disconnect(String(id));
        this.connections.delete(String(id));
        await this.options.vault.delete(`mcp:${String(id)}`);
        await this.write(servers.filter((server) => server.id !== id));
    }

    /** Reconnects and lists the tools again; a failure is shown on the server, not thrown. */
    async refresh(id: unknown): Promise<McpServerView> {
        const server = this.stored().find((candidate) => candidate.id === id);
        if (!server) {
            throw new Error('Unknown MCP server.');
        }
        await this.disconnect(server.id);
        if (!server.enabled) {
            return this.view(server);
        }
        try {
            const client = await this.client(server);
            const tools = await client.listTools();
            const latest = this.stored();
            await this.write(latest.map((other) => (other.id === server.id ? { ...other, tools } : other)));
        } catch (failure) {
            this.setFailed(server.id, failure);
        }
        return this.view(this.stored().find((candidate) => candidate.id === server.id) ?? server);
    }

    /** The tools of every enabled server, as agent tools. */
    tools(): readonly AgentTool[] {
        const result: AgentTool[] = [];
        for (const server of this.stored()) {
            if (server.enabled) {
                for (const tool of server.tools) {
                    result.push(this.agentTool(server, tool));
                }
            }
        }
        return result;
    }

    /** Stops every server process and closes every connection (on quit). */
    async closeAll(): Promise<void> {
        await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
    }

    private agentTool(server: StoredServer, tool: McpToolDescription): AgentTool {
        const target = server.transport === 'stdio' ? commandLine(server) : server.url;
        return {
            name: agentToolName(server.slug, tool.name),
            title: `${tool.title ?? tool.name} (${server.name})`,
            description: `[MCP server "${server.name}"] ${tool.description}`.slice(0, 1024),
            risk: 'network',
            parameters: { type: 'object', properties: {}, ...tool.inputSchema },
            preview: (args) => ({
                summary: `${server.name}: ${tool.name}`,
                detail: clip(`MCP server "${server.name}" (${target})\ntool: ${tool.name}\n\narguments:\n${JSON.stringify(args, null, 2)}`, MAX_TEXT),
            }),
            run: async (args, context) => {
                const current = this.stored().find((candidate) => candidate.id === server.id);
                if (!current || !current.enabled) {
                    throw new Error(`The MCP server "${server.name}" was removed or turned off.`);
                }
                try {
                    const client = await this.client(current);
                    return clip(await client.callTool(tool.name, args, context.signal));
                } catch (failure) {
                    if (this.connections.get(server.id)?.client?.closed) {
                        this.setFailed(server.id, failure);
                    }
                    throw failure;
                }
            },
        };
    }

    /** The open connection, or a new one. */
    private client(server: StoredServer): Promise<McpClient> {
        const connection = this.connections.get(server.id) ?? { status: 'stopped' };
        this.connections.set(server.id, connection);
        if (connection.client && !connection.client.closed) {
            return Promise.resolve(connection.client);
        }
        if (connection.connecting) {
            return connection.connecting;
        }
        connection.status = 'connecting';
        delete connection.error;
        const token = (): string | undefined => this.options.vault.get(`mcp:${server.id}`);
        const transport = this.options.transport?.(server, token) ?? (server.transport === 'stdio'
            ? stdioTransport(server.command, server.args, { cwd: this.options.cwd, env: this.options.env, ...(this.options.spawn ? { spawn: this.options.spawn } : {}) })
            : httpTransport(server.url, token, this.options.fetch));
        const client = new McpClient(transport);
        connection.connecting = client.connect().then(() => {
            connection.client = client;
            connection.status = 'ready';
            return client;
        }, async (failure: unknown) => {
            await client.close();
            throw failure;
        }).finally(() => {
            delete connection.connecting;
        });
        return connection.connecting;
    }

    private setFailed(id: string, failure: unknown): void {
        const connection = this.connections.get(id) ?? { status: 'error' };
        connection.status = 'error';
        connection.error = (failure instanceof Error ? failure.message : String(failure)).slice(0, 500);
        this.connections.set(id, connection);
    }

    private async disconnect(id: string): Promise<void> {
        const connection = this.connections.get(id);
        if (!connection) {
            return;
        }
        const client = connection.client ?? await connection.connecting?.catch(() => undefined);
        delete connection.client;
        connection.status = 'stopped';
        delete connection.error;
        await client?.close();
    }

    private view(server: StoredServer): McpServerView {
        const connection = this.connections.get(server.id);
        const status: McpServerStatus = connection?.client?.closed && connection.status === 'ready' ? 'stopped' : connection?.status ?? 'stopped';
        const tools: ToolInfo[] = server.tools.map((tool) => {
            const agentTool = this.agentTool(server, tool);
            return { name: agentTool.name, title: agentTool.title, description: tool.description, risk: agentTool.risk };
        });
        return {
            id: server.id,
            name: server.name,
            transport: server.transport,
            command: server.command,
            args: server.args,
            url: server.url,
            hasToken: this.options.vault.storageOf(`mcp:${server.id}`) !== 'none',
            enabled: server.enabled,
            status,
            ...(connection?.error ? { error: connection.error } : {}),
            tools,
        };
    }

    private stored(): readonly StoredServer[] {
        const value = this.options.store.get<unknown>(KEY, []);
        return Array.isArray(value) ? value.filter(isStored) : [];
    }

    private write(servers: readonly StoredServer[]): Promise<void> {
        return this.options.store.update(KEY, servers);
    }
}

/** The exact command line the person approves. */
export function commandLine(server: { readonly command: string; readonly args: readonly string[] }): string {
    return [server.command, ...server.args].map((part) => (/[\s"']/.test(part) || !part ? JSON.stringify(part) : part)).join(' ');
}

/** `mcp__<server>__<tool>` within the providers' 64-character name rule. */
export function agentToolName(slug: string, tool: string): string {
    const name = `mcp__${slug}__${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
    return TOOL_NAME.test(name) ? name : `mcp__${slug}__tool`;
}

function uniqueSlug(name: string, others: readonly StoredServer[]): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'server';
    const taken = new Set(others.map((server) => server.slug));
    let slug = base;
    for (let index = 2; taken.has(slug); index++) {
        slug = `${base}-${index}`;
    }
    return slug;
}

interface ParsedInput {
    readonly name: string;
    readonly transport: TransportKind;
    readonly command: string;
    readonly args: readonly string[];
    readonly url: string;
    readonly token?: string;
    readonly enabled: boolean;
}

function parseInput(input: unknown): ParsedInput {
    if (!input || typeof input !== 'object') {
        throw new Error('Invalid MCP server.');
    }
    const record = input as Partial<Record<keyof McpServerInput, unknown>>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name || name.length > 60) {
        throw new Error('Give the server a name (up to 60 characters).');
    }
    const transport = record.transport;
    if (transport !== 'stdio' && transport !== 'http') {
        throw new Error('Invalid transport.');
    }
    const enabled = record.enabled !== false;
    const token = typeof record.token === 'string' ? record.token.trim().slice(0, 4096) : undefined;
    if (transport === 'stdio') {
        const command = typeof record.command === 'string' ? record.command.trim() : '';
        const args = record.args ?? [];
        if (!command || command.length > MAX_TEXT || command.includes('\0')) {
            throw new Error('Give the command that starts the server, e.g. npx.');
        }
        if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((arg) => typeof arg !== 'string' || arg.length > MAX_TEXT || arg.includes('\0'))) {
            throw new Error('Invalid arguments.');
        }
        return { name, transport, command, args: args as string[], url: '', enabled };
    }
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('Give the server URL, e.g. https://example.com/mcp.');
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
        throw new Error('The URL must be https (plain http only on this computer).');
    }
    if (parsed.username || parsed.password) {
        throw new Error('Put the token in its own field, not in the URL.');
    }
    return { name, transport, command: '', args: [], url: parsed.toString(), ...(token !== undefined ? { token } : {}), enabled };
}

function isLoopback(host: string): boolean {
    return host === 'localhost' || host === '[::1]' || /^127\./.test(host);
}

function isStored(value: unknown): value is StoredServer {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record['id'] === 'string' && typeof record['name'] === 'string' && typeof record['slug'] === 'string'
        && (record['transport'] === 'stdio' || record['transport'] === 'http') && typeof record['command'] === 'string'
        && Array.isArray(record['args']) && typeof record['url'] === 'string' && typeof record['enabled'] === 'boolean' && Array.isArray(record['tools']);
}
