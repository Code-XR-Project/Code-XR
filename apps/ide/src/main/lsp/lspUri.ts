import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLIENT_URI_SCHEME } from '../../shared/lsp.ts';
import { isInside, parseWorkspacePath } from '../workspace/workspacePath.ts';

/**
 * The URI mapping of the language client (#21). The renderer names documents
 * `codexr-file:///<workspace path>` (Monaco's URIs); a language server knows
 * files as `file://` URIs. Both directions go through the workspace path
 * rules (`parseWorkspacePath`), so a URI that would name anything outside
 * the open folder is refused on the way in and dropped on the way out.
 */

/** The open folder as given and as its real path (a server may answer with either). */
export interface WorkspaceRoots {
    readonly root: string;
    readonly realRoot: string;
}

/** Monaco writes a URI with an empty authority as `codexr-file:/path`; `codexr-file:///path` means the same. */
const CLIENT_PREFIX = `${CLIENT_URI_SCHEME}:/`;
const MAX_URI_LENGTH = 8192;

/** The workspace path a renderer URI names; throws on anything else. */
export function clientUriToWorkspacePath(uri: unknown): string {
    if (typeof uri !== 'string' || uri.length > MAX_URI_LENGTH || !uri.startsWith(CLIENT_PREFIX)) {
        throw new Error('Not a workspace document URI.');
    }
    let encoded = uri.slice(CLIENT_PREFIX.length);
    if (encoded.startsWith('/')) {
        // An authority follows "//": only an empty one is a workspace file.
        if (!encoded.startsWith('//')) {
            throw new Error('Not a workspace document URI.');
        }
        encoded = encoded.slice(2);
    }
    // Monaco percent-encodes "?" and "#" inside a path: a raw one is a query or a fragment.
    if (encoded.includes('?') || encoded.includes('#')) {
        throw new Error('Not a workspace document URI.');
    }
    let decoded: string;
    try {
        decoded = decodeURIComponent(encoded);
    } catch {
        throw new Error('Not a workspace document URI.');
    }
    if (decoded === '') {
        throw new Error('The workspace folder is not a document.');
    }
    return parseWorkspacePath(decoded).join('/');
}

/** The renderer URI of a validated workspace path, in Monaco's own form (`codexr-file:/src/a.ts`). */
export function workspacePathToClientUri(workspacePath: string): string {
    return CLIENT_PREFIX + parseWorkspacePath(workspacePath).map(encodeSegment).join('/');
}

/** Like Monaco's `Uri.toString()`: everything but unreserved characters is percent-encoded. */
function encodeSegment(segment: string): string {
    return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Renderer URI to the `file://` URI a server understands; throws outside the folder. */
export function toServerUri(clientUri: unknown, roots: WorkspaceRoots): string {
    const segments = clientUriToWorkspacePath(clientUri).split('/');
    const absolute = path.join(roots.root, ...segments);
    if (!isInside(roots.root, absolute)) {
        throw new Error('Path leaves the workspace.');
    }
    return pathToFileURL(absolute).href;
}

/** A server's `file://` URI to the renderer's, or null when it is not a file inside the folder. */
export function toClientUri(serverUri: unknown, roots: WorkspaceRoots): string | null {
    if (typeof serverUri !== 'string' || serverUri.length > MAX_URI_LENGTH || !serverUri.startsWith('file:')) {
        return null;
    }
    let absolute: string;
    try {
        absolute = fileURLToPath(serverUri);
    } catch {
        return null;
    }
    for (const base of new Set([roots.root, roots.realRoot])) {
        if (!isInside(base, absolute)) {
            continue;
        }
        const relative = path.relative(base, absolute).split(path.sep).join('/');
        try {
            return relative === '' ? null : workspacePathToClientUri(relative);
        } catch {
            return null;
        }
    }
    return null;
}

const DROP: unique symbol = Symbol('drop');
const MAX_DEPTH = 64;
/** The properties of LSP objects that carry a document URI (Location, LocationLink, the diagnostics' related information). */
const URI_KEYS: ReadonlySet<string> = new Set(['uri', 'targetUri']);

/**
 * Maps every `uri` / `targetUri` inside a server's answer to the renderer's
 * URI. An object naming a file outside the folder is dropped from its array
 * (a definition in a library, related information in a lib file), and so is
 * any object containing one; when the whole answer goes, the result is null.
 */
export function mapServerUris(value: unknown, map: (uri: string) => string | null): unknown {
    const mapped = walk(value, map, 0);
    return mapped === DROP ? null : mapped;
}

function walk(value: unknown, map: (uri: string) => string | null, depth: number): unknown {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (depth > MAX_DEPTH) {
        return DROP;
    }
    if (Array.isArray(value)) {
        return value.map((item) => walk(item, map, depth + 1)).filter((item) => item !== DROP);
    }
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        if (URI_KEYS.has(key) && typeof child === 'string') {
            const uri = map(child);
            if (uri === null) {
                return DROP;
            }
            result[key] = uri;
            continue;
        }
        const mapped = walk(child, map, depth + 1);
        if (mapped === DROP) {
            return DROP;
        }
        result[key] = mapped;
    }
    return result;
}
