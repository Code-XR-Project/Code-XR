import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
    type LoginTerminal,
    type PermissionOptionView,
    type ProjectSessions,
    type PromptAttachment,
    type SessionEvent,
    type SessionSummary,
    type ToolKind,
    type TurnMetricDeltaView,
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
import type { AgentCatalog } from './agentCatalog.ts';
import { AgentTerminals } from './agentTerminals.ts';
import { isSessionId, type SessionStore } from './sessionStore.ts';

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
    readonly openTerminal: (window: WindowPort, request: { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly title: string }) => Promise<{ readonly terminal: LoginTerminal; readonly exited: Promise<number> }>;
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

    async login(window: WindowPort, ref: unknown, methodId: unknown): Promise<LoginTerminal | null> {
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
            const command = spec.command ?? launch.command;
            const args = spec.command ? (spec.args ?? []) : [...launch.args, ...(spec.args ?? [])];
            const cwd = this.options.rootOf(window) ?? this.options.homeDir;
            const opened = await this.options.openTerminal(window, { command, args, cwd, env: { ...launch.env, ...(spec.env ?? {}) }, title: `${definition.name}: ${spec.view.name}` });
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
        try {
            await withTimeout(connection.newSession(this.options.probeDir, []), timeout, 'The agent did not open a session in time.');
            this.options.catalog.setState(agentRef, { availability: 'ready', authMethods });
        } catch (error) {
            this.options.catalog.setState(agentRef, isAuthRequiredError(error)
                ? { availability: 'needs-login', detail: 'Log in to use this agent.', authMethods }
                : { availability: 'error', detail: errorMessage(error), authMethods });
        }
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
        return live.state;
    }

    async create(window: WindowPort, agentRef: unknown): Promise<AgentSessionState> {
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
        const at = this.now();
        const state = emptySession({ id: randomUUID(), title: 'New chat', agentRef: ref, agentName: definition.name, workspaceRoot: root, createdAt: at, updatedAt: at });
        const live = this.track(state, root, window.id);
        await this.options.store.saveNow(state);
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
            ({ resolved, labels } = await this.resolveAttachments(live.root, attachments));
        } catch (error) {
            live.turnActive = false;
            throw error;
        }
        try {
            const checkpoint = await this.hook('beforePrompt', () => this.options.beforePrompt?.(live.state.id, live.root)).then((result) => result?.checkpointId ?? null);
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

    async remove(window: WindowPort, sessionId: unknown): Promise<void> {
        this.remember(window);
        const live = await this.open(window, sessionId);
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
        const { oldText, newText } = await review.diff(live.state.id, live.root, relative);
        return { path: relative, oldText, newText };
    }

    async keepChanges(window: WindowPort, sessionId: unknown, paths: unknown): Promise<ChatChanges> {
        const { live, review } = await this.reviewOf(window, sessionId, true);
        await review.keep(live.state.id, live.root, reviewPaths(paths));
        return this.refreshChanges(live, review);
    }

    async undoChanges(window: WindowPort, sessionId: unknown, paths: unknown): Promise<ChatChanges> {
        const { live, review } = await this.reviewOf(window, sessionId, true);
        await review.undo(live.state.id, live.root, reviewPaths(paths));
        return this.refreshChanges(live, review);
    }

    async previewRestore(window: WindowPort, sessionId: unknown, checkpointId: unknown): Promise<readonly string[]> {
        const { live, review } = await this.reviewOf(window, sessionId, false);
        return review.previewRestore(live.root, this.checkpointOf(live, checkpointId));
    }

    async restoreCheckpoint(window: WindowPort, sessionId: unknown, checkpointId: unknown): Promise<readonly string[]> {
        const { live, review } = await this.reviewOf(window, sessionId, true);
        const written = await review.restoreCheckpoint(live.root, this.checkpointOf(live, checkpointId));
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
        const terminals = new AgentTerminals({
            root: live.root,
            env: this.options.terminalEnv,
            isInside: (root, candidate) => isSameOrInside(root, candidate, this.platform),
            events: { onOutput: (terminalId, chunk, exitCode, truncated) => this.queueTerminalOutput(live, terminalId, chunk, exitCode, truncated) },
        });
        const connection = this.connectAgent(resolution.launch, live.root, this.handlersFor(live, terminals));
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
            const mcpServers = [...((await this.hook('mcpServers', () => this.options.mcpServers?.(live.root))) ?? [])];
            const previous = live.state.agentSessionId;
            let sessionId: string | null = null;
            if (previous && init.agentCapabilities?.loadSession) {
                live.replaying = true;
                try {
                    const loaded = await withTimeout(connection.loadSession(previous, live.root, mcpServers), timeout, 'The agent did not reopen the chat in time.');
                    sessionId = previous;
                    this.applySessionSetup(live, loaded.modes, loaded.configOptions);
                } catch (error) {
                    if (isAuthRequiredError(error)) {
                        throw error;
                    }
                    this.emit(live, { type: 'notice', id: randomUUID(), level: 'info', text: `${definition.name} could not reopen its earlier session (${errorMessage(error)}); it starts a new one and does not remember the earlier messages.` });
                } finally {
                    live.replaying = false;
                }
            }
            if (!sessionId) {
                const created = await withTimeout(connection.newSession(live.root, mcpServers), timeout, 'The agent did not open a session in time.');
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
        const refuse = (): Error => new Error(`${requested} is outside the project folder ${live.root}; agents only read and write inside it.`);
        if (!isSameOrInside(live.root, target, this.platform)) {
            throw refuse();
        }
        // A link inside the project must not lead outside it: check the real path of the nearest existing ancestor.
        let existing = target;
        for (;;) {
            try {
                const real = await fs.promises.realpath(existing);
                const realRoot = await fs.promises.realpath(live.root).catch(() => live.root);
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
        const count = await this.hook('afterTurn', () => this.options.afterTurn?.(live.state.id, live.root, turnId));
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
        const changes = await review.pending(live.state.id, live.root);
        if (changes.disabledReason === null) {
            this.setPendingCount(live, changes.files.length);
        }
        return changes;
    }

    private reportFailure(live: Live, error: unknown): void {
        if (isAuthRequiredError(error)) {
            this.markNeedsLogin(live);
            this.emit(live, { type: 'notice', id: randomUUID(), level: 'error', text: `${live.state.agentName} needs you to log in. Choose Log in for it in the agent picker, then send the message again.` });
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
