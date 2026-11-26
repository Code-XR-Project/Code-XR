/**
 * The contract between the renderer and the rest of the IDE.
 *
 * The renderer never touches Node or Electron directly: everything it can do
 * is listed here, exposed by the preload script as `window.codexr`, and served
 * by an allow-listed IPC handler in the main process. Adding a capability means
 * adding it to all three places (this file, `IPC_CHANNELS`, the handler).
 *
 * This module is shared by main, preload and renderer, so it must stay free of
 * any Node, Electron or DOM import.
 */

/** Facts about the running IDE, shown on the welcome screen and in About. */
export interface AppInfo {
    readonly name: string;
    readonly version: string;
    readonly platform: string;
    readonly arch: string;
    readonly versions: {
        readonly electron: string;
        readonly chrome: string;
        readonly node: string;
    };
    /** True when the renderer is served by the Vite dev server. */
    readonly isDevelopment: boolean;
}

/** What `window.codexr` offers the renderer. Every member returns a promise. */
export interface CodeXRApi {
    readonly app: {
        getInfo(): Promise<AppInfo>;
    };
}

/**
 * Every IPC channel the main process answers. The preload may only invoke
 * these, and the main process registers a handler for exactly these.
 */
export const IPC_CHANNELS = {
    appGetInfo: 'codexr:app:get-info',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const ALLOWED_IPC_CHANNELS: ReadonlySet<string> = new Set(Object.values(IPC_CHANNELS));
