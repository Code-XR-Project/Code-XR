import type { ModelInfo } from '../../../shared/agents.ts';

/**
 * The provider-neutral chat model of the agent hub (#A2). Every adapter turns
 * these into its own wire format and its streamed answer back into
 * `ChatEvent`s, so the rest of the IDE never sees a provider's JSON.
 */

export interface ToolCall {
    readonly id: string;
    readonly name: string;
    /** The arguments as the model wrote them: a JSON object in text. */
    readonly arguments: string;
}

export type ChatMessage =
    | { readonly role: 'user'; readonly content: string }
    | { readonly role: 'assistant'; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
    | { readonly role: 'tool'; readonly toolCallId: string; readonly toolName: string; readonly content: string; readonly isError?: boolean };

export interface ToolDefinition {
    readonly name: string;
    readonly description: string;
    /** JSON Schema of the arguments object. */
    readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ChatRequest {
    readonly model: string;
    readonly system?: string;
    readonly messages: readonly ChatMessage[];
    readonly tools?: readonly ToolDefinition[];
    readonly maxTokens?: number;
    readonly temperature?: number;
}

export type StopReason = 'end' | 'tool-calls' | 'max-tokens' | 'other';

export type ChatEvent =
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'tool-call'; readonly call: ToolCall }
    | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
    | { readonly type: 'done'; readonly stopReason: StopReason };

export interface ProviderAdapter {
    listModels(signal?: AbortSignal): Promise<readonly ModelInfo[]>;
    /** Streams one answer. Aborting `signal` cancels the HTTP request. */
    stream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>;
}

/** The `fetch` the adapters use, injectable so tests never reach the network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface AdapterOptions {
    readonly baseUrl: string;
    readonly apiKey: string | undefined;
    readonly fetch?: FetchLike;
    /** Delay between retries; tests pass 0. */
    readonly retryDelayMs?: number;
}

export type ProviderErrorKind = 'auth' | 'quota' | 'rate-limit' | 'not-found' | 'bad-request' | 'server' | 'network' | 'aborted';

/** A provider failure with a message fit to show the user. */
export class ProviderError extends Error {
    readonly kind: ProviderErrorKind;
    readonly status: number | undefined;

    constructor(kind: ProviderErrorKind, message: string, status?: number) {
        super(message);
        this.name = 'ProviderError';
        this.kind = kind;
        this.status = status;
    }
}
