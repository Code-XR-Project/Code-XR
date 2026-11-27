import { spawn, type ChildProcess } from 'node:child_process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import type { LspServerId } from '../../shared/lsp.ts';
import type { Logger } from '../log.ts';
import { RestartBudget } from './lspProtocol.ts';
import type { ServerCommand } from './lspServers.ts';

/**
 * One language server process (#21), spoken to over stdio with JSON-RPC.
 *
 * It keeps the text of every document the window has open, so the server
 * can be restarted after a crash with the same documents (at most a few
 * times, see `RestartBudget`). Documents are synced whole: the renderer
 * sends the full text on each (debounced) change, which every server accepts.
 */

export type ServerState = 'starting' | 'running' | 'stopped' | 'failed';

interface OpenDocument {
    readonly languageId: string;
    version: number;
    text: string;
}

export interface DiagnosticsParams {
    readonly uri: string;
    readonly diagnostics: readonly unknown[];
}

export interface LanguageServerOptions {
    readonly id: LspServerId;
    readonly command: ServerCommand;
    /** The workspace folder: its absolute path and `file://` URI. */
    readonly rootPath: string;
    readonly rootUri: string;
    readonly rootName: string;
    readonly log: Logger;
    readonly onDiagnostics: (params: DiagnosticsParams) => void;
}

const INITIALIZE_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;

/** What the IDE's Monaco bridge supports, as the server is told at start. */
const CLIENT_CAPABILITIES = {
    general: { positionEncodings: ['utf-16'] },
    textDocument: {
        synchronization: { dynamicRegistration: false, didSave: false, willSave: false, willSaveWaitUntil: false },
        publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, versionSupport: false },
        hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
        completion: {
            dynamicRegistration: false,
            contextSupport: true,
            completionItem: {
                snippetSupport: true,
                insertReplaceSupport: true,
                labelDetailsSupport: true,
                deprecatedSupport: true,
                tagSupport: { valueSet: [1] },
                documentationFormat: ['markdown', 'plaintext'],
                resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
            },
        },
        definition: { dynamicRegistration: false, linkSupport: true },
        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
    },
    workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
    window: { workDoneProgress: false },
};

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class LanguageServer {
    private readonly options: LanguageServerOptions;
    private readonly documents = new Map<string, OpenDocument>();
    private readonly restarts = new RestartBudget();
    private child: ChildProcess | null = null;
    private connection: MessageConnection | null = null;
    private ready: Promise<void> | null = null;
    private stateValue: ServerState = 'stopped';
    private stopping = false;

    constructor(options: LanguageServerOptions) {
        this.options = options;
    }

    get state(): ServerState {
        return this.stateValue;
    }

    hasDocument(uri: string): boolean {
        return this.documents.has(uri);
    }

    open(uri: string, languageId: string, version: number, text: string): void {
        const known = this.documents.get(uri);
        this.documents.set(uri, { languageId, version, text });
        if (this.stateValue === 'running') {
            if (known) {
                // The window reopened a document the server still holds (a reloaded tab).
                this.notify('textDocument/didClose', { textDocument: { uri } });
            }
            this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
        } else if (this.stateValue === 'stopped') {
            this.start();
        }
    }

    change(uri: string, version: number, text: string): void {
        const document = this.documents.get(uri);
        if (!document) {
            return;
        }
        document.version = version;
        document.text = text;
        if (this.stateValue === 'running') {
            this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
        }
    }

    close(uri: string): void {
        if (this.documents.delete(uri) && this.stateValue === 'running') {
            this.notify('textDocument/didClose', { textDocument: { uri } });
        }
    }

    /** Sends a request once the server is up; null when it is not running. */
    async request(method: string, params: unknown): Promise<unknown> {
        if (this.ready) {
            await this.ready.catch(() => undefined);
        }
        const connection = this.connection;
        if (this.stateValue !== 'running' || !connection) {
            return null;
        }
        return withTimeout(connection.sendRequest(method, params), REQUEST_TIMEOUT_MS, method);
    }

    /** Shuts the server down politely, then kills it. */
    async stop(): Promise<void> {
        this.stopping = true;
        const child = this.child;
        const connection = this.connection;
        this.stateValue = 'stopped';
        if (!child) {
            return;
        }
        const exited = new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
                resolve();
            } else {
                child.once('exit', () => resolve());
            }
        });
        try {
            if (connection) {
                await withTimeout(connection.sendRequest('shutdown'), SHUTDOWN_TIMEOUT_MS, 'shutdown');
                await connection.sendNotification('exit');
            }
            await withTimeout(exited, SHUTDOWN_TIMEOUT_MS, 'exit');
        } catch {
            child.kill();
        }
        this.dispose();
    }

    private start(): void {
        this.stopping = false;
        this.stateValue = 'starting';
        this.ready = this.launch();
        this.ready.catch((error: unknown) => {
            this.options.log.error(`${this.options.command.name} did not start.`, error);
            this.child?.kill();
        });
    }

    private async launch(): Promise<void> {
        const { command, log, id } = this.options;
        log.info(`Starting ${command.name} for ${this.options.rootPath}`);
        const child = spawn(command.command, [...command.args], {
            cwd: this.options.rootPath,
            env: command.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.child = child;
        child.once('error', (error) => {
            log.error(`${command.name} could not run.`, error);
            this.exited(child, null, null);
        });
        child.once('exit', (code, signal) => this.exited(child, code, signal));
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            for (const line of chunk.split(/\r?\n/)) {
                if (line.trim() !== '') {
                    log.info(`[${id}] ${line}`);
                }
            }
        });
        if (!child.stdout || !child.stdin) {
            throw new Error('The server has no stdio.');
        }
        const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
        this.connection = connection;
        this.listen(connection);
        connection.listen();
        const result = await withTimeout(connection.sendRequest('initialize', {
            processId: process.pid,
            clientInfo: { name: 'Code-XR IDE' },
            locale: 'en',
            rootPath: this.options.rootPath,
            rootUri: this.options.rootUri,
            workspaceFolders: [{ uri: this.options.rootUri, name: this.options.rootName }],
            capabilities: CLIENT_CAPABILITIES,
            initializationOptions: command.initializationOptions ?? null,
        }), INITIALIZE_TIMEOUT_MS, 'initialize') as { serverInfo?: { name?: string; version?: string } } | null;
        if (this.child !== child || this.stopping) {
            return;
        }
        await connection.sendNotification('initialized', {});
        this.stateValue = 'running';
        const info = result?.serverInfo;
        log.info(`${command.name} is running${info?.name ? ` (${info.name}${info.version ? ` ${info.version}` : ''})` : ''}.`);
        // Documents opened while it started, or held across a restart.
        for (const [uri, document] of this.documents) {
            this.notify('textDocument/didOpen', { textDocument: { uri, languageId: document.languageId, version: document.version, text: document.text } });
        }
    }

    /** Requests and notifications the server sends; anything else is answered "method not found" by the library. */
    private listen(connection: MessageConnection): void {
        const { log, id } = this.options;
        connection.onNotification('textDocument/publishDiagnostics', (params: DiagnosticsParams) => this.options.onDiagnostics(params));
        const message = (params: { type?: number; message?: unknown }): void => {
            const text = `[${id}] ${String(params.message ?? '')}`;
            if (params.type === 1) {
                log.error(text);
            } else if (params.type === 2) {
                log.warn(text);
            } else {
                log.info(text);
            }
        };
        connection.onNotification('window/logMessage', message);
        connection.onNotification('window/showMessage', message);
        connection.onRequest('window/showMessageRequest', (params: { type?: number; message?: unknown }) => {
            message(params);
            return null;
        });
        // No settings: every server falls back to its defaults (and to the project's own config files).
        connection.onRequest('workspace/configuration', (params: { items?: unknown[] }) => (params.items ?? []).map(() => null));
        connection.onRequest('workspace/workspaceFolders', () => [{ uri: this.options.rootUri, name: this.options.rootName }]);
        connection.onRequest('client/registerCapability', () => null);
        connection.onRequest('client/unregisterCapability', () => null);
        connection.onRequest('window/workDoneProgress/create', () => null);
        // A server never edits files behind the editor's back.
        connection.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'The Code-XR IDE does not apply server edits.' }));
        connection.onError(([error]) => log.warn(`[${id}] connection error: ${error.message}`));
    }

    private exited(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
        if (this.child !== child) {
            return;
        }
        this.dispose();
        if (this.stopping) {
            this.stateValue = 'stopped';
            return;
        }
        const { log, command } = this.options;
        log.warn(`${command.name} exited unexpectedly (${signal ?? `code ${String(code)}`}).`);
        if (this.restarts.allow(Date.now())) {
            log.info(`Restarting ${command.name}.`);
            this.start();
        } else {
            this.stateValue = 'failed';
            log.error(`${command.name} keeps crashing; it was not restarted again. Reopen the folder to try again.`);
        }
    }

    private notify(method: string, params: unknown): void {
        this.connection?.sendNotification(method, params).catch((error: unknown) => {
            this.options.log.warn(`[${this.options.id}] ${method} was not delivered: ${String(error)}`);
        });
    }

    private dispose(): void {
        this.connection?.dispose();
        this.connection = null;
        this.child = null;
    }
}
