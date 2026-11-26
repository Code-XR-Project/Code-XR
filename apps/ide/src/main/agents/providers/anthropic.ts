import type { ModelInfo } from '../../../shared/agents.ts';
import { parseJson, readSse, send } from './http.ts';
import { ProviderError, type AdapterOptions, type ChatEvent, type ChatMessage, type ChatRequest, type FetchLike, type ProviderAdapter, type StopReason } from './types.ts';

const API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

/** Anthropic Messages API (https://docs.anthropic.com/en/api/messages-streaming). */
export class AnthropicAdapter implements ProviderAdapter {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly fetchImpl: FetchLike;
    private readonly retryDelayMs: number;

    constructor(options: AdapterOptions) {
        if (!options.apiKey) {
            throw new ProviderError('auth', 'Anthropic needs an API key.');
        }
        this.baseUrl = options.baseUrl;
        this.apiKey = options.apiKey;
        this.fetchImpl = options.fetch ?? fetch;
        this.retryDelayMs = options.retryDelayMs ?? 1000;
    }

    private headers(): Record<string, string> {
        return { 'x-api-key': this.apiKey, 'anthropic-version': API_VERSION };
    }

    async listModels(signal?: AbortSignal): Promise<readonly ModelInfo[]> {
        const response = await send(this.fetchImpl, { url: `${this.baseUrl}/models?limit=100`, method: 'GET', headers: this.headers(), signal }, this.retryDelayMs);
        const body = (await response.json()) as { data?: Array<{ id?: unknown; display_name?: unknown }> };
        return (body.data ?? [])
            .filter((model): model is { id: string; display_name?: unknown } => typeof model.id === 'string')
            .map((model) => ({ id: model.id, label: typeof model.display_name === 'string' ? model.display_name : model.id }));
    }

    async *stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
        const body: Record<string, unknown> = {
            model: request.model,
            max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
            messages: toAnthropicMessages(request.messages),
            stream: true,
        };
        if (request.system) {
            body['system'] = request.system;
        }
        if (request.temperature !== undefined) {
            body['temperature'] = request.temperature;
        }
        if (request.tools && request.tools.length > 0) {
            body['tools'] = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
        }
        const response = await send(this.fetchImpl, { url: `${this.baseUrl}/messages`, method: 'POST', headers: this.headers(), body, signal }, this.retryDelayMs);

        const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
        let inputTokens = 0;
        let outputTokens = 0;
        let stopReason: StopReason = 'other';
        for await (const message of readSse(response.body, signal)) {
            if (message.event === 'ping') {
                continue;
            }
            const data = parseJson(message.data);
            switch (data['type']) {
                case 'message_start': {
                    const usage = (data['message'] as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined)?.usage;
                    inputTokens = usage?.input_tokens ?? 0;
                    outputTokens = usage?.output_tokens ?? 0;
                    break;
                }
                case 'content_block_start': {
                    const block = data['content_block'] as { type?: string; id?: string; name?: string } | undefined;
                    if (block?.type === 'tool_use') {
                        toolBlocks.set(Number(data['index']), { id: block.id ?? '', name: block.name ?? '', json: '' });
                    }
                    break;
                }
                case 'content_block_delta': {
                    const delta = data['delta'] as { type?: string; text?: string; partial_json?: string } | undefined;
                    if (delta?.type === 'text_delta' && delta.text) {
                        yield { type: 'text', text: delta.text };
                    } else if (delta?.type === 'input_json_delta') {
                        const block = toolBlocks.get(Number(data['index']));
                        if (block) {
                            block.json += delta.partial_json ?? '';
                        }
                    }
                    break;
                }
                case 'content_block_stop': {
                    const index = Number(data['index']);
                    const block = toolBlocks.get(index);
                    if (block) {
                        toolBlocks.delete(index);
                        yield { type: 'tool-call', call: { id: block.id, name: block.name, arguments: block.json || '{}' } };
                    }
                    break;
                }
                case 'message_delta': {
                    const delta = data['delta'] as { stop_reason?: string } | undefined;
                    stopReason = mapStop(delta?.stop_reason);
                    const usage = data['usage'] as { output_tokens?: number } | undefined;
                    if (usage?.output_tokens !== undefined) {
                        outputTokens = usage.output_tokens;
                    }
                    break;
                }
                case 'error': {
                    const error = data['error'] as { type?: string; message?: string } | undefined;
                    const kind = error?.type === 'overloaded_error' ? 'server' : error?.type === 'rate_limit_error' ? 'rate-limit' : 'server';
                    throw new ProviderError(kind, `Anthropic: ${error?.message ?? 'stream error'}`);
                }
                default:
                    break;
            }
        }
        yield { type: 'usage', inputTokens, outputTokens };
        yield { type: 'done', stopReason };
    }
}

function mapStop(reason: string | undefined): StopReason {
    switch (reason) {
        case 'end_turn':
        case 'stop_sequence':
            return 'end';
        case 'tool_use':
            return 'tool-calls';
        case 'max_tokens':
            return 'max-tokens';
        default:
            return 'other';
    }
}

/** Tool results go back as `tool_result` blocks inside a user turn; consecutive ones share that turn. */
export function toAnthropicMessages(messages: readonly ChatMessage[]): unknown[] {
    const out: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
    const push = (role: 'user' | 'assistant', block: unknown): void => {
        const last = out.at(-1);
        if (last && last.role === role) {
            last.content.push(block);
        } else {
            out.push({ role, content: [block] });
        }
    };
    for (const message of messages) {
        if (message.role === 'user') {
            push('user', { type: 'text', text: message.content });
        } else if (message.role === 'tool') {
            push('user', { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content, ...(message.isError ? { is_error: true } : {}) });
        } else {
            if (message.content) {
                push('assistant', { type: 'text', text: message.content });
            }
            for (const call of message.toolCalls ?? []) {
                push('assistant', { type: 'tool_use', id: call.id, name: call.name, input: parseArguments(call.arguments) });
            }
        }
    }
    return out;
}

export function parseArguments(text: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(text || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}
