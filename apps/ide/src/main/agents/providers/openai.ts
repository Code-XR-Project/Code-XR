import type { ModelInfo } from '../../../shared/agents.ts';
import { parseJson, readSse, send } from './http.ts';
import type { AdapterOptions, ChatEvent, ChatMessage, ChatRequest, FetchLike, ProviderAdapter, StopReason } from './types.ts';

/**
 * OpenAI Chat Completions (https://platform.openai.com/docs/api-reference/chat/streaming).
 * The same protocol serves OpenAI, OpenRouter, Nous Portal and local servers
 * such as Ollama or LM Studio; only the endpoint, the key and a few headers change.
 */
export class OpenAiAdapter implements ProviderAdapter {
    private readonly baseUrl: string;
    private readonly apiKey: string | undefined;
    private readonly fetchImpl: FetchLike;
    private readonly retryDelayMs: number;
    private readonly extraHeaders: Readonly<Record<string, string>>;

    constructor(options: AdapterOptions, extraHeaders: Readonly<Record<string, string>> = {}) {
        this.baseUrl = options.baseUrl;
        this.apiKey = options.apiKey;
        this.fetchImpl = options.fetch ?? fetch;
        this.retryDelayMs = options.retryDelayMs ?? 1000;
        this.extraHeaders = extraHeaders;
    }

    private headers(): Record<string, string> {
        return { ...this.extraHeaders, ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) };
    }

    async listModels(signal?: AbortSignal): Promise<readonly ModelInfo[]> {
        const response = await send(this.fetchImpl, { url: `${this.baseUrl}/models`, method: 'GET', headers: this.headers(), signal }, this.retryDelayMs);
        const body = (await response.json()) as { data?: Array<{ id?: unknown; name?: unknown }> };
        return (body.data ?? [])
            .filter((model): model is { id: string; name?: unknown } => typeof model.id === 'string')
            .map((model) => ({ id: model.id, label: typeof model.name === 'string' ? model.name : model.id }))
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    async *stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
        const body: Record<string, unknown> = {
            model: request.model,
            messages: toOpenAiMessages(request.system, request.messages),
            stream: true,
            stream_options: { include_usage: true },
        };
        if (request.maxTokens !== undefined) {
            body['max_tokens'] = request.maxTokens;
        }
        if (request.temperature !== undefined) {
            body['temperature'] = request.temperature;
        }
        if (request.tools && request.tools.length > 0) {
            body['tools'] = request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
        }
        const response = await send(this.fetchImpl, { url: `${this.baseUrl}/chat/completions`, method: 'POST', headers: this.headers(), body, signal }, this.retryDelayMs);

        // Tool calls arrive in fragments keyed by `index`; emit them once the answer ends.
        const calls = new Map<number, { id: string; name: string; arguments: string }>();
        let stopReason: StopReason = 'other';
        let usage: { inputTokens: number; outputTokens: number } | undefined;
        for await (const message of readSse(response.body, signal)) {
            if (message.data === '[DONE]') {
                break;
            }
            const data = parseJson(message.data);
            const reported = data['usage'] as { prompt_tokens?: number; completion_tokens?: number } | null | undefined;
            if (reported) {
                usage = { inputTokens: reported.prompt_tokens ?? 0, outputTokens: reported.completion_tokens ?? 0 };
            }
            const choice = (data['choices'] as Array<Record<string, unknown>> | undefined)?.[0];
            if (!choice) {
                continue;
            }
            const delta = choice['delta'] as { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } | undefined;
            if (delta?.content) {
                yield { type: 'text', text: delta.content };
            }
            for (const fragment of delta?.tool_calls ?? []) {
                const index = fragment.index ?? 0;
                const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
                call.id ||= fragment.id ?? '';
                call.name += fragment.function?.name ?? '';
                call.arguments += fragment.function?.arguments ?? '';
                calls.set(index, call);
            }
            const finish = choice['finish_reason'];
            if (typeof finish === 'string') {
                stopReason = mapStop(finish);
            }
        }
        for (const [index, call] of [...calls].sort((a, b) => a[0] - b[0])) {
            yield { type: 'tool-call', call: { id: call.id || `call_${index}`, name: call.name, arguments: call.arguments || '{}' } };
        }
        if (usage) {
            yield { type: 'usage', ...usage };
        }
        yield { type: 'done', stopReason };
    }
}

function mapStop(reason: string): StopReason {
    switch (reason) {
        case 'stop':
            return 'end';
        case 'tool_calls':
        case 'function_call':
            return 'tool-calls';
        case 'length':
            return 'max-tokens';
        default:
            return 'other';
    }
}

export function toOpenAiMessages(system: string | undefined, messages: readonly ChatMessage[]): unknown[] {
    const out: unknown[] = system ? [{ role: 'system', content: system }] : [];
    for (const message of messages) {
        if (message.role === 'user') {
            out.push({ role: 'user', content: message.content });
        } else if (message.role === 'tool') {
            out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
        } else {
            const toolCalls = message.toolCalls ?? [];
            out.push({
                role: 'assistant',
                content: message.content || (toolCalls.length > 0 ? null : ''),
                ...(toolCalls.length > 0
                    ? { tool_calls: toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }
                    : {}),
            });
        }
    }
    return out;
}
