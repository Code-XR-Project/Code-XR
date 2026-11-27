import { app, session, type WebContents, type WebFrameMain } from 'electron';
import { buildContentSecurityPolicy, isAllowedNavigation } from './security.ts';
import { log } from './log.ts';

/**
 * Process-wide defaults, applied before any window exists. Each one closes a
 * door that a later feature has to open on purpose, with a reason.
 */
export function applyProcessHardening(origins: ReadonlySet<string>, devServerOrigin: string | undefined): void {
    // Sandbox every renderer, including any created by a future feature that
    // forgets to ask for it. Skipped only when Chromium's OS sandbox was
    // switched off explicitly with --no-sandbox (required to run as root, e.g.
    // in containers): forcing it then makes every child process abort. The
    // per-window `sandbox: true` preference and its startup assertion stay.
    if (!app.commandLine.hasSwitch('no-sandbox')) {
        app.enableSandbox();
    }

    app.on('web-contents-created', (_event, contents) => guardWebContents(contents, origins));

    void app.whenReady().then(() => {
        const ses = session.defaultSession;

        // No permission (camera, microphone, notifications, geolocation, XR...)
        // is granted until a story needs it and allow-lists it here.
        ses.setPermissionRequestHandler((_wc, permission, callback) => {
            log.warn(`Denied permission request: ${permission}`);
            callback(false);
        });
        ses.setPermissionCheckHandler(() => false);

        // The packaged renderer gets its CSP from the app protocol handler. The
        // dev server's responses get it here, so development runs under the
        // same policy (plus what HMR needs).
        if (devServerOrigin) {
            const csp = buildContentSecurityPolicy({ devServerOrigin });
            ses.webRequest.onHeadersReceived({ urls: [`${devServerOrigin}/*`] }, (details, callback) => {
                callback({
                    responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
                });
            });
        }
    });
}

/**
 * The one extra origin a scene view may navigate within (#16): the local
 * server it was opened on. Set by the scene view, keyed by its web contents,
 * so the app window itself never gains it.
 */
const sceneOrigins = new WeakMap<WebContents, string>();

export function allowSceneOrigin(contents: WebContents, origin: string): void {
    sceneOrigins.set(contents, origin);
}

function sameOrigin(url: string, origin: string | undefined): boolean {
    if (!origin) {
        return false;
    }
    try {
        return new URL(url).origin === origin;
    } catch {
        return false;
    }
}

function guardWebContents(contents: WebContents, origins: ReadonlySet<string>): void {
    // No in-window navigation away from the app (a dropped file, a link, a
    // redirect). Links to the web are not opened either: the project rule is
    // no network access without explicit user consent, and the consent UI
    // does not exist yet.
    const blockNavigation = (event: { preventDefault(): void }, url: string): void => {
        if (!isAllowedNavigation(url, origins) && !sameOrigin(url, sceneOrigins.get(contents))) {
            event.preventDefault();
            log.warn(`Blocked navigation to ${url}`);
        }
    };
    contents.on('will-navigate', blockNavigation);
    // #261: a frame of the workbench (an extension's webview) stays on webview pages; its links go
    // through the workbench. Frames inside a webview (a page it embeds itself, such as a local
    // server's) are the webview's business, as in VS Code.
    const frameAllowed = (frame: WebFrameMain | null | undefined, url: string): boolean => {
        const workbenchChild = frame?.parent?.parent === null && isAllowedNavigation(contents.getURL(), origins);
        return !workbenchChild || url.startsWith('codexr-webview://') || url === 'about:blank' || url === 'about:srcdoc';
    };
    const blockFrame = (event: { preventDefault(): void }, frame: WebFrameMain | null | undefined, url: string): void => {
        if (!frameAllowed(frame, url)) {
            event.preventDefault();
            log.warn(`Blocked a frame navigation to ${url}`);
        }
    };
    contents.on('will-redirect', (event) => {
        if (event.isMainFrame) {
            blockNavigation(event, event.url);
        } else {
            blockFrame(event, event.frame, event.url);
        }
    });
    contents.on('will-frame-navigate', (event) => {
        if (!event.isMainFrame) {
            blockFrame(event, event.frame, event.url);
        }
    });

    contents.setWindowOpenHandler(({ url }) => {
        log.warn(`Blocked window.open(${url})`);
        return { action: 'deny' };
    });

    contents.on('will-attach-webview', (event) => {
        event.preventDefault();
        log.warn('Blocked a <webview>');
    });
}
