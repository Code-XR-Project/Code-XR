import type { ModelInfo } from '../../../shared/agents.ts';
import { parseArguments } from './anthropic.ts';
import { parseJson, readSse, send } from './http.ts';
import { ProviderError, type AdapterOptions, type ChatEvent, type ChatMessage, type ChatRequest, type FetchLike, type ProviderAdapter, type StopReason } from './types.ts';

/** Google Gemini API (https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent). */
export class GeminiAdapter implements ProviderAdapter {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly fetchImpl: FetchLike;
    private readonly retryDelayMs: number;

    constructor(options: AdapterOptions) {
        if (!options.apiKey) {
            throw new ProviderError('auth', 'Gemini needs an API key.');
        }
        this.baseUrl = options.baseUrl;
        this.apiKey = options.apiKey;
        this.fetchImpl = options.fetch ?? fetch;
        this.retryDelayMs = options.retryDelayMs ?? 1000;
    }

    private headers(): Record<string, string> {
        // The key goes in a header, never in the URL, so it cannot end up in a log line.
        return { 'x-goog-api-key': this.apiKey };
    }

    async listModels(signal?: AbortSignal): Promise<readonly ModelInfo[]> {
        const response = await send(this.fetchImpl, { url: `${this.baseUrl}/models?pageSize=200`, method: 'GET', headers: this.headers(), signal }, this.retryDelayMs);
        const body = (await response.json()) as { models?: Array<{ name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown }> };
        return (body.models ?? [])
            .filter((model) => typeof model.name === 'string'
                && (!Array.isArray(model.supportedGenerationMethods) || model.supportedGenerationMethods.includes('generateContent')))
            .map((model) => {
                const id = String(model.name).replace(/^models\//, '');
                return { id, label: typeof model.displayName === 'string' ? model.displayName : id };
            });
    }

    async *stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
        const body: Record<string, unknown> = { contents: toGeminiContents(request.messages) };
        if (request.system) {
            body['systemInstruction'] = { parts: [{ text: request.system }] };
        }
        const generationConfig: Record<string, unknown> = {};
        if (request.maxTokens !== undefined) {
            generationConfig['maxOutputTokens'] = request.maxTokens;
        }
        if (request.temperature !== undefined) {
            generationConfig['temperature'] = request.temperature;
        }
        if (Object.keys(generationConfig).length > 0) {
            body['generationConfig'] = generationConfig;
        }
        if (request.tools && request.tools.length > 0) {
            body['tools'] = [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }];
        }
        const model = encodeURIComponent(request.model.replace(/^models\//, ''));
        const response = await send(this.fetchImpl, {
            url: `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`,
            method: 'POST',
            headers: this.headers(),
            body,
            signal,
        }, this.retryDelayMs);

        let stopReason: StopReason = 'other';
        let usage: { inputTokens: number; outputTokens: number } | undefined;
        let callCount = 0;
        for await (const message of readSse(response.body, signal)) {
            const data = parseJson(message.data);
            const metadata = data['usageMetadata'] as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
            if (metadata) {
                usage = { inputTokens: metadata.promptTokenCount ?? 0, outputTokens: metadata.candidatesTokenCount ?? 0 };
            }
            const candidate = (data['candidates'] as Array<Record<string, unknown>> | undefined)?.[0];
            const parts = (candidate?.['content'] as { parts?: Array<{ text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown; id?: string } }> } | undefined)?.parts ?? [];
            for (const part of parts) {
                if (part.functionCall) {
                    callCount += 1;
                    yield {
                        type: 'tool-call',
                        call: { id: part.functionCall.id ?? `call_${callCount}`, name: part.functionCall.name ?? '', arguments: JSON.stringify(part.functionCall.args ?? {}) },
                    };
                } else if (part.text && !part.thought) {
                    yield { type: 'text', text: part.text };
                }
            }
            const finish = candidate?.['finishReason'];
            if (typeof finish === 'string') {
                stopReason = callCount > 0 ? 'tool-calls' : finish === 'STOP' ? 'end' : finish === 'MAX_TOKENS' ? 'max-tokens' : 'other';
            }
        }
        if (usage) {
            yield { type: 'usage', ...usage };
        }
        yield { type: 'done', stopReason };
    }
}

/** Gemini calls the assistant `model`; tool results are `functionResponse` parts in a user turn. */
export function toGeminiContents(messages: readonly ChatMessage[]): unknown[] {
    const out: Array<{ role: 'user' | 'model'; parts: unknown[] }> = [];
    const push = (role: 'user' | 'model', part: unknown): void => {
        const last = out.at(-1);
        if (last && last.role === role) {
            last.parts.push(part);
        } else {
            out.push({ role, parts: [part] });
        }
    };
    for (const message of messages) {
        if (message.role === 'user') {
            push('user', { text: message.content });
        } else if (message.role === 'tool') {
            push('user', { functionResponse: { name: message.toolName, response: { [message.isError ? 'error' : 'result']: message.content } } });
        } else {
            if (message.content) {
                push('model', { text: message.content });
            }
            for (const call of message.toolCalls ?? []) {
                push('model', { functionCall: { name: call.name, args: parseArguments(call.arguments) } });
            }
        }
    }
    return out;
}
