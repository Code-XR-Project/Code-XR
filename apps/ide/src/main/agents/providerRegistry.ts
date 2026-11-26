import { randomUUID } from 'node:crypto';
import { PROVIDER_KINDS, type ConnectionTestResult, type ProviderInput, type ProviderKind, type ProviderView, type SecretStoreStatus } from '../../shared/agents.ts';
import type { JsonKeyValueStore } from '../core/jsonStore.ts';
import type { KeyVault } from './keyVault.ts';
import { normalizeBaseUrl, PROVIDER_CATALOG } from './providerCatalog.ts';
import { createAdapter } from './providers/createAdapter.ts';
import { ProviderError, type FetchLike, type ProviderAdapter } from './providers/types.ts';

const STORE_KEY = 'agents.providers';

/** What is persisted per provider: no secret, the key lives in the vault. */
interface StoredProvider {
    readonly id: string;
    readonly kind: ProviderKind;
    readonly label: string;
    readonly baseUrl: string;
}

/**
 * The user's configured providers (#A1). Configuration goes to the IDE's
 * JSON store, keys to the KeyVault; `list()` is the only view the renderer gets.
 */
export class ProviderRegistry {
    private readonly store: JsonKeyValueStore;
    private readonly vault: KeyVault;
    private readonly fetchImpl: FetchLike | undefined;

    constructor(store: JsonKeyValueStore, vault: KeyVault, fetchImpl?: FetchLike) {
        this.store = store;
        this.vault = vault;
        this.fetchImpl = fetchImpl;
    }

    secretStore(): SecretStoreStatus {
        return this.vault.status();
    }

    list(): readonly ProviderView[] {
        return this.stored().map((provider) => ({
            ...provider,
            hasKey: this.vault.storageOf(provider.id) !== 'none',
            keyHint: this.vault.hint(provider.id),
            keyStorage: this.vault.storageOf(provider.id),
        }));
    }

    /** Adds a provider (no `id`) or edits one. Returns the saved view. */
    async save(input: unknown, id?: unknown): Promise<ProviderView> {
        const parsed = parseInput(input);
        const spec = PROVIDER_CATALOG[parsed.kind];
        const providers = [...this.stored()];
        const existingIndex = typeof id === 'string' ? providers.findIndex((provider) => provider.id === id) : -1;
        if (typeof id === 'string' && existingIndex < 0) {
            throw new Error('That provider no longer exists.');
        }
        const existing = existingIndex >= 0 ? providers[existingIndex] : undefined;
        if (existing && existing.kind !== parsed.kind) {
            throw new Error('A provider cannot change kind; add a new one instead.');
        }
        const provider: StoredProvider = {
            id: existing?.id ?? randomUUID(),
            kind: parsed.kind,
            label: parsed.label?.trim().slice(0, 60) || existing?.label || spec.label,
            baseUrl: spec.editableBaseUrl && parsed.baseUrl ? normalizeBaseUrl(parsed.baseUrl) : existing?.baseUrl ?? spec.defaultBaseUrl,
        };
        if (parsed.apiKey !== undefined) {
            await this.vault.set(provider.id, parsed.apiKey);
        }
        if (existingIndex >= 0) {
            providers[existingIndex] = provider;
        } else {
            providers.push(provider);
        }
        await this.store.update(STORE_KEY, providers);
        const view = this.list().find((candidate) => candidate.id === provider.id);
        if (!view) {
            throw new Error('The provider could not be saved.');
        }
        return view;
    }

    async remove(id: unknown): Promise<void> {
        if (typeof id !== 'string') {
            throw new Error('Unknown provider.');
        }
        await this.vault.delete(id);
        await this.store.update(STORE_KEY, this.stored().filter((provider) => provider.id !== id));
    }

    /** Builds the adapter for a provider, with its key; main process only. */
    adapterFor(id: string): ProviderAdapter {
        const provider = this.stored().find((candidate) => candidate.id === id);
        if (!provider) {
            throw new Error('Unknown provider.');
        }
        return createAdapter({ kind: provider.kind, baseUrl: provider.baseUrl, apiKey: this.vault.get(provider.id) }, this.fetchImpl);
    }

    /** "Test connection": lists the provider's models, or says why it cannot. */
    async test(id: unknown): Promise<ConnectionTestResult> {
        if (typeof id !== 'string') {
            return { ok: false, error: 'Unknown provider.' };
        }
        const timeout = AbortSignal.timeout(20_000);
        try {
            const models = await this.adapterFor(id).listModels(timeout);
            return { ok: true, models };
        } catch (error) {
            if (timeout.aborted) {
                return { ok: false, error: 'The provider did not answer within 20 seconds.' };
            }
            return { ok: false, error: error instanceof ProviderError || error instanceof Error ? error.message : String(error) };
        }
    }

    private stored(): readonly StoredProvider[] {
        const raw = this.store.get<unknown>(STORE_KEY, []);
        return Array.isArray(raw) ? raw.filter(isStoredProvider) : [];
    }
}

function isStoredProvider(value: unknown): value is StoredProvider {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record['id'] === 'string' && typeof record['label'] === 'string' && typeof record['baseUrl'] === 'string'
        && (PROVIDER_KINDS as readonly unknown[]).includes(record['kind']);
}

/** Validates what came over IPC: the renderer is not trusted to send a well-formed object. */
function parseInput(input: unknown): ProviderInput {
    if (!input || typeof input !== 'object') {
        throw new Error('Invalid provider.');
    }
    const record = input as Record<string, unknown>;
    const kind = record['kind'];
    if (!(PROVIDER_KINDS as readonly unknown[]).includes(kind)) {
        throw new Error(`Unknown provider kind: ${String(kind)}`);
    }
    const optional = (key: string, max: number): string | undefined => {
        const value = record[key];
        if (value === undefined || value === null) {
            return undefined;
        }
        if (typeof value !== 'string' || value.length > max) {
            throw new Error(`Invalid ${key}.`);
        }
        return value;
    };
    const label = optional('label', 200);
    const baseUrl = optional('baseUrl', 2048);
    const apiKey = optional('apiKey', 4096);
    return {
        kind: kind as ProviderKind,
        ...(label !== undefined ? { label } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(apiKey !== undefined ? { apiKey } : {}),
    };
}
