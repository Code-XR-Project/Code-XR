import { BrowserWindow, clipboard, webContents, type WebContents } from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AnalysisOrchestrator } from '@codexr/core/analysis/analysisOrchestrator';
import { AnalysisConfigurationStorage } from '@codexr/core/analysis/configuration/analysisConfigurationStorage';
import { CollaborationProfileManager } from '@codexr/core/collaboration/collaborationProfileManager';
import { getHost } from '@codexr/core/host/hostRegistry';
import { EXTENSION_MODE, type CoreContext } from '@codexr/core/host/hostPaths';
import type { HostDisposable } from '@codexr/core/host/codeXRHost';
import { setLaunchNotifier } from '@codexr/core/server/launchNotifier';
import { RemoteAccessManager } from '@codexr/core/remote-access/remoteAccessManager';
import { getActiveServerRegistry } from '@codexr/core/server/registry/activeServerRegistry';
import { ServerControl } from '@codexr/core/server/serverControl';
import { ServerSettingsManager } from '@codexr/core/server/serverSettingsManager';
import { AUTO_START_MODES, IPC_EVENTS, type AnalysisKind, type AnalysisStartResult, type AutoStartMode, type SceneAddress, type SceneInfo, type SceneFilesEvent, type SceneShareEvent, type SceneShareState } from '../../shared/api.ts';
import { channelLog } from '../log.ts';
import type { PythonEnvironmentService } from '../python/pythonEnvironment.ts';
import { readAnalysedFileCount, watchAnalysedFileCount } from './analysedFiles.ts';
import { closeScene, showScene } from './sceneView.ts';
import { sceneTargetToWorkspacePath } from './sceneEditorTarget.ts';
import type { SceneEditorTarget } from '../../shared/sceneBridge.ts';
import { sceneTitle, targetName } from './sceneUrl.ts';
import { isQuickTunnelUrl, sameShareState, SerialQueue, startShareOnce, STOPPED, toSceneShareState } from './sceneShare.ts';

const log = channelLog('core');

/**
 * Runs the extension's analyses from the IDE (#16), through the same core
 * pipeline the extension uses (`AnalysisOrchestrator`), and shows the result
 * in the window that asked, beside the code.
 *
 * The core opens a finished launch through its `LaunchNotifier`; the IDE's
 * shows it in the scene view instead of a browser, which is why the IDE's
 * server settings use the core's `lateralPanel` open mode: the scene is
 * served over plain HTTP on loopback (a secure context, so WebXR still works),
 * with no self-signed certificate to accept.
 */
/** Where the IDE keeps the "analyse a folder when it opens" choice (#139). */
const AUTO_START_KEY = 'ide.analysis.autoStartOnOpen';
const DEFAULT_AUTO_START: AutoStartMode = 'xr-deep';

/** The analysis a window is showing: its folder, and the core server that serves it. */
interface WindowScene {
    readonly folder: string;
    readonly kind: AnalysisKind;
    readonly serverId: string;
    readonly url: string;
    /** The sharing state last sent to the window (#155), to send changes only. */
    share: SceneShareState;
    /** #16: stops following the analysis's file count. */
    unwatch: () => void;
}

export class AnalysisService {
    private readonly context: CoreContext;
    private readonly ready: Promise<void>;
    /** The window whose request is launching, so its scene opens there. */
    private owner: BrowserWindow | null = null;
    private ownerFolder = '';
    private ownerKind: AnalysisKind = 'xr-deep';
    /** #155: analysis launches and share requests never overlap (see `startShareOnce`). */
    private readonly launches = new SerialQueue();
    /** Per window (by webContents id): the scene it last opened. */
    private readonly scenes = new Map<number, WindowScene>();
    private readonly python: PythonEnvironmentService;
    private readonly hooks: { sceneOpened?(contents: WebContents, folder: string): void };

    constructor(python: PythonEnvironmentService, subscriptions: HostDisposable[], hooks: { sceneOpened?(contents: WebContents, folder: string): void } = {}) {
        this.python = python;
        this.hooks = hooks;
        const host = getHost();
        this.context = {
            extensionPath: host.paths.installRoot,
            extensionMode: host.paths.mode === 'development' ? EXTENSION_MODE.Development : EXTENSION_MODE.Production,
            globalStorageUri: { fsPath: host.paths.globalStorageDir },
            storageUri: undefined,
            globalState: host.globalState,
        };
        AnalysisConfigurationStorage.initialize(this.context);
        CollaborationProfileManager.initialize({ ...this.context, subscriptions });
        // #155: the core's Cloudflare quick tunnels. Disposed with `subscriptions`
        // when the app quits, which stops every tunnel (no orphan cloudflared).
        RemoteAccessManager.initialize({ ...this.context, subscriptions });
        subscriptions.push(getActiveServerRegistry().onRegistryChange((event) => {
            if (event.serverId && (event.type === 'serverUpdated' || event.type === 'serverRemoved')) {
                this.publishShare(event.serverId);
            }
        }));
        ServerControl.initialize(this.context);
        setLaunchNotifier({
            warnHttpsOverriddenForPanel: () => { /* expected: the IDE serves its scenes over HTTP on loopback */ },
            notifyPortChanged: (requested, final) => {
                void host.notifier.notify('info', `Port ${requested} was busy, the analysis server uses ${final}.`);
            },
            handleAutoOpening: (_settings, serverUrl, _html, _mode, serverId) => this.open(serverUrl, serverId),
        });
        this.ready = this.prepareServerSettings();
    }

    private async prepareServerSettings(): Promise<void> {
        const settings = ServerSettingsManager.getInstance(this.context);
        await settings.ensureInitialized();
        const current = settings.getServerSettings();
        if (current.launch.openMode !== 'lateralPanel' || !current.launch.autoOpen) {
            await settings.updateServerSettings({ launch: { ...current.launch, openMode: 'lateralPanel', autoOpen: true } });
        }
        // #155: the core shares every new server on its own while cross-network
        // connections are enabled (its default). In the IDE a scene is shared
        // only from its header's button, so the setting stays off and is turned
        // on only for the duration of that request (startShareOnce).
        if (current.remoteAccess.enabled || !current.remoteAccess.enabledByDefaultApplied) {
            await this.setRemoteAccessEnabled(false);
        }
    }

    private async setRemoteAccessEnabled(enabled: boolean): Promise<void> {
        const settings = ServerSettingsManager.getInstance(this.context);
        const remoteAccess = settings.getServerSettings().remoteAccess;
        await settings.updateServerSettings({ remoteAccess: { ...remoteAccess, enabled, enabledByDefaultApplied: true } });
    }

    /** Whether a folder is analysed as soon as it opens (#139). On unless the person turned it off. */
    autoStart(): AutoStartMode {
        const saved = getHost().globalState.get<unknown>(AUTO_START_KEY);
        return (AUTO_START_MODES as readonly unknown[]).includes(saved) ? saved as AutoStartMode : DEFAULT_AUTO_START;
    }

    async setAutoStart(mode: AutoStartMode): Promise<AutoStartMode> {
        await getHost().globalState.update(AUTO_START_KEY, mode);
        return mode;
    }

    /**
     * `auto` marks an analysis the person did not click for (#139, a folder
     * just opened). It reuses a scene that is still being served for the same
     * folder. It never asks first, whatever the project's size (#203): the
     * scene's header then says how many files the analysis took.
     */
    async analyseProject(win: BrowserWindow, folder: string | undefined, kind: AnalysisKind, options: { auto?: boolean } = {}): Promise<AnalysisStartResult> {
        if (!folder) {
            return { ok: false, reason: 'no-workspace', message: 'Open a folder first.' };
        }
        const status = await this.python.status();
        if (status.state !== 'ready') {
            return { ok: false, reason: 'python-not-ready', message: 'Set up the Python environment first (Analysis view).' };
        }
        const running = this.scenes.get(win.webContents.id);
        if (options.auto && running && running.folder === folder && getActiveServerRegistry().getServer(running.serverId)) {
            this.owner = win;
            this.ownerFolder = folder;
            this.ownerKind = running.kind;
            await this.open(running.url, running.serverId);
            return { ok: true };
        }
        try {
            await this.ready;
            await this.launches.run(async () => {
                this.owner = win;
                this.ownerFolder = folder;
                this.ownerKind = kind;
                const context = this.contextFor(folder);
                switch (kind) {
                    case 'xr-deep':
                        await AnalysisOrchestrator.orchestrateAnalysis(folder, 'XR', 'directory', context, true);
                        break;
                }
            });
            return { ok: true };
        } catch (error) {
            log.error('Analysis failed to start', error);
            return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) };
        }
    }

    /**
     * A window's folder changed (or the window went): the scene of the old
     * folder closes and its server stops, so a project left behind is not
     * served on.
     */
    async folderChanged(contents: WebContents, root: string | null): Promise<void> {
        const previous = this.scenes.get(contents.id);
        if (!previous || previous.folder === root) {
            return;
        }
        this.scenes.delete(contents.id);
        previous.unwatch();
        const win = contents.isDestroyed() ? null : BrowserWindow.fromWebContents(contents);
        if (win && !win.isDestroyed()) {
            closeScene(win);
        }
        await this.stopTunnel(previous.serverId);
        if (getActiveServerRegistry().getServer(previous.serverId)) {
            await ServerControl.stopServer(previous.serverId, { silent: true }).catch((error: unknown) => log.warn(`Could not stop the analysis server of ${previous.folder}: ${String(error)}`));
        }
    }

    /**
     * Shares the calling window's scene through a Cloudflare quick tunnel
     * (#155). The renderer names no server: the scene is the one this window
     * shows. The core asks before downloading cloudflared, as in the extension.
     */
    async shareScene(win: BrowserWindow): Promise<SceneShareState> {
        const scene = this.liveScene(win);
        const manager = RemoteAccessManager.getInstance();
        if (!manager) {
            throw new Error('Remote access is not available.');
        }
        await this.ready;
        const { serverId } = scene;
        this.sendShare(win.webContents, scene, { status: 'starting' });
        let state: SceneShareState;
        try {
            state = await this.launches.run(() => startShareOnce({
                setEnabled: (enabled) => this.setRemoteAccessEnabled(enabled),
                start: () => manager.startSharing(serverId),
            }));
        } catch (error) {
            this.publishShare(serverId);
            throw error;
        }
        // The scene may have gone while cloudflared started (folder changed,
        // window closed): a tunnel to a server nobody shows is stopped at once.
        const current = this.scenes.get(win.webContents.id);
        if (!getActiveServerRegistry().getServer(serverId) || current?.serverId !== serverId) {
            await this.stopTunnel(serverId);
            return STOPPED;
        }
        this.publishShare(serverId);
        return state;
    }

    /** The static folder of the scene this window shows (epic #189, A10: read by agents' analysis tools), or null. */
    outputDirectory(contents: WebContents): string | null {
        const scene = this.scenes.get(contents.id);
        const htmlFile = scene ? getActiveServerRegistry().getServer(scene.serverId)?.htmlFile : undefined;
        return htmlFile ? path.dirname(htmlFile) : null;
    }

    async stopSharingScene(win: BrowserWindow): Promise<SceneShareState> {
        const scene = this.scenes.get(win.webContents.id);
        if (scene) {
            await this.stopTunnel(scene.serverId);
            this.publishShare(scene.serverId);
        }
        return STOPPED;
    }

    /** Copies an address of the calling window's scene: its local URL, or the tunnel's invitation link. */
    copySceneAddress(win: BrowserWindow, which: SceneAddress): void {
        const scene = this.liveScene(win);
        if (which === 'local') {
            clipboard.writeText(scene.url);
            return;
        }
        const invitation = getActiveServerRegistry().getServer(scene.serverId)?.remoteAccess?.invitationUrl;
        if (!isQuickTunnelUrl(invitation)) {
            throw new Error('This scene is not shared.');
        }
        clipboard.writeText(invitation);
    }

    /**
     * The scene asked to open a file in the editor (#16): resolved against
     * the folder the scene analysed, and only a file inside the window's open
     * folder is opened. Returns the workspace path to open, or null.
     */
    openFromScene(win: BrowserWindow, workspaceRoot: string | undefined, target: SceneEditorTarget): { readonly path: string; readonly line?: number | undefined } | null {
        const scene = this.scenes.get(win.webContents.id);
        if (!scene || !workspaceRoot) {
            return null;
        }
        const relative = sceneTargetToWorkspacePath(workspaceRoot, scene.folder, target.path);
        if (!relative) {
            log.warn(`Scene asked to open a path outside the folder: ${target.path}`);
            return null;
        }
        return target.line === undefined ? { path: relative } : { path: relative, line: target.line };
    }

    /** The scene's close button: the view goes and so does any tunnel; the local server keeps running, as in the extension. */
    async closeScene(win: BrowserWindow): Promise<void> {
        closeScene(win);
        const scene = this.scenes.get(win.webContents.id);
        if (scene) {
            await this.stopTunnel(scene.serverId);
        }
    }

    private liveScene(win: BrowserWindow): WindowScene {
        const scene = this.scenes.get(win.webContents.id);
        if (!scene || !getActiveServerRegistry().getServer(scene.serverId)) {
            throw new Error('This window shows no running analysis.');
        }
        return scene;
    }

    private async stopTunnel(serverId: string): Promise<void> {
        await RemoteAccessManager.getInstance()?.stopSharing(serverId, false)
            .catch((error: unknown) => log.warn(`Could not stop sharing ${serverId}: ${String(error)}`));
    }

    /** Sends each window showing this server's scene its new sharing state, when it changed. */
    private publishShare(serverId: string): void {
        const share = toSceneShareState(getActiveServerRegistry().getServer(serverId)?.remoteAccess);
        for (const [id, scene] of this.scenes) {
            const contents = webContents.fromId(id);
            if (scene.serverId === serverId && contents && !contents.isDestroyed() && !sameShareState(scene.share, share)) {
                this.sendShare(contents, scene, share);
            }
        }
    }

    private sendShare(contents: WebContents, scene: WindowScene, share: SceneShareState): void {
        scene.share = share;
        contents.send(IPC_EVENTS.analysisSceneShareChanged, { url: scene.url, share } satisfies SceneShareEvent);
    }

    /**
     * The core keeps each analysis's files in the workspace storage, which VS
     * Code gives per workspace. The IDE's is a folder per project under its
     * own storage, named by a hash of the project's path.
     */
    private contextFor(folder: string): CoreContext {
        const id = createHash('sha256').update(path.resolve(folder)).digest('hex').slice(0, 16);
        return { ...this.context, storageUri: { fsPath: path.join(this.context.globalStorageUri.fsPath, 'workspaces', id) } };
    }

    private async open(serverUrl: string, serverId: string): Promise<void> {
        const win = this.owner && !this.owner.isDestroyed()
            ? this.owner
            : BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (!win) {
            return;
        }
        const previous = this.scenes.get(win.webContents.id);
        previous?.unwatch();
        const server = getActiveServerRegistry().getServer(serverId);
        const share = toSceneShareState(server?.remoteAccess);
        const files = await readAnalysedFileCount(server?.htmlFile);
        const contents = win.webContents;
        const unwatch = watchAnalysedFileCount(server?.htmlFile, files, (count) => {
            if (!contents.isDestroyed()) {
                contents.send(IPC_EVENTS.analysisSceneFilesChanged, { url: serverUrl, files: count } satisfies SceneFilesEvent);
            }
        });
        win.once('closed', unwatch);
        this.scenes.set(win.webContents.id, { folder: this.ownerFolder, kind: this.ownerKind, serverId, url: serverUrl, share, unwatch });
        if (previous && previous.serverId !== serverId) {
            // A new analysis replaces the window's scene; its old server (and tunnel) has nothing left to show.
            void this.stopTunnel(previous.serverId);
            if (getActiveServerRegistry().getServer(previous.serverId)) {
                void ServerControl.stopServer(previous.serverId, { silent: true }).catch(() => undefined);
            }
        }
        const scene: SceneInfo = {
            url: serverUrl,
            title: sceneTitle(this.ownerFolder),
            kind: this.ownerKind,
            target: targetName(this.ownerFolder),
            targetPath: this.ownerFolder,
            files,
            share,
        };
        win.webContents.send(IPC_EVENTS.analysisSceneOpened, scene);
        // #173: the Problems panel measures the functions of the folder the scene shows.
        if (this.ownerFolder) {
            this.hooks.sceneOpened?.(win.webContents, this.ownerFolder);
        }
        await showScene(win, serverUrl);
    }
}
