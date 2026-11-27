import type { WebContents } from 'electron';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LSP_IPC_EVENTS, serverIdOf, type LspDiagnosticsEvent, type LspServerId } from '../../shared/lsp.ts';
import { channelLog } from '../log.ts';
import { addFolderChangeListener, currentWorkspaceInfo } from '../workspace/workspaceWindows.ts';
import { addTrustChangeListener, isWorkspaceTrusted } from '../trust/workspaceTrust.ts';
import { LanguageServer, type DiagnosticsParams } from './languageServer.ts';
import { assertLanguage, assertRequestMethod, assertText, assertVersion, buildDocumentRequest, buildWorkspaceSymbolRequest, CompletionDataStore, lspLanguageId } from './lspProtocol.ts';
import { mapDocumentResult, mapWorkspaceSymbols } from './lspResults.ts';
import { findPythonServer, typescriptServerCommand, type ServerCommand } from './lspServers.ts';
import { clientUriToWorkspacePath, mapServerUris, toClientUri, toServerUri, type WorkspaceRoots } from './lspUri.ts';

/**
 * Wires the language client (#21) into Electron: one set of servers per
 * window, for the folder it has open, started on the first document of their
 * language and stopped when the folder changes, the page reloads, the window
 * closes or the IDE quits. The logic it wires (URI mapping, request checks,
 * restarts, server lookup) is in the modules next to it, unit-tested.
 */
export interface LspHost {
    didOpen(contents: WebContents, uri: unknown, languageId: unknown, version: unknown, text: unknown): Promise<void>;
    didChange(contents: WebContents, uri: unknown, version: unknown, text: unknown): Promise<void>;
    didClose(contents: WebContents, uri: unknown): Promise<void>;
    request(contents: WebContents, method: unknown, params: unknown): Promise<unknown>;
    stopAll(): Promise<void>;
}

interface Session {
    readonly contents: WebContents;
    readonly roots: WorkspaceRoots;
    /** The servers that run, per language family. */
    readonly servers: Map<LspServerId, LanguageServer>;
    /** Each family's lookup, once: resolves null when none can run. */
    readonly lookups: Map<LspServerId, Promise<LanguageServer | null>>;
    readonly completions: CompletionDataStore;
}

const lspLog = channelLog('lsp');

/** out/main/index.cjs -> apps/ide, whose node_modules hold the shipped server. */
const IDE_ROOT = path.resolve(__dirname, '..', '..');

function isExecutableFile(file: string): Promise<boolean> {
    return fs.promises.stat(file).then(
        (stat) => stat.isFile() && (process.platform === 'win32' || fs.promises.access(file, fs.constants.X_OK).then(() => true, () => false)),
        () => false,
    );
}

function typescriptCommand(): ServerCommand {
    const ideRequire = createRequire(path.join(IDE_ROOT, 'package.json'));
    return typescriptServerCommand({
        execPath: process.execPath,
        cliPath: ideRequire.resolve('typescript-language-server/lib/cli.mjs'),
        tsserverPath: ideRequire.resolve('typescript/lib/tsserver.js'),
    }, process.env);
}

export function createLspHost(): LspHost {
    const sessions = new Map<number, Session>();
    const tracked = new Set<number>();
    /**
     * A window's document notifications run one after another, in the order
     * they came: opening a document waits for its server's lookup, and a
     * change sent meanwhile must not overtake it. Requests wait their turn
     * to be sent, not for their answer.
     */
    const chains = new Map<number, Promise<unknown>>();
    function inOrder<T>(contents: WebContents, task: () => Promise<T> | T): Promise<T> {
        const previous = chains.get(contents.id) ?? Promise.resolve();
        const next = previous.then(task, task);
        const settled = next.catch(() => undefined);
        chains.set(contents.id, settled);
        void settled.then(() => {
            if (chains.get(contents.id) === settled) {
                chains.delete(contents.id);
            }
        });
        return next;
    }

    async function stopSession(id: number): Promise<void> {
        const session = sessions.get(id);
        if (!session) {
            return;
        }
        sessions.delete(id);
        await Promise.all([...session.servers.values()].map((server) => server.stop()));
    }

    addFolderChangeListener((contents) => void stopSession(contents.id));
    // #177: the renderer sends its documents again after a trust change, and the servers the new trust allows start.
    addTrustChangeListener((contents) => void stopSession(contents.id));

    /** The window's session for its open folder; a new one when the folder changed. */
    async function sessionOf(contents: WebContents): Promise<Session> {
        const root = currentWorkspaceInfo(contents)?.root;
        if (!root) {
            throw new Error('No folder is open in this window.');
        }
        const existing = sessions.get(contents.id);
        if (existing && existing.roots.root === root) {
            return existing;
        }
        await stopSession(contents.id);
        const realRoot = await fs.promises.realpath(root).catch(() => root);
        const raced = sessions.get(contents.id);
        if (raced && raced.roots.root === root) {
            return raced;
        }
        const session: Session = { contents, roots: { root, realRoot }, servers: new Map(), lookups: new Map(), completions: new CompletionDataStore() };
        sessions.set(contents.id, session);
        if (!tracked.has(contents.id)) {
            const id = contents.id;
            tracked.add(id);
            // A reloaded page has lost its editors: the servers would hold stale documents.
            contents.on('did-navigate', () => void stopSession(id));
            contents.on('render-process-gone', () => void stopSession(id));
            contents.once('destroyed', () => {
                tracked.delete(id);
                void stopSession(id);
            });
        }
        return session;
    }

    function publish(session: Session, params: DiagnosticsParams): void {
        const uri = toClientUri(params.uri, session.roots);
        if (uri === null || session.contents.isDestroyed() || sessions.get(session.contents.id) !== session) {
            return;
        }
        const diagnostics = mapServerUris(Array.isArray(params.diagnostics) ? params.diagnostics : [], (u) => toClientUri(u, session.roots));
        const event: LspDiagnosticsEvent = { uri, diagnostics: Array.isArray(diagnostics) ? diagnostics : [] };
        session.contents.send(LSP_IPC_EVENTS.lspDiagnostics, event);
    }

    function serverFor(session: Session, id: LspServerId): Promise<LanguageServer | null> {
        let lookup = session.lookups.get(id);
        if (!lookup) {
            lookup = createServer(session, id);
            session.lookups.set(id, lookup);
        }
        return lookup;
    }

    async function createServer(session: Session, id: LspServerId): Promise<LanguageServer | null> {
        let command: ServerCommand | null;
        try {
            if (id !== 'typescript' && !isWorkspaceTrusted(session.contents)) {
                // #177: pyright runs the interpreter a project's config names, so Restricted Mode starts no Python server.
                lspLog.info('Restricted Mode: the Python language server does not start until this folder is trusted (Manage Workspace Trust).');
                return null;
            }
            command = id === 'typescript'
                ? typescriptCommand()
                : await findPythonServer({ platform: process.platform, env: process.env, isFile: isExecutableFile });
        } catch (error) {
            lspLog.error('The TypeScript language server is missing from this build; TypeScript and JavaScript get syntax highlighting only.', error);
            return null;
        }
        if (!command) {
            lspLog.info('No Python language server found on PATH (looked for pyright-langserver, then pylsp). Python files get syntax highlighting only; install one (pip install pyright, or pip install python-lsp-server) and reopen the folder.');
            return null;
        }
        if (sessions.get(session.contents.id) !== session) {
            return null;
        }
        const server = new LanguageServer({
            id,
            command,
            rootPath: session.roots.root,
            rootUri: pathToFileURL(session.roots.root).href,
            rootName: path.basename(session.roots.root) || session.roots.root,
            log: lspLog,
            onDiagnostics: (params) => publish(session, params),
        });
        session.servers.set(id, server);
        return server;
    }

    function serverHolding(session: Session | undefined, serverUri: string): LanguageServer | null {
        for (const server of session?.servers.values() ?? []) {
            if (server.hasDocument(serverUri)) {
                return server;
            }
        }
        return null;
    }

    return {
        didOpen: (contents, uri, languageId, version, text) => inOrder(contents, async () => {
            const language = assertLanguage(languageId);
            const workspacePath = clientUriToWorkspacePath(uri);
            const checkedVersion = assertVersion(version);
            const checkedText = assertText(text);
            const session = await sessionOf(contents);
            const serverUri = toServerUri(uri, session.roots);
            const server = await serverFor(session, serverIdOf(language));
            if (sessions.get(contents.id) !== session) {
                return; // the folder changed meanwhile
            }
            server?.open(serverUri, lspLanguageId(language, workspacePath), checkedVersion, checkedText);
        }),
        didChange: (contents, uri, version, text) => inOrder(contents, () => {
            const session = sessions.get(contents.id);
            if (!session) {
                return;
            }
            const serverUri = toServerUri(uri, session.roots);
            serverHolding(session, serverUri)?.change(serverUri, assertVersion(version), assertText(text));
        }),
        didClose: (contents, uri) => inOrder(contents, () => {
            const session = sessions.get(contents.id);
            if (!session) {
                return;
            }
            const serverUri = toServerUri(uri, session.roots);
            serverHolding(session, serverUri)?.close(serverUri);
        }),
        async request(contents, method, params) {
            const checked = assertRequestMethod(method);
            await inOrder(contents, () => undefined);
            const session = sessions.get(contents.id);
            if (!session) {
                return null;
            }
            const toClient = (u: string): string | null => toClientUri(u, session.roots);
            if (checked === 'completionItem/resolve') {
                const restored = session.completions.restore(params);
                const server = restored ? session.servers.get(restored.server) : null;
                if (!restored || !server) {
                    return params;
                }
                const resolved = mapServerUris(await server.request(checked, restored.item), toClient);
                if (resolved !== null && typeof resolved === 'object' && !Array.isArray(resolved)) {
                    (resolved as Record<string, unknown>)['data'] = restored.token;
                }
                return resolved ?? params;
            }
            if (checked === 'workspace/symbol') {
                // #287: every server of the window answers for its languages; a server that fails leaves its part out.
                const query = buildWorkspaceSymbolRequest(params);
                const answers = await Promise.all([...session.servers.values()].map((server) => server.request(checked, query).catch((error: unknown) => {
                    lspLog.warn(`workspace/symbol failed: ${String(error)}`);
                    return null;
                })));
                return answers.flatMap((answer) => mapWorkspaceSymbols(answer, toClient));
            }
            const request = buildDocumentRequest(checked, params, (u) => toServerUri(u, session.roots));
            const server = serverHolding(session, request.serverUri);
            if (!server) {
                return null;
            }
            const result = mapDocumentResult(request.method, await server.request(request.method, request.params), toClient);
            if (request.method === 'textDocument/completion') {
                const id = [...session.servers.entries()].find(([, candidate]) => candidate === server)?.[0];
                return id ? session.completions.tokenize(result, id) : result;
            }
            return result;
        },
        async stopAll() {
            await Promise.all([...sessions.keys()].map((id) => stopSession(id)));
        },
    };
}
