import { PROVIDER_DESCRIPTORS, type ProviderApiFamily, type ProviderDescriptor, type ProviderKind } from '../../shared/agents.ts';

/**
 * What the main process knows about each provider kind: the shared
 * descriptor (label, endpoint, key rules) plus the wire protocol it speaks.
 * Pure data, no Electron.
 */
export interface ProviderSpec extends ProviderDescriptor {
    readonly kind: ProviderKind;
    readonly family: ProviderApiFamily;
}

const FAMILY: Readonly<Record<ProviderKind, ProviderApiFamily>> = {
    anthropic: 'anthropic',
    openai: 'openai',
    gemini: 'gemini',
    openrouter: 'openai',
    nous: 'openai',
    'openai-compatible': 'openai',
};

export const PROVIDER_CATALOG = Object.fromEntries(
    (Object.keys(FAMILY) as ProviderKind[]).map((kind) => [kind, { ...PROVIDER_DESCRIPTORS[kind], kind, family: FAMILY[kind] }]),
) as Readonly<Record<ProviderKind, ProviderSpec>>;

/**
 * Checks a user-entered endpoint: http(s) only, no credentials in the URL, and
 * plain http only towards this machine, so a key is never sent in clear over
 * the network. Returns the URL without a trailing slash.
 */
export function normalizeBaseUrl(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new Error('The endpoint is not a valid URL.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('The endpoint must use https (or http on this machine).');
    }
    if (url.username || url.password) {
        throw new Error('Put the API key in its own field, not in the URL.');
    }
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
        throw new Error('Plain http is only allowed for a server on this machine; use https.');
    }
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
}

function isLoopbackHost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}
