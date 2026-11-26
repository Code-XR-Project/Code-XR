/**
 * The IDE's security baseline, as pure functions with no Electron import so
 * that `npm test` can check every rule without starting Electron.
 *
 * Follows Electron's security checklist
 * (https://www.electronjs.org/docs/latest/tutorial/security): context
 * isolation, a sandboxed renderer without Node integration, a strict
 * Content-Security-Policy, no navigation or new windows by default, and IPC
 * answered only for allow-listed channels from trusted frames.
 */

/** The custom scheme the packaged renderer is served from: `codexr://app/`. */
export const APP_SCHEME = 'codexr';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** The web preferences every IDE window is created with. */
export interface SecureWebPreferences {
    readonly preload: string;
    readonly contextIsolation: true;
    readonly sandbox: true;
    readonly nodeIntegration: false;
    readonly nodeIntegrationInWorker: false;
    readonly nodeIntegrationInSubFrames: false;
    readonly webSecurity: true;
    readonly allowRunningInsecureContent: false;
    readonly experimentalFeatures: false;
    readonly webviewTag: false;
    readonly navigateOnDragDrop: false;
    readonly spellcheck: false;
}

export function secureWebPreferences(preloadPath: string): SecureWebPreferences {
    return {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
    };
}

/**
 * The preferences that must hold on a live window, with the value each one
 * must have. Checked against `webContents.getLastWebPreferences()` at startup,
 * so a later change that weakens one fails loudly instead of shipping.
 */
export const REQUIRED_WEB_PREFERENCES = {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
} as const;

/** Throws if any required preference is missing or has the wrong value. */
export function assertSecureWebPreferences(actual: Readonly<Record<string, unknown>> | null | undefined): void {
    if (!actual) {
        throw new Error('Security baseline: the window reported no web preferences.');
    }
    const violations: string[] = [];
    for (const [key, expected] of Object.entries(REQUIRED_WEB_PREFERENCES)) {
        if (actual[key] !== expected) {
            violations.push(`${key} must be ${String(expected)} (got ${String(actual[key])})`);
        }
    }
    if (violations.length > 0) {
        throw new Error(`Security baseline violated: ${violations.join('; ')}.`);
    }
}

export interface CspOptions {
    /** Origin of the Vite dev server, e.g. `http://localhost:5174`. Development only. */
    readonly devServerOrigin?: string;
}

/**
 * The Content-Security-Policy for the renderer.
 *
 * Production allows nothing but the app's own files, with one relaxation for
 * styles: `'unsafe-inline'` in `style-src`, because Monaco (#14) builds its
 * theme and decorations as `<style>` elements and `style` attributes at run
 * time and has no nonce hook. VS Code ships the same relaxation. It is scoped
 * to styles only: scripts stay `'self'` with no `eval`, and `connect-src`,
 * `img-src` and `font-src` stay on the app, so injected CSS cannot load or
 * send anything off it. Development additionally allows the dev server's HMR
 * websocket.
 */
export function buildContentSecurityPolicy(options: CspOptions = {}): string {
    const dev = options.devServerOrigin;
    const directives: Array<[string, string[]]> = [
        ['default-src', ["'none'"]],
        ['script-src', ["'self'"]],
        ['style-src', ["'self'", "'unsafe-inline'"]],
        ['img-src', ["'self'", 'data:']],
        ['font-src', ["'self'"]],
        ['connect-src', dev ? ["'self'", toWebSocketOrigin(dev)] : ["'self'"]],
        ['worker-src', ["'self'"]],
        ['base-uri', ["'none'"]],
        ['form-action', ["'none'"]],
        ['frame-ancestors', ["'none'"]],
        ['frame-src', ["'none'"]],
        ['object-src', ["'none'"]],
    ];
    return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

function toWebSocketOrigin(httpOrigin: string): string {
    // http://host:port -> ws://host:port, https:// -> wss://
    return new URL(httpOrigin).origin.replace(/^http/, 'ws');
}

/**
 * The origins the renderer may be loaded from and that may call IPC: the
 * custom app scheme, plus the dev server while developing.
 */
export function trustedOrigins(devServerOrigin?: string): ReadonlySet<string> {
    const origins = new Set<string>([APP_ORIGIN]);
    if (devServerOrigin) {
        origins.add(new URL(devServerOrigin).origin);
    }
    return origins;
}

/**
 * Origin of a URL, also for the custom scheme. WHATWG URL reports `null` as
 * the origin of non-special schemes, so it is rebuilt from protocol and host.
 */
export function originOf(rawUrl: string): string | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }
    if (url.protocol === `${APP_SCHEME}:`) {
        return `${APP_SCHEME}://${url.host}`;
    }
    return url.origin === 'null' ? null : url.origin;
}

/** In-window navigation is only allowed inside the app's own origin. */
export function isAllowedNavigation(targetUrl: string, origins: ReadonlySet<string>): boolean {
    const origin = originOf(targetUrl);
    return origin !== null && origins.has(origin);
}

/** IPC is answered only for allow-listed channels sent from a trusted frame. */
export function isTrustedIpcCall(
    channel: string,
    senderFrameUrl: string | undefined,
    allowedChannels: ReadonlySet<string>,
    origins: ReadonlySet<string>,
): boolean {
    if (!allowedChannels.has(channel) || !senderFrameUrl) {
        return false;
    }
    const origin = originOf(senderFrameUrl);
    return origin !== null && origins.has(origin);
}
