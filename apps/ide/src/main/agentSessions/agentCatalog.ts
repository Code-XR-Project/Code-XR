import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_PRESET_IDS, type AcpAgentDefinition, type AgentAvailability, type AgentPresetId, type AgentView } from '../../shared/agentSession.ts';
import type { AgentLaunch } from './acpConnection.ts';
import type { AuthMethodSpec } from './acpMapping.ts';

/**
 * AF1/AF2: the agents a chat can use. Three presets the IDE knows how to
 * launch (Claude Code, Codex and Gemini CLI, each through the vendor's own
 * ACP entry point), the person's custom ACP agents (stored as JSON), and the
 * built-in agent's profiles (epic #189), listed for the picker only.
 *
 * A preset is found, in order, as a package the IDE installed under
 * `<userData>/agent-packages` (its bin script run by Electron's own Node,
 * `ELECTRON_RUN_AS_NODE=1`, so no system Node is needed), or as its command
 * on PATH. Nothing is downloaded here: a missing agent says how to install it,
 * and agentInstaller.ts installs it on the person's request.
 *
 * Agents get a minimal environment: the variables a CLI needs to find its
 * home, its config and the network, the vendor's own key variables for a
 * preset, and the definition's `env`. The IDE never reads or stores the
 * agents' OAuth tokens; each vendor's CLI keeps its own.
 */

interface PresetSpec {
    readonly id: AgentPresetId;
    readonly name: string;
    readonly description: string;
    readonly packageName: string;
    readonly bin: string;
    readonly args: readonly string[];
    /** The vendor's own environment variables (API keys, endpoints) passed through to the agent. */
    readonly passEnv: RegExp;
}

export const PRESETS: readonly PresetSpec[] = [
    {
        id: 'claude',
        name: 'Claude Code',
        description: 'Anthropic\'s Claude Code through its ACP adapter. Sign in with your Claude account or use an API key.',
        packageName: '@agentclientprotocol/claude-agent-acp',
        bin: 'claude-agent-acp',
        args: [],
        passEnv: /^(ANTHROPIC_|CLAUDE_)/i,
    },
    {
        id: 'codex',
        name: 'Codex',
        description: 'OpenAI\'s Codex through its ACP adapter. Sign in with ChatGPT or use an API key.',
        packageName: '@agentclientprotocol/codex-acp',
        bin: 'codex-acp',
        args: [],
        passEnv: /^(OPENAI_|CODEX_)/i,
    },
    {
        id: 'gemini',
        name: 'Gemini CLI',
        description: 'Google\'s Gemini CLI in ACP mode. Sign in with Google or use an API key.',
        packageName: '@google/gemini-cli',
        bin: 'gemini',
        args: ['--acp'],
        passEnv: /^(GEMINI_|GOOGLE_)/i,
    },
];

/** What every agent may inherit from the IDE's environment. */
const BASE_ENV = /^(PATH|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LANGUAGE|LC_ALL|LC_CTYPE|USER|USERNAME|LOGNAME|SHELL|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|XDG_STATE_HOME|XDG_RUNTIME_DIR|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i;

/** The environment an agent starts with. */
export function agentEnvironment(base: Readonly<Record<string, string | undefined>>, passEnv: RegExp | null, extra: Readonly<Record<string, string>>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
        if (value !== undefined && (BASE_ENV.test(key) || (passEnv !== null && passEnv.test(key)))) {
            env[key] = value;
        }
    }
    return { ...env, ...extra };
}

export interface FileProbe {
    /** True when `file` exists and can be run (on Windows: exists). */
    isExecutable(file: string): Promise<boolean>;
    readText(file: string): Promise<string | null>;
}

export const diskProbe: FileProbe = {
    async isExecutable(file) {
        try {
            const stat = await fs.promises.stat(file);
            if (!stat.isFile()) {
                return false;
            }
            if (process.platform !== 'win32') {
                await fs.promises.access(file, fs.constants.X_OK);
            }
            return true;
        } catch {
            return false;
        }
    },
    async readText(file) {
        try {
            return await fs.promises.readFile(file, 'utf8');
        } catch {
            return null;
        }
    },
};

/** Looks `name` up on PATH (with PATHEXT on Windows), as a shell would. */
export async function findOnPath(name: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform, probe: FileProbe): Promise<string | null> {
    const api = platform === 'win32' ? path.win32 : path.posix;
    const pathValue = Object.entries(env).find(([key]) => (platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH'))?.[1] ?? '';
    const extensions = platform === 'win32'
        ? ['', ...(Object.entries(env).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase())]
        : [''];
    for (const dir of pathValue.split(platform === 'win32' ? ';' : ':')) {
        if (!dir.trim()) {
            continue;
        }
        for (const ext of extensions) {
            if (platform === 'win32' && ext === '' && !/\.[A-Za-z0-9]+$/.test(name)) {
                continue;
            }
            const candidate = api.join(dir.replace(/^"|"$/g, ''), name + ext);
            if (await probe.isExecutable(candidate)) {
                return candidate;
            }
        }
    }
    return null;
}

/** The bin script a package declares under `binName` (or its only bin). */
async function packageBin(packageDir: string, binName: string, probe: FileProbe): Promise<string | null> {
    const text = await probe.readText(path.join(packageDir, 'package.json'));
    if (text === null) {
        return null;
    }
    let manifest: { bin?: unknown };
    try {
        manifest = JSON.parse(text) as { bin?: unknown };
    } catch {
        return null;
    }
    const bin = manifest.bin;
    let relative: string | undefined;
    if (typeof bin === 'string') {
        relative = bin;
    } else if (bin && typeof bin === 'object') {
        const entries = bin as Record<string, unknown>;
        const named = entries[binName];
        relative = typeof named === 'string' ? named : (Object.values(entries).find((value): value is string => typeof value === 'string'));
    }
    return relative ? path.join(packageDir, relative) : null;
}

export type Resolution =
    | { readonly found: true; readonly launch: AgentLaunch; readonly via: string }
    | { readonly found: false; readonly detail: string };

export interface CatalogOptions {
    /** `<userData>/agent-packages`: packages the IDE installed (AF2). */
    readonly packagesDir: string;
    readonly store: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Promise<void> };
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly platform: NodeJS.Platform;
    /** Electron's own executable, which runs JavaScript bins with `ELECTRON_RUN_AS_NODE=1`. */
    readonly execPath: string;
    readonly probe?: FileProbe;
    /** The built-in agent's profiles (epic #189). */
    readonly builtinProfiles: () => Promise<readonly { readonly id: string; readonly name: string }[]>;
}

/** What the last probe or chat learned about an agent. */
export interface AgentState {
    readonly availability: AgentAvailability;
    readonly detail?: string;
    readonly authMethods?: readonly AuthMethodSpec[];
}

const CUSTOM_KEY = 'customAgents';
const CUSTOM_ID = /^custom-[a-f0-9]{8}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A custom agent from the renderer, checked field by field. */
export function parseCustomAgent(input: unknown): Omit<AcpAgentDefinition, 'id' | 'preset'> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Invalid agent.');
    }
    const value = input as Record<string, unknown>;
    const name = typeof value['name'] === 'string' ? value['name'].trim() : '';
    if (!name || name.length > 80) {
        throw new Error('An agent needs a name of at most 80 characters.');
    }
    const command = typeof value['command'] === 'string' ? value['command'].trim() : '';
    if (!command || command.length > 1024 || command.includes('\0')) {
        throw new Error('An agent needs a command: a program name on PATH or an absolute path.');
    }
    const rawArgs = value['args'] ?? [];
    if (!Array.isArray(rawArgs) || rawArgs.length > 64 || !rawArgs.every((arg) => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0'))) {
        throw new Error('Arguments must be a list of at most 64 strings.');
    }
    const rawEnv = value['env'] ?? {};
    if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
        throw new Error('The environment must be a map of names to values.');
    }
    const envEntries = Object.entries(rawEnv as Record<string, unknown>);
    if (envEntries.length > 64 || !envEntries.every(([key, val]) => ENV_NAME.test(key) && typeof val === 'string' && val.length <= 8192 && !val.includes('\0'))) {
        throw new Error('Environment variables need names like MY_VAR and string values.');
    }
    const description = typeof value['description'] === 'string' && value['description'].trim() ? value['description'].trim().slice(0, 300) : 'A custom ACP agent.';
    return {
        name,
        command,
        args: rawArgs as string[],
        ...(envEntries.length ? { env: Object.fromEntries(envEntries) as Record<string, string> } : {}),
        description,
    };
}

function isDefinition(value: unknown): value is AcpAgentDefinition {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const definition = value as AcpAgentDefinition;
    return typeof definition.id === 'string' && CUSTOM_ID.test(definition.id) && typeof definition.name === 'string' && typeof definition.command === 'string' && Array.isArray(definition.args);
}

/** Quotes one part of a `cmd.exe /d /s /c "..."` line. */
function cmdQuote(part: string): string {
    if (/["%]/.test(part)) {
        throw new Error(`Cannot pass ${part} to cmd.exe safely.`);
    }
    return /[\s&|<>^()]/.test(part) || part === '' ? `"${part}"` : part;
}

export class AgentCatalog {
    private readonly options: CatalogOptions;
    private readonly probe: FileProbe;
    private readonly states = new Map<string, AgentState>();

    constructor(options: CatalogOptions) {
        this.options = options;
        this.probe = options.probe ?? diskProbe;
    }

    customAgents(): AcpAgentDefinition[] {
        const raw = this.options.store.get<unknown>(CUSTOM_KEY);
        return Array.isArray(raw) ? raw.filter(isDefinition) : [];
    }

    /** The definition behind an `acp:<id>` ref; null for anything else. */
    definition(ref: string): AcpAgentDefinition | null {
        if (!ref.startsWith('acp:')) {
            return null;
        }
        const id = ref.slice(4);
        const preset = PRESETS.find((candidate) => candidate.id === id);
        if (preset) {
            return { id: preset.id, name: preset.name, command: preset.bin, args: preset.args, preset: preset.id, description: preset.description };
        }
        return this.customAgents().find((agent) => agent.id === id) ?? null;
    }

    state(ref: string): AgentState | undefined {
        return this.states.get(ref);
    }

    setState(ref: string, state: AgentState): void {
        const previous = this.states.get(ref);
        // A failed `session/new` must not forget the login methods `initialize` advertised.
        this.states.set(ref, state.authMethods || !previous?.authMethods ? state : { ...state, authMethods: previous.authMethods });
    }

    /** How to start an agent, or why it cannot be found. */
    async resolve(definition: AcpAgentDefinition): Promise<Resolution> {
        const { env, platform, execPath, packagesDir } = this.options;
        const preset = definition.preset ? PRESETS.find((candidate) => candidate.id === definition.preset) : undefined;
        const agentEnv = (extra: Record<string, string> = {}): Record<string, string> => agentEnvironment(env, preset?.passEnv ?? null, { ...(definition.env ?? {}), ...extra });
        const viaNode = (script: string, via: string): Resolution => ({
            found: true,
            via,
            launch: { command: execPath, args: [script, ...definition.args], env: agentEnv({ ELECTRON_RUN_AS_NODE: '1' }) },
        });

        if (preset) {
            const installed = await packageBin(path.join(packagesDir, 'node_modules', ...preset.packageName.split('/')), preset.bin, this.probe);
            if (installed && (await this.probe.readText(installed)) !== null) {
                return viaNode(installed, `${preset.packageName} (installed by the IDE)`);
            }
        }

        const api = platform === 'win32' ? path.win32 : path.posix;
        let found: string | null;
        if (api.isAbsolute(definition.command)) {
            found = (await this.probe.isExecutable(definition.command)) ? definition.command : null;
        } else if (/[\\/]/.test(definition.command)) {
            return { found: false, detail: `${definition.command} is a relative path; use a program name on PATH or an absolute path.` };
        } else {
            found = await findOnPath(definition.command, env, platform, this.probe);
        }
        if (!found) {
            return {
                found: false,
                detail: preset
                    ? `${preset.name} is not installed. Press Install, or install it yourself with: npm install -g ${preset.packageName}`
                    : `${definition.command} was not found. Check the command, or use an absolute path.`,
            };
        }
        if (platform === 'win32' && /\.(cmd|bat)$/i.test(found)) {
            // A .cmd shim cannot be spawned without a shell. An npm shim's script sits next to it.
            if (preset) {
                const script = await packageBin(api.join(api.dirname(found), 'node_modules', ...preset.packageName.split('/')), preset.bin, this.probe);
                if (script && (await this.probe.readText(script)) !== null) {
                    return viaNode(script, found);
                }
            }
            const line = [found, ...definition.args].map(cmdQuote).join(' ');
            return { found: true, via: found, launch: { command: env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], env: agentEnv(), verbatimArguments: true } };
        }
        return { found: true, via: found, launch: { command: found, args: [...definition.args], env: agentEnv() } };
    }

    /** AF2: the version of a preset the IDE installed under its own folder, or null. */
    async installedVersion(presetId: AgentPresetId): Promise<string | null> {
        const preset = PRESETS.find((candidate) => candidate.id === presetId);
        if (!preset) {
            return null;
        }
        const text = await this.probe.readText(path.join(this.options.packagesDir, 'node_modules', ...preset.packageName.split('/'), 'package.json'));
        if (text === null) {
            return null;
        }
        try {
            const version = (JSON.parse(text) as { version?: unknown }).version;
            return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version.slice(0, 64) : null;
        } catch {
            return null;
        }
    }

    /** Forgets what probes learned about an agent (after it was installed, updated or removed). */
    forget(ref: string): void {
        this.states.delete(ref);
    }

    async view(definition: AcpAgentDefinition): Promise<AgentView> {
        const ref = `acp:${definition.id}`;
        const resolution = await this.resolve(definition);
        const state = this.states.get(ref);
        const installedVersion = definition.preset ? await this.installedVersion(definition.preset) : null;
        const base = {
            ...(installedVersion ? { installedVersion } : {}),
            ref,
            name: definition.name,
            kind: 'acp' as const,
            description: definition.description,
            ...(definition.preset ? { preset: definition.preset } : {}),
            ...(state?.authMethods?.length ? { authMethods: state.authMethods.map((method) => method.view) } : {}),
        };
        if (!resolution.found) {
            return { ...base, availability: 'missing', detail: resolution.detail };
        }
        return { ...base, availability: state?.availability ?? 'available', ...(state?.detail ? { detail: state.detail } : {}) };
    }

    /** Every agent for the picker: presets, custom agents, then the built-in agent's profiles. */
    async list(): Promise<AgentView[]> {
        const acp = [...AGENT_PRESET_IDS.map((id) => this.definition(`acp:${id}`)), ...this.customAgents()].filter((definition): definition is AcpAgentDefinition => definition !== null);
        const views = await Promise.all(acp.map((definition) => this.view(definition)));
        let profiles: readonly { readonly id: string; readonly name: string }[] = [];
        try {
            profiles = await this.options.builtinProfiles();
        } catch {
            profiles = [];
        }
        for (const profile of profiles) {
            views.push({
                ref: `builtin:${profile.id}`,
                name: profile.name,
                kind: 'builtin',
                description: 'The IDE\'s own agent, with a provider and API key set up in the Agents view.',
                availability: 'available',
            });
        }
        return views;
    }

    async builtinView(ref: string): Promise<AgentView | null> {
        return (await this.list()).find((view) => view.ref === ref && view.kind === 'builtin') ?? null;
    }

    async saveCustom(input: unknown, id?: unknown): Promise<AcpAgentDefinition> {
        const parsed = parseCustomAgent(input);
        const agents = this.customAgents();
        if (id !== undefined && id !== null && (typeof id !== 'string' || !agents.some((agent) => agent.id === id))) {
            throw new Error('That agent no longer exists.');
        }
        const definition: AcpAgentDefinition = { ...parsed, id: typeof id === 'string' ? id : `custom-${randomUUID().replace(/-/g, '').slice(0, 8)}` };
        const next = typeof id === 'string' ? agents.map((agent) => (agent.id === id ? definition : agent)) : [...agents, definition];
        await this.options.store.update(CUSTOM_KEY, next);
        this.states.delete(`acp:${definition.id}`);
        return definition;
    }

    async removeCustom(id: unknown): Promise<void> {
        if (typeof id !== 'string' || !CUSTOM_ID.test(id)) {
            throw new Error('Only a custom agent can be removed.');
        }
        await this.options.store.update(CUSTOM_KEY, this.customAgents().filter((agent) => agent.id !== id));
        this.states.delete(`acp:${id}`);
    }
}
