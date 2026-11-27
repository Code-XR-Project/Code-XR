import fs from 'node:fs';
import path from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import type { ExtensionId } from '../../shared/extensions.ts';
import { compareVersions, isSafeRelativePath, localizeManifest, ManifestError, parseManifest, type ExtensionManifest } from './manifest.ts';
import { extractVsix, readVsixManifest } from './vsix.ts';

/**
 * The extensions installed for this user (#254): one folder per extension
 * version under `<userData>/extensions/`, and `extensions.json` beside them
 * recording what is installed, from where, and what the person turned off.
 * That file lives in the IDE's user-data folder, never in a project, so a
 * folder cannot enable an extension by itself (#263).
 *
 * No Electron import: unit-tested in Node against a temporary folder.
 */

export interface InstalledRecord {
    readonly version: string;
    /** The folder's name under the store's root. */
    readonly folder: string;
    readonly source: 'open-vsx' | 'vsix';
    readonly installedAt: number;
}

interface StoreFile {
    readonly version: 1;
    installed: Record<ExtensionId, InstalledRecord>;
    disabled: ExtensionId[];
}

/** An installed extension with its manifest read from disk. */
export interface LoadedExtension {
    readonly manifest: ExtensionManifest;
    readonly location: string;
    readonly record: InstalledRecord;
    readonly enabled: boolean;
}

function emptyFile(): StoreFile {
    return { version: 1, installed: {}, disabled: [] };
}

/** Reads a JSON-with-comments file, as VS Code accepts for manifests, themes and configurations. */
export function readJsonc(file: string): unknown {
    const errors: ParseError[] = [];
    const value = parseJsonc(fs.readFileSync(file, 'utf8'), errors, { allowTrailingComma: true, disallowComments: false });
    if (value === undefined) {
        throw new Error(`Cannot parse ${path.basename(file)}.`);
    }
    return value;
}

/** Parses a manifest's text with its translations (`package.nls.json`). */
export function manifestFromText(packageJson: string, nlsJson: string | null): ExtensionManifest {
    let json: unknown;
    try {
        json = parseJsonc(packageJson, [], { allowTrailingComma: true });
    } catch {
        json = undefined;
    }
    if (json === undefined) {
        throw new ManifestError('extension/package.json is not valid JSON.');
    }
    let nls: Record<string, unknown> = {};
    if (nlsJson) {
        const parsed = parseJsonc(nlsJson, [], { allowTrailingComma: true }) as unknown;
        if (typeof parsed === 'object' && parsed !== null) {
            nls = parsed as Record<string, unknown>;
        }
    }
    return parseManifest(localizeManifest(json, nls));
}

/** The manifest of an unpacked extension folder. */
export function readManifestFromFolder(folder: string): ExtensionManifest {
    const nlsFile = path.join(folder, 'package.nls.json');
    return manifestFromText(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'), fs.existsSync(nlsFile) ? fs.readFileSync(nlsFile, 'utf8') : null);
}

/** A file inside an extension, or null when the relative path would leave it. */
export function resolveInExtension(location: string, relative: string): string | null {
    const cleaned = relative.replace(/^\.\//, '');
    if (!isSafeRelativePath(cleaned)) {
        return null;
    }
    const root = path.resolve(location);
    const file = path.resolve(root, ...cleaned.split(/[\\/]+/));
    if (!file.startsWith(root + path.sep)) {
        return null;
    }
    // A link inside the folder that points out of it is refused too.
    try {
        const real = fs.realpathSync(file);
        const realRoot = fs.realpathSync(root);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
            return null;
        }
    } catch {
        // Not there (yet): the caller's read will fail on its own.
    }
    return file;
}

export interface InstallOutcome {
    readonly extension: LoadedExtension;
    /** The version it replaced, if one was installed. */
    readonly replaced: string | null;
}

export class ExtensionStore {
    readonly root: string;
    private readonly file: string;
    private data: StoreFile;
    private cache: Map<ExtensionId, LoadedExtension> | null = null;

    constructor(root: string) {
        this.root = root;
        this.file = path.join(root, 'extensions.json');
        fs.mkdirSync(root, { recursive: true });
        this.data = this.read();
    }

    private read(): StoreFile {
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoreFile>;
            const installed: Record<string, InstalledRecord> = {};
            for (const [id, value] of Object.entries(raw.installed ?? {})) {
                if (value && typeof value.folder === 'string' && !value.folder.includes('/') && !value.folder.includes('\\') && value.folder !== '..' && typeof value.version === 'string') {
                    installed[id.toLowerCase()] = {
                        version: value.version,
                        folder: value.folder,
                        source: value.source === 'open-vsx' ? 'open-vsx' : 'vsix',
                        installedAt: typeof value.installedAt === 'number' ? value.installedAt : 0,
                    };
                }
            }
            const disabled = Array.isArray(raw.disabled) ? raw.disabled.filter((id): id is string => typeof id === 'string').map((id) => id.toLowerCase()) : [];
            return { version: 1, installed, disabled };
        } catch {
            return emptyFile();
        }
    }

    private write(): void {
        const temp = `${this.file}.tmp`;
        fs.writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temp, this.file);
        this.cache = null;
    }

    /** Every installed extension whose folder and manifest still read; broken ones are skipped. */
    list(onError?: (id: string, error: Error) => void): readonly LoadedExtension[] {
        if (!this.cache) {
            const cache = new Map<ExtensionId, LoadedExtension>();
            for (const [id, record] of Object.entries(this.data.installed)) {
                const location = path.join(this.root, record.folder);
                try {
                    const manifest = readManifestFromFolder(location);
                    if (manifest.id !== id) {
                        throw new Error(`its manifest says ${manifest.id}`);
                    }
                    cache.set(id, { manifest, location, record, enabled: !this.data.disabled.includes(id) });
                } catch (error) {
                    onError?.(id, error as Error);
                }
            }
            this.cache = cache;
        }
        return [...this.cache.values()].sort((a, b) => a.manifest.displayName.localeCompare(b.manifest.displayName));
    }

    get(id: ExtensionId): LoadedExtension | undefined {
        this.list();
        return this.cache?.get(id.toLowerCase());
    }

    /** Reads a `.vsix`'s manifest without installing it (to show what is about to be installed). */
    async inspect(vsixFile: string): Promise<ExtensionManifest> {
        const preview = await readVsixManifest(vsixFile);
        return manifestFromText(preview.packageJson, preview.nlsJson);
    }

    /**
     * Installs a `.vsix`: unpacks it into a new folder, then records it and
     * removes the version it replaces. A same-version reinstall replaces the folder.
     */
    async install(vsixFile: string, source: InstalledRecord['source']): Promise<InstallOutcome> {
        const manifest = await this.inspect(vsixFile);
        const folder = `${manifest.id}-${manifest.version}`;
        const target = path.join(this.root, folder);
        const previous = this.data.installed[manifest.id];
        const staging = path.join(this.root, `.staging-${process.pid}-${Date.now()}`);
        await extractVsix(vsixFile, staging);
        const unpacked = readManifestFromFolder(staging);
        if (unpacked.id !== manifest.id || unpacked.version !== manifest.version) {
            await fs.promises.rm(staging, { recursive: true, force: true });
            throw new ManifestError('The archive\'s manifest changed while it was unpacked.');
        }
        await fs.promises.rm(target, { recursive: true, force: true });
        await fs.promises.rename(staging, target);
        const record: InstalledRecord = { version: manifest.version, folder, source, installedAt: Date.now() };
        this.data.installed[manifest.id] = record;
        this.write();
        if (previous && previous.folder !== folder) {
            await fs.promises.rm(path.join(this.root, previous.folder), { recursive: true, force: true });
        }
        const loaded = this.get(manifest.id);
        if (!loaded) {
            throw new ManifestError('The extension was unpacked but its manifest cannot be read back.');
        }
        return { extension: loaded, replaced: previous && previous.version !== manifest.version ? previous.version : null };
    }

    async uninstall(id: ExtensionId): Promise<boolean> {
        const key = id.toLowerCase();
        const record = this.data.installed[key];
        if (!record) {
            return false;
        }
        delete this.data.installed[key];
        this.data.disabled = this.data.disabled.filter((other) => other !== key);
        this.write();
        await fs.promises.rm(path.join(this.root, record.folder), { recursive: true, force: true });
        return true;
    }

    setEnabled(id: ExtensionId, enabled: boolean): void {
        const key = id.toLowerCase();
        if (!this.data.installed[key]) {
            return;
        }
        const others = this.data.disabled.filter((other) => other !== key);
        this.data.disabled = enabled ? others : [...others, key];
        this.write();
    }

    disableAll(): void {
        this.data.disabled = Object.keys(this.data.installed);
        this.write();
    }

    /** Whether a newer or equal version is installed (for "Update" vs "Install" in the view). */
    installedVersion(id: ExtensionId): string | null {
        return this.data.installed[id.toLowerCase()]?.version ?? null;
    }

    isNewer(id: ExtensionId, version: string): boolean {
        const installed = this.installedVersion(id);
        return installed === null || compareVersions(version, installed) > 0;
    }

    /** Leftovers of an interrupted install (staging or partial folders). */
    cleanUp(): void {
        for (const name of fs.readdirSync(this.root)) {
            if (name.startsWith('.staging-') || name.includes('.partial-')) {
                fs.rmSync(path.join(this.root, name), { recursive: true, force: true });
            }
        }
    }
}
