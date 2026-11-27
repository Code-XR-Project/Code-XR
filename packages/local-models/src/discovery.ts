import { LOCAL_SERVER_PRESETS, LOCAL_SERVER_IDS, serverRoot, type LocalServerId } from './servers.ts';

/**
 * Model listing and server detection (epic #310, LM1/LM4). Every request
 * goes through an injected `fetch`, with a short timeout: hosts pass their
 * own (Node's, Electron's), tests pass a fake, and nothing here touches the
 * network on its own.
 */

export type FetchFn = (input: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface LocalModel {
    readonly id: string;
    /** Bytes on disk, when the server says (Ollama). */
    readonly size?: number;
    /** e.g. "7.6B", when the server says (Ollama). */
    readonly parameters?: string;
}

export type ModelListResult =
    | { readonly ok: true; readonly models: readonly LocalModel[] }
    | { readonly ok: false; readonly error: string };

export interface ListOptions {
    readonly fetch: FetchFn;
    readonly apiKey?: string | undefined;
    readonly timeoutMs?: number;
    /** Which server this is, for the wording of errors. */
    readonly serverId?: LocalServerId;
}

const DEFAULT_TIMEOUT_MS = 4000;
const MAX_MODELS = 500;

async function getJson(fetchFn: FetchFn, url: string, apiKey: string | undefined, timeoutMs: number): Promise<{ status: number; ok: boolean; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchFn(url, { method: 'GET', headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, signal: controller.signal });
        let body: unknown = null;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        return { status: response.status, ok: response.ok, body };
    } finally {
        clearTimeout(timer);
    }
}

/** The models of an OpenAI-compatible `/models` answer (`{ data: [{ id }] }`). */
export function parseOpenAiModels(body: unknown): LocalModel[] {
    const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
    if (!Array.isArray(data)) {
        return [];
    }
    const ids = data
        .map((entry) => (entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === 'string' && id.trim() !== '' && id.length <= 300);
    return [...new Set(ids)].slice(0, MAX_MODELS).map((id) => ({ id }));
}

/** Ollama's `/api/tags` (`{ models: [{ name, size, details: { parameter_size } }] }`). */
export function parseOllamaTags(body: unknown): LocalModel[] {
    const models = body && typeof body === 'object' ? (body as { models?: unknown }).models : undefined;
    if (!Array.isArray(models)) {
        return [];
    }
    const out: LocalModel[] = [];
    for (const entry of models.slice(0, MAX_MODELS)) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const record = entry as { name?: unknown; model?: unknown; size?: unknown; details?: { parameter_size?: unknown } };
        const id = typeof record.model === 'string' ? record.model : typeof record.name === 'string' ? record.name : '';
        if (!id || id.length > 300) {
            continue;
        }
        const parameters = typeof record.details?.parameter_size === 'string' ? record.details.parameter_size.slice(0, 20) : undefined;
        out.push({ id, ...(typeof record.size === 'number' && record.size > 0 ? { size: record.size } : {}), ...(parameters ? { parameters } : {}) });
    }
    return out;
}

/** "Ollama is not running on 127.0.0.1:11434" and friends. */
export function unreachableMessage(baseUrl: string, serverId: LocalServerId | undefined, reason: string): string {
    let host = baseUrl;
    try {
        host = new URL(baseUrl).host;
    } catch {
        // Keep the raw text.
    }
    const preset = serverId ? LOCAL_SERVER_PRESETS[serverId] : undefined;
    const who = preset && serverId !== 'custom' ? preset.label : 'No server';
    return `${who} is not answering on ${host} (${reason}). ${preset?.startHint ?? LOCAL_SERVER_PRESETS.custom.startHint}`;
}

function reasonOf(error: unknown): string {
    if (error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError') {
        return 'timed out';
    }
    const cause = error && typeof error === 'object' ? (error as { cause?: { code?: unknown } }).cause : undefined;
    if (cause && typeof cause.code === 'string') {
        return cause.code === 'ECONNREFUSED' ? 'connection refused' : cause.code;
    }
    return error instanceof Error ? error.message : String(error);
}

/**
 * The models a server offers. Ollama is asked through its native API first
 * (it carries sizes), then everything through the OpenAI-compatible route.
 */
export async function listLocalModels(baseUrl: string, options: ListOptions): Promise<ModelListResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let ollama: LocalModel[] = [];
    if (options.serverId === 'ollama') {
        try {
            const tags = await getJson(options.fetch, `${serverRoot(baseUrl)}/api/tags`, options.apiKey, timeoutMs);
            ollama = tags.ok ? parseOllamaTags(tags.body) : [];
        } catch {
            ollama = [];
        }
    }
    let answer: { status: number; ok: boolean; body: unknown };
    try {
        answer = await getJson(options.fetch, `${baseUrl}/models`, options.apiKey, timeoutMs);
    } catch (error) {
        if (ollama.length > 0) {
            return { ok: true, models: ollama };
        }
        return { ok: false, error: unreachableMessage(baseUrl, options.serverId, reasonOf(error)) };
    }
    if (answer.status === 401 || answer.status === 403) {
        return { ok: false, error: 'The server refused the request: check the API key (most local servers need none).' };
    }
    if (!answer.ok) {
        return ollama.length > 0 ? { ok: true, models: ollama } : { ok: false, error: `The server answered ${answer.status} for ${baseUrl}/models. Check that the address is its OpenAI-compatible base URL (it usually ends in /v1).` };
    }
    const listed = parseOpenAiModels(answer.body);
    // Ollama's own list wins (it has sizes); anything only the OpenAI route lists is added.
    const byId = new Map<string, LocalModel>(ollama.map((model) => [model.id, model]));
    for (const model of listed) {
        if (!byId.has(model.id)) {
            byId.set(model.id, model);
        }
    }
    const models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, models };
}

export interface DetectedServer {
    readonly serverId: LocalServerId;
    readonly label: string;
    readonly baseUrl: string;
    readonly models: readonly LocalModel[];
}

/**
 * LM4: probes the default port of each detectable preset on this machine
 * only, in parallel, once, when the person asks. Two presets sharing a port
 * are probed once (the first wins). Servers that answer with no model are
 * still reported: the person may just need to load one.
 */
export async function detectLocalServers(fetchFn: FetchFn, timeoutMs = 1500): Promise<DetectedServer[]> {
    const seen = new Set<string>();
    const candidates = LOCAL_SERVER_IDS.map((id) => LOCAL_SERVER_PRESETS[id]).filter((preset) => {
        if (!preset.detectable || seen.has(preset.defaultBaseUrl)) {
            return false;
        }
        seen.add(preset.defaultBaseUrl);
        return true;
    });
    const results = await Promise.all(candidates.map(async (preset) => {
        const result = await listLocalModels(preset.defaultBaseUrl, { fetch: fetchFn, timeoutMs, serverId: preset.id });
        return result.ok ? { serverId: preset.id, label: preset.label, baseUrl: preset.defaultBaseUrl, models: result.models } : null;
    }));
    return results.filter((server): server is DetectedServer => server !== null);
}

/** "4.7 GB" for a model size in bytes. */
export function formatModelSize(bytes: number): string {
    if (bytes >= 1e9) {
        return `${(bytes / 1e9).toFixed(1)} GB`;
    }
    return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
