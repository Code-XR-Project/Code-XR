import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { APP_HOST, APP_SCHEME, buildContentSecurityPolicy } from './security.ts';
import { resolveRendererAsset } from './assetPath.ts';
import { WEBVIEW_SCHEME_PRIVILEGES } from './extensions/webviewServer.ts';

/**
 * The packaged renderer is served from `codexr://app/` instead of `file://`.
 * A file URL would give the page the whole disk as its origin; this scheme
 * serves only the built renderer folder and stamps the CSP header on every
 * response.
 *
 * Must be called before the `ready` event.
 */
export function registerAppSchemeAsPrivileged(): void {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: APP_SCHEME,
            privileges: { standard: true, secure: true, supportFetchAPI: true },
        },
        // #261: extensions' webviews, each on an origin of its own (Electron keeps only one list, so both go here).
        WEBVIEW_SCHEME_PRIVILEGES,
    ]);
}

/** Must be called after the `ready` event. */
export function serveRenderer(rendererRoot: string): void {
    const csp = buildContentSecurityPolicy();
    protocol.handle(APP_SCHEME, async (request) => {
        const url = new URL(request.url);
        const file = url.host === APP_HOST ? resolveRendererAsset(rendererRoot, url.pathname) : null;
        if (!file) {
            return new Response('Not found', { status: 404 });
        }
        const response = await net.fetch(pathToFileURL(file).toString());
        const headers = new Headers(response.headers);
        headers.set('Content-Security-Policy', csp);
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(response.body, { status: response.status, headers });
    });
}
