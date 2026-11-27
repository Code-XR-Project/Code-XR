import { DapMessageReader, encodeDapMessage, type DapMessage } from '../../shared/debug.ts';

/**
 * #180: a Debug Adapter Protocol client over a byte stream (an adapter's
 * stdio). Requests get their response as a promise; events and the adapter's
 * own requests (`runInTerminal`, `startDebugging`) go to the handlers. Any
 * request still waiting fails when the connection closes, so nothing hangs.
 */

export interface DapTransport {
    write(bytes: Uint8Array): void;
    onData(listener: (chunk: Uint8Array) => void): void;
    onClose(listener: () => void): void;
}

export class DapError extends Error {
    readonly command: string;
    constructor(command: string, message: string) {
        super(message);
        this.command = command;
    }
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class DapClient {
    private seq = 1;
    private readonly pending = new Map<number, { command: string; resolve(body: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> | undefined }>();
    private readonly reader = new DapMessageReader();
    private closed = false;
    private readonly transport: DapTransport;
    private readonly onEvent: (event: string, body: unknown) => void;
    private readonly onReverseRequest: (command: string, args: unknown) => Promise<unknown>;
    private readonly onClosed: (reason: string | null) => void;

    constructor(
        transport: DapTransport,
        handlers: {
            onEvent(event: string, body: unknown): void;
            /** The adapter's requests; a rejection answers with `success: false`. */
            onReverseRequest(command: string, args: unknown): Promise<unknown>;
            /** The stream ended, or sent something that is not DAP (the reason). */
            onClosed(reason: string | null): void;
        },
    ) {
        this.transport = transport;
        this.onEvent = handlers.onEvent;
        this.onReverseRequest = handlers.onReverseRequest;
        this.onClosed = handlers.onClosed;
        transport.onData((chunk) => {
            if (this.closed) {
                return;
            }
            let messages: DapMessage[];
            try {
                messages = this.reader.push(chunk);
            } catch (error) {
                this.close(error instanceof Error ? error.message : String(error));
                return;
            }
            for (const message of messages) {
                this.dispatch(message);
            }
        });
        transport.onClose(() => this.close(null));
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /** Sends a request; resolves with the response's body, rejects with its message. */
    request<T = unknown>(command: string, args?: unknown, timeoutMs: number | null = DEFAULT_TIMEOUT_MS): Promise<T> {
        if (this.closed) {
            return Promise.reject(new DapError(command, 'The debug session has ended.'));
        }
        const seq = this.seq++;
        return new Promise<T>((resolve, reject) => {
            const timer = timeoutMs === null ? undefined : setTimeout(() => {
                this.pending.delete(seq);
                reject(new DapError(command, `The debug adapter did not answer "${command}".`));
            }, timeoutMs);
            this.pending.set(seq, { command, resolve: resolve as (body: unknown) => void, reject, timer });
            this.send({ seq, type: 'request', command, ...(args === undefined ? {} : { arguments: args }) });
        });
    }

    close(reason: string | null): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const [seq, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new DapError(entry.command, 'The debug session has ended.'));
            this.pending.delete(seq);
        }
        this.onClosed(reason);
    }

    private send(message: object): void {
        try {
            this.transport.write(encodeDapMessage(message));
        } catch (error) {
            this.close(error instanceof Error ? error.message : String(error));
        }
    }

    private dispatch(message: DapMessage): void {
        if (message.type === 'response' && typeof message.request_seq === 'number') {
            const entry = this.pending.get(message.request_seq);
            if (!entry) {
                return;
            }
            this.pending.delete(message.request_seq);
            clearTimeout(entry.timer);
            if (message.success) {
                entry.resolve(message.body);
            } else {
                entry.reject(new DapError(entry.command, responseError(message)));
            }
        } else if (message.type === 'event' && typeof message.event === 'string') {
            this.onEvent(message.event, message.body);
        } else if (message.type === 'request' && typeof message.command === 'string') {
            const command = message.command;
            this.onReverseRequest(command, message.arguments).then(
                (body) => this.send({ seq: this.seq++, type: 'response', request_seq: message.seq, command, success: true, ...(body === undefined ? {} : { body }) }),
                (error: unknown) => this.send({
                    seq: this.seq++, type: 'response', request_seq: message.seq, command, success: false,
                    message: error instanceof Error ? error.message : String(error),
                }),
            );
        }
    }
}

/** The adapter's error text: `message`, or the formatted `body.error` debugpy and js-debug send. */
function responseError(message: DapMessage): string {
    const body = message.body as { error?: { format?: unknown; variables?: Record<string, unknown> } } | undefined;
    const format = body?.error?.format;
    if (typeof format === 'string') {
        const variables = body?.error?.variables ?? {};
        return format.replace(/\{(\w+)\}/g, (_match, name: string) => String(variables[name] ?? `{${name}}`));
    }
    return message.message || 'The debug adapter refused the request.';
}
