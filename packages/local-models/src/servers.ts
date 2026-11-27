/**
 * Local model servers (epic #310, LM1): the servers Code-XR knows by name,
 * and the rules every endpoint the person types has to follow.
 *
 * Pure data and functions: no Node, Electron, DOM or `vscode` import, so the
 * Code-XR IDE and the VS Code extension share this module as it is.
 */

export const LOCAL_SERVER_IDS = ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'jan', 'localai', 'custom'] as const;
export type LocalServerId = (typeof LOCAL_SERVER_IDS)[number];

export interface LocalServerPreset {
    readonly id: LocalServerId;
    readonly label: string;
    /** The OpenAI-compatible base URL the server listens on by default (ends in /v1). */
    readonly defaultBaseUrl: string;
    /** One line on how to start it, shown when it cannot be reached. */
    readonly startHint: string;
    /** True when "Detect" probes its default port. */
    readonly detectable: boolean;
}

export const LOCAL_SERVER_PRESETS: Readonly<Record<LocalServerId, LocalServerPreset>> = {
    ollama: { id: 'ollama', label: 'Ollama', defaultBaseUrl: 'http://127.0.0.1:11434/v1', startHint: 'Start Ollama (the app, or `ollama serve`) and pull a model, e.g. `ollama pull qwen2.5-coder`.', detectable: true },
    lmstudio: { id: 'lmstudio', label: 'LM Studio', defaultBaseUrl: 'http://127.0.0.1:1234/v1', startHint: 'In LM Studio, load a model and start the server (Developer tab, or `lms server start`).', detectable: true },
    llamacpp: { id: 'llamacpp', label: 'llama.cpp server', defaultBaseUrl: 'http://127.0.0.1:8080/v1', startHint: 'Run `llama-server -m <model.gguf> --jinja` (the --jinja flag enables tool calls).', detectable: true },
    vllm: { id: 'vllm', label: 'vLLM', defaultBaseUrl: 'http://127.0.0.1:8000/v1', startHint: 'Run `vllm serve <model> --enable-auto-tool-choice --tool-call-parser <parser>`.', detectable: true },
    jan: { id: 'jan', label: 'Jan', defaultBaseUrl: 'http://127.0.0.1:1337/v1', startHint: 'In Jan, open Settings > Local API Server and start it.', detectable: true },
    localai: { id: 'localai', label: 'LocalAI', defaultBaseUrl: 'http://127.0.0.1:8080/v1', startHint: 'Start LocalAI (e.g. `local-ai run <model>`).', detectable: false },
    custom: { id: 'custom', label: 'Other OpenAI-compatible server', defaultBaseUrl: 'http://127.0.0.1:8080/v1', startHint: 'Start your server and check its OpenAI-compatible base URL (it usually ends in /v1).', detectable: false },
};

export function isLocalServerId(value: unknown): value is LocalServerId {
    return typeof value === 'string' && (LOCAL_SERVER_IDS as readonly string[]).includes(value);
}

/** True for this machine: localhost, 127.0.0.0/8 and ::1. */
export function isLoopbackHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * True for an address of a private network (RFC 1918, link-local, CGNAT as
 * used by Tailscale, IPv6 unique-local and link-local): a model served by
 * another computer at home or in the lab.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
    }
    return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host) || host.endsWith('.local');
}

/**
 * Checks an endpoint the person typed and returns it normalised (no trailing
 * slash, `/v1` added to a bare host). Plain http is accepted towards this
 * machine and a private network only, so an API key never crosses the
 * internet in clear; credentials in the URL are refused.
 */
export function normalizeLocalBaseUrl(raw: string): string {
    const text = raw.trim();
    if (!text) {
        throw new Error('Enter the server address, e.g. http://127.0.0.1:11434/v1.');
    }
    let url: URL;
    try {
        url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
    } catch {
        throw new Error('The server address is not a valid URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('The server address must start with http:// or https://.');
    }
    if (url.username || url.password) {
        throw new Error('Put the API key in its own field, not in the URL.');
    }
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !isPrivateNetworkHost(url.hostname)) {
        throw new Error('Plain http is only allowed for this computer or your local network; use https for anything else.');
    }
    url.hash = '';
    url.search = '';
    let pathname = url.pathname.replace(/\/+$/, '');
    // The OpenAI-compatible routes live under /v1 on every known server.
    if (pathname === '') {
        pathname = '/v1';
    }
    // People paste the chat route itself; keep the base.
    pathname = pathname.replace(/\/(chat\/completions|completions|models)$/, '');
    return `${url.protocol}//${url.host}${pathname}`;
}

/** The server's root (without /v1), where Ollama's native API lives. */
export function serverRoot(baseUrl: string): string {
    return baseUrl.replace(/\/v1$/, '');
}

/** A short label for an endpoint: `Ollama, qwen2.5-coder` style lists use it. */
export function describeEndpoint(baseUrl: string): string {
    try {
        const url = new URL(baseUrl);
        return url.host;
    } catch {
        return baseUrl;
    }
}
