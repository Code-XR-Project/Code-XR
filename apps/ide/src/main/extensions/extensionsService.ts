import { BrowserWindow, dialog, net, type IpcMainInvokeEvent, type WebContents } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    DEFAULT_GALLERY_URL, EXTENSION_IPC_CHANNELS, EXTENSION_IPC_EVENTS, GALLERY_URL_SETTING, isExtensionId,
    type ExtensionActivation, type ExtensionContributions, type ExtensionId, type ExtensionLogEvent, type GalleryQuery, type InstallResult, type InstalledDetails, type InstalledExtension,
} from '../../shared/extensions.ts';
import { channelLog } from '../log.ts';
import type { SettingsService } from '../settings/settingsService.ts';
import { addTrustChangeListener, isWorkspaceTrusted } from '../trust/workspaceTrust.ts';
import { ContributionIndex } from './contributions.ts';
import { ExtensionStore, resolveInExtension, type LoadedExtension } from './extensionStore.ts';
import { engineSupported, summarizeContributions, type ExtensionManifest } from './manifest.ts';
import { GalleryError, normalizeGalleryUrl, OpenVsxClient, type FetchLike } from './openVsx.ts';
import { extensionRunState, mayRunCode } from './runState.ts';

type Handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

const extLog = channelLog('extensions');

/** What the extension host reports for a window (#259); empty until the host runs. */
export interface ActivationSource {
    activation(contents: WebContents, id: ExtensionId): { state: ExtensionActivation; error?: string };
}

const ICON_TYPES: Record<string, string> = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_ICON_BYTES = 256 * 1024;

function iconOf(extension: LoadedExtension): string | null {
    if (!extension.manifest.icon) {
        return null;
    }
    const file = resolveInExtension(extension.location, extension.manifest.icon);
    const type = file ? ICON_TYPES[path.extname(file).toLowerCase()] : undefined;
    if (!file || !type) {
        return null;
    }
    try {
        const bytes = fs.readFileSync(file);
        return bytes.length > MAX_ICON_BYTES ? null : `data:${type};base64,${bytes.toString('base64')}`;
    } catch {
        return null;
    }
}

function readText(location: string, names: readonly string[]): string | null {
    for (const name of names) {
        const file = resolveInExtension(location, name);
        if (file && fs.existsSync(file)) {
            try {
                return fs.readFileSync(file, 'utf8').slice(0, 512 * 1024);
            } catch {
                return null;
            }
        }
    }
    return null;
}

/**
 * The extensions of the IDE in the main process (#254, #255, #257, #258):
 * the store on disk, the Open VSX client, the declarative contributions, and
 * the IPC handlers of `window.codexr.extensions`. Installing always asks in a
 * native dialog that the renderer cannot answer.
 */
export class ExtensionsService {
    readonly store: ExtensionStore;
    private index: ContributionIndex;
    private readonly icons = new Map<ExtensionId, string | null>();
    private activations: ActivationSource | null = null;
    private readonly changeListeners = new Set<() => void>();
    private readonly settings: SettingsService;
    private readonly fetchImpl: FetchLike;
    private readonly disabledByFlag: boolean;

    constructor(options: { root: string; settings: SettingsService; fetchImpl?: FetchLike; disableExtensions?: boolean }) {
        this.store = new ExtensionStore(options.root);
        this.store.cleanUp();
        this.settings = options.settings;
        this.fetchImpl = options.fetchImpl ?? ((url, init) => net.fetch(url, init));
        this.disabledByFlag = options.disableExtensions === true;
        this.index = this.buildIndex();
        if (this.disabledByFlag) {
            extLog.warn('Started with --disable-extensions: no extension contributes or runs in this session.');
        }
        // #263: trusting a folder changes which extensions may run in its window.
        addTrustChangeListener((contents) => this.notify(contents));
    }

    /** The extensions whose contributions apply (enabled, and not turned off by the start-up flag). */
    enabled(): readonly LoadedExtension[] {
        return this.disabledByFlag ? [] : this.store.list().filter((extension) => extension.enabled);
    }

    private buildIndex(): ContributionIndex {
        const all = this.store.list((id, error) => extLog.warn(`${id} is installed but cannot be read: ${error.message}`));
        void all;
        return new ContributionIndex(this.enabled(), (message) => extLog.warn(message));
    }

    /** #259: the extension host's IPC handlers, registered with the service's own. */
    private hostHandlers: ((handle: Handle) => void) | null = null;

    attachHost(register: (handle: Handle) => void): void {
        this.hostHandlers = register;
    }

    setActivationSource(source: ActivationSource): void {
        this.activations = source;
    }

    onDidChange(listener: () => void): () => void {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }

    get contributions(): ExtensionContributions {
        return this.index.contributions;
    }

    /** Whether an extension's code may run in this window (#263). */
    mayRun(contents: WebContents | null, extension: LoadedExtension): boolean {
        return mayRunCode({ enabled: extension.enabled, disabledByFlag: this.disabledByFlag, supportsUntrusted: extension.manifest.supportsUntrusted, trusted: contents === null ? null : isWorkspaceTrusted(contents) });
    }

    describe(contents: WebContents | null, extension: LoadedExtension): InstalledExtension {
        const manifest = extension.manifest;
        const hasCode = manifest.main !== null;
        if (!this.icons.has(manifest.id)) {
            this.icons.set(manifest.id, iconOf(extension));
        }
        const activation = hasCode && contents && this.activations ? this.activations.activation(contents, manifest.id) : { state: hasCode ? 'inactive' as const : 'none' as const };
        return {
            id: manifest.id,
            publisher: manifest.publisher,
            name: manifest.name,
            version: manifest.version,
            displayName: manifest.displayName,
            description: manifest.description,
            categories: manifest.categories,
            license: manifest.license,
            repository: manifest.repository,
            icon: this.icons.get(manifest.id) ?? null,
            hasCode,
            state: extensionRunState({ enabled: extension.enabled, disabledByFlag: this.disabledByFlag, hasCode, supportsUntrusted: manifest.supportsUntrusted, trusted: contents === null ? null : isWorkspaceTrusted(contents) }),
            activation: activation.state,
            ...(activation.error ? { activationError: activation.error } : {}),
            engine: manifest.engine,
            engineWarning: !engineSupported(manifest.engine),
            source: extension.record.source,
            installedAt: extension.record.installedAt,
            contributes: summarizeContributions(manifest),
            supportsUntrusted: manifest.supportsUntrusted,
        };
    }

    list(contents: WebContents | null): InstalledExtension[] {
        return this.store.list().map((extension) => this.describe(contents, extension));
    }

    /** Tells one window (or all) that the list or a state changed. */
    notify(only?: WebContents): void {
        for (const win of BrowserWindow.getAllWindows()) {
            if (win.isDestroyed() || (only && win.webContents !== only)) {
                continue;
            }
            win.webContents.send(EXTENSION_IPC_EVENTS.extensionsChanged, { installed: this.list(win.webContents) });
        }
    }

    private changed(): void {
        this.icons.clear();
        this.index = this.buildIndex();
        this.notify();
        for (const listener of this.changeListeners) {
            listener();
        }
    }

    private async gallery(): Promise<OpenVsxClient> {
        const value = (await this.settings.snapshot(null)).effective[GALLERY_URL_SETTING];
        const url = typeof value === 'string' && normalizeGalleryUrl(value) ? value : DEFAULT_GALLERY_URL;
        return new OpenVsxClient(url, this.fetchImpl);
    }

    /** The native confirmation shown before anything is installed. */
    private async confirmInstall(contents: WebContents, manifest: ExtensionManifest, origin: string, verified: boolean | null): Promise<boolean> {
        const win = BrowserWindow.fromWebContents(contents);
        const replacing = this.store.installedVersion(manifest.id);
        const lines = [
            `${manifest.displayName} ${manifest.version}`,
            `Identifier: ${manifest.id}`,
            `Publisher: ${manifest.publisher}${verified === null ? '' : verified ? ' (verified by the registry)' : ' (NOT verified by the registry)'}`,
            `Licence: ${manifest.license ?? 'not stated'}`,
            `From: ${origin}`,
        ];
        if (replacing) {
            lines.push(`Replaces version ${replacing}.`);
        }
        lines.push('', manifest.main
            ? 'This extension contains code. It runs on this computer with your user\'s rights, as in VS Code. Install extensions only from publishers you trust.'
            : 'This extension only contributes themes, languages or snippets; it runs no code.');
        if (!engineSupported(manifest.engine)) {
            lines.push('', `It asks for VS Code ${manifest.engine}; the IDE implements part of that API, so some features may not work.`);
        }
        const options = {
            type: 'question' as const,
            buttons: ['Install', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
            title: 'Install extension',
            message: `Install ${manifest.displayName}?`,
            detail: lines.join('\n'),
        };
        const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
        return response === 0;
    }

    private async installFile(contents: WebContents, file: string, source: 'open-vsx' | 'vsix', origin: string, verified: boolean | null, expectedId?: ExtensionId): Promise<InstallResult> {
        const manifest = await this.store.inspect(file);
        if (expectedId && manifest.id !== expectedId) {
            return { ok: false, error: `The registry sent ${manifest.id} instead of ${expectedId}; it was not installed.` };
        }
        if (!(await this.confirmInstall(contents, manifest, origin, verified))) {
            return { ok: false, cancelled: true, error: 'Cancelled.' };
        }
        const outcome = await this.store.install(file, source);
        extLog.info(`Installed ${manifest.id} ${manifest.version} from ${origin}${outcome.replaced ? ` (replaced ${outcome.replaced})` : ''}.`);
        this.changed();
        return { ok: true, extension: this.describe(contents, outcome.extension), replaced: outcome.replaced };
    }

    async install(contents: WebContents, id: unknown, version: unknown): Promise<InstallResult> {
        if (!isExtensionId(id) || (version !== undefined && (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,64}$/.test(version)))) {
            throw new Error('Invalid extension.');
        }
        const gallery = await this.gallery();
        const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codexr-vsix-'));
        try {
            extLog.info(`Downloading ${id}${version ? ` ${version}` : ''} from ${gallery.url}…`);
            const download = await gallery.download(id.toLowerCase(), version as string | undefined);
            const file = path.join(temp, 'extension.vsix');
            await fs.promises.writeFile(file, download.bytes);
            return await this.installFile(contents, file, 'open-vsx', new URL(gallery.url).host, download.verified, id.toLowerCase());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            extLog.error(`Installing ${id} failed: ${message}`);
            return { ok: false, error: message };
        } finally {
            await fs.promises.rm(temp, { recursive: true, force: true });
        }
    }

    async installVsix(contents: WebContents, file?: string): Promise<InstallResult> {
        let chosen = file;
        if (!chosen) {
            const win = BrowserWindow.fromWebContents(contents);
            const options = { title: 'Install from VSIX', properties: ['openFile' as const], filters: [{ name: 'VS Code extension', extensions: ['vsix'] }] };
            const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
            if (picked.canceled || picked.filePaths.length === 0) {
                return { ok: false, cancelled: true, error: 'Cancelled.' };
            }
            chosen = picked.filePaths[0] ?? '';
        }
        try {
            return await this.installFile(contents, chosen, 'vsix', path.basename(chosen), null);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            extLog.error(`Installing ${path.basename(chosen)} failed: ${message}`);
            return { ok: false, error: message };
        }
    }

    async uninstall(contents: WebContents, id: unknown): Promise<boolean> {
        if (!isExtensionId(id)) {
            throw new Error('Invalid extension.');
        }
        const extension = this.store.get(id);
        if (!extension) {
            return false;
        }
        const win = BrowserWindow.fromWebContents(contents);
        const options = { type: 'question' as const, buttons: ['Uninstall', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true, title: 'Uninstall extension', message: `Uninstall ${extension.manifest.displayName}?`, detail: `${extension.manifest.id} ${extension.manifest.version} and its files are removed.` };
        const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
        if (response !== 0) {
            return false;
        }
        const removed = await this.store.uninstall(id);
        if (removed) {
            extLog.info(`Uninstalled ${id}.`);
            this.changed();
        }
        return removed;
    }

    setEnabled(id: unknown, enabled: unknown): void {
        if (!isExtensionId(id) || typeof enabled !== 'boolean') {
            throw new Error('Invalid extension.');
        }
        this.store.setEnabled(id, enabled);
        extLog.info(`${enabled ? 'Enabled' : 'Disabled'} ${id}.`);
        this.changed();
    }

    disableAll(): void {
        this.store.disableAll();
        extLog.info('Disabled every installed extension.');
        this.changed();
    }

    details(contents: WebContents, id: unknown): InstalledDetails | null {
        if (!isExtensionId(id)) {
            throw new Error('Invalid extension.');
        }
        const extension = this.store.get(id);
        if (!extension) {
            return null;
        }
        return {
            extension: this.describe(contents, extension),
            readme: readText(extension.location, ['README.md', 'readme.md', 'README.MD', 'Readme.md']),
            changelog: readText(extension.location, ['CHANGELOG.md', 'changelog.md']),
        };
    }

    log(event: ExtensionLogEvent): void {
        extLog[event.level](event.message);
    }

    register(handle: Handle): void {
        this.hostHandlers?.(handle);
        handle(EXTENSION_IPC_CHANNELS.extensionsList, (event) => this.list(event.sender));
        handle(EXTENSION_IPC_CHANNELS.extensionsSearch, async (_event, query) => {
            const q = (typeof query === 'object' && query !== null ? query : {}) as Partial<GalleryQuery>;
            try {
                return await (await this.gallery()).search({ text: typeof q.text === 'string' ? q.text : '', ...(typeof q.category === 'string' ? { category: q.category } : {}), ...(q.sortBy ? { sortBy: q.sortBy } : {}), offset: typeof q.offset === 'number' ? q.offset : 0, size: typeof q.size === 'number' ? q.size : 30 });
            } catch (error) {
                throw new Error(error instanceof GalleryError ? error.message : `Search failed: ${String(error)}`);
            }
        });
        handle(EXTENSION_IPC_CHANNELS.extensionsGalleryDetails, async (_event, id) => {
            if (!isExtensionId(id)) {
                throw new Error('Invalid extension.');
            }
            return (await this.gallery()).details(id.toLowerCase());
        });
        handle(EXTENSION_IPC_CHANNELS.extensionsGalleryIcon, async (_event, url) => (typeof url === 'string' ? (await this.gallery()).icon(url) : null));
        handle(EXTENSION_IPC_CHANNELS.extensionsInstall, (event, id, version) => this.install(event.sender, id, version));
        handle(EXTENSION_IPC_CHANNELS.extensionsInstallVsix, (event) => this.installVsix(event.sender));
        handle(EXTENSION_IPC_CHANNELS.extensionsUninstall, (event, id) => this.uninstall(event.sender, id));
        handle(EXTENSION_IPC_CHANNELS.extensionsSetEnabled, (_event, id, enabled) => this.setEnabled(id, enabled));
        handle(EXTENSION_IPC_CHANNELS.extensionsDisableAll, () => this.disableAll());
        handle(EXTENSION_IPC_CHANNELS.extensionsDetails, (event, id) => this.details(event.sender, id));
        handle(EXTENSION_IPC_CHANNELS.extensionsContributions, () => this.index.contributions);
        handle(EXTENSION_IPC_CHANNELS.extensionsTheme, (_event, id) => (typeof id === 'string' && id.length < 600 ? this.index.theme(id) : null));
        handle(EXTENSION_IPC_CHANNELS.extensionsGrammarContent, (_event, ref) => (typeof ref === 'string' && ref.length < 600 ? this.index.grammarContent(ref) : null));
    }
}
