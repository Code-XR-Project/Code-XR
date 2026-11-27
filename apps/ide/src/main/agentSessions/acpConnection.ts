import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
    client,
    methods,
    ndJsonStream,
    RequestError,
    type AgentApp,
    type ClientConnection,
    type ContentBlock,
    type CreateTerminalRequest,
    type CreateTerminalResponse,
    type InitializeResponse,
    type KillTerminalRequest,
    type LoadSessionResponse,
    type McpServer,
    type NewSessionResponse,
    type PromptResponse,
    type ReadTextFileRequest,
    type ReadTextFileResponse,
    type ReleaseTerminalRequest,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionUpdate,
    type SetSessionConfigOptionResponse,
    type TerminalOutputRequest,
    type TerminalOutputResponse,
    type WaitForTerminalExitRequest,
    type WaitForTerminalExitResponse,
    type WriteTextFileRequest,
} from '@agentclientprotocol/sdk';

/**
 * AF1: one Agent Client Protocol connection to one agent process. The IDE is
 * the ACP *client*: it spawns the agent (no shell), speaks newline-delimited
 * JSON-RPC over the child's stdio through the SDK's stable v1 entry point,
 * and answers the agent's requests (files, terminals, permissions) through
 * `AcpClientHandlers`, which the service implements per chat. One process per
 * chat keeps a crash or a hung agent contained to that chat.
 *
 * Tests connect the same client to an in-process fake agent (`inProcess`),
 * so this file is exercised end to end without spawning anything.
 */

export const ACP_PROTOCOL_VERSION = 1;

/** What the agent may ask the IDE for, implemented per chat by the service. */
export interface AcpClientHandlers {
    onUpdate(sessionId: string, update: SessionUpdate): void;
    requestPermission(params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
    readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
    writeTextFile(params: WriteTextFileRequest): Promise<void>;
    createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse>;
    terminalOutput(params: TerminalOutputRequest): TerminalOutputResponse;
    waitForTerminalExit(params: WaitForTerminalExitRequest, signal: AbortSignal): Promise<WaitForTerminalExitResponse>;
    killTerminal(params: KillTerminalRequest): void;
    releaseTerminal(params: ReleaseTerminalRequest): void;
}

/** How to start an agent: an executable (never through a shell), its arguments and its whole environment. */
export interface AgentLaunch {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    /** Windows only: pass `args` to the program unquoted (a `cmd.exe /d /s /c "..."` launch). */
    readonly verbatimArguments?: boolean;
}

const STDERR_TAIL = 4000;

/**
 * The agent sees why a request was refused ("outside the project folder"),
 * not the SDK's generic "Internal error" for a thrown `Error`.
 */
async function answer<T>(run: () => T | Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof RequestError) {
            throw error;
        }
        throw new RequestError(-32603, error instanceof Error ? error.message : String(error));
    }
}

function clientApp(handlers: AcpClientHandlers) {
    return client({ name: 'code-xr-ide' })
        .onNotification(methods.client.session.update, ({ params }) => {
            handlers.onUpdate(params.sessionId, params.update);
        })
        .onRequest(methods.client.session.requestPermission, ({ params, signal }) => answer(() => handlers.requestPermission(params, signal)))
        .onRequest(methods.client.fs.readTextFile, ({ params }) => answer(() => handlers.readTextFile(params)))
        .onRequest(methods.client.fs.writeTextFile, ({ params }) => answer(async () => {
            await handlers.writeTextFile(params);
            return {};
        }))
        .onRequest(methods.client.terminal.create, ({ params }) => answer(() => handlers.createTerminal(params)))
        .onRequest(methods.client.terminal.output, ({ params }) => answer(() => handlers.terminalOutput(params)))
        .onRequest(methods.client.terminal.waitForExit, ({ params, signal }) => answer(() => handlers.waitForTerminalExit(params, signal)))
        .onRequest(methods.client.terminal.kill, ({ params }) => answer(() => {
            handlers.killTerminal(params);
            return {};
        }))
        .onRequest(methods.client.terminal.release, ({ params }) => answer(() => {
            handlers.releaseTerminal(params);
            return {};
        }));
}

export class AcpConnection {
    private readonly connection: ClientConnection;
    private readonly child: ChildProcess | null;
    private stderr = '';
    private exitError: Error | null = null;
    private readonly closeListeners: ((error: Error | null) => void)[] = [];
    private closed = false;

    private readonly exited: Promise<void>;

    private constructor(connection: ClientConnection, child: ChildProcess | null) {
        this.connection = connection;
        this.child = child;
        this.exited = child && child.exitCode === null && child.signalCode === null
            ? new Promise<void>((resolve) => child.once('exit', () => resolve()))
            : Promise.resolve();
        // stdout ends a moment before the process reports its exit: wait for
        // it, so the close carries the exit code and the stderr tail.
        void connection.closed.then(async () => {
            await this.settleExit();
            this.markClosed(this.exitError);
        });
    }

    /** Waits (briefly) for the process to report its exit after the stream ended. */
    private async settleExit(): Promise<void> {
        if (!this.child || this.exitError) {
            return;
        }
        await Promise.race([this.exited, new Promise<void>((resolve) => setTimeout(resolve, 500).unref())]);
    }

    /** A request that failed because the stream closed reports why the agent went away instead. */
    private async explain<T>(request: Promise<T>): Promise<T> {
        try {
            return await request;
        } catch (error) {
            if (error instanceof Error && /connection closed/i.test(error.message)) {
                await this.settleExit();
                throw this.exitError ?? error;
            }
            throw error;
        }
    }

    /** Starts the agent process in `cwd` and connects to its stdio. */
    static spawn(launch: AgentLaunch, cwd: string, handlers: AcpClientHandlers, onLog?: (line: string) => void): AcpConnection {
        const child = spawn(launch.command, [...launch.args], {
            cwd,
            env: { ...launch.env },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
            ...(launch.verbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });
        const stdin = child.stdin;
        const stdout = child.stdout;
        if (!stdin || !stdout) {
            child.kill();
            throw new Error('The agent process has no standard input or output.');
        }
        const stream = ndJsonStream(Writable.toWeb(stdin) as WritableStream<Uint8Array>, Readable.toWeb(stdout) as ReadableStream<Uint8Array>);
        const connection = new AcpConnection(clientApp(handlers).connect(stream), child);
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            connection.stderr = (connection.stderr + chunk).slice(-STDERR_TAIL);
            for (const line of chunk.split(/\r?\n/)) {
                if (line.trim()) {
                    onLog?.(line);
                }
            }
        });
        // A failed spawn (ENOENT, EACCES) and an exit both end the connection,
        // which rejects whatever request was waiting with the reason.
        child.on('error', (error) => connection.fail(new Error(`Could not start ${launch.command}: ${error.message}`)));
        child.on('exit', (code, signal) => {
            const tail = connection.stderr.trim().split(/\r?\n/).slice(-3).join(' ').trim();
            const how = signal ? `was stopped (${signal})` : `exited with code ${code ?? 'unknown'}`;
            connection.fail(new Error(`The agent ${how}.${tail ? ` ${tail}` : ''}`));
        });
        stdin.on('error', () => undefined);
        return connection;
    }

    /** Connects to an agent app in this process (tests). */
    static inProcess(agent: AgentApp, handlers: AcpClientHandlers): AcpConnection {
        return new AcpConnection(clientApp(handlers).connect(agent), null);
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /** The last lines the agent wrote to stderr (its log), for error messages. */
    get stderrTail(): string {
        return this.stderr;
    }

    onClose(listener: (error: Error | null) => void): void {
        if (this.closed) {
            listener(this.exitError);
            return;
        }
        this.closeListeners.push(listener);
    }

    initialize(): Promise<InitializeResponse> {
        return this.explain(this.connection.agent.request(methods.agent.initialize, {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientInfo: { name: 'code-xr-ide', title: 'Code-XR IDE', version: '0.1.0' },
            clientCapabilities: {
                fs: { readTextFile: true, writeTextFile: true },
                terminal: true,
                auth: { terminal: true },
            },
        }));
    }

    authenticate(methodId: string): Promise<unknown> {
        return this.explain(this.connection.agent.request(methods.agent.authenticate, { methodId }));
    }

    newSession(cwd: string, mcpServers: readonly McpServer[]): Promise<NewSessionResponse> {
        return this.explain(this.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [...mcpServers] }));
    }

    loadSession(sessionId: string, cwd: string, mcpServers: readonly McpServer[]): Promise<LoadSessionResponse> {
        return this.explain(this.connection.agent.request(methods.agent.session.load, { sessionId, cwd, mcpServers: [...mcpServers] }));
    }

    prompt(sessionId: string, prompt: readonly ContentBlock[]): Promise<PromptResponse> {
        return this.explain(this.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [...prompt] }));
    }

    cancel(sessionId: string): Promise<void> {
        return this.connection.agent.notify(methods.agent.session.cancel, { sessionId });
    }

    async setMode(sessionId: string, modeId: string): Promise<void> {
        await this.explain(this.connection.agent.request(methods.agent.session.setMode, { sessionId, modeId }));
    }

    setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<SetSessionConfigOptionResponse> {
        return this.explain(this.connection.agent.request(
            methods.agent.session.setConfigOption,
            typeof value === 'boolean' ? { sessionId, configId, type: 'boolean', value } : { sessionId, configId, value },
        ));
    }

    /** Closes the connection and stops the process. Safe to call more than once. */
    close(): void {
        this.connection.close();
        this.killProcess();
        this.markClosed(this.exitError);
    }

    private fail(error: Error): void {
        this.exitError ??= error;
        this.connection.close(error);
        this.markClosed(this.exitError);
    }

    private killProcess(): void {
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) {
            return;
        }
        try {
            child.kill();
        } catch {
            // Already gone.
        }
        // An agent that ignores SIGTERM is killed for good a moment later.
        const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // Already gone.
                }
            }
        }, 3000);
        timer.unref();
    }

    private markClosed(error: Error | null): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.killProcess();
        for (const listener of this.closeListeners.splice(0)) {
            listener(error);
        }
    }
}
