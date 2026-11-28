import { BrowserWindow, clipboard, webContents, type WebContents } from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AnalysisOrchestrator } from '@codexr/core/analysis/analysisOrchestrator';
import { AnalysisConfigurationStorage } from '@codexr/core/analysis/configuration/analysisConfigurationStorage';
import { analysisRefreshCoordinator } from '@codexr/core/analysis/refresh/analysisRefreshCoordinator';
import { UnifiedSessionRegistry } from '@codexr/core/analysis/session/sessionRegistry';
import { SessionWatcherManager } from '@codexr/core/analysis/watchers/sessionWatcherManager';
import { CollaborationProfileManager } from '@codexr/core/collaboration/collaborationProfileManager';
import { getHost } from '@codexr/core/host/hostRegistry';
import { EXTENSION_MODE, type CoreContext } from '@codexr/core/host/hostPaths';
import type { HostDisposable } from '@codexr/core/host/codeXRHost';
import { setLaunchNotifier } from '@codexr/core/server/launchNotifier';
import { RemoteAccessManager } from '@codexr/core/remote-access/remoteAccessManager';
import { revealInScene } from '@codexr/core/server/analysis/sceneReveal';
import { drillDownInScenes } from '@codexr/core/server/analysis/sceneDrillDown';
import { getActiveServerRegistry } from '@codexr/core/server/registry/activeServerRegistry';
import { ServerControl } from '@codexr/core/server/serverControl';
import { ServerSettingsManager } from '@codexr/core/server/serverSettingsManager';
import { AUTO_START_MODES, FILE_ANALYSIS_KINDS, IPC_EVENTS, type AnalysisKind, type AnalysisStartResult, type AutoStartMode, type EnterXrResult, type FileAnalysisKind, type ProjectAnalysisKind, type SceneAddress, type SceneInfo, type SceneFilesEvent, type SceneShareEvent, type SceneShareState } from '../../shared/api.ts';
import { channelLog } from '../log.ts';
import type { PythonEnvironmentService } from '../python/pythonEnvironment.ts';
import { resolveInWorkspace } from '../workspace/workspacePath.ts';
import { readAnalysedFileCount, watchAnalysedFileCount } from './analysedFiles.ts';
import { readMetrics, type FileMetrics } from '../agents/tools/analysisQueries.ts';
import { computeMetricDelta, type MetricDeltaReport } from './metricDelta.ts';
import { followRefreshes, waitUntilSettled, type RefreshPort, type SceneUpdatedEvent, type SettleResult } from './sceneRefresh.ts';
import { closeScene, enterSceneXr, sceneSupportsImmersiveXr, showScene } from './sceneView.ts';
import { unsupportedXrMessage } from './sceneXrPolicy.ts';
import { sceneTargetToWorkspacePath } from './sceneEditorTarget.ts';
import type { SceneEditorTarget } from '../../shared/sceneBridge.ts';
import { localSceneOrigin, sceneTitle, targetName } from './sceneUrl.ts';
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

/** AF9: how long a turn's delta waits for the core's re-analysis to catch up with the disk. */
const DEFAULT_SETTLE_TIMEOUT_MS = 60_000;
/**
 * AF9: a change the core's own watcher is still hashing has updated its file
 * tracker but not yet queued its refresh; a short pause after our reconcile
 * lets that refresh be queued before "settled" is read.
 */
const RECONCILE_GRACE_MS = 250;

/** Why a scene could not be brought up to date with the disk. */
export type SceneSettleResult = SettleResult | 'no-scene' | 'not-following';

const NO_WORKSPACE: AnalysisStartResult = { ok: false, reason: 'no-workspace', message: 'Open a folder first.' };

function isFileKind(kind: AnalysisKind): kind is FileAnalysisKind {
    return (FILE_ANALYSIS_KINDS as readonly string[]).includes(kind);
}

/** The analysis a window is showing: its folder, and the core server that serves it. */
interface WindowScene {
    /** The window's open folder when the analysis ran. */
    readonly folder: string;
    readonly kind: AnalysisKind;
    /** What was analysed: the folder itself, or one file of it. */
    readonly target: string;
    readonly serverId: string;
    /** The core's analysis session behind the server (AF8), when the registry names it. */
    readonly sessionId: string | undefined;
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
    private ownerTarget = '';
    /** #155: analysis launches and share requests never overlap (see `startShareOnce`). */
    private readonly launches = new SerialQueue();
    /** Per window (by webContents id): the scene it last opened. */
    private readonly scenes = new Map<number, WindowScene>();
    private readonly python: PythonEnvironmentService;
    private readonly hooks: { sceneOpened?(contents: WebContents, folder: string): void };
    /** AF8: who hears that a window's scene was re-analysed after a change on disk. */
    private readonly updateListeners = new Set<(contents: WebContents, event: SceneUpdatedEvent) => void>();

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
     * AF8: whether an open scene follows changes on disk (the core's
     * auto-analysis setting, shared with the extension; on by default). The
     * core reads it on every change, so turning it off takes effect at once;
     * turning it on reaches a scene launched while it was off only when that
     * scene is analysed again (the core starts no watcher for it).
     */
    async followsChanges(): Promise<boolean> {
        return AnalysisConfigurationStorage.getInstance(this.context).getAutoAnalysisEnabled();
    }

    async setFollowsChanges(enabled: boolean): Promise<boolean> {
        await AnalysisConfigurationStorage.getInstance(this.context).setAutoAnalysisEnabled(enabled);
        return enabled;
    }

    /**
     * AF8: `listener` hears each re-analysis of a window's scene that a change
     * on disk caused (the editor's save, a terminal, an agent). Returns the
     * function that stops it.
     */
    onSceneUpdated(listener: (contents: WebContents, event: SceneUpdatedEvent) => void): () => void {
        this.updateListeners.add(listener);
        return () => this.updateListeners.delete(listener);
    }

    /**
     * AF9: brings the window's scene up to date with the disk: asks the core
     * to compare the folder with its last analysis now (not waiting for the
     * file watcher), then waits for the refresh it queued. Never throws.
     */
    async settleScene(contents: WebContents, timeoutMs = DEFAULT_SETTLE_TIMEOUT_MS): Promise<SceneSettleResult> {
        const scene = this.scenes.get(contents.id);
        if (!scene?.sessionId || !getActiveServerRegistry().getServer(scene.serverId)) {
            return 'no-scene';
        }
        const { sessionId } = scene;
        try {
            if (!await this.followsChanges()) {
                return 'not-following';
            }
            await SessionWatcherManager.reconcileSession(sessionId);
        } catch (error) {
            log.warn(`Could not reconcile the analysis of ${scene.target}: ${String(error)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, RECONCILE_GRACE_MS));
        return waitUntilSettled(refreshPort(sessionId), timeoutMs);
    }

    /**
     * AF9: the metric records of the window's project scene (one per analysed
     * file), or null without one. Taken at the start of an agent's turn, they
     * are the `before` of `turnMetricDelta`.
     */
    async sceneMetrics(contents: WebContents): Promise<FileMetrics[] | null> {
        const scene = this.scenes.get(contents.id);
        const dir = this.outputDirectory(contents);
        // A single file's analysis records its functions, not files: no per-file delta there.
        if (!scene || !dir || isFileKind(scene.kind)) {
            return null;
        }
        try {
            return await readMetrics(dir);
        } catch {
            return null;
        }
    }

    /**
     * AF9: what a turn did to the measurements: waits for the scene to catch
     * up with the disk, then compares its records with `before` (from
     * `sceneMetrics` at the turn's start). `changedPaths` are relative to the
     * window's folder (the folder a project scene analyses).
     */
    async turnMetricDelta(
        contents: WebContents,
        before: readonly FileMetrics[] | null,
        changedPaths?: readonly string[] | null,
        options: { readonly timeoutMs?: number } = {},
    ): Promise<{ readonly settle: SceneSettleResult; readonly report: MetricDeltaReport }> {
        const settle = await this.settleScene(contents, options.timeoutMs);
        return { settle, report: computeMetricDelta(before, await this.sceneMetrics(contents), changedPaths) };
    }

    /**
     * `auto` marks an analysis the person did not click for (#139, a folder
     * just opened). It reuses a scene that is still being served for the same
     * folder. It never asks first, whatever the project's size (#203): the
     * scene's header then says how many files the analysis took.
     */
    async analyseProject(win: BrowserWindow, folder: string | undefined, kind: ProjectAnalysisKind, options: { auto?: boolean } = {}): Promise<AnalysisStartResult> {
        const refused = await this.refusal(folder);
        if (refused || !folder) {
            return refused ?? NO_WORKSPACE;
        }
        const running = this.scenes.get(win.webContents.id);
        if (options.auto && running && running.target === folder && getActiveServerRegistry().getServer(running.serverId)) {
            this.setOwner(win, folder, running.kind, folder);
            await this.open(running.url, running.serverId);
            return { ok: true };
        }
        const mode = kind === 'livepanel-deep' ? 'LivePanel' : 'XR';
        return this.launch(win, folder, kind, folder, (context) => AnalysisOrchestrator.orchestrateAnalysis(folder, mode, 'directory', context, true));
    }

    /**
     * Analyses one file of the window's folder (#16), named by its workspace
     * path: the same launches as the extension's explorer menu.
     */
    async analyseFile(win: BrowserWindow, folder: string | undefined, kind: FileAnalysisKind, relativePath: unknown): Promise<AnalysisStartResult> {
        const refused = await this.refusal(folder);
        if (refused || !folder) {
            return refused ?? NO_WORKSPACE;
        }
        const file = resolveInWorkspace(folder, relativePath);
        const mode = kind === 'livepanel-file' ? 'LivePanel' : 'XR';
        return this.launch(win, folder, kind, file, (context) => AnalysisOrchestrator.orchestrateAnalysis(file, mode, 'file', context, false));
    }

    /** Why an analysis cannot start, or null: nothing is queued and nothing is downloaded from here. */
    private async refusal(folder: string | undefined): Promise<AnalysisStartResult | null> {
        if (!folder) {
            return NO_WORKSPACE;
        }
        const status = await this.python.status();
        return status.state === 'ready'
            ? null
            : { ok: false, reason: 'python-not-ready', message: 'Set up the Python environment first (Analysis view).' };
    }

    private setOwner(win: BrowserWindow, folder: string, kind: AnalysisKind, target: string): void {
        this.owner = win;
        this.ownerFolder = folder;
        this.ownerKind = kind;
        this.ownerTarget = target;
    }

    private async launch(win: BrowserWindow, folder: string, kind: AnalysisKind, target: string, run: (context: CoreContext) => Promise<unknown>): Promise<AnalysisStartResult> {
        try {
            await this.ready;
            await this.launches.run(async () => {
                this.setOwner(win, folder, kind, target);
                await run(this.contextFor(folder));
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

    /**
     * #178: marks a file of the open folder in this window's scene (the same
     * core call as the extension's "Reveal in XR Scene"). False when the
     * window shows no scene, or its analysis does not hold the file.
     */
    revealInScene(contents: WebContents, absolutePath: string): boolean {
        const scene = this.scenes.get(contents.id);
        return scene !== undefined && revealInScene(absolutePath, [scene.serverId]) > 0;
    }

    /**
     * #339: switches this window's scene to the analysis of a file or folder,
     * in place (drill-down, #333; the same core call as the extension's
     * "Analyze in XR Scene"). False when the window shows no scene, or the
     * path is outside what its scene can explore.
     */
    analyzeInScene(contents: WebContents, absolutePath: string): boolean {
        const scene = this.scenes.get(contents.id);
        return scene !== undefined && drillDownInScenes(absolutePath, [scene.serverId]) > 0;
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
     * #19: enters the window's scene in XR on a headset tethered to this
     * computer. Without one (Chromium sees no XR runtime), says what to do
     * instead rather than failing silently.
     */
    async enterXr(win: BrowserWindow): Promise<EnterXrResult> {
        const scene = this.liveScene(win);
        if (scene.kind.startsWith('livepanel')) {
            return { ok: false, reason: 'failed', message: 'A LivePanel is a 2D page: analyse in XR to enter a scene.' };
        }
        if (!await sceneSupportsImmersiveXr(win)) {
            return { ok: false, reason: 'unsupported', message: unsupportedXrMessage(process.platform) };
        }
        try {
            await enterSceneXr(win);
            return { ok: true };
        } catch (error) {
            log.error('Entering XR failed', error);
            return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) };
        }
    }

    /** #19: the scene's local address in the system browser (only ever a local Code-XR server). */
    async openSceneInBrowser(win: BrowserWindow, openExternal: (url: string) => Promise<void>): Promise<void> {
        const scene = this.liveScene(win);
        if (!localSceneOrigin(scene.url)) {
            throw new Error('This scene is not served locally.');
        }
        await openExternal(authenticatedSceneUrl(scene.serverId, scene.url));
    }

    /** #19: the invitation link a standalone headset opens, or null while the scene is not shared. */
    headsetLink(win: BrowserWindow): string | null {
        const scene = this.liveScene(win);
        const invitation = getActiveServerRegistry().getServer(scene.serverId)?.remoteAccess?.invitationUrl;
        return isQuickTunnelUrl(invitation) ? invitation : null;
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
        const analysedFolder = isFileKind(scene.kind) ? path.dirname(scene.target) : scene.target;
        const relative = sceneTargetToWorkspacePath(workspaceRoot, analysedFolder, target.path);
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

    /** The core's analysis session a server serves: named in its registration, else found by server id. */
    private sessionOf(serverId: string): string | undefined {
        const named = getActiveServerRegistry().getServer(serverId)?.metadata?.sessionId;
        if (typeof named === 'string' && named) {
            return named;
        }
        return UnifiedSessionRegistry.getInstance(this.context).getAllSessions().find((session) => session.serverId === serverId)?.id;
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
        // A single file's analysis records its functions, not files: its count is 1 and never changes.
        const single = isFileKind(this.ownerKind);
        const files = single ? 1 : await readAnalysedFileCount(server?.htmlFile);
        const contents = win.webContents;
        const unwatchCount = watchAnalysedFileCount(single ? undefined : server?.htmlFile, files, (count) => {
            if (!contents.isDestroyed()) {
                contents.send(IPC_EVENTS.analysisSceneFilesChanged, { url: serverUrl, files: count } satisfies SceneFilesEvent);
            }
        });
        const sessionId = this.sessionOf(serverId);
        // AF8: each finished re-analysis of this scene, for whoever listens.
        const unfollow = sessionId
            ? followRefreshes(refreshPort(sessionId), (revision) => {
                void readAnalysedFileCount(single ? undefined : server?.htmlFile).then((count) => {
                    if (contents.isDestroyed()) {
                        return;
                    }
                    const event: SceneUpdatedEvent = count === undefined ? { url: serverUrl, revision } : { url: serverUrl, revision, files: count };
                    for (const listener of this.updateListeners) {
                        listener(contents, event);
                    }
                });
            })
            : () => undefined;
        const unwatch = (): void => {
            unwatchCount();
            unfollow();
        };
        win.once('closed', unwatch);
        this.scenes.set(win.webContents.id, { folder: this.ownerFolder, kind: this.ownerKind, target: this.ownerTarget, serverId, sessionId, url: serverUrl, share, unwatch });
        if (previous && previous.serverId !== serverId) {
            // A new analysis replaces the window's scene; its old server (and tunnel) has nothing left to show.
            void this.stopTunnel(previous.serverId);
            if (getActiveServerRegistry().getServer(previous.serverId)) {
                void ServerControl.stopServer(previous.serverId, { silent: true }).catch(() => undefined);
            }
        }
        const scene: SceneInfo = {
            url: serverUrl,
            title: sceneTitle(this.ownerTarget, this.ownerKind.startsWith('livepanel') ? 'LivePanel' : 'XR'),
            kind: this.ownerKind,
            target: targetName(this.ownerTarget),
            targetPath: this.ownerTarget,
            files,
            share,
        };
        win.webContents.send(IPC_EVENTS.analysisSceneOpened, scene);
        // #173: the Problems panel measures the functions of the folder the scene shows.
        if (this.ownerFolder && !isFileKind(this.ownerKind)) {
            this.hooks.sceneOpened?.(win.webContents, this.ownerFolder);
        }
        await showScene(win, authenticatedSceneUrl(serverId, serverUrl));
    }
}

/**
 * The scene's address with a one-time token that signs the person in as
 * themselves (their Code-XR name and colour), the way the extension opens
 * it. The raw address joined the room under a random name (COLLAB-IDE-3).
 * The token is single use, so a new one is made for each opening.
 */
function authenticatedSceneUrl(serverId: string, url: string): string {
    const instance = getActiveServerRegistry().getServer(serverId)?.serverInstance;
    try {
        return typeof instance?.createAuthenticatedBrowserUrl === 'function'
            ? instance.createAuthenticatedBrowserUrl(url)
            : url;
    } catch (error) {
        log.warn(`Scene sign-in link failed, opening the plain address: ${String(error)}`);
        return url;
    }
}

/** The core's refresh state of one analysis session, as `sceneRefresh.ts` reads it. */
function refreshPort(sessionId: string): RefreshPort {
    return {
        view: () => analysisRefreshCoordinator.getViewState(sessionId),
        onChange: (listener) => analysisRefreshCoordinator.onStateChanged(sessionId, () => listener()),
    };
}
