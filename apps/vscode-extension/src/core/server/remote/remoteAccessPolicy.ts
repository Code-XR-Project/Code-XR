import * as http from 'http';
import { RemoteSessionAuthority } from '../../remote-access/remoteSessionAuthority';

/**
 * The only paths a remote guest may reach without a session cookie: the
 * pairing flow itself. Everything else requires a cookie minted by pairing.
 */
const COOKIE_FREE_REMOTE_PATHS = new Set([
    '/join',
    '/api/remote/identity',
    '/api/remote/pair/request',
    '/api/remote/pair/confirm',
    '/api/remote/browser',
    '/api/remote/profile',
]);

const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip'];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostKey(host: string): string {
    const lower = host.toLowerCase();
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(lower);
    if (!match) {
        return lower;
    }
    const name = LOOPBACK_HOSTS.has(match[1]) ? 'loopback' : match[1];
    return `${name}:${match[2] ?? ''}`;
}

/**
 * Browsers send `Origin` on every WebSocket upgrade, and nothing else stops a
 * page on another site, open in the host's browser, from connecting to
 * localhost and joining the room as the host (COLLAB-ROOM-6). Allowed: no
 * Origin (not a browser), the page's own origin (localhost and 127.0.0.1
 * count as one), and the VS Code webview schemes a web page cannot claim.
 */
export function isWebSocketOriginAllowed(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) {
        return true;
    }
    let parsed: URL;
    try {
        parsed = new URL(String(origin));
    } catch {
        return false;
    }
    if (parsed.protocol === 'vscode-webview:' || parsed.protocol === 'vscode-file:') {
        return true;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
    }
    const host = String(req.headers.host || '');
    return !!host && hostKey(parsed.host) === hostKey(host);
}

/**
 * Authorization policy for requests arriving through the public tunnel.
 * Local requests are always allowed; remote ones need a server-issued session.
 */
export class RemoteAccessPolicy {
    constructor(private readonly authority: RemoteSessionAuthority) {}

    public isRequestAuthorized(req: http.IncomingMessage, requestUrl: string): boolean {
        if (!this.isRemoteRequest(req)) {
            return true;
        }
        const pathname = new URL(requestUrl, 'https://codexr.local').pathname;
        if (COOKIE_FREE_REMOTE_PATHS.has(pathname)) {
            return true;
        }
        return !!this.authority.resolveCookie(req.headers.cookie);
    }

    public isWebSocketAuthorized(req: http.IncomingMessage): boolean {
        if (!isWebSocketOriginAllowed(req)) {
            return false;
        }
        return !this.isRemoteRequest(req)
            || !!this.authority.resolveCookie(req.headers.cookie);
    }

    /**
     * The person on this machine: a loopback connection that did not come
     * through any proxy. cloudflared is told apart by its host name and
     * header; any other loopback proxy (ssh -L aside, which adds nothing)
     * announces itself with a forwarding header and is not the host
     * (COLLAB-ROOM-9).
     */
    public isLocalRequest(req: http.IncomingMessage, isLoopback: (address: string | undefined) => boolean): boolean {
        return !this.isRemoteRequest(req)
            && isLoopback(req.socket.remoteAddress)
            && FORWARDING_HEADERS.every((header) => req.headers[header] === undefined);
    }

    public isRemoteRequest(req: http.IncomingMessage): boolean {
        const hostname = String(req.headers.host || '').split(':')[0].toLowerCase();
        return hostname.endsWith('.trycloudflare.com')
            || typeof req.headers['cf-connecting-ip'] === 'string';
    }
}
