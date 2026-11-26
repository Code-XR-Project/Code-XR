/**
 * The contract of the AI agent hub (epic "AI agent hub inside the Code-XR IDE").
 *
 * Kept apart from api.ts so the agent work and the rest of the IDE do not
 * edit the same file: api.ts only spreads these channels into its own lists.
 * Like api.ts, this module is shared by main, preload and renderer and must
 * stay free of any Node, Electron or DOM import.
 *
 * Secrets never cross this contract towards the renderer: once an API key is
 * saved, the renderer only ever learns that one is configured and its last
 * four characters.
 */

/** The providers the IDE knows how to talk to. */
export const PROVIDER_KINDS = ['anthropic', 'openai', 'gemini', 'openrouter', 'nous', 'openai-compatible'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** What the settings form needs to know per kind; the main process adds the wire protocol (providerCatalog.ts). */
export interface ProviderDescriptor {
    readonly label: string;
    readonly defaultBaseUrl: string;
    /** False only for local, OpenAI-compatible servers (Ollama, LM Studio…). */
    readonly requiresKey: boolean;
    /** True when the person may point it at another endpoint. */
    readonly editableBaseUrl: boolean;
    /** Where the person gets a key, shown as a hint in the form. */
    readonly keyHelp: string;
}

export const PROVIDER_DESCRIPTORS: Readonly<Record<ProviderKind, ProviderDescriptor>> = {
    anthropic: { label: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com/v1', requiresKey: true, editableBaseUrl: false, keyHelp: 'console.anthropic.com, API keys' },
    openai: { label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', requiresKey: true, editableBaseUrl: false, keyHelp: 'platform.openai.com, API keys' },
    gemini: { label: 'Google Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', requiresKey: true, editableBaseUrl: false, keyHelp: 'aistudio.google.com, Get API key' },
    openrouter: { label: 'OpenRouter', defaultBaseUrl: 'https://openrouter.ai/api/v1', requiresKey: true, editableBaseUrl: false, keyHelp: 'openrouter.ai, Keys' },
    nous: { label: 'Nous Portal', defaultBaseUrl: 'https://inference-api.nousresearch.com/v1', requiresKey: true, editableBaseUrl: false, keyHelp: 'portal.nousresearch.com, API keys' },
    'openai-compatible': { label: 'OpenAI-compatible', defaultBaseUrl: 'http://127.0.0.1:11434/v1', requiresKey: false, editableBaseUrl: true, keyHelp: 'Optional: local servers such as Ollama or LM Studio need none' },
};

/** The wire protocol a provider speaks; several providers share the OpenAI one. */
export type ProviderApiFamily = 'anthropic' | 'openai' | 'gemini';

/** Where an API key is kept. */
export type KeyStorage =
    /** Encrypted with the OS secret store (Keychain, DPAPI, libsecret/kwallet). */
    | 'os-encrypted'
    /** No usable secret store: held in memory until the IDE quits. */
    | 'session-only'
    /** No key (e.g. a local Ollama endpoint). */
    | 'none';

/** A configured provider as the renderer sees it: never the key itself. */
export interface ProviderView {
    readonly id: string;
    readonly kind: ProviderKind;
    readonly label: string;
    /** Only for kinds whose endpoint can change (`openai-compatible`); otherwise the catalogue default. */
    readonly baseUrl: string;
    readonly hasKey: boolean;
    /** Last four characters of the key, to tell keys apart; empty when there is none. */
    readonly keyHint: string;
    readonly keyStorage: KeyStorage;
}

/** What the renderer sends to add or edit a provider. `apiKey` absent keeps the stored one. */
export interface ProviderInput {
    readonly kind: ProviderKind;
    readonly label?: string;
    readonly baseUrl?: string;
    readonly apiKey?: string;
}

/** How safe key storage is on this machine, shown in the providers settings. */
export interface SecretStoreStatus {
    readonly available: boolean;
    /** Electron's Linux backend name (`gnome_libsecret`, `kwallet6`, `basic_text`…), or the OS store elsewhere. */
    readonly backend: string;
}

export interface ModelInfo {
    readonly id: string;
    readonly label: string;
}

export type ConnectionTestResult =
    | { readonly ok: true; readonly models: readonly ModelInfo[] }
    | { readonly ok: false; readonly error: string };

/** Channels of the agent hub; api.ts merges them into IPC_CHANNELS. */
export const AGENT_IPC_CHANNELS = {
    agentsSecretStore: 'codexr:agents:secret-store',
    agentsListProviders: 'codexr:agents:list-providers',
    agentsSaveProvider: 'codexr:agents:save-provider',
    agentsRemoveProvider: 'codexr:agents:remove-provider',
    agentsTestProvider: 'codexr:agents:test-provider',
    agentsListAgents: 'codexr:agents:list-agents',
    agentsSaveAgent: 'codexr:agents:save-agent',
    agentsRemoveAgent: 'codexr:agents:remove-agent',
    agentsListSessions: 'codexr:agents:list-sessions',
    agentsGetSession: 'codexr:agents:get-session',
    agentsCreateSession: 'codexr:agents:create-session',
    agentsRenameSession: 'codexr:agents:rename-session',
    agentsDeleteSession: 'codexr:agents:delete-session',
    agentsExportSession: 'codexr:agents:export-session',
    agentsSend: 'codexr:agents:send',
    agentsStop: 'codexr:agents:stop',
    agentsTools: 'codexr:agents:tools',
    agentsApprove: 'codexr:agents:approve',
    agentsResolveReview: 'codexr:agents:resolve-review',
} as const;

/** What a tool can do, which decides whether it asks first (A7). */
export type ToolRisk = 'read' | 'write' | 'run' | 'network';

export interface ToolInfo {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly risk: ToolRisk;
}

/** One tool call inside an answer, as the chat shows it. */
export interface ToolRunView {
    readonly id: string;
    readonly name: string;
    /** One line: what was asked ("read src/main.ts lines 1-80"). */
    readonly summary: string;
    readonly status: 'running' | 'done' | 'error' | 'denied';
    /** The start of the result, for the collapsible block. */
    readonly result?: string;
}

/** A risky tool call waiting for the person (A7). */
export interface ApprovalRequest {
    readonly id: string;
    readonly sessionId: string;
    readonly tool: string;
    readonly title: string;
    /** Exactly what will happen: the command, the file and its change… */
    readonly detail: string;
}

export type ApprovalDecision = 'once' | 'always' | 'deny';

/**
 * A file change an agent proposes (A8). The window shows it as a diff and
 * writes what the person accepts through its normal save path; the main
 * process never writes it.
 */
export interface EditReviewRequest {
    readonly id: string;
    readonly sessionId: string;
    readonly path: string;
    /** The file as the agent read it ('' for a new file). */
    readonly original: string;
    /** Its modification time then, so a file changed meanwhile is not overwritten. */
    readonly originalMtimeMs: number | null;
    readonly proposed: string;
    readonly isNew: boolean;
    /** The agent's one-line reason. */
    readonly summary: string;
}

export interface EditReviewResult {
    readonly outcome: 'applied' | 'rejected' | 'failed';
    /** Hunks accepted out of the total. */
    readonly accepted: number;
    readonly total: number;
    /** Why it failed, or the person's note. */
    readonly message?: string;
}

/** Context attached to a message (A6). The main process reads files itself; only the selection's text crosses. */
export type ChatAttachment =
    | { readonly kind: 'file'; readonly path: string }
    | { readonly kind: 'selection'; readonly path: string; readonly startLine: number; readonly endLine: number; readonly text: string };

/** Main -> renderer events of the agent hub; api.ts merges them into IPC_EVENTS. */
export const AGENT_IPC_EVENTS = {
    agentsChat: 'codexr:agents:chat',
} as const;

/** A named agent (A4): which provider and model, how it behaves. No secrets. */
export interface AgentProfile {
    readonly id: string;
    readonly name: string;
    /** A configured provider's id; empty when the agent still needs one. */
    readonly providerId: string;
    readonly model: string;
    readonly instructions: string;
    /** 0-2; absent uses the provider's default. */
    readonly temperature?: number;
    /** Tool names this agent may use (A7). */
    readonly tools: readonly string[];
    /** Risky tools the person allowed for this agent with "Always" (A7). */
    readonly alwaysAllow?: readonly string[];
}

/** What the renderer sends to create (no id) or edit an agent. */
export type AgentProfileInput = Omit<AgentProfile, 'id'>;

/** One message of a chat, as stored and shown. */
export interface ChatMessageView {
    readonly role: 'user' | 'assistant';
    readonly content: string;
    /** ISO time. */
    readonly at: string;
    /** Set on an assistant turn that failed or was stopped. */
    readonly error?: string;
    readonly stopped?: boolean;
    readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
    readonly model?: string;
    /** Labels of the context attached to a user turn ("src/main.ts", "app.ts:10-24"). */
    readonly attachments?: readonly string[];
    /** The attached context itself, sent to the model before `content` on every turn; not shown. */
    readonly context?: string;
    /** Tools the agent used while answering (A7). */
    readonly toolRuns?: readonly ToolRunView[];
}

export interface ChatSessionSummary {
    readonly id: string;
    readonly title: string;
    readonly agentId: string;
    readonly updatedAt: string;
    readonly messageCount: number;
}

export interface ChatSession extends ChatSessionSummary {
    readonly messages: readonly ChatMessageView[];
    /** True while an answer is streaming. */
    readonly running: boolean;
}

/** Streaming progress of one answer, pushed to the window that asked. */
export type AgentChatEvent =
    | { readonly sessionId: string; readonly type: 'start'; readonly model: string; readonly trimmed: number }
    | { readonly sessionId: string; readonly type: 'delta'; readonly text: string }
    | { readonly sessionId: string; readonly type: 'tool'; readonly run: ToolRunView }
    | { readonly sessionId: string; readonly type: 'approval'; readonly request: ApprovalRequest }
    | { readonly sessionId: string; readonly type: 'review'; readonly request: EditReviewRequest }
    | { readonly sessionId: string; readonly type: 'end'; readonly message: ChatMessageView };

/** What `window.codexr.agents` offers the renderer. */
export interface AgentsApi {
    /** Whether keys can be stored encrypted on this machine. */
    secretStore(): Promise<SecretStoreStatus>;
    listProviders(): Promise<readonly ProviderView[]>;
    /** Adds a provider (no `id`) or edits one; an absent `apiKey` keeps the stored key. */
    saveProvider(input: ProviderInput, id?: string): Promise<ProviderView>;
    /** Removes the provider and deletes its key. */
    removeProvider(id: string): Promise<void>;
    /** Lists the provider's models with the stored key, or says why it cannot. */
    testProvider(id: string): Promise<ConnectionTestResult>;
    /** Agent profiles (A4); built-in starters are created on first use. */
    listAgents(): Promise<readonly AgentProfile[]>;
    saveAgent(input: AgentProfileInput, id?: string): Promise<AgentProfile>;
    removeAgent(id: string): Promise<void>;
    /** Chats of the folder open in this window (A5), newest first. */
    listSessions(): Promise<readonly ChatSessionSummary[]>;
    getSession(id: string): Promise<ChatSession>;
    createSession(agentId: string): Promise<ChatSession>;
    renameSession(id: string, title: string): Promise<ChatSessionSummary>;
    deleteSession(id: string): Promise<void>;
    /** The chat as Markdown, for saving or copying. */
    exportSession(id: string): Promise<string>;
    /** Sends a message; the answer streams through `onChat`. Resolves once the answer ends. */
    send(sessionId: string, text: string, attachments?: readonly ChatAttachment[]): Promise<void>;
    /** Stops the answer being streamed in this chat, if any. */
    stop(sessionId: string): Promise<void>;
    onChat(listener: (event: AgentChatEvent) => void): () => void;
    /** Every tool an agent can be given (A7). */
    tools(): Promise<readonly ToolInfo[]>;
    /** Answers an approval card. */
    approve(requestId: string, decision: ApprovalDecision): Promise<void>;
    /** Reports what the person did with a proposed edit (A8). */
    resolveReview(requestId: string, result: EditReviewResult): Promise<void>;
}
