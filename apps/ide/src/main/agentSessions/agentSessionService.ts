import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { detectLocalServers, listLocalModels, type FetchFn } from '@codexr/local-models/discovery.ts';
import { isLocalServerId, normalizeLocalBaseUrl } from '@codexr/local-models/servers.ts';
import type {
    InitializeResponse,
    McpServer,
    ReadTextFileRequest,
    ReadTextFileResponse,
    RequestPermissionRequest,
    RequestPermissionResponse,
    SessionConfigOption,
    SessionModeState,
    SessionUpdate,
    WriteTextFileRequest,
} from '@agentclientprotocol/sdk';
import {
    applySessionEvent,
    emptySession,
    summarize,
    titleFromPrompt,
    type AgentSessionMessage,
    type AgentSessionState,
    type AgentView,
    type ChangeDiffView,
    type ChatChanges,
    type ImportableSession,
    type InstallDescription,
    type LoginTerminal,
    type PermissionOptionView,
    type ProjectSessions,
    type PromptAttachment,
    type SessionEvent,
    type SessionSummary,
    type ToolKind,
    type TurnMetricDeltaView,
    type SessionWorktree,
    type WorktreeAvailabilityView,
    type WorktreeCommitView,
    type WorktreeMergeView,
    type WorktreeStatusView,
    type DetectedLocalServer,
    type LocalModelList,
} from '../../shared/agentSession.ts';
import { normalizeProjectPath } from '../checkpoints/checkpointStore.ts';
import { isSameOrInside } from '../trust/trustModel.ts';
import { AcpConnection, type AcpClientHandlers, type AgentLaunch } from './acpConnection.ts';
import {
    attachmentLabel,
    buildPromptBlocks,
    errorMessage,
    isAuthRequiredError,
    mapAuthMethods,
    mapConfigOptions,
    mapModes,
    mapSessionUpdate,
    sliceLines,
    stopReasonOf,
    toolEvent,
    toolKindOf,
    type MappingContext,
    type ResolvedAttachment,
} from './acpMapping.ts';
import { loginProgram, nativeLoginProgram, type AgentCatalog } from './agentCatalog.ts';
import { parsePresetId, type AgentInstaller } from './agentInstaller.ts';
import { AgentTerminals } from './agentTerminals.ts';
import { isSessionId, type SessionStore } from './sessionStore.ts';
import { canUseWorktrees, commitAll, createWorktree, mergeIntoCurrent, removeWorktree, worktreeStatus, WorktreeError, type WorktreeInfo } from '../worktrees/worktreeManager.ts';
import { runWorktreeGit } from '../worktrees/worktreeGit.ts';

/**
 * AF1: the agent-first chat in the main process. It owns the authoritative
 * state of every open chat, starts one ACP agent process per chat when the
 * chat first needs it (in the chat's project folder, only when that folder is
 * trusted), turns the agent's `session/update`s into `SessionEvent`s, applies
 * them with the shared reducer and streams them to the window that owns the
 * chat, and answers the agent's requests: files inside the project, terminals
 * shown in tool cards, and permissions the person answers in the chat
 * (`allow_always` / `reject_always` are remembered per agent and tool kind).
 *
 * A chat belongs to the folder open in the window that created it; another
 * window can read it but only a window with that folder open can continue it.
 * No Electron here: windows are `WindowPort`s and everything the IDE provides
 * (files, terminals, trust, checkpoints, MCP servers) is injected, so the
 * whole flow is unit-tested against an in-process fake agent.
 */

/** The window side of a chat: where its events go. `id` is the webContents id. */
export interface WindowPort {
    readonly id: number;
    send(message: AgentSessionMessage): void;
    isDestroyed(): boolean;
}

export interface KeyValueStore {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Promise<void>;
}

export interface AgentSessionServiceOptions {
    readonly catalog: AgentCatalog;
    /** #311/#314: how local model servers are asked for their models (Node's fetch by default; tests inject one). */
    readonly localFetch?: FetchFn;
    /** AF2: installs presets' adapters on request; absent in the smoke run (no download may happen). */
    readonly installer?: AgentInstaller;
    readonly store: SessionStore;
    /** Where `allow_always` / `reject_always` answers are kept. */
    readonly decisions: KeyValueStore;
    /** The folder open in the window, or null. */
    readonly rootOf: (window: WindowPort) => string | null;
    readonly isTrusted: (window: WindowPort) => boolean;
    /** The text the agent reads for a file: the window's unsaved buffer when the IDE has one, else the disk. */
    readonly readText: (absolutePath: string) => Promise<string>;
    readonly writeText: (absolutePath: string, content: string) => Promise<void>;
    /**
     * Runs an agent's login command in a new terminal of the window (terminal
     * login methods): resolves once it runs, with a promise of its exit code.
     */
    /**
     * #297: runs a login program directly (no shell) in a terminal of the window.
     */
    readonly openTerminal: (window: WindowPort, request: { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly title: string; readonly cols: number; readonly rows: number }) => Promise<{ readonly terminal: LoginTerminal; readonly exited: Promise<number> }>;
    /** The MCP servers every chat gets in `session/new` and `session/load` (the IDE's own server). Default none. */
    readonly mcpServers?: (workspaceRoot: string | null) => readonly McpServer[];
    /** Takes a checkpoint before a prompt is sent (AF6); its id is recorded on the person's message. */
    readonly beforePrompt?: (sessionId: string, workspaceRoot: string) => Promise<{ readonly checkpointId: string } | null>;
    /**
     * After each turn: how many files the agent changed that still await
     * review (AF5), sent as `pending-changes`. `turnId` is the id of the
     * turn-end item, for `attachMetricDelta` (AF9).
     */
    readonly afterTurn?: (sessionId: string, workspaceRoot: string, turnId: string) => Promise<number | null>;
    /**
     * AF12: the IDE's own folder for chat worktrees (`<userData>/worktrees`),
     * outside every project; absent, a chat cannot have a worktree.
     */
    readonly worktreeStorageDir?: string;
    /** The review of a chat's changes and its checkpoints (AF5, AF6); absent, the review calls refuse. */
    readonly review?: ChangeReview;
    /** Starts an agent (tests connect to an in-process agent instead). */
    readonly connect?: (launch: AgentLaunch, cwd: string, handlers: AcpClientHandlers) => AcpConnection;
    /** False in the smoke run: no agent process may start. */
    readonly spawnAllowed: boolean;
    /** An empty folder of the IDE's own where agents are probed and logged in. */
    readonly probeDir: string;
    readonly homeDir: string;
    /** The environment of the commands agents run in terminals. */
    readonly terminalEnv: Readonly<Record<string, string>>;
    readonly platform?: NodeJS.Platform;
    readonly log?: (line: string) => void;
    readonly now?: () => string;
    /** How long an agent has to start (`initialize` plus `session/new`), ms. */
    readonly startTimeoutMs?: number;
    /** How long a cancelled turn may take to end before the agent is stopped, ms. */
    readonly cancelGraceMs?: number;
}

/** What the chat needs from the checkpoints (AF5, AF6): `SessionChanges` in the IDE. Paths are project-relative. */
export interface ChangeReview {
    pending(sessionId: string, root: string): Promise<ChatChanges>;
    diff(sessionId: string, root: string, path: string): Promise<{ readonly oldText: string | null; readonly newText: string | null }>;
    keep(sessionId: string, root: string, paths: readonly string[] | 'all'): Promise<void>;
    undo(sessionId: string, root: string, paths: readonly string[] | 'all'): Promise<unknown>;
    previewRestore(root: string, checkpointId: string): Promise<string[]>;
    restoreCheckpoint(root: string, checkpointId: string): Promise<string[]>;
    forget?(sessionId: string): Promise<void>;
}

const MAX_REVIEW_PATHS = 5000;

/** Paths from the renderer: an array of project-relative paths (normalised), or 'all'. */
function reviewPaths(value: unknown): readonly string[] | 'all' {
    if (value === 'all') {
        return 'all';
    }
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REVIEW_PATHS) {
        throw new Error('Invalid list of files.');
    }
    return [...new Set(value.map((entry) => normalizeProjectPath(requireString(entry, 'file path'))))];
}

interface PendingPermission {
    readonly options: readonly PermissionOptionView[];
    readonly toolKind: ToolKind;
    readonly resolve: (response: RequestPermissionResponse) => void;
}

interface AgentRuntime {
    readonly connection: AcpConnection;
    readonly sessionId: string;
    readonly init: InitializeResponse;
    readonly terminals: AgentTerminals;
}

interface Live {
    state: AgentSessionState;
    readonly root: string;
    ownerId: number | null;
    agent: AgentRuntime | null;
    starting: Promise<AgentRuntime> | null;
    turnActive: boolean;
    cancelRequested: boolean;
    cancelTimer: ReturnType<typeof setTimeout> | null;
    replaying: boolean;
    /** #298: the person's messages of an imported history arrive in chunks; they are joined here. */
    importedUser: string | null;
    configRaw: readonly SessionConfigOption[];
    readonly permissions: Map<string, PendingPermission>;
    readonly terminalBuffer: Map<string, { output: string; exitCode?: number | null; truncated: boolean }>;
    terminalTimer: ReturnType<typeof setTimeout> | null;
}

const DECISIONS_KEY = 'decisions';
const MAX_PROMPT_LENGTH = 200_000;
const MAX_ATTACHMENTS = 50;
const MAX_EMBEDDED_FILE = 256 * 1024;
const MAX_READ_FILE = 10 * 1024 * 1024;
const TERMINAL_FLUSH_MS = 50;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** #298: at most this many chats are offered for import, read in at most this many pages. */
const MAX_IMPORT = 200;
const MAX_IMPORT_PAGES = 20;

/** #298: an imported chat's title: the agent's, cleaned, or a neutral one. */
function importTitle(value: unknown): string {
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    return text ? (text.length > 80 ? `${text.slice(0, 79)}...` : text) : 'Imported chat';
}

/** Fails with `message` when `promise` takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(errorMessage(error)));
            },
        );
    });
}

function requireString(value: unknown, what: string, max = 4096): string {
    if (typeof value !== 'string' || !value || value.length > max) {
        throw new Error(`Invalid ${what}.`);
    }
    return value;
}

async function isDirectory(dir: string): Promise<boolean> {
    return (await fs.promises.stat(dir).catch(() => null))?.isDirectory() === true;
}

/** AF12: the project's current branch (where a merge lands), or null when detached or unknown. */
async function currentBranch(repoRoot: string): Promise<string | null> {
    try {
        const result = await runWorktreeGit(repoRoot, ['symbolic-ref', '-q', '--short', 'HEAD'], { okExitCodes: [1] });
        return result.exitCode === 0 ? result.stdout.trim() || null : null;
    } catch {
        return null;
    }
}

/** A handler set that refuses everything: probes and logins never run a turn. */
const REFUSING_HANDLERS: AcpClientHandlers = {
    onUpdate: () => undefined,
    requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
    readTextFile: () => Promise.reject(new Error('No project is open for this agent.')),
    writeTextFile: () => Promise.reject(new Error('No project is open for this agent.')),
    createTerminal: () => Promise.reject(new Error('No project is open for this agent.')),
    terminalOutput: () => {
        throw new Error('Unknown terminal.');
    },
    waitForTerminalExit: () => Promise.reject(new Error('Unknown terminal.')),
    killTerminal: () => undefined,
    releaseTerminal: () => undefined,
};

export class AgentSessionService {
    private readonly options: AgentSessionServiceOptions;
    private readonly live = new Map<string, Live>();
    private readonly ports = new Map<number, WindowPort>();
    private readonly platform: NodeJS.Platform;
    private readonly now: () => string;
    private sessionsChangedTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;
    private storageReal: string | null | undefined = undefined;

    constructor(options: AgentSessionServiceOptions) {
        this.options = options;
        this.platform = options.platform ?? process.platform;
        this.now = options.now ?? (() => new Date().toISOString());
    }

    // ---- Agents -------------------------------------------------------------

    listAgents(window: WindowPort): Promise<readonly AgentView[]> {
        this.remember(window);
        return this.options.catalog.list();
    }

    async probeAgent(window: WindowPort, ref: unknown): Promise<AgentView> {
        this.remember(window);
        const agentRef = requireString(ref, 'agent', 200);
        const builtin = agentRef.startsWith('builtin:') ? await this.options.catalog.builtinView(agentRef) : null;
        if (builtin) {
            return builtin;
        }
        const definition = this.options.catalog.definition(agentRef);
        if (!definition) {
            throw new Error('Unknown agent.');
        }
        const resolution = await this.options.catalog.resolve(definition);
        if (!resolution.found || !this.options.spawnAllowed) {
            return this.options.catalog.view(definition);
        }
        const connection = await this.openScratchConnection(resolution.launch);
        try {
            await this.checkLogin(agentRef, connection);
        } finally {
            connection.close();
        }
        this.broadcast({ kind: 'agents-changed' });
        return this.options.catalog.view(definition);
    }

    async saveCustomAgent(window: WindowPort, input: unknown, id: unknown, confirm: (commandLine: string) => Promise<boolean>): Promise<AgentView> {
        this.remember(window);
        const existing = typeof id === 'string' ? this.options.catalog.customAgents().find((agent) => agent.id === id) : undefined;
        const parsedLine = (() => {
            const value = input as { command?: unknown; args?: unknown } | null;
            const parts = [String(value?.command ?? ''), ...(Array.isArray(value?.args) ? value.args.map(String) : [])];
            return parts.map((part) => (/\s|^$/.test(part) ? `"${part}"` : part)).join(' ');
        })();
        // The command line came from the page: the person confirms it in a dialog the page cannot answer,
        // unless it is exactly what was confirmed before.
        const unchanged = existing && JSON.stringify([existing.command, existing.args, existing.env ?? {}]) === JSON.stringify([(input as { command?: unknown })?.command, (input as { args?: unknown })?.args ?? [], (input as { env?: unknown })?.env ?? {}]);
        if (!unchanged && !(await confirm(parsedLine))) {
            throw new Error('The agent was not saved.');
        }
        const definition = await this.options.catalog.saveCustom(input, id);
        this.broadcast({ kind: 'agents-changed' });
        return this.options.catalog.view(definition);
    }

    async removeCustomAgent(window: WindowPort, id: unknown): Promise<void> {
        this.remember(window);
        await this.options.catalog.removeCustom(id);
        this.broadcast({ kind: 'agents-changed' });
    }

    /** #313: local models run the IDE's own agent bundle, so no command line needs confirming. */
    async saveLocalModel(window: WindowPort, input: unknown, id: unknown): Promise<AgentView> {
        this.remember(window);
        const definition = await this.options.catalog.saveLocal(input, id);
        this.broadcast({ kind: 'agents-changed' });
        return this.options.catalog.view(definition);
    }

    async removeLocalModel(window: WindowPort, id: unknown): Promise<void> {
        this.remember(window);
        await this.options.catalog.removeLocal(id);
        this.broadcast({ kind: 'agents-changed' });
    }

    private localFetch(): FetchFn {
        return this.options.localFetch ?? ((input, init) => fetch(input, init));
    }

    /** #311: the models a local server offers; a saved model's stored key is used when none is typed. */
    async listLocalModels(window: WindowPort, server: unknown, baseUrl: unknown, apiKey: unknown, id: unknown): Promise<LocalModelList> {
        this.remember(window);
        if (!isLocalServerId(server)) {
            return { ok: false, error: 'Pick the server that runs the model.' };
        }
        let url: string;
        try {
            url = normalizeLocalBaseUrl(typeof baseUrl === 'string' && baseUrl.length <= 2048 ? baseUrl : '');
        } catch (error) {
            return { ok: false, error: errorMessage(error) };
        }
        const typed = typeof apiKey === 'string' && apiKey.trim() && apiKey.length <= 4096 ? apiKey.trim() : undefined;
        const stored = !typed && typeof id === 'string' ? this.options.catalog.localKey(id) : undefined;
        return listLocalModels(url, { fetch: this.localFetch(), apiKey: typed ?? stored, serverId: server });
    }

    /** #314: probes the known servers' default ports on this machine, only now that the person asked. */
    async detectLocalServers(window: WindowPort): Promise<DetectedLocalServer[]> {
        this.remember(window);
        const found = await detectLocalServers(this.localFetch());
        return found.map((entry) => ({ server: entry.serverId, label: entry.label, baseUrl: entry.baseUrl, models: entry.models }));
    }

    async login(window: WindowPort, ref: unknown, methodId: unknown, cols?: unknown, rows?: unknown): Promise<LoginTerminal | null> {
        this.remember(window);
        const agentRef = requireString(ref, 'agent', 200);
        const method = requireString(methodId, 'login method', 200);
        const definition = this.options.catalog.definition(agentRef);
        if (!definition) {
            throw new Error('Only an ACP agent signs in here; the built-in agent uses the keys of the Agents view.');
        }
        if (!this.options.spawnAllowed) {
            throw new Error('Agents cannot start in this mode.');
        }
        const resolution = await this.options.catalog.resolve(definition);
        if (!resolution.found) {
            throw new Error(resolution.detail);
        }
        if (!this.options.catalog.state(agentRef)?.authMethods) {
            await this.probeAgent(window, agentRef);
        }
        const spec = this.options.catalog.state(agentRef)?.authMethods?.find((candidate) => candidate.view.id === method);
        if (!spec) {
            throw new Error('The agent does not offer that login method.');
        }
        if (spec.view.type === 'env') {
            throw new Error(`${spec.view.name}: put the key in the agent's environment (a custom agent's environment, or the environment the IDE starts with), then try again.`);
        }
        if (spec.view.type === 'terminal') {
            const launch = resolution.launch;
            const program = await nativeLoginProgram(loginProgram(launch, spec), {
                platform: this.platform,
                arch: process.arch,
                env: launch.env,
                exists: (file) => fs.promises.stat(file).then((stat) => stat.isFile(), () => false),
            });
            const cwd = this.options.rootOf(window) ?? this.options.homeDir;
            const size = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 1000 ? value : fallback);
            const opened = await this.options.openTerminal(window, {
                ...program,
                cwd,
                env: { ...launch.env, ...(spec.env ?? {}) },
                title: `${definition.name}: ${spec.view.name}`,
                cols: size(cols, 100),
                rows: size(rows, 30),
            });
            // Once the login command ends, the agent is probed again; the picker hears `agents-changed`.
            void opened.exited
                .then(() => this.probeAgent(window, agentRef))
                .catch((error: unknown) => this.options.log?.(`Could not check ${definition.name} after its login: ${errorMessage(error)}`));
            return opened.terminal;
        }
        const connection = await this.openScratchConnection(resolution.launch);
        try {
            await withTimeout(connection.authenticate(method), LOGIN_TIMEOUT_MS, 'The login took too long.');
            await this.checkLogin(agentRef, connection);
        } finally {
            connection.close();
        }
        this.broadcast({ kind: 'agents-changed' });
        return null;
    }

    // ---- Installing presets (AF2) ------------------------------------------

    private requireInstaller(): AgentInstaller {
        if (!this.options.installer) {
            throw new Error('Installing agents is not available in this mode.');
        }
        return this.options.installer;
    }

    /** What installing a preset would download: read from the registry now, because the person asked. */
    describeInstall(window: WindowPort, presetId: unknown): Promise<InstallDescription> {
        this.remember(window);
        const id = parsePresetId(presetId);
        return this.requireInstaller().describe(id);
    }

    /**
     * Installs or updates a preset after `confirm` (a native dialog the page
     * cannot answer) accepted the description. npm's output streams to every
     * window as `install-progress`; the agents list hears `agents-changed`.
     */
    async installAgent(window: WindowPort, presetIdInput: unknown, confirm: (description: InstallDescription) => Promise<boolean>): Promise<boolean> {
        this.remember(window);
        const presetId = parsePresetId(presetIdInput);
        const installer = this.requireInstaller();
        const progress = (extra: { line?: string; done?: boolean; error?: string }): void => this.broadcast({ kind: 'install-progress', presetId, action: 'install', ...extra });
        let started = false;
        try {
            const done = await installer.install(presetId, async (description) => {
                started = await confirm(description);
                return started;
            }, (line) => progress({ line }));
            if (started) {
                progress({ done: true });
            }
            return done;
        } catch (error) {
            if (started) {
                progress({ done: true, error: errorMessage(error) });
            }
            throw error;
        } finally {
            if (started) {
                this.options.catalog.forget(`acp:${presetId}`);
                this.broadcast({ kind: 'agents-changed' });
            }
        }
    }

    /** Removes a preset the IDE installed, after `confirm`. */
    async uninstallAgent(window: WindowPort, presetIdInput: unknown, confirm: (packageName: string, version: string) => Promise<boolean>): Promise<boolean> {
        this.remember(window);
        const presetId = parsePresetId(presetIdInput);
        const installer = this.requireInstaller();
        const progress = (extra: { line?: string; done?: boolean; error?: string }): void => this.broadcast({ kind: 'install-progress', presetId, action: 'uninstall', ...extra });
        let started = false;
        try {
            const done = await installer.uninstall(presetId, async (packageName, version) => {
                started = await confirm(packageName, version);
                return started;
            }, (line) => progress({ line }));
            if (started) {
                progress({ done: true });
            }
            return done;
        } catch (error) {
            if (started) {
                progress({ done: true, error: errorMessage(error) });
            }
            throw error;
        } finally {
            if (started) {
                this.options.catalog.forget(`acp:${presetId}`);
                this.broadcast({ kind: 'agents-changed' });
            }
        }
    }

    /** Starts an agent in the IDE's own empty folder, initialised and recorded in the catalogue. */
    private async openScratchConnection(launch: AgentLaunch): Promise<AcpConnection> {
        await fs.promises.mkdir(this.options.probeDir, { recursive: true });
        const connection = this.connectAgent(launch, this.options.probeDir, REFUSING_HANDLERS);
        return connection;
    }

    /** `initialize` then `session/new`: ready, needs a login, or failing (and why). */
    private async checkLogin(agentRef: string, connection: AcpConnection): Promise<void> {
        const timeout = this.options.startTimeoutMs ?? 60_000;
        let init: InitializeResponse;
        try {
            init = await withTimeout(connection.initialize(), timeout, 'The agent did not answer initialize in time.');
        } catch (error) {
            this.options.catalog.setState(agentRef, { availability: 'error', detail: errorMessage(error) });
            return;
        }
        const authMethods = mapAuthMethods(init.authMethods ?? []);
        // #297: an agent may open a session while signed out and only refuse the
        // first prompt (Claude Code does), so ask who is signed in when it can say.
        const status = await readAuthStatus(connection, init, timeout);
        if (status.state === 'unauthenticated') {
            this.options.catalog.setState(agentRef, { availability: 'needs-login', detail: 'Not signed in. Use one of its sign-in buttons.', authMethods });
            return;
        }
        try {
            await withTimeout(connection.newSession(this.options.probeDir, []), timeout, 'The agent did not open a session in time.');
            this.options.catalog.setState(agentRef, { availability: 'ready', authMethods, ...(status.account ? { detail: `Signed in as ${status.account}.` } : {}) });
        } catch (error) {
            this.options.catalog.setState(agentRef, isAuthRequiredError(error)
                ? { availability: 'needs-login', detail: 'Log in to use this agent.', authMethods }
                : { availability: 'error', detail: errorMessage(error), authMethods });
        }
    }

    /** #298: the joined message of the person in an imported replay becomes a message of the chat. */
    private flushImportedUser(live: Live): void {
        const text = live.importedUser;
        live.importedUser = null;
        if (text !== null && text.trim()) {
            this.emit(live, { type: 'user', id: randomUUID(), text, at: live.state.updatedAt });
        }
    }

    /**
     * #298: the chats the agent keeps in its own history for the open folder
     * (ACP `session/list`), less those already in the IDE. The agent reads its
     * own files; the IDE never opens them.
     */
    async listImportable(window: WindowPort, ref: unknown): Promise<ImportableSession[]> {
        this.remember(window);
        const agentRef = requireString(ref, 'agent', 200);
        const root = this.options.rootOf(window);
        if (!root) {
            throw new Error('Open a folder to import its chats.');
        }
        if (!this.options.isTrusted(window)) {
            throw new Error('This folder is in Restricted Mode. Trust it to start an agent.');
        }
        const definition = this.options.catalog.definition(agentRef);
        if (!definition) {
            throw new Error('Only an ACP agent keeps a history to import.');
        }
        const resolution = await this.options.catalog.resolve(definition);
        if (!resolution.found) {
            throw new Error(resolution.detail);
        }
        const connection = this.connectAgent(resolution.launch, root, REFUSING_HANDLERS);
        const timeout = this.options.startTimeoutMs ?? 60_000;
        try {
            const init = await withTimeout(connection.initialize(), timeout, 'The agent did not answer initialize in time.');
            if (!init.agentCapabilities?.sessionCapabilities?.list || !init.agentCapabilities.loadSession) {
                throw new Error(`${definition.name} cannot list or reopen its earlier chats, so there is nothing to import.`);
            }
            const known = await this.linkedAgentSessions(root, agentRef);
            const found: ImportableSession[] = [];
            let cursor: string | undefined;
            for (let page = 0; page < MAX_IMPORT_PAGES; page += 1) {
                const response = await withTimeout(connection.listSessions(root, cursor), timeout, 'The agent did not list its chats in time.');
                for (const info of response.sessions) {
                    if (typeof info.sessionId !== 'string' || !info.sessionId || info.sessionId.length > 200 || known.has(info.sessionId)) {
                        continue;
                    }
                    // Only the chats of this folder: an agent may ignore the filter.
                    if (typeof info.cwd === 'string' && !isSameOrInside(root, info.cwd, this.platform)) {
                        continue;
                    }
                    found.push({ agentSessionId: info.sessionId, title: importTitle(info.title), updatedAt: typeof info.updatedAt === 'string' ? info.updatedAt : null });
                }
                cursor = typeof response.nextCursor === 'string' && response.nextCursor ? response.nextCursor : undefined;
                if (!cursor || found.length >= MAX_IMPORT) {
                    break;
                }
            }
            return found.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, MAX_IMPORT);
        } catch (error) {
            if (isAuthRequiredError(error)) {
                throw new Error(`${definition.name} needs you to sign in first.`);
            }
            throw error;
        } finally {
            connection.close();
        }
    }

    /** #298: adds chats of the agent's history to the folder's list; each reads its messages when first opened. */
    async importSessions(window: WindowPort, ref: unknown, sessions: unknown): Promise<number> {
        this.remember(window);
        const agentRef = requireString(ref, 'agent', 200);
        const root = this.options.rootOf(window);
        if (!root) {
            throw new Error('Open a folder to import its chats.');
        }
        const definition = this.options.catalog.definition(agentRef);
        if (!definition) {
            throw new Error('Only an ACP agent keeps a history to import.');
        }
        if (!Array.isArray(sessions) || sessions.length > MAX_IMPORT) {
            throw new Error(`Import at most ${MAX_IMPORT} chats at a time.`);
        }
        const known = await this.linkedAgentSessions(root, agentRef);
        let added = 0;
        for (const raw of sessions as unknown[]) {
            const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
            const agentSessionId = record['agentSessionId'];
            if (typeof agentSessionId !== 'string' || !agentSessionId || agentSessionId.length > 200 || known.has(agentSessionId)) {
                continue;
            }
            const updatedAt = typeof record['updatedAt'] === 'string' && !Number.isNaN(Date.parse(record['updatedAt'])) ? new Date(record['updatedAt']).toISOString() : this.now();
            const base = emptySession({ id: randomUUID(), title: importTitle(record['title']), agentRef, agentName: definition.name, workspaceRoot: root, createdAt: updatedAt, updatedAt });
            const state: AgentSessionState = { ...base, agentSessionId, historyPending: true };
            known.add(agentSessionId);
            this.track(state, root, window.id);
            await this.options.store.saveNow(state);
            added += 1;
        }
        if (added > 0) {
            this.sessionsChanged();
        }
        return added;
    }

    /** The agent-side ids of the folder's chats with `agentRef`, so a chat is not imported twice. */
    private async linkedAgentSessions(root: string, agentRef: string): Promise<Set<string>> {
        const ids = new Set<string>();
        const projects = await this.options.store.listProjects(root);
        for (const summary of projects.find((project) => project.root === root)?.sessions ?? []) {
            if (summary.agentRef !== agentRef) {
                continue;
            }
            const state = this.live.get(summary.id)?.state ?? (await this.options.store.load(root, summary.id));
            if (state?.agentSessionId) {
                ids.add(state.agentSessionId);
            }
        }
        return ids;
    }

    private connectAgent(launch: AgentLaunch, cwd: string, handlers: AcpClientHandlers): AcpConnection {
        if (!this.options.spawnAllowed || this.stopped) {
            throw new Error('Agents cannot start in this mode.');
        }
        return this.options.connect ? this.options.connect(launch, cwd, handlers) : AcpConnection.spawn(launch, cwd, handlers, (line) => this.options.log?.(line));
    }

    // ---- Chats --------------------------------------------------------------

    async listProjects(window: WindowPort): Promise<readonly ProjectSessions[]> {
        this.remember(window);
        return this.options.store.listProjects(this.options.rootOf(window), (summary) => {
            const live = this.live.get(summary.id);
            return live ? summarize(live.state) : summary;
        });
    }

    async get(window: WindowPort, sessionId: unknown): Promise<AgentSessionState> {
        this.remember(window);
        const live = await this.open(window, sessionId);
        // #298: an imported chat reads its messages from the agent when it is first opened.
        if (live.state.historyPending && this.options.spawnAllowed && this.options.isTrusted(window) && this.options.rootOf(window) === live.root) {
            void this.ensureAgent(live, window).catch((error: unknown) => this.reportStartFailure(live, error));
        }
        return live.state;
    }

    async create(window: WindowPort, agentRef: unknown, createOptions?: unknown): Promise<AgentSessionState> {
        this.remember(window);
        const ref = requireString(agentRef, 'agent', 200);
        if (ref.startsWith('builtin:')) {
            throw new Error('Use the Agents view for the built-in agent for now.');
        }
        const root = this.options.rootOf(window);
        if (!root) {
            throw new Error('Open a folder to start a chat.');
        }
        const definition = this.options.catalog.definition(ref);
        if (!definition) {
            throw new Error('Unknown agent.');
        }
        const wantsWorktree = !!createOptions && typeof createOptions === 'object' && (createOptions as { worktree?: unknown }).worktree === true;
        const id = randomUUID();
        let worktree: SessionWorktree | null = null;
        let dirty = false;
        if (wantsWorktree) {
            // AF12: git creates the worktree with no hook of the repository; still, only a trusted folder gets one.
            if (!this.options.isTrusted(window)) {
                throw new Error('This folder is in Restricted Mode. Trust it to start a chat in its own worktree.');
            }
            const created = await this.worktreeCall(() => createWorktree({ projectRoot: root, storageDir: this.requireWorktreeStorage(), sessionId: id, label: definition.name }));
            worktree = { branch: created.branch, path: created.path, cwd: created.cwd, baseCommit: created.baseCommit, repoRoot: created.repoRoot };
            dirty = created.dirty;
        }
        const at = this.now();
        const state = emptySession({ id, title: 'New chat', agentRef: ref, agentName: definition.name, workspaceRoot: root, createdAt: at, updatedAt: at, ...(worktree ? { worktree } : {}) });
        const live = this.track(state, root, window.id);
        if (worktree && dirty) {
            this.emit(live, { type: 'notice', id: randomUUID(), level: 'info', text: `This chat works on the branch ${worktree.branch}, started from the project's last commit. Your uncommitted changes in the project are not in its worktree.` });
        }
        await this.options.store.saveNow(live.state);
        this.sessionsChanged();
        // The agent starts now, so its modes, models and commands are there before the first message.
        if (this.options.spawnAllowed && this.options.isTrusted(window)) {
            void this.ensureAgent(live, window).catch((error: unknown) => this.reportStartFailure(live, error));
        }
        return live.state;
    }

    async prompt(window: WindowPort, sessionId: unknown, text: unknown, attachments: unknown): Promise<void> {
        this.remember(window);
        if (typeof text !== 'string' || text.length > MAX_PROMPT_LENGTH || (!text.trim() && !(Array.isArray(attachments) && attachments.length))) {
            throw new Error('A message needs text of at most 200,000 characters.');
        }
        const live = await this.open(window, sessionId);
        this.assertContinuable(live, window);
        if (live.turnActive) {
            throw new Error('The agent is still answering; wait for it or stop it first.');
        }
        live.turnActive = true;
        live.cancelRequested = false;
        let resolved: ResolvedAttachment[];
        let labels: string[];
        try {
            ({ resolved, labels } = await this.resolveAttachments(this.workRoot(live), attachments));
        } catch (error) {
            live.turnActive = false;
            throw error;
        }
        try {
            const checkpoint = await this.hook('beforePrompt', () => this.options.beforePrompt?.(live.state.id, this.workRoot(live))).then((result) => result?.checkpointId ?? null);
            const firstMessage = !live.state.items.some((item) => item.kind === 'user');
            this.emit(live, { type: 'user', id: randomUUID(), text, at: this.now(), ...(labels.length ? { attachments: labels } : {}), ...(checkpoint ? { checkpoint } : {}) });
            if (firstMessage && live.state.title === 'New chat') {
                this.emit(live, { type: 'title', title: titleFromPrompt(text) });
            }
            this.sessionsChanged();
            const agent = await this.ensureAgent(live, window);
            const embedded = agent.init.agentCapabilities?.promptCapabilities?.embeddedContext === true;
            const response = await agent.connection.prompt(agent.sessionId, buildPromptBlocks(text, resolved, embedded));
            this.flushTerminalOutput(live);
            const turnId = randomUUID();
            this.emit(live, { type: 'turn-end', id: turnId, stopReason: live.cancelRequested ? 'cancelled' : stopReasonOf(response.stopReason), at: this.now() });
            await this.reportPendingChanges(live, turnId);
        } catch (error) {
            this.flushTerminalOutput(live);
            this.cancelPermissions(live);
            const turnId = randomUUID();
            if (live.cancelRequested) {
                this.emit(live, { type: 'turn-end', id: turnId, stopReason: 'cancelled', at: this.now() });
            } else {
                this.reportFailure(live, error);
                this.emit(live, { type: 'turn-end', id: turnId, stopReason: 'error', at: this.now() });
            }
            await this.reportPendingChanges(live, turnId);
        } finally {
            live.turnActive = false;
            live.cancelRequested = false;
            if (live.cancelTimer) {
                clearTimeout(live.cancelTimer);
                live.cancelTimer = null;
            }
            await this.options.store.saveNow(live.state).catch((error: unknown) => this.options.log?.(`Could not save chat ${live.state.id}: ${errorMessage(error)}`));
            this.sessionsChanged();
        }
    }

    async cancel(window: WindowPort, sessionId: unknown): Promise<void> {
        this.remember(window);
        const live = await this.open(window, sessionId);
        if (!live.turnActive) {
            return;
        }
        live.cancelRequested = true;
        // ACP: after session/cancel the client answers every pending permission with `cancelled`.
        this.cancelPermissions(live);
        const agent = live.agent;
        if (!agent) {
            return;
        }
        await agent.connection.cancel(agent.sessionId).catch(() => undefined);
        // An agent that does not end the turn is stopped; the next message starts it again.
        live.cancelTimer ??= setTimeout(() => {
            live.cancelTimer = null;
            if (live.turnActive && live.agent === agent) {
                agent.connection.close();
            }
        }, this.options.cancelGraceMs ?? 15_000);
    }

    async respondPermission(window: WindowPort, sessionId: unknown, requestId: unknown, optionId: unknown): Promise<void> {
        this.remember(window);
        const live = await this.open(window, sessionId);
        const id = requireString(requestId, 'request', 200);
        const option = requireString(optionId, 'option', 200);
        const pending = live.permissions.get(id);
        if (!pending) {
            throw new Error('That request was already answered.');
        }
        const chosen = pending.options.find((candidate) => candidate.id === option);
        if (!chosen) {
            throw new Error('That option is not one the agent offered.');
        }
        if (chosen.kind === 'allow_always' || chosen.kind === 'reject_always') {
            await this.rememberDecision(live.state.agentRef, pending.toolKind, chosen.kind === 'allow_always' ? 'allow' : 'reject');
        }
        this.settlePermission(live, id, { outcome: { outcome: 'selected', optionId: chosen.id } }, chosen.id);
    }

    async setMode(window: WindowPort, sessionId: unknown, modeId: unknown): Promise<void> {
        this.remember(window);
        const live = await this.open(window, sessionId);
        const mode = requireString(modeId, 'mode', 200);
        this.assertContinuable(live, window);
        const agent = await this.ensureAgent(live, window);
        await agent.connection.setMode(agent.sessionId, mode);
        this.emit(live, { type: 'modes', current: mode });
    }

    async setConfigOption(window: WindowPort, sessionId: unknown, optionId: unknown, valueId: unknown): Promise<void> {
        this.remember(window);
        const live = await this.open(window, sessionId);
        const configId = requireString(optionId, 'option', 200);
        const value = requireString(valueId, 'value', 400);
        this.assertContinuable(live, window);
        const agent = await this.ensureAgent(live, window);
        const raw = live.configRaw.find((option) => option.id === configId);
        const response = await agent.connection.setConfigOption(agent.sessionId, configId, raw?.type === 'boolean' ? value === 'true' : value);
        live.configRaw = response.configOptions;
        this.emit(live, { type: 'config', options: mapConfigOptions(response.configOptions) });
    }

    async rename(window: WindowPort, sessionId: unknown, title: unknown): Promise<SessionSummary> {
        this.remember(window);
        const live = await this.open(window, sessionId);
        const next = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
        if (!next || next.length > 200) {
            throw new Error('A chat title needs 1 to 200 characters.');
        }
        this.emit(live, { type: 'title', title: next });
        await this.options.store.saveNow(live.state);
        this.sessionsChanged();
        return summarize(live.state);
    }

    async remove(window: WindowPort, sessionId: unknown, removeOptions?: unknown): Promise<void> {
        this.remember(window);
        const live = await this.open(window, sessionId);
        const removeWorktreeToo = !!removeOptions && typeof removeOptions === 'object' && (removeOptions as { removeWorktree?: unknown }).removeWorktree === true;
        const worktree = live.state.worktree;
        if (removeWorktreeToo && worktree && !worktree.removed) {
            // AF12: the worktree goes first, so a refusal keeps the chat that names it.
            if (this.options.rootOf(window) !== live.root) {
                throw new Error(`This chat belongs to ${live.root}; open that folder to remove its worktree.`);
            }
            this.stopAgent(live);
            await this.worktreeCall(() => removeWorktree(this.worktreeInfo(live), { deleteBranch: true }));
        }
        this.stopAgent(live);
        this.live.delete(live.state.id);
        await this.options.store.remove(live.root, live.state.id);
        await this.hook('review.forget', () => this.options.review?.forget?.(live.state.id));
        this.sessionsChanged();
    }

    async markRead(window: WindowPort, sessionId: unknown): Promise<void> {
        this.remember(window);
        const live = await this.open(window, sessionId);
        if (!live.state.unread) {
            return;
        }
        this.emit(live, { type: 'read' });
        this.sessionsChanged();
    }

    // ---- Review of changes and checkpoints (AF5, AF6, AF9) ---------------------

    async changes(window: WindowPort, sessionId: unknown): Promise<ChatChanges> {
        const { live, review } = await this.reviewOf(window, sessionId, false);
        return this.refreshChanges(live, review);
    }

    async changeDiff(window: WindowPort, sessionId: unknown, filePath: unknown): Promise<ChangeDiffView> {
        const { live, review } = await this.reviewOf(window, sessionId, false);
        const relative = normalizeProjectPath(requireString(filePath, 'file path'));
        const { oldText, newText } = await review.diff(live.state.id, this.workRoot(live), relative);
        return { path: relative, oldText, newText };
    }

    async keepChanges(window: WindowPort, sessionId: unknown, paths: unknown): Promise<ChatChanges> {
        const { live, review } = await this.reviewOf(window, sessionId, true);
        await review.keep(live.state.id, this.workRoot(live), reviewPaths(paths));
        return this.refreshChanges(live, review);
    }

    async undoChanges(window: WindowPort, sessionId: unknown, paths: unknown): Promise<ChatChanges> {
        const { live, review } = await this.reviewOf(window, sessionId, true);
        await review.undo(live.state.id, this.workRoot(live), reviewPaths(paths));
        return this.refreshChanges(live, review);
    }

    async previewRestore(window: WindowPort, sessionId: unknown, checkpointId: unknown): Promise<readonly string[]> {
        const { live, review } = await this.reviewOf(window, sessionId, false);
        return review.previewRestore(this.workRoot(live), this.checkpointOf(live, checkpointId));
    }

    async restoreCheckpoint(window: WindowPort, sessionId: unknown, checkpointId: unknown): Promise<readonly string[]> {
        const { live, review } = await this.reviewOf(window, sessionId, true);
        const written = await review.restoreCheckpoint(this.workRoot(live), this.checkpointOf(live, checkpointId));
        await this.refreshChanges(live, review).catch((error: unknown) => this.options.log?.(`Could not refresh the changes of ${live.state.id}: ${errorMessage(error)}`));
        return written;
    }

    /** AF9: attaches a metric delta to one of the chat's finished turns (quietly ignored once the chat is gone). */
    attachMetricDelta(sessionId: string, turnId: string, delta: TurnMetricDeltaView): void {
        const live = this.live.get(sessionId);
        if (!live || !live.state.items.some((item) => item.kind === 'turn-end' && item.id === turnId)) {
            return;
        }
        this.emit(live, { type: 'metric-delta', turnId, delta });
    }

    /** Only a checkpoint recorded on one of the chat's own messages can be restored. */
    private checkpointOf(live: Live, checkpointId: unknown): string {
        const id = requireString(checkpointId, 'checkpoint', 128);
        if (!live.state.items.some((item) => item.kind === 'user' && item.checkpoint === id)) {
            throw new Error('That checkpoint is not part of this chat.');
        }
        return id;
    }

    // ---- Worktrees (AF12) -------------------------------------------------------

    /** Whether a new chat of the window's folder can have its own worktree. */
    async worktreeAvailability(window: WindowPort): Promise<WorktreeAvailabilityView> {
        this.remember(window);
        const root = this.options.rootOf(window);
        if (!root) {
            return { ok: false, message: 'Open a folder to start a chat in a worktree.' };
        }
        if (!this.options.worktreeStorageDir) {
            return { ok: false, message: 'Worktrees are not available here.' };
        }
        if (!this.options.isTrusted(window)) {
            return { ok: false, message: 'Trust this folder to start chats in their own worktree.' };
        }
        const availability = await canUseWorktrees(root);
        return availability.ok ? { ok: true, message: null } : { ok: false, message: availability.message };
    }

    async worktreeStatus(window: WindowPort, sessionId: unknown): Promise<WorktreeStatusView> {
        const { live, worktree } = await this.worktreeOf(window, sessionId);
        const into = await currentBranch(worktree.repoRoot);
        if (worktree.removed) {
            return { branch: worktree.branch, into, exists: false, removed: true, files: [], ahead: 0, behind: 0, hasUncommitted: false };
        }
        const status = await this.worktreeCall(() => worktreeStatus(this.worktreeInfo(live)));
        return {
            branch: worktree.branch,
            into,
            exists: status.exists,
            removed: false,
            files: status.files.map((file) => ({ path: file.path, status: file.status, committed: file.committed, uncommitted: file.uncommitted })),
            ahead: status.ahead,
            behind: status.behind,
            hasUncommitted: status.hasUncommitted,
        };
    }

    async worktreeCommit(window: WindowPort, sessionId: unknown, message: unknown): Promise<WorktreeCommitView> {
        const { live } = await this.worktreeOf(window, sessionId, true);
        const text = typeof message === 'string' ? message.trim() : '';
        if (!text || text.length > 10_000 || text.includes('\0')) {
            throw new Error('A commit needs a message of at most 10,000 characters.');
        }
        const result = await this.worktreeCall(() => commitAll(this.worktreeInfo(live), text));
        return { commit: result?.commit ?? null, fileCount: result?.fileCount ?? 0 };
    }

    async worktreeMerge(window: WindowPort, sessionId: unknown, strategy: unknown): Promise<WorktreeMergeView> {
        const { live } = await this.worktreeOf(window, sessionId, true);
        if (strategy !== 'merge' && strategy !== 'squash') {
            throw new Error('Unknown merge strategy.');
        }
        // The merge into the person's branch runs their hooks: only in a trusted folder.
        if (!this.options.isTrusted(window)) {
            throw new Error('This folder is in Restricted Mode. Trust it to merge an agent\'s branch into it.');
        }
        const message = strategy === 'squash' ? live.state.title : undefined;
        const result = await this.worktreeCall(() => mergeIntoCurrent(this.worktreeInfo(live), { strategy, message }));
        return { strategy: result.strategy, into: result.into, commit: result.commit, nothingToMerge: result.nothingToMerge };
    }

    /** Removes the chat's worktree and deletes its branch; the chat stays, read-only. */
    async worktreeDiscard(window: WindowPort, sessionId: unknown): Promise<void> {
        const { live, worktree } = await this.worktreeOf(window, sessionId, true);
        this.stopAgent(live);
        await this.worktreeCall(() => removeWorktree(this.worktreeInfo(live), { deleteBranch: true }));
        this.emit(live, { type: 'worktree', worktree: { ...worktree, removed: true } });
        this.setPendingCount(live, 0);
        await this.hook('review.forget', () => this.options.review?.forget?.(live.state.id));
        await this.options.store.saveNow(live.state);
        this.sessionsChanged();
    }

    /** The chat and its worktree, for a worktree call of a window that has the chat's folder open. */
    private async worktreeOf(window: WindowPort, sessionId: unknown, mutating = false): Promise<{ live: Live; worktree: SessionWorktree }> {
        this.remember(window);
        const live = await this.open(window, sessionId);
        if (this.options.rootOf(window) !== live.root) {
            throw new Error(`This chat belongs to ${live.root}; open that folder to manage its worktree.`);
        }
        const worktree = live.state.worktree;
        if (!worktree) {
            throw new Error('This chat does not have a worktree.');
        }
        if (mutating) {
            if (worktree.removed) {
                throw new Error('The worktree of this chat was discarded.');
            }
            if (live.turnActive) {
                throw new Error('The agent is still working. Stop it or wait for it to finish, then try again.');
            }
        }
        this.checkWorktreeLocation(worktree);
        return { live, worktree };
    }

    /** What worktreeManager needs, rebuilt from the chat's stored record (never from the page). */
    private worktreeInfo(live: Live): WorktreeInfo {
        const worktree = live.state.worktree;
        if (!worktree) {
            throw new Error('This chat does not have a worktree.');
        }
        this.checkWorktreeLocation(worktree);
        return { sessionId: live.state.id, label: live.state.title, repoRoot: worktree.repoRoot, path: worktree.path, cwd: worktree.cwd, branch: worktree.branch, baseCommit: worktree.baseCommit, createdAt: 0 };
    }

    /** A worktree record is only acted on when it lies in the IDE's own worktree folder. */
    private checkWorktreeLocation(worktree: SessionWorktree): void {
        const storage = this.options.worktreeStorageDir;
        const inside = (dir: string): boolean => isSameOrInside(dir, worktree.path, this.platform) && path.resolve(worktree.path) !== path.resolve(dir);
        if (!storage || !(inside(path.resolve(storage)) || inside(this.realStorageDir(storage))) || !isSameOrInside(worktree.path, worktree.cwd, this.platform)) {
            throw new Error('The worktree of this chat is not one the IDE created.');
        }
    }

    private realStorageDir(storage: string): string {
        if (this.storageReal === undefined) {
            try {
                this.storageReal = fs.realpathSync.native(storage);
            } catch {
                // Not created yet: try again next time.
                return path.resolve(storage);
            }
        }
        return this.storageReal ?? path.resolve(storage);
    }

    private requireWorktreeStorage(): string {
        if (!this.options.worktreeStorageDir) {
            throw new Error('Worktrees are not available here.');
        }
        return this.options.worktreeStorageDir;
    }

    /** Runs a worktreeManager call; its refusals reach the page as plain errors with the files involved. */
    private async worktreeCall<T>(run: () => Promise<T>): Promise<T> {
        try {
            return await run();
        } catch (error) {
            if (error instanceof WorktreeError) {
                const files = error.files.length === 0 ? '' : ` Files: ${error.files.slice(0, 8).join(', ')}${error.files.length > 8 ? ` and ${error.files.length - 8} more` : ''}.`;
                throw new Error(`${error.message}${files}`);
            }
            throw new Error(errorMessage(error));
        }
    }

    /** The folder the chat's agent works in: its worktree (AF12), or the project. */
    private workRoot(live: Live): string {
        const worktree = live.state.worktree;
        if (!worktree) {
            return live.root;
        }
        if (worktree.removed) {
            throw new Error('The worktree of this chat was discarded, so it cannot continue. Start a new chat.');
        }
        this.checkWorktreeLocation(worktree);
        return worktree.cwd;
    }

    // ---- Windows and shutdown -------------------------------------------------

    /** A window closed: its chats' agents stop (a running turn ends in error and is saved). */
    windowClosed(windowId: number): void {
        this.ports.delete(windowId);
        for (const live of this.live.values()) {
            if (live.ownerId === windowId) {
                this.stopAgent(live);
                live.ownerId = null;
            }
        }
    }

    /** A window opened another folder: agents of chats of the previous folder stop. */
    folderChanged(windowId: number, root: string | null): void {
        for (const live of this.live.values()) {
            if (live.ownerId === windowId && live.root !== root) {
                this.stopAgent(live);
                live.ownerId = null;
            }
        }
    }

    /** The app quits: every agent stops and every chat is written. */
    async stopAll(): Promise<void> {
        this.stopped = true;
        for (const live of this.live.values()) {
            this.stopAgent(live);
        }
        await this.options.store.flush();
    }

    // ---- Internals ------------------------------------------------------------

    private remember(window: WindowPort): void {
        this.ports.set(window.id, window);
    }

    private track(state: AgentSessionState, root: string, ownerId: number | null): Live {
        const live: Live = {
            state,
            root,
            ownerId,
            agent: null,
            starting: null,
            turnActive: false,
            cancelRequested: false,
            cancelTimer: null,
            replaying: false,
            importedUser: null,
            configRaw: [],
            permissions: new Map(),
            terminalBuffer: new Map(),
            terminalTimer: null,
        };
        this.live.set(state.id, live);
        return live;
    }

    /** The chat, loaded from disk when it is not open yet; the calling window becomes its owner when it has the chat's folder. */
    private async open(window: WindowPort, sessionId: unknown): Promise<Live> {
        if (!isSessionId(sessionId)) {
            throw new Error('Invalid chat.');
        }
        const root = this.options.rootOf(window);
        let live = this.live.get(sessionId);
        if (!live) {
            const state = await this.options.store.find(sessionId, root);
            if (!state || !state.workspaceRoot) {
                throw new Error('That chat no longer exists.');
            }
            live = this.live.get(sessionId) ?? this.track(state, state.workspaceRoot, null);
        }
        if (root !== null && live.root === root) {
            live.ownerId = window.id;
        } else if (live.ownerId === null) {
            live.ownerId = window.id;
        }
        return live;
    }

    private assertContinuable(live: Live, window: WindowPort): void {
        if (this.options.rootOf(window) !== live.root) {
            throw new Error(`This chat belongs to ${live.root}; open that folder to continue it.`);
        }
        if (live.state.worktree?.removed) {
            throw new Error('The worktree of this chat was discarded, so it cannot continue. Start a new chat.');
        }
    }

    private emit(live: Live, event: SessionEvent): void {
        const updatedAt = this.now();
        live.state = applySessionEvent(live.state, event, updatedAt);
        const port = live.ownerId === null ? undefined : this.ports.get(live.ownerId);
        if (port && !port.isDestroyed()) {
            port.send({ kind: 'event', sessionId: live.state.id, event, updatedAt });
        }
        this.options.store.save(live.state);
        if (event.type === 'title' || event.type === 'status' || event.type === 'permission' || event.type === 'pending-changes') {
            this.sessionsChanged();
        }
    }

    private broadcast(message: AgentSessionMessage): void {
        for (const [id, port] of this.ports) {
            if (port.isDestroyed()) {
                this.ports.delete(id);
            } else {
                port.send(message);
            }
        }
    }

    /** The sessions sidebar of every window refreshes, at most once per 100 ms. */
    private sessionsChanged(): void {
        if (this.sessionsChangedTimer) {
            return;
        }
        this.sessionsChangedTimer = setTimeout(() => {
            this.sessionsChangedTimer = null;
            this.broadcast({ kind: 'sessions-changed' });
        }, 100);
        this.sessionsChangedTimer.unref?.();
    }

    private ensureAgent(live: Live, window: WindowPort): Promise<AgentRuntime> {
        if (live.agent && !live.agent.connection.isClosed) {
            return Promise.resolve(live.agent);
        }
        live.starting ??= this.startAgent(live, window).finally(() => {
            live.starting = null;
        });
        return live.starting;
    }

    private async startAgent(live: Live, window: WindowPort): Promise<AgentRuntime> {
        const { catalog } = this.options;
        if (!this.options.spawnAllowed) {
            throw new Error('Agents cannot start in this mode.');
        }
        if (this.options.rootOf(window) !== live.root) {
            throw new Error(`This chat belongs to ${live.root}; open that folder to continue it.`);
        }
        if (!this.options.isTrusted(window)) {
            throw new Error('This folder is in Restricted Mode. Trust it to let a coding agent work in it.');
        }
        const agentRef = live.state.agentRef;
        const definition = catalog.definition(agentRef);
        if (!definition) {
            throw new Error('The agent of this chat no longer exists.');
        }
        const resolution = await catalog.resolve(definition);
        if (!resolution.found) {
            throw new Error(resolution.detail);
        }
        // AF12: a worktree chat's agent works, reads, writes and runs commands in its worktree only.
        const workRoot = this.workRoot(live);
        if (live.state.worktree && !(await isDirectory(workRoot))) {
            throw new Error(`The worktree of this chat is missing (${workRoot}). Discard it from the Worktree bar and start a new chat.`);
        }
        const terminals = new AgentTerminals({
            root: workRoot,
            env: this.options.terminalEnv,
            isInside: (root, candidate) => isSameOrInside(root, candidate, this.platform),
            events: { onOutput: (terminalId, chunk, exitCode, truncated) => this.queueTerminalOutput(live, terminalId, chunk, exitCode, truncated) },
        });
        const connection = this.connectAgent(resolution.launch, workRoot, this.handlersFor(live, terminals));
        connection.onClose((error) => {
            terminals.disposeAll();
            if (live.agent?.connection === connection) {
                live.agent = null;
                this.cancelPermissions(live);
                if (error && !live.turnActive && !this.stopped) {
                    this.emit(live, { type: 'notice', id: randomUUID(), level: 'warning', text: `${errorMessage(error)} It starts again with the next message.` });
                }
            }
        });
        const timeout = this.options.startTimeoutMs ?? 60_000;
        try {
            const init = await withTimeout(connection.initialize(), timeout, 'The agent did not answer initialize in time.');
            const authMethods = mapAuthMethods(init.authMethods ?? []);
            catalog.setState(agentRef, { availability: catalog.state(agentRef)?.availability ?? 'available', authMethods });
            // AF12: the analysis follows the project, not a chat's worktree, so the MCP server gets the project.
            const mcpServers = [...((await this.hook('mcpServers', () => this.options.mcpServers?.(live.root))) ?? [])];
            const previous = live.state.agentSessionId;
            let sessionId: string | null = null;
            if (previous && init.agentCapabilities?.loadSession) {
                // #298: an imported chat keeps what the agent replays: that is its history.
                const importing = live.state.historyPending === true;
                live.replaying = !importing;
                try {
                    const loaded = await withTimeout(connection.loadSession(previous, workRoot, mcpServers), timeout, 'The agent did not reopen the chat in time.');
                    sessionId = previous;
                    if (importing) {
                        this.flushImportedUser(live);
                        this.emit(live, { type: 'history', pending: false });
                    }
                    this.applySessionSetup(live, loaded.modes, loaded.configOptions);
                } catch (error) {
                    if (isAuthRequiredError(error)) {
                        throw error;
                    }
                    this.emit(live, { type: 'notice', id: randomUUID(), level: 'info', text: `${definition.name} could not reopen its earlier session (${errorMessage(error)}); it starts a new one and does not remember the earlier messages.` });
                    if (importing) {
                        this.emit(live, { type: 'history', pending: false });
                    }
                } finally {
                    live.replaying = false;
                    live.importedUser = null;
                }
            }
            if (!sessionId) {
                const created = await withTimeout(connection.newSession(workRoot, mcpServers), timeout, 'The agent did not open a session in time.');
                sessionId = created.sessionId;
                const hadHistory = live.state.items.some((item) => item.kind === 'turn-end');
                if (hadHistory && !(previous && init.agentCapabilities?.loadSession)) {
                    this.emit(live, { type: 'notice', id: randomUUID(), level: 'info', text: `${definition.name} cannot reopen earlier sessions, so it starts a new one and does not remember the earlier messages of this chat.` });
                }
                this.emit(live, { type: 'agent-session', agentSessionId: sessionId });
                this.applySessionSetup(live, created.modes, created.configOptions);
            }
            const previousState = catalog.state(agentRef)?.availability;
            catalog.setState(agentRef, { availability: 'ready', authMethods });
            if (previousState !== 'ready') {
                this.broadcast({ kind: 'agents-changed' });
            }
            const runtime: AgentRuntime = { connection, sessionId, init, terminals };
            live.agent = runtime;
            return runtime;
        } catch (error) {
            connection.close();
            throw error;
        }
    }

    private applySessionSetup(live: Live, modes: SessionModeState | null | undefined, configOptions: readonly SessionConfigOption[] | null | undefined): void {
        if (modes) {
            const mapped = mapModes(modes);
            this.emit(live, { type: 'modes', current: mapped.current, available: mapped.available });
        }
        if (configOptions) {
            live.configRaw = configOptions;
            this.emit(live, { type: 'config', options: mapConfigOptions(configOptions) });
        }
    }

    private handlersFor(live: Live, terminals: AgentTerminals): AcpClientHandlers {
        const ctx: MappingContext = { newId: () => randomUUID(), terminal: (id) => terminals.snapshot(id) };
        return {
            onUpdate: (_sessionId, update) => this.onUpdate(live, update, ctx),
            requestPermission: (params, signal) => this.onPermission(live, params, signal, ctx),
            readTextFile: (params) => this.onReadText(live, params),
            writeTextFile: (params) => this.onWriteText(live, params),
            createTerminal: (params) => {
                this.flushTerminalOutput(live);
                return Promise.resolve({ terminalId: terminals.create(params) });
            },
            terminalOutput: (params) => terminals.output(params.terminalId),
            waitForTerminalExit: (params, signal) => terminals.waitForExit(params.terminalId, signal),
            killTerminal: (params) => terminals.kill(params.terminalId),
            releaseTerminal: (params) => {
                this.flushTerminalOutput(live);
                terminals.release(params.terminalId);
            },
        };
    }

    private onUpdate(live: Live, update: SessionUpdate, ctx: MappingContext): void {
        if (live.state.historyPending) {
            // #298: the replay of an imported chat. The person's messages come as
            // chunks the live mapping ignores (the IDE records its own), so they
            // are joined here and become the chat's messages.
            if (update.sessionUpdate === 'user_message_chunk') {
                const text = update.content.type === 'text' ? update.content.text : '';
                live.importedUser = (live.importedUser ?? '') + text;
                return;
            }
            if (!['available_commands_update', 'current_mode_update', 'config_option_update', 'usage_update'].includes(update.sessionUpdate)) {
                this.flushImportedUser(live);
            }
        }
        if (live.replaying && !['available_commands_update', 'current_mode_update', 'config_option_update', 'usage_update'].includes(update.sessionUpdate)) {
            // `session/load` replays the history the IDE already has.
            return;
        }
        if (update.sessionUpdate === 'config_option_update') {
            live.configRaw = update.configOptions;
        }
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
            this.flushTerminalOutput(live);
        }
        for (const event of mapSessionUpdate(update, ctx)) {
            this.emit(live, event);
        }
    }

    private async onPermission(live: Live, params: RequestPermissionRequest, signal: AbortSignal, ctx: MappingContext): Promise<RequestPermissionResponse> {
        const toolCall = params.toolCall;
        const existing = live.state.items.find((item) => item.kind === 'tool' && item.id === toolCall.toolCallId);
        const card = toolEvent(toolCall, ctx, !existing);
        if (!existing || Object.keys(card).length > 2) {
            this.emit(live, card);
        }
        const toolKind = toolCall.kind ? toolKindOf(toolCall.kind) : existing?.kind === 'tool' ? existing.toolKind : 'other';
        const options: PermissionOptionView[] = params.options.map((option) => ({ id: option.optionId, name: option.name, kind: option.kind }));
        const remembered = this.decisionFor(live.state.agentRef, toolKind);
        if (remembered) {
            const kinds = remembered === 'allow' ? ['allow_always', 'allow_once'] : ['reject_always', 'reject_once'];
            const option = kinds.map((kind) => options.find((candidate) => candidate.kind === kind)).find((candidate) => candidate !== undefined);
            if (option) {
                return { outcome: { outcome: 'selected', optionId: option.id } };
            }
        }
        if (live.cancelRequested || signal.aborted) {
            return { outcome: { outcome: 'cancelled' } };
        }
        const id = randomUUID();
        const title = (typeof toolCall.title === 'string' && toolCall.title) || (existing?.kind === 'tool' ? existing.title : '') || 'The agent asks for permission';
        this.emit(live, { type: 'permission', id, title, options, toolCallId: toolCall.toolCallId });
        return new Promise<RequestPermissionResponse>((resolve) => {
            live.permissions.set(id, { options, toolKind, resolve });
            signal.addEventListener('abort', () => this.settlePermission(live, id, { outcome: { outcome: 'cancelled' } }, 'cancelled'), { once: true });
        });
    }

    private settlePermission(live: Live, id: string, response: RequestPermissionResponse, outcome: string): void {
        const pending = live.permissions.get(id);
        if (!pending) {
            return;
        }
        live.permissions.delete(id);
        this.emit(live, { type: 'permission-resolved', id, outcome });
        pending.resolve(response);
    }

    private cancelPermissions(live: Live): void {
        for (const id of [...live.permissions.keys()]) {
            this.settlePermission(live, id, { outcome: { outcome: 'cancelled' } }, 'cancelled');
        }
    }

    private decisionFor(agentRef: string, toolKind: ToolKind): 'allow' | 'reject' | null {
        const all = this.options.decisions.get<Record<string, Record<string, unknown>>>(DECISIONS_KEY) ?? {};
        const value = all[agentRef]?.[toolKind];
        return value === 'allow' || value === 'reject' ? value : null;
    }

    private async rememberDecision(agentRef: string, toolKind: ToolKind, decision: 'allow' | 'reject'): Promise<void> {
        const all = this.options.decisions.get<Record<string, Record<string, string>>>(DECISIONS_KEY) ?? {};
        await this.options.decisions.update(DECISIONS_KEY, { ...all, [agentRef]: { ...(all[agentRef] ?? {}), [toolKind]: decision } });
    }

    /** An absolute path the agent named, refused unless it is inside the chat's project (symbolic links followed). */
    private async insideRoot(live: Live, requested: unknown): Promise<string> {
        if (typeof requested !== 'string' || !requested || requested.includes('\0')) {
            throw new Error('Invalid path.');
        }
        const api = this.platform === 'win32' ? path.win32 : path.posix;
        if (!api.isAbsolute(requested)) {
            throw new Error(`Paths must be absolute: ${requested}`);
        }
        const target = api.resolve(requested);
        const root = this.workRoot(live);
        const refuse = (): Error => new Error(`${requested} is outside the ${live.state.worktree ? 'chat\'s worktree' : 'project folder'} ${root}; agents only read and write inside it.`);
        if (!isSameOrInside(root, target, this.platform)) {
            throw refuse();
        }
        // A link inside the project must not lead outside it: check the real path of the nearest existing ancestor.
        let existing = target;
        for (;;) {
            try {
                const real = await fs.promises.realpath(existing);
                const realRoot = await fs.promises.realpath(root).catch(() => root);
                if (!isSameOrInside(realRoot, real, this.platform)) {
                    throw refuse();
                }
                break;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
                const parent = api.dirname(existing);
                if (parent === existing) {
                    break;
                }
                existing = parent;
            }
        }
        return target;
    }

    private async onReadText(live: Live, params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
        const file = await this.insideRoot(live, params.path);
        const stat = await fs.promises.stat(file).catch(() => null);
        if (stat && stat.size > MAX_READ_FILE) {
            throw new Error(`${params.path} is larger than 10 MB.`);
        }
        const text = await this.options.readText(file);
        return { content: sliceLines(text, params.line, params.limit) };
    }

    private async onWriteText(live: Live, params: WriteTextFileRequest): Promise<void> {
        const file = await this.insideRoot(live, params.path);
        if (typeof params.content !== 'string') {
            throw new Error('Invalid content.');
        }
        await this.options.writeText(file, params.content);
    }

    private async resolveAttachments(root: string, input: unknown): Promise<{ resolved: ResolvedAttachment[]; labels: string[] }> {
        if (input === undefined || input === null) {
            return { resolved: [], labels: [] };
        }
        if (!Array.isArray(input) || input.length > MAX_ATTACHMENTS) {
            throw new Error(`At most ${MAX_ATTACHMENTS} attachments.`);
        }
        const resolved: ResolvedAttachment[] = [];
        const labels: string[] = [];
        for (const raw of input as unknown[]) {
            const attachment = raw as Partial<PromptAttachment> | null;
            if (!attachment || (attachment.kind !== 'file' && attachment.kind !== 'selection') || typeof attachment.path !== 'string' || !attachment.path || attachment.path.length > 4096) {
                throw new Error('Invalid attachment.');
            }
            const api = this.platform === 'win32' ? path.win32 : path.posix;
            const absolutePath = api.resolve(root, attachment.path);
            if (!isSameOrInside(root, absolutePath, this.platform)) {
                throw new Error(`${attachment.path} is outside the project folder.`);
            }
            const lineOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined);
            const startLine = lineOf(attachment.startLine);
            const endLine = lineOf(attachment.endLine);
            const label = attachmentLabel({ kind: attachment.kind, path: attachment.path, ...(startLine !== undefined ? { startLine } : {}), ...(endLine !== undefined ? { endLine } : {}) });
            labels.push(label);
            if (attachment.kind === 'selection') {
                if (typeof attachment.text !== 'string' || attachment.text.length > MAX_PROMPT_LENGTH) {
                    throw new Error('A selection needs its text.');
                }
                resolved.push({ kind: 'selection', absolutePath, relativePath: attachment.path, text: attachment.text, ...(startLine !== undefined ? { startLine } : {}), ...(endLine !== undefined ? { endLine } : {}) });
                continue;
            }
            let text: string | null = null;
            const stat = await fs.promises.stat(absolutePath).catch(() => null);
            if (stat?.isFile() && stat.size <= MAX_EMBEDDED_FILE) {
                text = await this.options.readText(absolutePath).catch(() => null);
            }
            resolved.push({ kind: 'file', absolutePath, relativePath: attachment.path, text });
        }
        return { resolved, labels };
    }

    private queueTerminalOutput(live: Live, terminalId: string, chunk: string, exitCode: number | null | undefined, truncated: boolean): void {
        const buffered = live.terminalBuffer.get(terminalId) ?? { output: '', truncated: false };
        buffered.output += chunk;
        buffered.truncated ||= truncated;
        if (exitCode !== undefined) {
            buffered.exitCode = exitCode;
        }
        live.terminalBuffer.set(terminalId, buffered);
        if (exitCode !== undefined) {
            this.flushTerminalOutput(live);
            return;
        }
        live.terminalTimer ??= setTimeout(() => this.flushTerminalOutput(live), TERMINAL_FLUSH_MS);
    }

    private flushTerminalOutput(live: Live): void {
        if (live.terminalTimer) {
            clearTimeout(live.terminalTimer);
            live.terminalTimer = null;
        }
        for (const [terminalId, buffered] of live.terminalBuffer) {
            this.emit(live, {
                type: 'terminal-output',
                terminalId,
                output: buffered.output,
                ...(buffered.exitCode !== undefined ? { exitCode: buffered.exitCode } : {}),
                ...(buffered.truncated ? { truncated: true } : {}),
            });
        }
        live.terminalBuffer.clear();
    }

    /** Runs an optional hook of another feature; its failure is logged and never fails the chat. */
    private async hook<T>(name: string, run: () => T | Promise<T> | undefined): Promise<T | null> {
        try {
            return (await run()) ?? null;
        } catch (error) {
            this.options.log?.(`The ${name} hook failed: ${errorMessage(error)}`);
            return null;
        }
    }

    private async reportPendingChanges(live: Live, turnId: string): Promise<void> {
        const count = await this.hook('afterTurn', () => this.options.afterTurn?.(live.state.id, this.workRoot(live), turnId));
        this.setPendingCount(live, count);
    }

    private setPendingCount(live: Live, count: number | null): void {
        if (typeof count === 'number' && Number.isInteger(count) && count >= 0 && count !== live.state.pendingChanges) {
            this.emit(live, { type: 'pending-changes', count });
        }
    }

    /** The review calls: the window must have the chat's folder open, and the review must exist. */
    private async reviewOf(window: WindowPort, sessionId: unknown, mutating: boolean): Promise<{ live: Live; review: ChangeReview }> {
        this.remember(window);
        const live = await this.open(window, sessionId);
        this.assertContinuable(live, window);
        const review = this.options.review;
        if (!review) {
            throw new Error('Checkpoints are not available here.');
        }
        if (mutating && live.turnActive) {
            throw new Error('The agent is still working. Stop it or wait for it to finish, then try again.');
        }
        return { live, review };
    }

    /** Refreshes the chat's pending count after a review action and returns the list. */
    private async refreshChanges(live: Live, review: ChangeReview): Promise<ChatChanges> {
        const changes = await review.pending(live.state.id, this.workRoot(live));
        if (changes.disabledReason === null) {
            this.setPendingCount(live, changes.files.length);
        }
        return changes;
    }

    private reportFailure(live: Live, error: unknown): void {
        if (isAuthRequiredError(error)) {
            this.markNeedsLogin(live);
            this.emit(live, { type: 'notice', id: randomUUID(), level: 'error', text: `${live.state.agentName} needs you to sign in. Use one of its sign-in buttons in the Agents section of the Chats view, then send the message again.` });
            return;
        }
        this.emit(live, { type: 'notice', id: randomUUID(), level: 'error', text: errorMessage(error) });
    }

    /** A chat's agent could not start in the background (no turn was running). */
    private reportStartFailure(live: Live, error: unknown): void {
        if (!this.live.has(live.state.id)) {
            return;
        }
        this.reportFailure(live, error);
    }

    private markNeedsLogin(live: Live): void {
        const agentRef = live.state.agentRef;
        const state = this.options.catalog.state(agentRef);
        if (state?.availability !== 'needs-login') {
            this.options.catalog.setState(agentRef, { availability: 'needs-login', detail: 'Log in to use this agent.' });
            this.broadcast({ kind: 'agents-changed' });
        }
    }

    private stopAgent(live: Live): void {
        this.cancelPermissions(live);
        const agent = live.agent;
        live.agent = null;
        agent?.connection.close();
        agent?.terminals.disposeAll();
        if (live.terminalTimer) {
            clearTimeout(live.terminalTimer);
            live.terminalTimer = null;
        }
        live.terminalBuffer.clear();
    }
}

/** #297: `auth/status` when the agent advertises it; unknown otherwise or on any failure. */
async function readAuthStatus(connection: AcpConnection, init: InitializeResponse, timeout: number): Promise<{ readonly state: 'authenticated' | 'unauthenticated' | 'unknown'; readonly account?: string }> {
    const capabilities = init.agentCapabilities as { readonly auth?: { readonly status?: unknown } } | undefined;
    if (!capabilities?.auth?.status) {
        return { state: 'unknown' };
    }
    try {
        return await withTimeout(connection.authStatus(), Math.min(timeout, 15_000), 'The agent did not say whether it is signed in.');
    } catch {
        return { state: 'unknown' };
    }
}
