import { ProviderError, type FetchLike, type ProviderErrorKind } from './types.ts';

/** Shared HTTP plumbing of the adapters: requests with retry, error mapping, SSE parsing. */

const MAX_RETRIES = 2;

export interface JsonRequest {
    readonly url: string;
    readonly method: 'GET' | 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly signal?: AbortSignal | undefined;
}

/**
 * Sends a request and returns the response once it is OK. Retries 429 and 5xx
 * (and network failures) with exponential backoff, honouring `Retry-After`;
 * nothing has been streamed yet at that point, so a retry is always safe.
 */
export async function send(fetchImpl: FetchLike, request: JsonRequest, retryDelayMs: number): Promise<Response> {
    let attempt = 0;
    for (;;) {
        let response: Response;
        try {
            const init: RequestInit = {
                method: request.method,
                headers: { ...request.headers, ...(request.body === undefined ? {} : { 'content-type': 'application/json' }) },
            };
            if (request.body !== undefined) {
                init.body = JSON.stringify(request.body);
            }
            if (request.signal) {
                init.signal = request.signal;
            }
            response = await fetchImpl(request.url, init);
        } catch (error) {
            if (request.signal?.aborted) {
                throw new ProviderError('aborted', 'Stopped.');
            }
            if (attempt < MAX_RETRIES) {
                await wait(retryDelayMs * 2 ** attempt, request.signal);
                attempt += 1;
                continue;
            }
            throw new ProviderError('network', `Could not reach the provider: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (response.ok) {
            return response;
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < MAX_RETRIES) {
            const retryAfter = Number(response.headers.get('retry-after'));
            const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : retryDelayMs * 2 ** attempt;
            await response.body?.cancel().catch(() => undefined);
            await wait(delay, request.signal);
            attempt += 1;
            continue;
        }
        throw await errorFromResponse(response);
    }
}

/** Turns a failed response into a ProviderError with the provider's own message when it gives one. */
export async function errorFromResponse(response: Response): Promise<ProviderError> {
    let detail = '';
    try {
        const text = await response.text();
        try {
            detail = extractMessage(JSON.parse(text)) ?? text;
        } catch {
            detail = text;
        }
    } catch {
        // No body.
    }
    detail = detail.trim().slice(0, 300);
    const kind = kindOf(response.status, detail);
    const prefix: Record<ProviderErrorKind, string> = {
        auth: 'The API key was rejected',
        quota: 'The account has no credit or quota left',
        'rate-limit': 'Too many requests; try again in a moment',
        'not-found': 'Not found (check the model name and the endpoint)',
        'bad-request': 'The provider refused the request',
        server: 'The provider had an error',
        network: 'Could not reach the provider',
        aborted: 'Stopped',
    };
    return new ProviderError(kind, detail ? `${prefix[kind]} (${response.status}): ${detail}` : `${prefix[kind]} (${response.status}).`, response.status);
}

function kindOf(status: number, detail: string): ProviderErrorKind {
    if (status === 401 || status === 403) {
        return 'auth';
    }
    if (status === 402 || /quota|credit|billing|insufficient/i.test(detail)) {
        return 'quota';
    }
    if (status === 429) {
        return 'rate-limit';
    }
    if (status === 404) {
        return 'not-found';
    }
    return status >= 500 ? 'server' : 'bad-request';
}

function extractMessage(body: unknown): string | undefined {
    if (Array.isArray(body)) {
        return extractMessage(body[0]);
    }
    if (!body || typeof body !== 'object') {
        return undefined;
    }
    const record = body as Record<string, unknown>;
    const error = record['error'];
    if (typeof error === 'string') {
        return error;
    }
    if (error && typeof error === 'object') {
        const message = (error as Record<string, unknown>)['message'];
        if (typeof message === 'string') {
            return message;
        }
    }
    return typeof record['message'] === 'string' ? record['message'] : undefined;
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (ms <= 0) {
        return signal?.aborted ? Promise.reject(new ProviderError('aborted', 'Stopped.')) : Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(new ProviderError('aborted', 'Stopped.'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export interface SseMessage {
    readonly event: string;
    readonly data: string;
}

/**
 * Parses a Server-Sent Events body (https://html.spec.whatwg.org/#event-stream-interpretation):
 * `event:` and `data:` fields, messages separated by a blank line, CRLF or LF.
 */
export async function* readSse(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AsyncGenerator<SseMessage> {
    if (!body) {
        return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';
    let data: string[] = [];
    try {
        for (;;) {
            let chunk: Awaited<ReturnType<typeof reader.read>>;
            try {
                chunk = await reader.read();
            } catch (error) {
                if (signal?.aborted) {
                    throw new ProviderError('aborted', 'Stopped.');
                }
                throw new ProviderError('network', `The connection dropped: ${error instanceof Error ? error.message : String(error)}`);
            }
            buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
            if (chunk.done && buffer !== '') {
                buffer += '\n'; // the last line may have no terminator
            }
            let newline: number;
            while ((newline = buffer.search(/\r\n|\n|\r/)) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1));
                if (line === '') {
                    if (data.length > 0) {
                        yield { event: event || 'message', data: data.join('\n') };
                    }
                    event = '';
                    data = [];
                } else if (!line.startsWith(':')) {
                    const colon = line.indexOf(':');
                    const field = colon < 0 ? line : line.slice(0, colon);
                    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
                    if (field === 'event') {
                        event = value;
                    } else if (field === 'data') {
                        data.push(value);
                    }
                }
            }
            if (chunk.done) {
                if (data.length > 0) {
                    yield { event: event || 'message', data: data.join('\n') };
                }
                return;
            }
        }
    } finally {
        reader.releaseLock();
        await body.cancel().catch(() => undefined);
    }
}

/** Parses one SSE data payload as JSON, failing with a readable error. */
export function parseJson(data: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(data);
        if (parsed && typeof parsed === 'object') {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Fall through.
    }
    throw new ProviderError('server', 'The provider sent a malformed stream event.');
}
