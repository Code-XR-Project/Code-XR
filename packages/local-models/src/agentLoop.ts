/**
 * The host-neutral agent loop of a local model (epic #310, LM2): send the
 * conversation, stream the answer, run the tools the model asks for, feed
 * their results back, repeat until the model answers without a tool call.
 *
 * It knows nothing of ACP, Electron or VS Code: the model client, the tools
 * and the way events are shown are all handed in. The shapes below are the
 * same as the Code-XR IDE's provider adapters (src/main/agents/providers), so
 * an IDE adapter is a `ModelClient` as it is.
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

export type ChatEvent =
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'tool-call'; readonly call: ToolCall }
    | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number; readonly cost?: number }
    | { readonly type: 'done'; readonly stopReason: 'end' | 'tool-calls' | 'max-tokens' | 'other' };

export interface ModelClient {
    stream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>;
}

export interface ToolResult {
    readonly content: string;
    readonly isError?: boolean;
}

/** What runs the tools: the host decides how (ACP requests, VS Code APIs...). */
export interface ToolHost {
    definitions(): readonly ToolDefinition[];
    run(call: ToolCall, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
}

export interface LoopEvents {
    onText(text: string): void | Promise<void>;
    onUsage?(inputTokens: number, outputTokens: number): void;
    /** The model was asked again without tools because the server said it cannot use them. */
    onToolsUnsupported?(): void | Promise<void>;
}

export type LoopStop = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'cancelled';

export interface LoopOptions {
    readonly client: ModelClient;
    readonly model: string;
    readonly system: string;
    /** The conversation so far; the loop appends to it in place. */
    readonly history: ChatMessage[];
    readonly tools: ToolHost;
    /** False once the server said this model cannot call tools; the loop sets it. */
    readonly toolsEnabled: { value: boolean };
    readonly events: LoopEvents;
    readonly signal: AbortSignal;
    /** How many model requests one prompt may make (each tool round is one). */
    readonly maxSteps?: number;
    readonly temperature?: number;
}

export const DEFAULT_MAX_STEPS = 40;
/** What a tool result may weigh in the conversation: local models have small contexts. */
export const MAX_TOOL_RESULT_CHARS = 24_000;

/** True when a server refused a request because the model has no tool support. */
export function isToolsUnsupportedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /does not support tools|tools? (are|is) not supported|tool[_ ]?choice|function calling is not (enabled|supported)|--jinja|enable-auto-tool-choice/i.test(message);
}

/** Cuts a long tool result, keeping its start and end. */
export function clampToolResult(text: string, max = MAX_TOOL_RESULT_CHARS): string {
    if (text.length <= max) {
        return text;
    }
    const head = Math.floor(max * 0.7);
    const tail = max - head;
    return `${text.slice(0, head)}\n\n[... ${text.length - max} characters left out ...]\n\n${text.slice(-tail)}`;
}

/** Parses the model's arguments; a model that wrote nothing means "no arguments". */
export function parseToolArguments(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
    const text = raw.trim();
    if (!text) {
        return { ok: true, args: {} };
    }
    try {
        const value = JSON.parse(text) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return { ok: true, args: value as Record<string, unknown> };
        }
        return { ok: false, error: 'The arguments must be a JSON object.' };
    } catch {
        return { ok: false, error: `The arguments are not valid JSON: ${text.slice(0, 200)}` };
    }
}

function aborted(signal: AbortSignal, error?: unknown): boolean {
    return signal.aborted || (!!error && typeof error === 'object' && ((error as { name?: unknown }).name === 'AbortError' || (error as { kind?: unknown }).kind === 'aborted'));
}

/** Runs one prompt to its end. The last user message must already be in `history`. */
export async function runAgentTurn(options: LoopOptions): Promise<LoopStop> {
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    for (let step = 0; step < maxSteps; step++) {
        if (options.signal.aborted) {
            return 'cancelled';
        }
        let text = '';
        const calls: ToolCall[] = [];
        let stop: ChatEvent & { type: 'done' } = { type: 'done', stopReason: 'other' };
        const request = (withTools: boolean): ChatRequest => ({
            model: options.model,
            system: options.system,
            messages: options.history,
            ...(withTools ? { tools: options.tools.definitions() } : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        });
        const consume = async (withTools: boolean): Promise<void> => {
            for await (const event of options.client.stream(request(withTools), options.signal)) {
                if (event.type === 'text') {
                    text += event.text;
                    await options.events.onText(event.text);
                } else if (event.type === 'tool-call') {
                    calls.push(event.call);
                } else if (event.type === 'usage') {
                    options.events.onUsage?.(event.inputTokens, event.outputTokens);
                } else {
                    stop = event;
                }
            }
        };
        try {
            await consume(options.toolsEnabled.value);
        } catch (error) {
            if (aborted(options.signal, error)) {
                if (text) {
                    options.history.push({ role: 'assistant', content: text });
                }
                return 'cancelled';
            }
            if (options.toolsEnabled.value && text === '' && calls.length === 0 && isToolsUnsupportedError(error)) {
                options.toolsEnabled.value = false;
                await options.events.onToolsUnsupported?.();
                try {
                    await consume(false);
                } catch (retryError) {
                    if (aborted(options.signal, retryError)) {
                        return 'cancelled';
                    }
                    throw retryError;
                }
            } else {
                throw error;
            }
        }
        options.history.push({ role: 'assistant', content: text, ...(calls.length > 0 ? { toolCalls: calls } : {}) });
        if (calls.length === 0) {
            return stop.stopReason === 'max-tokens' ? 'max_tokens' : 'end_turn';
        }
        for (const call of calls) {
            if (options.signal.aborted) {
                // Every call needs an answer, or the next request is malformed.
                options.history.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: 'Stopped by the user.', isError: true });
                continue;
            }
            const parsed = parseToolArguments(call.arguments);
            let result: ToolResult;
            if (!parsed.ok) {
                result = { content: parsed.error, isError: true };
            } else {
                try {
                    result = await options.tools.run(call, parsed.args, options.signal);
                } catch (error) {
                    result = { content: error instanceof Error ? error.message : String(error), isError: true };
                }
            }
            options.history.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: clampToolResult(result.content), ...(result.isError ? { isError: true } : {}) });
        }
        if (options.signal.aborted) {
            return 'cancelled';
        }
    }
    return 'max_turn_requests';
}
