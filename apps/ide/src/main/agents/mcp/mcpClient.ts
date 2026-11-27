/**
 * A minimal Model Context Protocol client (A12): JSON-RPC 2.0 over a
 * transport, with only what agents need: the initialize handshake,
 * `tools/list` and `tools/call`. Resources, prompts and sampling are not
 * offered, so a server never gets to call back into a model.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 30_000;
export const CALL_TIMEOUT_MS = 300_000;

export interface JsonRpcMessage {
    readonly jsonrpc: '2.0';
    readonly id?: number | string | null;
    readonly method?: string;
    readonly params?: unknown;
    readonly result?: unknown;
    readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** Carries JSON-RPC messages to one server and back. */
export interface McpTransport {
    /** Called once, before any send. */
    start(onMessage: (message: JsonRpcMessage) => void, onClose: (reason: string) => void): Promise<void>;
    send(message: JsonRpcMessage): Promise<void>;
    close(): Promise<void>;
}

/** A tool as the server describes it. */
export interface McpToolDescription {
    readonly name: string;
    readonly title?: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
}

interface Pending {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

export class McpClient {
    private readonly transport: McpTransport;
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    private closedReason: string | null = null;
    /** The server's name and version, from initialize. */
    serverInfo = '';

    constructor(transport: McpTransport) {
        this.transport = transport;
    }

    get closed(): boolean {
        return this.closedReason !== null;
    }

    async connect(): Promise<void> {
        await this.transport.start((message) => this.receive(message), (reason) => this.fail(reason));
        const result = await this.request('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'code-xr-ide', version: '1.0.0' },
        }) as { serverInfo?: { name?: unknown; version?: unknown } } | null;
        const info = result?.serverInfo;
        this.serverInfo = [info?.name, info?.version].filter((part) => typeof part === 'string' && part).join(' ');
        await this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }

    async listTools(): Promise<readonly McpToolDescription[]> {
        const tools: McpToolDescription[] = [];
        let cursor: string | undefined;
        // A server that pages forever is cut off at 20 pages.
        for (let page = 0; page < 20; page++) {
            const result = await this.request('tools/list', cursor ? { cursor } : {}) as { tools?: unknown; nextCursor?: unknown } | null;
            for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
                const parsed = parseTool(tool);
                if (parsed) {
                    tools.push(parsed);
                }
            }
            cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
            if (!cursor) {
                break;
            }
        }
        return tools;
    }

    /** Runs a tool; resolves with its text, or throws its error text. */
    async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
        const result = await this.request('tools/call', { name, arguments: args }, { timeoutMs: CALL_TIMEOUT_MS, signal }) as { content?: unknown; structuredContent?: unknown; isError?: unknown } | null;
        const text = contentText(result);
        if (result?.isError === true) {
            throw new Error(text || `${name} failed.`);
        }
        return text || '(no output)';
    }

    async close(): Promise<void> {
        this.fail('Closed.');
        await this.transport.close().catch(() => undefined);
    }

    private request(method: string, params: unknown, options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<unknown> {
        if (this.closedReason !== null) {
            return Promise.reject(new Error(this.closedReason));
        }
        const id = this.nextId++;
        return new Promise<unknown>((resolve, reject) => {
            const onAbort = (): void => {
                settle();
                void this.transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Stopped by the person.' } }).catch(() => undefined);
                reject(new Error('Stopped.'));
            };
            const settle = (): void => {
                clearTimeout(timer);
                this.pending.delete(id);
                options.signal?.removeEventListener('abort', onAbort);
            };
            const timer = setTimeout(() => {
                settle();
                reject(new Error(`The MCP server did not answer ${method} in ${Math.round((options.timeoutMs ?? REQUEST_TIMEOUT_MS) / 1000)}s.`));
            }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
            this.pending.set(id, {
                resolve: (value) => {
                    settle();
                    resolve(value);
                },
                reject: (error) => {
                    settle();
                    reject(error);
                },
                timer,
            });
            if (options.signal?.aborted) {
                onAbort();
                return;
            }
            options.signal?.addEventListener('abort', onAbort, { once: true });
            this.transport.send({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
                this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
            });
        });
    }

    private receive(message: JsonRpcMessage): void {
        if (message.method !== undefined) {
            if (message.id !== undefined && message.id !== null) {
                // A request from the server: answer ping, refuse the rest (no sampling, no roots).
                const reply: JsonRpcMessage = message.method === 'ping'
                    ? { jsonrpc: '2.0', id: message.id, result: {} }
                    : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `${message.method} is not supported by Code-XR IDE.` } };
                void this.transport.send(reply).catch(() => undefined);
            }
            return;
        }
        if (typeof message.id !== 'number') {
            return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
            return;
        }
        if (message.error) {
            pending.reject(new Error(typeof message.error.message === 'string' && message.error.message ? message.error.message : 'The MCP server returned an error.'));
        } else {
            pending.resolve(message.result ?? null);
        }
    }

    private fail(reason: string): void {
        if (this.closedReason !== null) {
            return;
        }
        this.closedReason = reason;
        for (const pending of [...this.pending.values()]) {
            pending.reject(new Error(reason));
        }
        this.pending.clear();
    }
}

function parseTool(value: unknown): McpToolDescription | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (typeof record['name'] !== 'string' || !record['name']) {
        return null;
    }
    const schema = record['inputSchema'];
    return {
        name: record['name'],
        ...(typeof record['title'] === 'string' && record['title'] ? { title: record['title'] } : {}),
        description: typeof record['description'] === 'string' ? record['description'] : '',
        inputSchema: schema && typeof schema === 'object' && !Array.isArray(schema) ? schema as Record<string, unknown> : { type: 'object', properties: {} },
    };
}

/** A tool result as text: its text blocks, a note for each other block, or its structured content. */
export function contentText(result: { content?: unknown; structuredContent?: unknown } | null): string {
    const parts: string[] = [];
    for (const block of Array.isArray(result?.content) ? result.content : []) {
        if (!block || typeof block !== 'object') {
            continue;
        }
        const item = block as Record<string, unknown>;
        if (item['type'] === 'text' && typeof item['text'] === 'string') {
            parts.push(item['text']);
        } else if (item['type'] === 'resource' && item['resource'] && typeof item['resource'] === 'object') {
            const resource = item['resource'] as Record<string, unknown>;
            parts.push(typeof resource['text'] === 'string' ? resource['text'] : `[resource ${String(resource['uri'] ?? '')}]`);
        } else if (item['type'] === 'resource_link') {
            parts.push(`[resource ${String(item['uri'] ?? '')}]`);
        } else if (typeof item['type'] === 'string') {
            parts.push(`[${item['type']} content left out]`);
        }
    }
    if (parts.length === 0 && result?.structuredContent !== undefined) {
        parts.push(JSON.stringify(result.structuredContent, null, 2));
    }
    return parts.join('\n');
}
