import { extensionIdOf, HOST_VSCODE_API_VERSION, type ContributionSummary, type ExtensionId } from '../../shared/extensions.ts';

/**
 * The `package.json` of a VS Code extension (#254), validated. Pure: no file
 * access, unit-tested in Node. Only what the IDE reads is typed; the rest of
 * the manifest is kept as `raw` for the extension host, which hands it to the
 * extension as `extension.packageJSON`.
 */

export interface ExtensionManifest {
    readonly id: ExtensionId;
    readonly publisher: string;
    readonly name: string;
    readonly version: string;
    readonly displayName: string;
    readonly description: string;
    readonly engine: string;
    readonly main: string | null;
    readonly browser: string | null;
    readonly icon: string | null;
    readonly categories: readonly string[];
    readonly license: string | null;
    readonly repository: string | null;
    readonly activationEvents: readonly string[];
    readonly extensionDependencies: readonly ExtensionId[];
    readonly extensionPack: readonly ExtensionId[];
    readonly contributes: Readonly<Record<string, unknown>>;
    /** `capabilities.untrustedWorkspaces.supported` is `true` or `"limited"`. */
    readonly supportsUntrusted: boolean;
    readonly raw: Readonly<Record<string, unknown>>;
}

export class ManifestError extends Error {}

const NAME = /^[a-z0-9][a-z0-9._-]*$/i;

function str(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Replaces `%key%` placeholders with the strings of `package.nls.json`, as
 * VS Code does for `displayName`, `description`, command titles and settings.
 * Works on any JSON value; unknown keys stay as they are.
 */
export function localizeManifest(value: unknown, nls: Readonly<Record<string, unknown>>): unknown {
    if (typeof value === 'string') {
        const match = /^%([^%]+)%$/.exec(value);
        if (match?.[1] !== undefined) {
            const entry = nls[match[1]];
            if (typeof entry === 'string') {
                return entry;
            }
            // { message, comment } entries (vscode-nls format).
            const message = record(entry).message;
            if (typeof message === 'string') {
                return message;
            }
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => localizeManifest(item, nls));
    }
    if (typeof value === 'object' && value !== null) {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = localizeManifest(item, nls);
        }
        return out;
    }
    return value;
}

function repositoryUrl(value: unknown): string | null {
    const url = typeof value === 'string' ? value : str(record(value).url);
    if (!url) {
        return null;
    }
    const cleaned = url.replace(/^git\+/, '').replace(/\.git$/, '');
    return /^https:\/\//i.test(cleaned) ? cleaned : null;
}

/** Parses and validates a manifest already read as JSON (and localised). */
export function parseManifest(json: unknown): ExtensionManifest {
    const raw = record(json);
    const publisher = str(raw.publisher);
    const name = str(raw.name);
    const version = str(raw.version);
    if (!publisher || !NAME.test(publisher)) {
        throw new ManifestError('The extension has no valid "publisher".');
    }
    if (!name || !NAME.test(name)) {
        throw new ManifestError('The extension has no valid "name".');
    }
    if (!version || !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
        throw new ManifestError('The extension has no valid "version".');
    }
    const engine = str(record(raw.engines).vscode);
    if (!engine) {
        throw new ManifestError('The extension does not declare "engines.vscode": it is not a VS Code extension.');
    }
    const main = str(raw.main);
    const icon = str(raw.icon);
    for (const [field, value] of [['main', main], ['icon', icon]] as const) {
        if (value !== null && !isSafeRelativePath(value)) {
            throw new ManifestError(`"${field}" points outside the extension.`);
        }
    }
    const untrusted = record(record(raw.capabilities).untrustedWorkspaces).supported;
    return {
        id: extensionIdOf(publisher, name),
        publisher,
        name,
        version,
        displayName: str(raw.displayName) ?? name,
        description: str(raw.description) ?? '',
        engine,
        main,
        browser: str(raw.browser),
        icon,
        categories: strings(raw.categories),
        license: str(raw.license),
        repository: repositoryUrl(raw.repository),
        activationEvents: strings(raw.activationEvents),
        extensionDependencies: strings(raw.extensionDependencies).map((id) => id.toLowerCase()),
        extensionPack: strings(raw.extensionPack).map((id) => id.toLowerCase()),
        contributes: record(raw.contributes),
        supportsUntrusted: untrusted === true || untrusted === 'limited',
        raw,
    };
}

/** A path inside the extension: relative, `/` or `\` separated, no `..`, no drive, no NUL. */
export function isSafeRelativePath(value: string): boolean {
    if (value === '' || value.includes('\0') || /^[a-zA-Z]:/.test(value) || value.startsWith('/') || value.startsWith('\\')) {
        return false;
    }
    return !value.split(/[\\/]+/).some((segment) => segment === '..');
}

/** The contributions as counts and names for the Extensions view. */
export function summarizeContributions(manifest: ExtensionManifest): ContributionSummary {
    const c = manifest.contributes;
    const list = (key: string): Record<string, unknown>[] => (Array.isArray(c[key]) ? (c[key] as unknown[]).map(record) : []);
    const views = Object.values(record(c.views)).flatMap((entries) => (Array.isArray(entries) ? entries.map(record) : []));
    const configuration = Array.isArray(c.configuration) ? c.configuration.map(record) : [record(c.configuration)];
    return {
        themes: list('themes').map((theme) => str(theme.label) ?? str(theme.id) ?? '').filter(Boolean),
        iconThemes: list('iconThemes').map((theme) => str(theme.label) ?? str(theme.id) ?? '').filter(Boolean),
        languages: list('languages').map((language) => str(language.id) ?? '').filter(Boolean),
        grammars: list('grammars').length,
        snippets: list('snippets').length,
        commands: list('commands').map((command) => str(command.title) ?? str(command.command) ?? '').filter(Boolean),
        views: views.map((view) => str(view.name) ?? str(view.id) ?? '').filter(Boolean),
        settings: configuration.reduce((sum, section) => sum + Object.keys(record(section.properties)).length, 0),
        keybindings: list('keybindings').length,
        localizations: list('localizations').map((loc) => str(loc.languageName) ?? str(loc.languageId) ?? '').filter(Boolean),
    };
}

/** A semver triple, prerelease ignored; null when it does not parse. */
function triple(version: string): [number, number, number] | null {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a: string, b: string): number {
    const x = triple(a) ?? [0, 0, 0];
    const y = triple(b) ?? [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d !== 0) {
            return d;
        }
    }
    return 0;
}

/**
 * Whether `engines.vscode` (`^1.80.0`, `>=1.60.0`, `1.x`, `*`) is satisfied by
 * the API version the host implements. Only the minimum matters: VS Code
 * itself treats the range as "at least".
 */
export function engineSupported(engine: string, hostVersion: string = HOST_VSCODE_API_VERSION): boolean {
    const trimmed = engine.trim();
    if (trimmed === '*' || trimmed === '') {
        return true;
    }
    const match = /(\d+)\.(\d+|x)(?:\.(\d+|x))?/.exec(trimmed);
    if (!match) {
        return true;
    }
    const wanted = `${match[1]}.${match[2] === 'x' ? 0 : match[2]}.${match[3] === undefined || match[3] === 'x' ? 0 : match[3]}`;
    return compareVersions(hostVersion, wanted) >= 0;
}
