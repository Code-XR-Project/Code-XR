import { createHash } from 'node:crypto';
import { extensionIdOf, GALLERY_SORTS, type ExtensionId, type GalleryDetails, type GalleryExtension, type GalleryQuery, type GallerySearchResult } from '../../shared/extensions.ts';

/**
 * A client for an Open VSX registry (#254, ADR 0002): open-vsx.org by
 * default, or a company's own instance (setting `extensions.gallery.serviceUrl`).
 * Its REST API is public and needs no key. Every request is started by the
 * person (a search, opening a details page, an install); nothing here runs on
 * its own. `fetch` is injected: Electron's `net.fetch` in the app (it honours
 * the system proxy), a fake server in the unit tests.
 */

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly headers: { get(name: string): string | null };
    json(): Promise<unknown>;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
}>;

export class GalleryError extends Error {}

const TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/** The largest `.vsix` the IDE downloads. */
export const MAX_VSIX_BYTES = 300 * 1024 * 1024;
const MAX_ICON_BYTES = 512 * 1024;

/** The registry base URL from the setting, or null when it is not acceptable (https, or http on this machine). */
export function normalizeGalleryUrl(value: string): string | null {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        return null;
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
        return null;
    }
    return url.toString().replace(/\/+$/, '');
}

/** Only https downloads (registries put files on a CDN of another host), or the registry's own origin. */
function checkFileUrl(raw: unknown, base: string): string {
    if (typeof raw !== 'string') {
        throw new GalleryError('The registry answered without a file address.');
    }
    const url = new URL(raw, `${base}/`);
    if (url.protocol !== 'https:' && url.origin !== new URL(base).origin) {
        throw new GalleryError(`Refused a download over ${url.protocol}`);
    }
    return url.toString();
}

/** Open VSX's name for the platform the IDE runs on. */
export function targetPlatform(platform: string = process.platform, arch: string = process.arch): string {
    const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
    const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch === 'arm' ? 'armhf' : null;
    return os && cpu && !(os !== 'linux' && cpu === 'armhf') ? `${os}-${cpu}` : 'universal';
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function num(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toGalleryExtension(raw: unknown): GalleryExtension | null {
    const item = record(raw);
    const namespace = text(item.namespace);
    const name = text(item.name);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(namespace) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        return null;
    }
    const icon = record(item.files).icon;
    return {
        id: extensionIdOf(namespace, name),
        namespace,
        name,
        version: text(item.version),
        displayName: text(item.displayName) || name,
        description: text(item.description),
        iconUrl: typeof icon === 'string' && /^https:\/\//.test(icon) ? icon : null,
        downloadCount: num(item.downloadCount),
        averageRating: typeof item.averageRating === 'number' ? item.averageRating : null,
        verified: item.verified === true,
        timestamp: typeof item.timestamp === 'string' ? item.timestamp : null,
    };
}

/** Splits `publisher.name` (the name may itself contain dots). */
export function splitExtensionId(id: ExtensionId): { namespace: string; name: string } {
    const dot = id.indexOf('.');
    return { namespace: id.slice(0, dot), name: id.slice(dot + 1) };
}

function compareDesc(a: string, b: string): number {
    const parse = (v: string): number[] => v.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < 3; i++) {
        const d = (y[i] ?? 0) - (x[i] ?? 0);
        if (d !== 0) {
            return d;
        }
    }
    return 0;
}

export interface DownloadedVsix {
    readonly bytes: Buffer;
    readonly version: string;
    readonly verified: boolean;
    readonly sha256: string;
}

export class OpenVsxClient {
    private readonly base: string;
    private readonly fetchImpl: FetchLike;
    private readonly platform: string;

    constructor(base: string, fetchImpl: FetchLike, platform: string = targetPlatform()) {
        const normalized = normalizeGalleryUrl(base);
        if (!normalized) {
            throw new GalleryError(`Not an acceptable registry address: ${base} (https, or http on this machine).`);
        }
        this.base = normalized;
        this.fetchImpl = fetchImpl;
        this.platform = platform;
    }

    get url(): string {
        return this.base;
    }

    private async request(url: string, timeoutMs = TIMEOUT_MS): Promise<Awaited<ReturnType<FetchLike>>> {
        let response;
        try {
            response = await this.fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
        } catch (error) {
            throw new GalleryError(`Cannot reach the extension registry (${new URL(url).host}): ${(error as Error).message}`);
        }
        if (!response.ok) {
            throw new GalleryError(response.status === 404 ? 'Not found in the extension registry.' : `The extension registry answered ${response.status}.`);
        }
        return response;
    }

    private async getJson(path: string): Promise<Record<string, unknown>> {
        const response = await this.request(`${this.base}${path}`);
        const body = record(await response.json());
        if (typeof body.error === 'string') {
            throw new GalleryError(body.error);
        }
        return body;
    }

    async search(query: GalleryQuery): Promise<GallerySearchResult> {
        const params = new URLSearchParams();
        params.set('query', query.text.slice(0, 200));
        if (query.category) {
            params.set('category', query.category.slice(0, 64));
        }
        const sortBy = query.sortBy && (GALLERY_SORTS as readonly string[]).includes(query.sortBy) ? query.sortBy : 'relevance';
        params.set('sortBy', sortBy);
        params.set('sortOrder', 'desc');
        params.set('offset', String(Math.max(0, Math.floor(query.offset ?? 0))));
        params.set('size', String(Math.min(50, Math.max(1, Math.floor(query.size ?? 30)))));
        params.set('includeAllVersions', 'false');
        const body = await this.getJson(`/api/-/search?${params.toString()}`);
        const extensions = (Array.isArray(body.extensions) ? body.extensions : []).map(toGalleryExtension).filter((item): item is GalleryExtension => item !== null);
        return { offset: num(body.offset), totalSize: num(body.totalSize), extensions };
    }

    /** The registry's JSON for an extension: this platform's build when there is one, else the universal one. */
    private async metadata(id: ExtensionId, version?: string): Promise<Record<string, unknown>> {
        const { namespace, name } = splitExtensionId(id);
        const ns = encodeURIComponent(namespace);
        const ext = encodeURIComponent(name);
        const suffix = version ? `/${encodeURIComponent(version)}` : '';
        if (this.platform !== 'universal') {
            try {
                return await this.getJson(`/api/${ns}/${ext}/${this.platform}${suffix}`);
            } catch (error) {
                if (!(error instanceof GalleryError)) {
                    throw error;
                }
            }
        }
        return this.getJson(`/api/${ns}/${ext}${suffix}`);
    }

    async details(id: ExtensionId): Promise<GalleryDetails> {
        const body = await this.metadata(id);
        const base = toGalleryExtension(body);
        if (!base) {
            throw new GalleryError('The registry sent an extension without a valid name.');
        }
        const files = record(body.files);
        let readme: string | null = null;
        if (typeof files.readme === 'string') {
            try {
                readme = (await (await this.request(checkFileUrl(files.readme, this.base))).text()).slice(0, 512 * 1024);
            } catch {
                readme = null;
            }
        }
        const versions = Object.keys(record(body.allVersions)).filter((v) => v !== 'latest' && v !== 'pre-release').sort(compareDesc);
        const publishedBy = record(body.publishedBy);
        const targets = Array.isArray(body.allTargetPlatformVersions)
            ? body.allTargetPlatformVersions.flatMap((entry) => (Array.isArray(record(entry).targetPlatforms) ? record(entry).targetPlatforms as unknown[] : [])).filter((t): t is string => typeof t === 'string')
            : [text(body.targetPlatform, 'universal')];
        const repository = text(body.repository);
        const homepage = text(body.homepage);
        return {
            ...base,
            publisherDisplayName: text(body.namespaceDisplayName) || text(publishedBy.fullName) || base.namespace,
            license: text(body.license) || null,
            repository: /^https:\/\//.test(repository) ? repository.replace(/\.git$/, '') : null,
            homepage: /^https:\/\//.test(homepage) ? homepage : null,
            categories: Array.isArray(body.categories) ? body.categories.filter((c): c is string => typeof c === 'string') : [],
            tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string').slice(0, 30) : [],
            engine: text(record(body.engines).vscode) || null,
            versions,
            readme,
            targetPlatforms: [...new Set(targets)],
        };
    }

    /**
     * Downloads the `.vsix` and checks it against the registry's SHA-256.
     * A registry that publishes no checksum is refused: the archive could not
     * be told apart from a corrupted or swapped one.
     */
    async download(id: ExtensionId, version?: string): Promise<DownloadedVsix> {
        const body = await this.metadata(id, version);
        const files = record(body.files);
        const downloadUrl = checkFileUrl(files.download, this.base);
        if (typeof files.sha256 !== 'string') {
            throw new GalleryError('The registry publishes no SHA-256 for this extension; it was not installed.');
        }
        const expected = ((await (await this.request(checkFileUrl(files.sha256, this.base))).text()).trim().split(/\s+/)[0] ?? '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(expected)) {
            throw new GalleryError('The registry sent a malformed SHA-256.');
        }
        const response = await this.request(downloadUrl, DOWNLOAD_TIMEOUT_MS);
        const length = Number(response.headers.get('content-length') ?? '0');
        if (length > MAX_VSIX_BYTES) {
            throw new GalleryError('The extension is larger than the IDE downloads.');
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_VSIX_BYTES) {
            throw new GalleryError('The extension is larger than the IDE downloads.');
        }
        const actual = createHash('sha256').update(bytes).digest('hex');
        if (actual !== expected) {
            throw new GalleryError('The downloaded file does not match the registry\'s SHA-256; it was not installed.');
        }
        return { bytes, version: text(body.version), verified: body.verified === true, sha256: actual };
    }

    /** An icon as a `data:` URL, so the renderer never fetches from the network itself. */
    async icon(url: string): Promise<string | null> {
        if (!/^https:\/\//.test(url)) {
            return null;
        }
        try {
            const response = await this.request(url);
            const type = ((response.headers.get('content-type') ?? '').split(';')[0] ?? '').trim().toLowerCase();
            if (!['image/png', 'image/jpeg', 'image/svg+xml', 'image/gif', 'image/webp'].includes(type)) {
                return null;
            }
            const bytes = Buffer.from(await response.arrayBuffer());
            return bytes.length > MAX_ICON_BYTES ? null : `data:${type};base64,${bytes.toString('base64')}`;
        } catch {
            return null;
        }
    }
}
