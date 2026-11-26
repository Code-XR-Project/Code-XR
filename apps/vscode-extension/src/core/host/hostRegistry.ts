/**
 * Holds the one `CodeXRHost` of the running application, set once at
 * start-up (the extension: `activate()` in extension.ts).
 *
 * Mirrors `platform/extensionContext.ts`, which core modules use today and
 * which #13 retires step by step in favour of this. vscode-free.
 */
import type { CodeXRHost } from './codeXRHost';

let currentHost: CodeXRHost | null = null;

/** Stores the host. Must be called once at start-up; later calls are ignored. */
export function initializeHost(host: CodeXRHost): void {
    if (!currentHost) {
        currentHost = host;
    }
}

/** The host stored by `initializeHost`. Throws if called before it. */
export function getHost(): CodeXRHost {
    if (!currentHost) {
        throw new Error('Code-XR host not initialized. Call initializeHost(host) at start-up first.');
    }
    return currentHost;
}

/** True once a host is stored. */
export function hasHost(): boolean {
    return currentHost !== null;
}

/**
 * Forgets the stored host. For tests only: the unit runner executes every
 * suite in one process, so a suite that initializes a host must reset it.
 */
export function resetHostForTests(): void {
    currentHost = null;
}
