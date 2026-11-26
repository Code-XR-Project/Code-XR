import { BrowserWindow, dialog, type WebContents } from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AnalysisOrchestrator } from '@codexr/core/analysis/analysisOrchestrator';
import { AnalysisConfigurationStorage } from '@codexr/core/analysis/configuration/analysisConfigurationStorage';
import { CollaborationProfileManager } from '@codexr/core/collaboration/collaborationProfileManager';
import { getHost } from '@codexr/core/host/hostRegistry';
import { EXTENSION_MODE, type CoreContext } from '@codexr/core/host/hostPaths';
import type { HostDisposable } from '@codexr/core/host/codeXRHost';
import { setLaunchNotifier } from '@codexr/core/server/launchNotifier';
import { getActiveServerRegistry } from '@codexr/core/server/registry/activeServerRegistry';
import { ServerControl } from '@codexr/core/server/serverControl';
import { ServerSettingsManager } from '@codexr/core/server/serverSettingsManager';
import { AUTO_START_MODES, IPC_EVENTS, type AnalysisKind, type AnalysisStartResult, type AutoStartMode, type SceneInfo } from '../../shared/api.ts';
import { log } from '../log.ts';
import type { PythonEnvironmentService } from '../python/pythonEnvironment.ts';
import { countFilesUpTo } from './projectSize.ts';
import { closeScene, showScene } from './sceneView.ts';
import { sceneTitle } from './sceneUrl.ts';

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
/** Above this many files an analysis nobody clicked for asks first. */
export const AUTO_START_FILE_LIMIT = 5000;

/** The analysis a window is showing: its folder, and the core server that serves it. */
interface WindowScene {
    readonly folder: string;
    readonly serverId: string;
    readonly url: string;
}

export class AnalysisService {
    private readonly context: CoreContext;
    private readonly ready: Promise<void>;
    /** The window whose request is launching, so its scene opens there. */
    private owner: BrowserWindow | null = null;
    private ownerFolder = '';
    /** Per window (by webContents id): the scene it last opened. */
    private readonly scenes = new Map<number, WindowScene>();
    private readonly python: PythonEnvironmentService;

    constructor(python: PythonEnvironmentService, subscriptions: HostDisposable[]) {
        this.python = python;
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
     * folder, and asks before analysing a project of more than
     * `AUTO_START_FILE_LIMIT` files.
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
            await this.open(running.url, running.serverId);
            return { ok: true };
        }
        if (options.auto && !(await this.confirmLargeProject(win, folder))) {
            return { ok: false, reason: 'declined', message: 'The automatic analysis was skipped. Start it from the Analysis view.' };
        }
        try {
            await this.ready;
            this.owner = win;
            this.ownerFolder = folder;
            const context = this.contextFor(folder);
            switch (kind) {
                case 'xr-deep':
                    await AnalysisOrchestrator.orchestrateAnalysis(folder, 'XR', 'directory', context, true);
                    break;
            }
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
        const win = contents.isDestroyed() ? null : BrowserWindow.fromWebContents(contents);
        if (win && !win.isDestroyed()) {
            closeScene(win);
        }
        if (getActiveServerRegistry().getServer(previous.serverId)) {
            await ServerControl.stopServer(previous.serverId, { silent: true }).catch((error: unknown) => log.warn(`Could not stop the analysis server of ${previous.folder}: ${String(error)}`));
        }
    }

    private async confirmLargeProject(win: BrowserWindow, folder: string): Promise<boolean> {
        const files = await countFilesUpTo(folder, AUTO_START_FILE_LIMIT);
        if (files <= AUTO_START_FILE_LIMIT) {
            return true;
        }
        const { response } = await dialog.showMessageBox(win, {
            type: 'question',
            buttons: ['Analyse', 'Not now'],
            defaultId: 1,
            cancelId: 1,
            title: 'Analyse this project?',
            message: `This folder has more than ${AUTO_START_FILE_LIMIT.toLocaleString('en')} files.`,
            detail: 'Analysing it in XR can take a while. You can also start it later from the Analysis view, or turn the automatic analysis off there.',
        });
        return response === 0;
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
        this.scenes.set(win.webContents.id, { folder: this.ownerFolder, serverId, url: serverUrl });
        if (previous && previous.serverId !== serverId && getActiveServerRegistry().getServer(previous.serverId)) {
            // A new analysis replaces the window's scene; its old server has nothing left to show.
            void ServerControl.stopServer(previous.serverId, { silent: true }).catch(() => undefined);
        }
        const scene: SceneInfo = { url: serverUrl, title: sceneTitle(this.ownerFolder) };
        win.webContents.send(IPC_EVENTS.analysisSceneOpened, scene);
        await showScene(win, serverUrl);
    }
}
