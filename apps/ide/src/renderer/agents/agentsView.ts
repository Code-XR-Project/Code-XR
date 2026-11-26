import { PROVIDER_DESCRIPTORS, PROVIDER_KINDS, type AgentsApi, type KeyStorage, type ProviderKind, type ProviderView, type SecretStoreStatus } from '../../shared/agents.ts';
import { el } from '../dom.ts';

/**
 * The Agents view of the side bar (AI agent hub, story A1): the providers the
 * person connected with their own API keys. A key typed here goes straight to
 * the main process, which encrypts it with the OS secret store; this view
 * never gets it back, only whether one is set and its last four characters.
 * Chats and agent profiles join this view in later stories.
 */

const STORAGE_LABEL: Record<KeyStorage, string> = {
    'os-encrypted': 'Key in the system keychain',
    'session-only': 'Key kept until the IDE closes',
    none: 'No key',
};

export interface AgentsView {
    refresh(): Promise<void>;
    /** Opens the add-provider form (the "Agents: Add AI Provider" command). */
    addProvider(): void;
}

export function createAgentsView(container: HTMLElement, api: AgentsApi, callbacks: { onStatus(message: string): void }): AgentsView {
    const storeNote = el('p', { className: 'agents-store-note muted small', attrs: { hidden: '', 'data-testid': 'agents-store-note' } });
    const list = el('ul', { className: 'agents-provider-list', attrs: { 'data-testid': 'agents-providers' } });
    const empty = el('p', { className: 'muted side-note', text: 'No provider yet. Add one with your own API key: calls go straight from this computer to the provider.' });
    const addButton = el('button', { className: 'primary-button', text: 'Add provider', attrs: { type: 'button', 'data-action': 'add-provider' } });
    const formSlot = el('div');

    container.replaceChildren(
        el('h2', { className: 'side-bar-title', text: 'Agents' }),
        el('section', { className: 'agents-section', attrs: { 'aria-labelledby': 'agents-providers-heading' } }, [
            el('h3', { className: 'side-bar-subtitle', text: 'AI providers', attrs: { id: 'agents-providers-heading' } }),
            storeNote,
            list,
            empty,
            formSlot,
            addButton,
        ]),
    );

    let store: SecretStoreStatus | null = null;
    addButton.addEventListener('click', () => openForm(null));

    async function refresh(): Promise<void> {
        const [status, providers] = await Promise.all([api.secretStore(), api.listProviders()]);
        store = status;
        storeNote.hidden = status.available;
        storeNote.textContent = `No system keychain is available (${status.backend}). Keys you enter are kept in memory until the IDE closes and are never written to disk. Install and unlock a keyring (GNOME Keyring or KWallet) to keep them.`;
        list.replaceChildren(...providers.map(renderProvider));
        empty.hidden = providers.length > 0;
    }

    function renderProvider(provider: ProviderView): HTMLElement {
        const descriptor = PROVIDER_DESCRIPTORS[provider.kind];
        const result = el('p', { className: 'agents-test-result small', attrs: { hidden: '', role: 'status' } });
        const keyText = provider.hasKey
            ? `${STORAGE_LABEL[provider.keyStorage]}${provider.keyHint ? ` (…${provider.keyHint})` : ''}`
            : descriptor.requiresKey ? 'No key: add one to use it' : 'No key needed';
        const action = (label: string, onClick: () => void): HTMLButtonElement => {
            const button = el('button', { className: 'secondary-button', text: label, attrs: { type: 'button', 'data-action': label.toLowerCase() } });
            button.addEventListener('click', onClick);
            return button;
        };
        const test = action('Test', () => {
            test.disabled = true;
            result.hidden = false;
            result.dataset['state'] = 'pending';
            result.textContent = 'Connecting…';
            api.testProvider(provider.id).then((outcome) => {
                result.dataset['state'] = outcome.ok ? 'ok' : 'error';
                result.textContent = outcome.ok
                    ? `Connected: ${outcome.models.length} model${outcome.models.length === 1 ? '' : 's'} available.`
                    : outcome.error;
            }, (error: unknown) => {
                result.dataset['state'] = 'error';
                result.textContent = String(error);
            }).finally(() => { test.disabled = false; });
        });
        const item = el('li', { className: 'agents-provider', attrs: { 'data-kind': provider.kind, 'data-provider-id': provider.id } }, [
            el('div', { className: 'agents-provider-head' }, [
                el('span', { className: 'agents-provider-name', text: provider.label }),
                el('span', { className: 'env-badge', text: descriptor.label }),
            ]),
            el('p', { className: 'agents-provider-key muted small', text: keyText }),
            ...(descriptor.editableBaseUrl ? [el('p', { className: 'agents-provider-url muted small', text: provider.baseUrl })] : []),
            el('div', { className: 'env-actions' }, [
                test,
                action('Edit', () => openForm(provider)),
                action('Remove', () => {
                    if (!window.confirm(`Remove ${provider.label} and delete its API key from this computer?`)) {
                        return;
                    }
                    api.removeProvider(provider.id).then(() => {
                        callbacks.onStatus(`Removed ${provider.label}.`);
                        return refresh();
                    }, (error: unknown) => callbacks.onStatus(String(error)));
                }),
            ]),
            result,
        ]);
        return item;
    }

    /** The add/edit form, shown in place above the Add button. */
    function openForm(existing: ProviderView | null): void {
        addButton.hidden = true;
        const kindSelect = el('select', { className: 'agents-input', attrs: { id: 'agents-kind', 'data-testid': 'agents-kind' } },
            PROVIDER_KINDS.map((kind) => el('option', { text: PROVIDER_DESCRIPTORS[kind].label, attrs: { value: kind } })));
        kindSelect.value = existing?.kind ?? 'anthropic';
        kindSelect.disabled = existing !== null;
        const label = el('input', { className: 'agents-input', attrs: { id: 'agents-label', type: 'text', maxlength: '60', autocomplete: 'off', spellcheck: 'false' } });
        label.value = existing?.label ?? '';
        const baseUrl = el('input', { className: 'agents-input', attrs: { id: 'agents-url', type: 'url', autocomplete: 'off', spellcheck: 'false' } });
        const key = el('input', { className: 'agents-input', attrs: { id: 'agents-key', type: 'password', autocomplete: 'off', spellcheck: 'false', 'data-testid': 'agents-key' } });
        const keyHelp = el('p', { className: 'muted small agents-help' });
        const urlRow = el('div', { className: 'agents-field' }, [el('label', { text: 'Endpoint', attrs: { for: 'agents-url' } }), baseUrl]);
        const error = el('p', { className: 'error small', attrs: { hidden: '', role: 'alert' } });
        const save = el('button', { className: 'primary-button', text: existing ? 'Save' : 'Add', attrs: { type: 'submit' } });
        const cancel = el('button', { className: 'secondary-button', text: 'Cancel', attrs: { type: 'button' } });

        const sync = (): void => {
            const descriptor = PROVIDER_DESCRIPTORS[kindSelect.value as ProviderKind];
            label.placeholder = descriptor.label;
            urlRow.hidden = !descriptor.editableBaseUrl;
            baseUrl.placeholder = descriptor.defaultBaseUrl;
            if (!baseUrl.value || !existing) {
                baseUrl.value = existing?.baseUrl ?? descriptor.defaultBaseUrl;
            }
            key.placeholder = existing?.hasKey ? 'Leave empty to keep the current key' : descriptor.requiresKey ? 'Paste your API key' : 'Optional';
            keyHelp.textContent = descriptor.keyHelp + (store && !store.available ? '. Kept in memory only: no keychain available.' : '. Encrypted with the system keychain.');
        };
        kindSelect.addEventListener('change', sync);
        sync();

        const form = el('form', { className: 'agents-form', attrs: { 'aria-label': existing ? `Edit ${existing.label}` : 'Add a provider' } }, [
            el('div', { className: 'agents-field' }, [el('label', { text: 'Provider', attrs: { for: 'agents-kind' } }), kindSelect]),
            el('div', { className: 'agents-field' }, [el('label', { text: 'Name', attrs: { for: 'agents-label' } }), label]),
            urlRow,
            el('div', { className: 'agents-field' }, [el('label', { text: 'API key', attrs: { for: 'agents-key' } }), key, keyHelp]),
            error,
            el('div', { className: 'env-actions' }, [save, cancel]),
        ]);
        const close = (): void => {
            key.value = '';
            formSlot.replaceChildren();
            addButton.hidden = false;
        };
        cancel.addEventListener('click', close);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const kind = kindSelect.value as ProviderKind;
            const descriptor = PROVIDER_DESCRIPTORS[kind];
            const typedKey = key.value.trim();
            if (descriptor.requiresKey && !typedKey && !existing?.hasKey) {
                error.hidden = false;
                error.textContent = `${descriptor.label} needs an API key.`;
                key.focus();
                return;
            }
            save.disabled = true;
            api.saveProvider({
                kind,
                label: label.value,
                ...(descriptor.editableBaseUrl ? { baseUrl: baseUrl.value } : {}),
                ...(typedKey || !existing ? { apiKey: typedKey } : {}),
            }, existing?.id).then((saved) => {
                close();
                callbacks.onStatus(`Saved ${saved.label}.`);
                return refresh();
            }, (failure: unknown) => {
                error.hidden = false;
                error.textContent = failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(failure);
            }).finally(() => { save.disabled = false; });
        });
        formSlot.replaceChildren(form);
        (existing ? key : kindSelect).focus();
    }

    return { refresh, addProvider: () => openForm(null) };
}
