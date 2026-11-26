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
} as const;

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
}
