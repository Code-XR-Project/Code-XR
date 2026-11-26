import type { CodeXRApi } from '../shared/api.ts';

declare global {
    interface Window {
        /** Exposed by the preload script; the renderer's only way out of its sandbox. */
        readonly codexr: CodeXRApi;
    }
}

export {};
