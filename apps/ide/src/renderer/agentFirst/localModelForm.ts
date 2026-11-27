import type { AgentSessionsApi, AgentView, DetectedLocalServer, LocalModelEntry } from '../../shared/agentSession.ts';
import { el } from '../dom.ts';
import { errorText } from './agentSetup.ts';
import { addressAfterServerChange, detectedSummary, initialValues, localIdOf, modelLabel, NOTHING_DETECTED, serverChoices, suggestName, toInput } from './localModelModel.ts';

/**
 * #313/#314: the form that adds or edits a local model (Ollama, LM Studio,
 * llama.cpp, vLLM, Jan, LocalAI or any OpenAI-compatible server) in the
 * Agents section of the Chats view. "Detect" probes the known ports of this
 * computer once, and "List models" asks the chosen server; nothing is probed
 * before the person presses one of them. A typed key goes to main, which
 * keeps it in the OS secret store; the page never gets it back.
 */

export interface LocalModelFormDeps {
    readonly api: AgentSessionsApi;
    onStatus(message: string): void;
    /** Called after a save or a removal, to reload the agent list. */
    onSaved(view: AgentView | null): void;
    onClose(): void;
}

let formCounter = 0;

export function localModelForm(editing: AgentView | null, deps: LocalModelFormDeps): HTMLFormElement {
    const prefix = `af-local-${++formCounter}`;
    const values = initialValues(editing);
    const id = editing ? localIdOf(editing) : null;

    const input = (suffix: string, attrs: Record<string, string>): HTMLInputElement => el('input', { className: 'agents-input', attrs: { id: `${prefix}-${suffix}`, autocomplete: 'off', spellcheck: 'false', ...attrs } });
    const field = (label: string, suffix: string, control: HTMLElement, help?: HTMLElement): HTMLElement => el('div', { className: 'agents-field' }, [el('label', { text: label, attrs: { for: `${prefix}-${suffix}` } }), control, ...(help ? [help] : [])]);

    const server = el('select', { className: 'agents-input', attrs: { id: `${prefix}-server`, 'data-testid': 'af-local-server' } },
        serverChoices().map((choice) => el('option', { text: choice.label, attrs: { value: choice.id } })));
    server.value = values.server;
    let previousServer = server.value;
    const baseUrl = input('url', { type: 'text', 'data-testid': 'af-local-url', placeholder: 'http://127.0.0.1:11434/v1' });
    baseUrl.value = values.baseUrl;
    const modelList = el('datalist', { attrs: { id: `${prefix}-models` } });
    const model = input('model', { type: 'text', list: `${prefix}-models`, maxlength: '300', 'data-testid': 'af-local-model', placeholder: 'e.g. qwen2.5-coder:7b' });
    model.value = values.model;
    const name = input('name', { type: 'text', maxlength: '80', 'data-testid': 'af-local-name' });
    name.value = values.name;
    const key = input('key', { type: 'password', 'data-testid': 'af-local-key', placeholder: editing?.local?.hasKey ? 'Leave empty to keep the stored key' : 'Optional: most local servers need none' });
    const forget = el('input', { attrs: { type: 'checkbox', id: `${prefix}-forget` } });
    const forgetRow = el('label', { className: 'af-local-check', attrs: { for: `${prefix}-forget` } }, [forget, el('span', { text: 'Forget the stored key' })]);
    forgetRow.hidden = !editing?.local?.hasKey;

    const found = el('div', { className: 'af-local-found', attrs: { hidden: '', 'data-testid': 'af-local-found' } });
    const status = el('p', { className: 'muted small af-local-status', attrs: { role: 'status' } });
    const error = el('p', { className: 'error small', attrs: { hidden: '', role: 'alert' } });

    const syncName = (): void => {
        name.placeholder = suggestName(model.value, server.value);
    };
    syncName();

    const fillModels = (models: readonly LocalModelEntry[]): void => {
        modelList.replaceChildren(...models.map((entry) => el('option', { text: modelLabel(entry), attrs: { value: entry.id } })));
        if (!model.value && models[0]) {
            model.value = models[0].id;
            syncName();
        }
    };

    server.addEventListener('change', () => {
        baseUrl.value = addressAfterServerChange(baseUrl.value, previousServer, server.value);
        previousServer = server.value;
        modelList.replaceChildren();
        syncName();
    });
    model.addEventListener('input', syncName);

    const detect = el('button', { className: 'secondary-button af-small-button', text: 'Detect', attrs: { type: 'button', 'data-testid': 'af-local-detect', title: 'Look for Ollama, LM Studio, llama.cpp, vLLM and Jan on this computer (their default ports only)' } });
    const list = el('button', { className: 'secondary-button af-small-button', text: 'List models', attrs: { type: 'button', 'data-testid': 'af-local-list', title: 'Ask this server which models it has' } });

    const pick = (detected: DetectedLocalServer, entry: LocalModelEntry | null): void => {
        server.value = detected.server;
        previousServer = detected.server;
        baseUrl.value = detected.baseUrl;
        fillModels(detected.models);
        if (entry) {
            model.value = entry.id;
        }
        syncName();
        found.hidden = true;
        status.textContent = entry ? `${entry.id} on ${detected.label} selected.` : `${detected.label} selected.`;
    };

    detect.addEventListener('click', () => {
        detect.disabled = true;
        status.textContent = 'Looking for local servers...';
        error.hidden = true;
        deps.api.detectLocalServers()
            .then((servers) => {
                status.textContent = '';
                if (servers.length === 0) {
                    found.hidden = true;
                    status.textContent = NOTHING_DETECTED;
                    return;
                }
                found.hidden = false;
                found.replaceChildren(...servers.map((detected) => {
                    const head = el('button', { className: 'af-local-server', text: detectedSummary(detected), attrs: { type: 'button' } });
                    head.addEventListener('click', () => pick(detected, null));
                    const models = detected.models.slice(0, 20).map((entry) => {
                        const choice = el('button', { className: 'secondary-button af-small-button af-local-model-choice', text: modelLabel(entry), attrs: { type: 'button', 'data-model': entry.id } });
                        choice.addEventListener('click', () => pick(detected, entry));
                        return choice;
                    });
                    return el('div', { className: 'af-local-found-server' }, [head, ...(models.length ? [el('div', { className: 'af-local-models' }, models)] : [])]);
                }));
            })
            .catch((failure: unknown) => {
                status.textContent = '';
                showError(errorText(failure));
            })
            .finally(() => {
                detect.disabled = false;
            });
    });

    list.addEventListener('click', () => {
        list.disabled = true;
        status.textContent = 'Asking the server...';
        error.hidden = true;
        deps.api.listLocalModels(server.value, baseUrl.value, key.value || undefined, id ?? undefined)
            .then((result) => {
                if (!result.ok) {
                    status.textContent = '';
                    showError(result.error);
                    return;
                }
                fillModels(result.models);
                status.textContent = result.models.length === 0 ? 'The server answered but has no model loaded yet.' : result.models.length === 1 ? 'The server has 1 model.' : `The server has ${result.models.length} models: pick one in the Model field.`;
            })
            .catch((failure: unknown) => {
                status.textContent = '';
                showError(errorText(failure));
            })
            .finally(() => {
                list.disabled = false;
            });
    });

    function showError(message: string): void {
        error.textContent = message;
        error.hidden = false;
    }

    const save = el('button', { className: 'primary-button', text: editing ? 'Save' : 'Add', attrs: { type: 'submit', 'data-testid': 'af-local-save' } });
    const cancel = el('button', { className: 'secondary-button', text: 'Cancel', attrs: { type: 'button' } });
    cancel.addEventListener('click', () => deps.onClose());

    const form = el('form', { className: 'agents-form af-local-form', attrs: { 'aria-label': editing ? `Edit ${editing.name}` : 'Add a local model', 'data-testid': 'af-local-form' } }, [
        el('p', { className: 'af-install-title', text: editing ? `Edit ${editing.name}` : 'Add a local model' }),
        el('p', { className: 'muted small af-install-note', text: 'Use a model served on your own machine or network. Nothing leaves it, and no account is needed. Models with tool support (for example qwen2.5-coder, llama3.1, mistral-nemo) can read and change files.' }),
        el('div', { className: 'af-install-actions' }, [detect]),
        found,
        field('Server', 'server', server),
        field('Address', 'url', baseUrl),
        el('div', { className: 'agents-field' }, [el('label', { text: 'Model', attrs: { for: `${prefix}-model` } }), el('div', { className: 'af-local-model-row' }, [model, list]), modelList]),
        field('Name', 'name', name),
        field('API key', 'key', key, forgetRow),
        status,
        error,
        el('div', { className: 'env-actions' }, [save, cancel]),
    ]);

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        error.hidden = true;
        const checked = toInput({ name: name.value, server: server.value, baseUrl: baseUrl.value, model: model.value, apiKey: key.value, forgetKey: forget.checked }, editing);
        if (!checked.ok) {
            showError(checked.error);
            return;
        }
        save.disabled = true;
        deps.api.saveLocalModel(checked.input, id ?? undefined)
            .then((view) => {
                deps.onStatus(editing ? `${view.name} was saved.` : `${view.name} was added. Pick it next to New chat.`);
                deps.onSaved(view);
            })
            .catch((failure: unknown) => showError(errorText(failure)))
            .finally(() => {
                save.disabled = false;
            });
    });
    return form;
}
