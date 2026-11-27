import { net, protocol } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WEBVIEW_SCHEME, webviewDocument } from '../../shared/extensionWebviewProtocol.ts';
import { WEBVIEW_CONTENT_TYPES, webviewServer } from './webviewRegistry.ts';

/** #261: answers `codexr-webview://` requests from what webviewRegistry.ts holds. */

/** Must be called before `ready`, in the same call as the app's own scheme (Electron keeps only the last list). */
export const WEBVIEW_SCHEME_PRIVILEGES = {
    scheme: WEBVIEW_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
} as const;

/** Must be called after `ready`. */
export function serveWebviews(): void {
    protocol.handle(WEBVIEW_SCHEME, async (request) => {
        const answer = request.method === 'GET' ? webviewServer.resolve(request.url) : null;
        if (!answer) {
            return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
        }
        if (answer.kind === 'page') {
            const nonce = crypto.randomBytes(16).toString('base64');
            return new Response(webviewDocument(answer.html, nonce), {
                headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
            });
        }
        const response = await net.fetch(pathToFileURL(answer.file).toString());
        const type = WEBVIEW_CONTENT_TYPES[path.extname(answer.file).toLowerCase()] ?? 'application/octet-stream';
        return new Response(response.body, {
            status: response.status,
            headers: { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' },
        });
    });
}
