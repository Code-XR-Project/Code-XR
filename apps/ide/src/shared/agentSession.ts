/**
 * The agent-first chat (epic #265): one transcript model for every coding
 * agent the IDE hosts, whether it runs over the Agent Client Protocol (AF1,
 * Claude Code / Codex / Gemini CLI and any custom ACP agent) or is the IDE's
 * own built-in agent (epic #189).
 *
 * Pure data plus a pure reducer, shared by the main process (which keeps the
 * authoritative state and persists it) and the renderer (which applies the
 * same events to draw the chat). No Electron, no DOM, no `vscode`: the VS Code
 * extension (1.3.0) can reuse it as is.
 */

// ---- Agents ----------------------------------------------------------------

/** The agents the IDE knows how to launch without any configuration (AF2). */
export const AGENT_PRESET_IDS = ['claude', 'codex', 'gemini'] as const;
export type AgentPresetId = (typeof AGENT_PRESET_IDS)[number];

/** An ACP agent the person can start a chat with. */
export interface AcpAgentDefinition {
    readonly id: string;
    readonly name: string;
    /** The executable, resolved without a shell. For presets, set by the catalogue. */
    readonly command: string;
    readonly args: readonly string[];
    /** Extra environment (never secrets: keys come from the key vault at spawn time). */
    readonly env?: Readonly<Record<string, string>>;
    readonly preset?: AgentPresetId;
    /** One line: what the agent is and how it bills ("Uses your Claude subscription or an API key"). */
    readonly description: string;
}

export type AgentAvailability =
    /** Its command was not found (preset not installed, custom path wrong). */
    | 'missing'
    /** Found; not known yet whether it is signed in. */
    | 'available'
    /** Started and answered `initialize` + `session/new`. */
    | 'ready'
    /** `session/new` failed asking for authentication. */
    | 'needs-login'
    | 'error';

/** An agent as the chat's agent picker shows it. */
export interface AgentView {
    /** `acp:<id>` or `builtin:<profileId>`. */
    readonly ref: string;
    readonly name: string;
    readonly kind: 'acp' | 'builtin';
    readonly description: string;
    readonly availability: AgentAvailability;
    /** Why it is missing or failing, in a sentence. */
    readonly detail?: string;
    readonly preset?: AgentPresetId;
    /** The login methods the agent advertised (ACP `authMethods`), shown with the vendor's wording. */
    readonly authMethods?: readonly AuthMethodView[];
}

export interface AuthMethodView {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    /** `terminal`: the IDE runs the agent's own login in a terminal; `agent`: the agent opens the browser itself. */
    readonly type: 'terminal' | 'agent' | 'env';
}

// ---- Transcript ------------------------------------------------------------

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type ToolContentView =
    | { readonly type: 'text'; readonly text: string }
    /** A file change: `oldText` null for a new file. Paths are absolute, as ACP sends them. */
    | { readonly type: 'diff'; readonly path: string; readonly oldText: string | null; readonly newText: string }
    | { readonly type: 'terminal'; readonly terminalId: string; readonly output: string; readonly exitCode: number | null; readonly truncated?: boolean };

export interface PermissionOptionView {
    readonly id: string;
    readonly name: string;
    readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export type TranscriptItem =
    | {
          readonly kind: 'user';
          readonly id: string;
          readonly text: string;
          readonly at: string;
          /** Labels of attached context ("src/app.ts", "app.ts:10-24"). */
          readonly attachments?: readonly string[];
          /** The checkpoint taken just before this message (AF6), if any. */
          readonly checkpoint?: string;
      }
    | { readonly kind: 'assistant'; readonly id: string; readonly text: string }
    | { readonly kind: 'thought'; readonly id: string; readonly text: string }
    | {
          readonly kind: 'tool';
          /** The ACP `toolCallId`. */
          readonly id: string;
          readonly title: string;
          readonly toolKind: ToolKind;
          readonly status: ToolStatus;
          readonly locations: readonly { readonly path: string; readonly line?: number }[];
          readonly content: readonly ToolContentView[];
          /** The raw input as compact JSON, for the expanded card. */
          readonly rawInput?: string;
      }
    | {
          readonly kind: 'permission';
          /** The request id the answer is sent back with. */
          readonly id: string;
          readonly toolCallId?: string;
          readonly title: string;
          readonly options: readonly PermissionOptionView[];
          /** The option chosen, or 'cancelled' when the turn ended first. Absent while waiting. */
          readonly outcome?: string;
      }
    | { readonly kind: 'notice'; readonly id: string; readonly level: 'info' | 'warning' | 'error'; readonly text: string }
    | {
          readonly kind: 'turn-end';
          readonly id: string;
          readonly stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error';
          readonly at: string;
      };

export interface PlanEntryView {
    readonly content: string;
    readonly priority: 'high' | 'medium' | 'low';
    readonly status: 'pending' | 'in_progress' | 'completed';
}

export interface SlashCommandView {
    readonly name: string;
    readonly description: string;
    /** Placeholder for the text after the command, when it takes some. */
    readonly hint?: string;
}

export interface ModeView {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
}

/** An agent setting with a fixed list of values (ACP config options: model, mode, thought level...). */
export interface ConfigOptionView {
    readonly id: string;
    readonly name: string;
    readonly category?: string;
    readonly current: string;
    readonly values: readonly { readonly id: string; readonly name: string; readonly description?: string }[];
}

export type SessionStatus =
    /** Waiting for the person. */
    | 'idle'
    /** The agent is working on a prompt. */
    | 'running'
    /** The agent asked for a permission and waits. */
    | 'awaiting'
    /** The last turn failed, or the agent could not start. */
    | 'error';

export interface SessionSummary {
    readonly id: string;
    readonly title: string;
    /** `acp:<id>` or `builtin:<profileId>`. */
    readonly agentRef: string;
    readonly agentName: string;
    /** The project folder the chat belongs to. */
    readonly workspaceRoot: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly status: SessionStatus;
    /** Something happened that the person has not seen yet (AF7). */
    readonly unread: boolean;
    /** Files the agent changed in this chat that are still pending review (AF5). */
    readonly pendingChanges: number;
}

export interface AgentSessionState extends SessionSummary {
    readonly items: readonly TranscriptItem[];
    readonly plan: readonly PlanEntryView[];
    readonly commands: readonly SlashCommandView[];
    readonly modes: { readonly current: string; readonly available: readonly ModeView[] } | null;
    readonly configOptions: readonly ConfigOptionView[];
    /** Context window use reported by the agent. */
    readonly usage: { readonly used: number; readonly size: number } | null;
    /** The agent-side session id (ACP), kept to resume with `session/load`. */
    readonly agentSessionId: string | null;
}

/** A project and its chats, for the sessions sidebar (AF7). */
export interface ProjectSessions {
    readonly root: string;
    readonly name: string;
    /** True for the folder open in the calling window. */
    readonly current: boolean;
    readonly sessions: readonly SessionSummary[];
}

// ---- Events ----------------------------------------------------------------

/**
 * What changes a session. The main process produces them (from ACP
 * `session/update` notifications, from the built-in agent, or from the
 * person's actions) and applies them with `applySessionEvent`; the renderer
 * receives the same events and applies the same function.
 */
export type SessionEvent =
    | { readonly type: 'user'; readonly id: string; readonly text: string; readonly at: string; readonly attachments?: readonly string[]; readonly checkpoint?: string }
    | { readonly type: 'assistant-chunk'; readonly text: string }
    | { readonly type: 'thought-chunk'; readonly text: string }
    | {
          readonly type: 'tool';
          readonly id: string;
          readonly title?: string;
          readonly toolKind?: ToolKind;
          readonly status?: ToolStatus;
          readonly locations?: readonly { readonly path: string; readonly line?: number }[];
          /** Replaces the card's content when present (ACP semantics). */
          readonly content?: readonly ToolContentView[];
          readonly rawInput?: string;
      }
    /** Appends output to one terminal shown in a tool card (the IDE runs the terminal itself). */
    | { readonly type: 'terminal-output'; readonly terminalId: string; readonly output: string; readonly exitCode?: number | null; readonly truncated?: boolean }
    | { readonly type: 'permission'; readonly id: string; readonly toolCallId?: string; readonly title: string; readonly options: readonly PermissionOptionView[] }
    | { readonly type: 'permission-resolved'; readonly id: string; readonly outcome: string }
    | { readonly type: 'plan'; readonly entries: readonly PlanEntryView[] }
    | { readonly type: 'commands'; readonly commands: readonly SlashCommandView[] }
    | { readonly type: 'modes'; readonly current: string; readonly available?: readonly ModeView[] }
    | { readonly type: 'config'; readonly options: readonly ConfigOptionView[] }
    | { readonly type: 'usage'; readonly used: number; readonly size: number }
    | { readonly type: 'notice'; readonly id: string; readonly level: 'info' | 'warning' | 'error'; readonly text: string }
    | { readonly type: 'status'; readonly status: SessionStatus }
    | { readonly type: 'turn-end'; readonly id: string; readonly stopReason: Extract<TranscriptItem, { kind: 'turn-end' }>['stopReason']; readonly at: string }
    | { readonly type: 'title'; readonly title: string }
    | { readonly type: 'agent-session'; readonly agentSessionId: string }
    | { readonly type: 'pending-changes'; readonly count: number }
    | { readonly type: 'read' };

/** Main -> renderer: an event for one session, or a session list change. */
export type AgentSessionMessage =
    | { readonly kind: 'event'; readonly sessionId: string; readonly event: SessionEvent; readonly updatedAt: string }
    | { readonly kind: 'sessions-changed' }
    | { readonly kind: 'agents-changed' };

// ---- Reducer ---------------------------------------------------------------

const MAX_TERMINAL_OUTPUT = 64_000;

function replaceLast<T>(items: readonly T[], value: T): T[] {
    const copy = items.slice();
    copy[copy.length - 1] = value;
    return copy;
}

/** A new, empty session. */
export function emptySession(summary: Omit<SessionSummary, 'status' | 'unread' | 'pendingChanges'>): AgentSessionState {
    return {
        ...summary,
        status: 'idle',
        unread: false,
        pendingChanges: 0,
        items: [],
        plan: [],
        commands: [],
        modes: null,
        configOptions: [],
        usage: null,
        agentSessionId: null,
    };
}

/**
 * Applies one event. Pure: returns a new state and never mutates the old one,
 * so the renderer can compare references to redraw only what changed.
 */
export function applySessionEvent(state: AgentSessionState, event: SessionEvent, updatedAt: string = state.updatedAt): AgentSessionState {
    const items = state.items;
    const last = items[items.length - 1];
    const touch = (next: Partial<AgentSessionState>): AgentSessionState => ({ ...state, ...next, updatedAt });
    switch (event.type) {
        case 'user':
            return touch({
                items: [...items, { kind: 'user', id: event.id, text: event.text, at: event.at, ...(event.attachments?.length ? { attachments: event.attachments } : {}), ...(event.checkpoint ? { checkpoint: event.checkpoint } : {}) }],
                status: 'running',
                // A new prompt starts a new plan only when the agent sends one.
            });
        case 'assistant-chunk':
            if (last?.kind === 'assistant') {
                return touch({ items: replaceLast(items, { ...last, text: last.text + event.text }) });
            }
            return touch({ items: [...items, { kind: 'assistant', id: `a${items.length}`, text: event.text }] });
        case 'thought-chunk':
            if (last?.kind === 'thought') {
                return touch({ items: replaceLast(items, { ...last, text: last.text + event.text }) });
            }
            return touch({ items: [...items, { kind: 'thought', id: `t${items.length}`, text: event.text }] });
        case 'tool': {
            const index = items.findIndex((item) => item.kind === 'tool' && item.id === event.id);
            if (index < 0) {
                const card: TranscriptItem = {
                    kind: 'tool',
                    id: event.id,
                    title: event.title ?? 'Tool',
                    toolKind: event.toolKind ?? 'other',
                    status: event.status ?? 'pending',
                    locations: event.locations ?? [],
                    content: event.content ?? [],
                    ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
                };
                return touch({ items: [...items, card] });
            }
            const old = items[index] as Extract<TranscriptItem, { kind: 'tool' }>;
            const updated: TranscriptItem = {
                ...old,
                ...(event.title !== undefined ? { title: event.title } : {}),
                ...(event.toolKind !== undefined ? { toolKind: event.toolKind } : {}),
                ...(event.status !== undefined ? { status: event.status } : {}),
                ...(event.locations !== undefined ? { locations: event.locations } : {}),
                ...(event.content !== undefined ? { content: mergeTerminalOutput(old.content, event.content) } : {}),
                ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
            };
            const copy = items.slice();
            copy[index] = updated;
            return touch({ items: copy });
        }
        case 'terminal-output': {
            let changed = false;
            const copy = items.map((item) => {
                if (item.kind !== 'tool' || !item.content.some((block) => block.type === 'terminal' && block.terminalId === event.terminalId)) {
                    return item;
                }
                changed = true;
                return {
                    ...item,
                    content: item.content.map((block) => {
                        if (block.type !== 'terminal' || block.terminalId !== event.terminalId) {
                            return block;
                        }
                        const output = block.output + event.output;
                        const truncated = output.length > MAX_TERMINAL_OUTPUT;
                        return {
                            ...block,
                            output: truncated ? output.slice(output.length - MAX_TERMINAL_OUTPUT) : output,
                            exitCode: event.exitCode === undefined ? block.exitCode : event.exitCode,
                            ...(truncated || block.truncated || event.truncated ? { truncated: true } : {}),
                        };
                    }),
                };
            });
            return changed ? touch({ items: copy }) : state;
        }
        case 'permission':
            return touch({
                items: [...items, { kind: 'permission', id: event.id, title: event.title, options: event.options, ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}) }],
                status: 'awaiting',
            });
        case 'permission-resolved': {
            const copy = items.map((item) => (item.kind === 'permission' && item.id === event.id ? { ...item, outcome: event.outcome } : item));
            const stillWaiting = copy.some((item) => item.kind === 'permission' && item.outcome === undefined);
            return touch({ items: copy, status: stillWaiting ? 'awaiting' : state.status === 'awaiting' ? 'running' : state.status });
        }
        case 'plan':
            return touch({ plan: event.entries });
        case 'commands':
            return touch({ commands: event.commands });
        case 'modes':
            return touch({ modes: { current: event.current, available: event.available ?? state.modes?.available ?? [] } });
        case 'config':
            return touch({ configOptions: event.options });
        case 'usage':
            return touch({ usage: { used: event.used, size: event.size } });
        case 'notice':
            return touch({ items: [...items, { kind: 'notice', id: event.id, level: event.level, text: event.text }] });
        case 'status':
            return touch({ status: event.status });
        case 'turn-end': {
            // Any permission still open was cancelled with the turn.
            const closed = items.map((item) => (item.kind === 'permission' && item.outcome === undefined ? { ...item, outcome: 'cancelled' } : item));
            return touch({
                items: [...closed, { kind: 'turn-end', id: event.id, stopReason: event.stopReason, at: event.at }],
                status: event.stopReason === 'error' ? 'error' : 'idle',
                unread: true,
            });
        }
        case 'title':
            return touch({ title: event.title });
        case 'agent-session':
            return touch({ agentSessionId: event.agentSessionId });
        case 'pending-changes':
            return touch({ pendingChanges: event.count });
        case 'read':
            return state.unread ? { ...state, unread: false } : state;
    }
}

/** ACP replaces a tool card's content; keep the output the IDE already streamed into its terminals. */
function mergeTerminalOutput(old: readonly ToolContentView[], next: readonly ToolContentView[]): readonly ToolContentView[] {
    return next.map((block) => {
        if (block.type !== 'terminal') {
            return block;
        }
        const previous = old.find((candidate) => candidate.type === 'terminal' && candidate.terminalId === block.terminalId);
        return previous && previous.type === 'terminal' && previous.output.length > block.output.length ? { ...block, output: previous.output, exitCode: block.exitCode ?? previous.exitCode } : block;
    });
}

/** The summary of a session, for lists. */
export function summarize(state: AgentSessionState): SessionSummary {
    return {
        id: state.id,
        title: state.title,
        agentRef: state.agentRef,
        agentName: state.agentName,
        workspaceRoot: state.workspaceRoot,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        status: state.status,
        unread: state.unread,
        pendingChanges: state.pendingChanges,
    };
}

/** A chat's first title: the start of the first message, on one line. */
export function titleFromPrompt(text: string): string {
    const line = text.replace(/\s+/g, ' ').trim();
    if (!line) {
        return 'New chat';
    }
    return line.length > 60 ? `${line.slice(0, 57).trimEnd()}...` : line;
}

// ---- IPC -------------------------------------------------------------------

export interface PromptAttachment {
    readonly kind: 'file' | 'selection';
    /** Workspace-relative path. */
    readonly path: string;
    readonly startLine?: number;
    readonly endLine?: number;
    /** The selected text (selection only); files are read by the main process. */
    readonly text?: string;
}

export const AGENT_SESSION_CHANNELS = {
    listAgents: 'codexr:agent-sessions:list-agents',
    probeAgent: 'codexr:agent-sessions:probe-agent',
    saveCustomAgent: 'codexr:agent-sessions:save-custom-agent',
    removeCustomAgent: 'codexr:agent-sessions:remove-custom-agent',
    login: 'codexr:agent-sessions:login',
    listProjects: 'codexr:agent-sessions:list-projects',
    get: 'codexr:agent-sessions:get',
    create: 'codexr:agent-sessions:create',
    prompt: 'codexr:agent-sessions:prompt',
    cancel: 'codexr:agent-sessions:cancel',
    respondPermission: 'codexr:agent-sessions:respond-permission',
    setMode: 'codexr:agent-sessions:set-mode',
    setConfigOption: 'codexr:agent-sessions:set-config-option',
    rename: 'codexr:agent-sessions:rename',
    remove: 'codexr:agent-sessions:remove',
    markRead: 'codexr:agent-sessions:mark-read',
} as const;

export const AGENT_SESSION_EVENTS = {
    message: 'codexr:agent-sessions:message',
} as const;

/** The integrated terminal a terminal login method runs in (see `AgentSessionsApi.login`). */
export interface LoginTerminal {
    readonly terminalId: number;
    readonly title: string;
    readonly cwd: string;
}

/** What `window.codexr.agentSessions` offers the renderer. */
export interface AgentSessionsApi {
    /** Every agent a chat can use: ACP presets and custom agents, and the built-in agent's profiles. */
    listAgents(): Promise<readonly AgentView[]>;
    /** Starts the agent once to learn whether it is installed and signed in (no prompt is sent). */
    probeAgent(ref: string): Promise<AgentView>;
    saveCustomAgent(input: Omit<AcpAgentDefinition, 'id' | 'preset'>, id?: string): Promise<AgentView>;
    removeCustomAgent(id: string): Promise<void>;
    /**
     * Runs one of the agent's login methods. An `agent` method resolves once
     * the agent finished its own login (it may open the browser). A `terminal`
     * method resolves as soon as the agent's login command runs in a new
     * integrated terminal of this window, with that terminal's id (the id the
     * terminal API and its data/exit events use) so the window can show it;
     * the agent is probed again when the command exits (`agents-changed`).
     */
    login(ref: string, methodId: string): Promise<LoginTerminal | null>;
    /** Recent projects and their chats, the window's own folder first. */
    listProjects(): Promise<readonly ProjectSessions[]>;
    get(sessionId: string): Promise<AgentSessionState>;
    /** A new chat in the folder open in this window. */
    create(agentRef: string): Promise<AgentSessionState>;
    /** Sends a message; events stream through `onMessage`. Resolves when the turn ends. */
    prompt(sessionId: string, text: string, attachments?: readonly PromptAttachment[]): Promise<void>;
    cancel(sessionId: string): Promise<void>;
    respondPermission(sessionId: string, requestId: string, optionId: string): Promise<void>;
    setMode(sessionId: string, modeId: string): Promise<void>;
    setConfigOption(sessionId: string, optionId: string, valueId: string): Promise<void>;
    rename(sessionId: string, title: string): Promise<SessionSummary>;
    remove(sessionId: string): Promise<void>;
    markRead(sessionId: string): Promise<void>;
    onMessage(listener: (message: AgentSessionMessage) => void): () => void;
}
