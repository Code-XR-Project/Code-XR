import fs from 'node:fs';
import path from 'node:path';
import { isWebviewId, WEBVIEW_SCHEME, webviewResourcePath, type WebviewOptionsData } from '../../shared/extensionWebviewProtocol.ts';

/**
 * #261: what extensions' webviews serve on `codexr-webview://<id>/`, one origin
 * per webview. The page is the extension's HTML with the bootstrap script in
 * front (`webviewDocument`); `/file/<path>` serves a file only when it lies,
 * after resolving links, inside one of the webview's `localResourceRoots`.
 * Anything else is a 404. Pure (no Electron), so the rules are unit-tested;
 * webviewServer.ts answers the requests.
 */

interface ServedWebview {
    readonly owner: number;
    html: string;
    version: number;
    options: WebviewOptionsData;
    /** The roots, resolved once (links followed). */
    roots: string[];
}

const served = new Map<string, ServedWebview>();

function realRoots(roots: readonly string[]): string[] {
    return roots.flatMap((root) => {
        try {
            return [fs.realpathSync.native(root)];
        } catch {
            return [];
        }
    });
}

function inside(file: string, root: string): boolean {
    const rel = path.relative(root, file);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export const WEBVIEW_CONTENT_TYPES: Readonly<Record<string, string>> = {
    '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.txt': 'text/plain', '.md': 'text/markdown',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

export const webviewServer = {
    create(owner: number, id: string, options: WebviewOptionsData): void {
        if (!isWebviewId(id)) {
            return;
        }
        served.set(id, { owner, html: '', version: 0, options, roots: realRoots(options.localResourceRoots) });
    },
    /** The new version number, or null for an unknown webview. */
    setHtml(owner: number, id: string, html: string): number | null {
        const entry = served.get(id);
        if (!entry || entry.owner !== owner) {
            return null;
        }
        entry.html = html;
        entry.version += 1;
        return entry.version;
    },
    setOptions(owner: number, id: string, options: WebviewOptionsData): boolean {
        const entry = served.get(id);
        if (!entry || entry.owner !== owner) {
            return false;
        }
        entry.options = options;
        entry.roots = realRoots(options.localResourceRoots);
        return true;
    },
    options(owner: number, id: string): WebviewOptionsData | null {
        const entry = served.get(id);
        return entry && entry.owner === owner ? entry.options : null;
    },
    dispose(owner: number, id: string): void {
        if (served.get(id)?.owner === owner) {
            served.delete(id);
        }
    },
    /** Every webview of a window (its host stopped or the window closed). */
    disposeOwner(owner: number): string[] {
        const ids = [...served].filter(([, entry]) => entry.owner === owner).map(([id]) => id);
        for (const id of ids) {
            served.delete(id);
        }
        return ids;
    },
    /** What a request is answered with: the page, a file, or nothing (404). */
    resolve(url: string, windows = process.platform === 'win32'): { kind: 'page'; html: string } | { kind: 'file'; file: string } | null {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return null;
        }
        const entry = parsed.protocol === `${WEBVIEW_SCHEME}:` ? served.get(parsed.hostname) : undefined;
        if (!entry) {
            return null;
        }
        if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
            return { kind: 'page', html: entry.html };
        }
        const requested = webviewResourcePath(parsed.pathname, windows);
        if (requested === null || !path.isAbsolute(requested)) {
            return null;
        }
        let real: string;
        try {
            real = fs.realpathSync.native(requested);
            if (!fs.statSync(real).isFile()) {
                return null;
            }
        } catch {
            return null;
        }
        return entry.roots.some((root) => inside(real, root)) ? { kind: 'file', file: real } : null;
    },
};

