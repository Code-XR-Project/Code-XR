import type { ProviderKind } from '../../../shared/agents.ts';
import { PROVIDER_CATALOG } from '../providerCatalog.ts';
import { AnthropicAdapter } from './anthropic.ts';
import { GeminiAdapter } from './gemini.ts';
import { OpenAiAdapter } from './openai.ts';
import { ProviderError, type FetchLike, type ProviderAdapter } from './types.ts';

export interface AdapterTarget {
    readonly kind: ProviderKind;
    readonly baseUrl: string;
    readonly apiKey: string | undefined;
}

/** Picks the adapter for a provider kind from the catalogue's API family. */
export function createAdapter(target: AdapterTarget, fetchImpl?: FetchLike, retryDelayMs?: number): ProviderAdapter {
    const spec = PROVIDER_CATALOG[target.kind];
    if (spec.requiresKey && !target.apiKey) {
        throw new ProviderError('auth', `${spec.label} needs an API key.`);
    }
    const options = {
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
    };
    switch (spec.family) {
        case 'anthropic':
            return new AnthropicAdapter(options);
        case 'gemini':
            return new GeminiAdapter(options);
        case 'openai':
            // OpenRouter asks apps to identify themselves; the headers carry no user data.
            return new OpenAiAdapter(options, target.kind === 'openrouter' ? { 'X-Title': 'Code-XR IDE', 'HTTP-Referer': 'https://code-xr.adrianmonteslinares.com/' } : {});
    }
}
