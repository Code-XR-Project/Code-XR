import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { JsonRpcMessage, McpTransport } from './mcpClient.ts';

/**
 * The two MCP transports (A12): stdio (a local process speaking
 * newline-delimited JSON-RPC) and Streamable HTTP (POSTs answered with JSON
 * or an event stream).
 */

const MAX_LINE_CHARS = 8 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2000;

export type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * How to start `command` without a shell, except on Windows for anything but
 * an .exe: npx, npm, uvx… are .cmd scripts there, which Node only starts
 * through cmd.exe, so the line is escaped for it the way cross-spawn does.
 */
export function processInvocation(command: string, args: readonly string[], platform: NodeJS.Platform = process.platform): { readonly file: string; readonly args: readonly string[]; readonly verbatim: boolean } {
    if (platform !== 'win32' || /\.exe$/i.test(command)) {
        return { file: command, args, verbatim: false };
    }
    const line = [command.replace(CMD_META, '^$1'), ...args.map(quoteForCmd)].join(' ');
    return { file: process.env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/** One argument for cmd.exe: quoted for the C runtime, then every metacharacter (quotes included) caret-escaped for cmd. */
export function quoteForCmd(arg: string): string {
    const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
    return quoted.replace(CMD_META, '^$1');
}

export function stdioTransport(command: string, args: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly spawn?: SpawnProcess }): McpTransport & { readonly stderrTail: () => string } {
    let child: ChildProcessWithoutNullStreams | null = null;
    let stderr = '';
    return {
        stderrTail: () => stderr.trim(),
        start(onMessage, onClose) {
            const invocation = processInvocation(command, args);
            return new Promise<void>((resolve, reject) => {
                const spawn = options.spawn ?? nodeSpawn;
                const proc = spawn(invocation.file, invocation.args, { cwd: options.cwd, env: { ...options.env }, windowsHide: true, windowsVerbatimArguments: invocation.verbatim });
                child = proc;
                let buffer = '';
                let answered = false;
                proc.stdout.setEncoding('utf8');
                proc.stdout.on('data', (chunk: string) => {
                    buffer += chunk;
                    let newline = buffer.indexOf('\n');
                    while (newline >= 0) {
                        const line = buffer.slice(0, newline).trim();
                        buffer = buffer.slice(newline + 1);
                        if (line) {
                            const message = parseMessage(line);
                            if (message) {
                                answered = true;
                                onMessage(message);
                            }
                        }
                        newline = buffer.indexOf('\n');
                    }
                    if (buffer.length > MAX_LINE_CHARS) {
                        buffer = '';
                        onClose('The MCP server sent a message too large to read.');
                        proc.kill();
                    }
                });
                proc.stderr.setEncoding('utf8');
                proc.stderr.on('data', (chunk: string) => {
                    stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
                });
                proc.once('spawn', () => resolve());
                proc.once('error', (error) => {
                    const reason = `Could not start ${command}: ${error.message}`;
                    onClose(reason);
                    reject(new Error(reason));
                });
                proc.once('exit', (code, signal) => {
                    child = null;
                    const tail = stderr.replace(/\r/g, '').trim().split('\n').slice(-3).join(' ').slice(-400);
                    const how = signal ?? `code ${code ?? '?'}`;
                    // Before its first message the process never was a server: on Windows a missing
                    // command still "starts" (cmd.exe), then exits with "is not recognized".
                    onClose(answered
                        ? `The MCP server exited (${how})${tail ? `: ${tail}` : '.'}`
                        : `Could not start ${command} (exited with ${how})${tail ? `: ${tail}` : '.'}`);
                });
                proc.stdin.on('error', () => undefined);
            });
        },
        send(message) {
            const proc = child;
            if (!proc || !proc.stdin.writable) {
                return Promise.reject(new Error('The MCP server is not running.'));
            }
            return new Promise<void>((resolve, reject) => {
                proc.stdin.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
            });
        },
        async close() {
            const proc = child;
            child = null;
            if (proc) {
                proc.stdin.end();
                // The spec: close stdin, then terminate if it does not exit by itself.
                const timer = setTimeout(() => proc.kill(), 2000);
                proc.once('exit', () => clearTimeout(timer));
            }
        },
    };
}

function parseMessage(text: string): JsonRpcMessage | null {
    try {
        const parsed: unknown = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as { jsonrpc?: unknown }).jsonrpc === '2.0' ? parsed as JsonRpcMessage : null;
    } catch {
        // A server printing logs to stdout: not a message, skip it.
        return null;
    }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Streamable HTTP: each message is a POST; answers come back as JSON or as an SSE stream on that POST. */
export function httpTransport(url: string, token: () => string | undefined, fetchImpl: Fetch = (input, init) => fetch(input, init)): McpTransport {
    let sessionId: string | null = null;
    let deliver: (message: JsonRpcMessage) => void = () => undefined;
    let closed = false;
    const controller = new AbortController();
    const headers = (): Record<string, string> => {
        const value = token();
        return {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-06-18',
            ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
            ...(value ? { Authorization: `Bearer ${value}` } : {}),
        };
    };
    return {
        start(onMessage) {
            deliver = onMessage;
            return Promise.resolve();
        },
        async send(message) {
            if (closed) {
                throw new Error('The MCP connection is closed.');
            }
            const response = await fetchImpl(url, { method: 'POST', headers: headers(), body: JSON.stringify(message), signal: controller.signal, redirect: 'error' });
            const session = response.headers.get('mcp-session-id');
            if (session) {
                sessionId = session;
            }
            if (response.status === 401 || response.status === 403) {
                throw new Error(`The MCP server refused the request (HTTP ${response.status}); check its token.`);
            }
            if (!response.ok) {
                throw new Error(`The MCP server answered HTTP ${response.status}.`);
            }
            const type = response.headers.get('content-type') ?? '';
            if (response.status === 202 || !response.body) {
                return;
            }
            if (type.includes('text/event-stream')) {
                // Read on in the background: the answer arrives through `deliver`.
                void readEvents(response, deliver).catch(() => undefined);
                return;
            }
            const text = await response.text();
            if (!text.trim()) {
                return;
            }
            const parsed: unknown = JSON.parse(text);
            for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
                if (item && typeof item === 'object') {
                    deliver(item as JsonRpcMessage);
                }
            }
        },
        async close() {
            closed = true;
            if (sessionId) {
                await fetchImpl(url, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(3000) }).catch(() => undefined);
            }
            controller.abort();
        },
    };
}

/** Delivers each `data:` event of an SSE stream as a JSON-RPC message. */
export async function readEvents(response: Response, deliver: (message: JsonRpcMessage) => void): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
        return;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let data: string[] = [];
    for (;;) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let newline = buffer.search(/\r?\n/);
        while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(buffer[newline] === '\r' ? newline + 2 : newline + 1);
            if (line === '') {
                const message = data.length > 0 ? parseMessage(data.join('\n')) : null;
                data = [];
                if (message) {
                    deliver(message);
                }
            } else if (line.startsWith('data:')) {
                data.push(line.slice(5).replace(/^ /, ''));
            }
            newline = buffer.search(/\r?\n/);
        }
        if (done) {
            if (buffer.startsWith('data:')) {
                data.push(buffer.slice(5).replace(/^ /, ''));
            }
            const message = data.length > 0 ? parseMessage(data.join('\n')) : null;
            if (message) {
                deliver(message);
            }
            return;
        }
    }
}
