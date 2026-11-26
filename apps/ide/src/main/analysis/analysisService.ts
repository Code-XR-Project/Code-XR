import { BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AnalysisOrchestrator } from '@codexr/core/analysis/analysisOrchestrator';
import { AnalysisConfigurationStorage } from '@codexr/core/analysis/configuration/analysisConfigurationStorage';
import { CollaborationProfileManager } from '@codexr/core/collaboration/collaborationProfileManager';
import { getHost } from '@codexr/core/host/hostRegistry';
import { EXTENSION_MODE, type CoreContext } from '@codexr/core/host/hostPaths';
import type { HostDisposable } from '@codexr/core/host/codeXRHost';
import { setLaunchNotifier } from '@codexr/core/server/launchNotifier';
import { ServerControl } from '@codexr/core/server/serverControl';
import { ServerSettingsManager } from '@codexr/core/server/serverSettingsManager';
import { IPC_EVENTS, type AnalysisKind, type AnalysisStartResult, type SceneInfo } from '../../shared/api.ts';
import { log } from '../log.ts';
import type { PythonEnvironmentService } from '../python/pythonEnvironment.ts';
import { showScene } from './sceneView.ts';
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
export class AnalysisService {
    private readonly context: CoreContext;
    private readonly ready: Promise<void>;
    /** The window whose request is launching, so its scene opens there. */
    private owner: BrowserWindow | null = null;
    private ownerFolder = '';
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
            handleAutoOpening: (_settings, serverUrl) => this.open(serverUrl),
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

    async analyseProject(win: BrowserWindow, folder: string | undefined, kind: AnalysisKind): Promise<AnalysisStartResult> {
        if (!folder) {
            return { ok: false, reason: 'no-workspace', message: 'Open a folder first.' };
        }
        const status = await this.python.status();
        if (status.state !== 'ready') {
            return { ok: false, reason: 'python-not-ready', message: 'Set up the Python environment first (Analysis view).' };
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
     * The core keeps each analysis's files in the workspace storage, which VS
     * Code gives per workspace. The IDE's is a folder per project under its
     * own storage, named by a hash of the project's path.
     */
    private contextFor(folder: string): CoreContext {
        const id = createHash('sha256').update(path.resolve(folder)).digest('hex').slice(0, 16);
        return { ...this.context, storageUri: { fsPath: path.join(this.context.globalStorageUri.fsPath, 'workspaces', id) } };
    }

    private async open(serverUrl: string): Promise<void> {
        const win = this.owner && !this.owner.isDestroyed()
            ? this.owner
            : BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (!win) {
            return;
        }
        const scene: SceneInfo = { url: serverUrl, title: sceneTitle(this.ownerFolder) };
        win.webContents.send(IPC_EVENTS.analysisSceneOpened, scene);
        await showScene(win, serverUrl);
    }
}
