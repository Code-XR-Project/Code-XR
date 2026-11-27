import type { AgentView, DetectedLocalServer, LocalModelEntry, LocalModelInput } from '../../shared/agentSession.ts';
import { formatModelSize } from '@codexr/local-models/discovery.ts';
import { LOCAL_SERVER_IDS, LOCAL_SERVER_PRESETS, isLocalServerId, type LocalServerId } from '@codexr/local-models/servers.ts';

/**
 * The pure side of the add-local-model form (#313, #314): what it shows and
 * what it sends, kept apart from the DOM so the unit tests can check it.
 */

export interface LocalFormValues {
    readonly name: string;
    readonly server: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey: string;
    /** Editing a model that has a stored key: true removes it. */
    readonly forgetKey: boolean;
}

/** The servers in the form's menu, in the order people most likely run them. */
export function serverChoices(): readonly { readonly id: LocalServerId; readonly label: string; readonly baseUrl: string }[] {
    return LOCAL_SERVER_IDS.map((id) => ({ id, label: LOCAL_SERVER_PRESETS[id].label, baseUrl: LOCAL_SERVER_PRESETS[id].defaultBaseUrl }));
}

/** The address to show after the server changed: the new default, unless the person typed their own. */
export function addressAfterServerChange(currentUrl: string, previousServer: string, nextServer: string): string {
    const previousDefault = isLocalServerId(previousServer) ? LOCAL_SERVER_PRESETS[previousServer].defaultBaseUrl : '';
    const typedOwn = currentUrl.trim() !== '' && currentUrl.trim() !== previousDefault;
    if (typedOwn || !isLocalServerId(nextServer)) {
        return currentUrl;
    }
    return LOCAL_SERVER_PRESETS[nextServer].defaultBaseUrl;
}

/** "qwen2.5-coder:7b (Ollama)" as a default name. */
export function suggestName(model: string, server: string): string {
    const label = isLocalServerId(server) && server !== 'custom' ? LOCAL_SERVER_PRESETS[server].label : 'local';
    const base = model.trim() || 'Local model';
    const name = `${base} (${label})`;
    return name.length > 80 ? name.slice(0, 80) : name;
}

/** A model in a list: its id, then what the server says about its size. */
export function modelLabel(entry: LocalModelEntry): string {
    const facts = [entry.parameters, entry.size ? formatModelSize(entry.size) : undefined].filter((fact): fact is string => !!fact);
    return facts.length ? `${entry.id} (${facts.join(', ')})` : entry.id;
}

/** One line per detected server: "Ollama on 127.0.0.1:11434: 3 models". */
export function detectedSummary(server: DetectedLocalServer): string {
    let host = server.baseUrl;
    try {
        host = new URL(server.baseUrl).host;
    } catch {
        // Keep the URL.
    }
    const count = server.models.length;
    return `${server.label} on ${host}: ${count === 0 ? 'no model loaded' : count === 1 ? '1 model' : `${count} models`}`;
}

/** What "Detect" says when nothing answered. */
export const NOTHING_DETECTED = 'No local server answered on this computer. Start Ollama, LM Studio, llama.cpp, vLLM or Jan, or type the address of your server.';

/** The form's values as the save call wants them, or the first problem to show. */
export function toInput(values: LocalFormValues, editing: AgentView | null): { ok: true; input: LocalModelInput } | { ok: false; error: string } {
    const name = values.name.trim() || suggestName(values.model, values.server);
    if (!isLocalServerId(values.server)) {
        return { ok: false, error: 'Pick the server that runs the model.' };
    }
    if (!values.baseUrl.trim()) {
        return { ok: false, error: 'Enter the server address.' };
    }
    if (!values.model.trim()) {
        return { ok: false, error: 'Pick a model (List models asks the server), or type its name.' };
    }
    const key = values.apiKey.trim();
    const apiKey = key || (editing?.local?.hasKey && values.forgetKey ? '' : undefined);
    return { ok: true, input: { name, server: values.server, baseUrl: values.baseUrl.trim(), model: values.model.trim(), ...(apiKey !== undefined ? { apiKey } : {}) } };
}

/** The form's starting values: a local model being edited, or the most common setup. */
export function initialValues(editing: AgentView | null): LocalFormValues {
    if (editing?.local) {
        return { name: editing.name, server: editing.local.server, baseUrl: editing.local.baseUrl, model: editing.local.model, apiKey: '', forgetKey: false };
    }
    return { name: '', server: 'ollama', baseUrl: LOCAL_SERVER_PRESETS.ollama.defaultBaseUrl, model: '', apiKey: '', forgetKey: false };
}

/** The local model's id behind an `acp:local-...` ref, or null for any other agent. */
export function localIdOf(agent: AgentView): string | null {
    return agent.local && agent.ref.startsWith('acp:local-') ? agent.ref.slice(4) : null;
}
