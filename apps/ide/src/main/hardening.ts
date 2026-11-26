import { app, session, type WebContents } from 'electron';
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

function guardWebContents(contents: WebContents, origins: ReadonlySet<string>): void {
    // No in-window navigation away from the app (a dropped file, a link, a
    // redirect). Links to the web are not opened either: the project rule is
    // no network access without explicit user consent, and the consent UI
    // does not exist yet.
    const blockNavigation = (event: { preventDefault(): void }, url: string): void => {
        if (!isAllowedNavigation(url, origins)) {
            event.preventDefault();
            log.warn(`Blocked navigation to ${url}`);
        }
    };
    contents.on('will-navigate', blockNavigation);
    contents.on('will-redirect', blockNavigation);

    contents.setWindowOpenHandler(({ url }) => {
        log.warn(`Blocked window.open(${url})`);
        return { action: 'deny' };
    });

    contents.on('will-attach-webview', (event) => {
        event.preventDefault();
        log.warn('Blocked a <webview>');
    });
}
