import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getHost, initializeHost } from '@codexr/core/host/hostRegistry';
import { setServerBindHost } from '@codexr/core/server/serverBindHost';
import { IPC_EVENTS, type HostNotification, type ProgressEvent } from '../../shared/api.ts';
import { createElectronHost } from './electronHost.ts';
import { PythonEnvironmentService } from '../python/pythonEnvironment.ts';
import { AnalysisService } from '../analysis/analysisService.ts';
import { FunctionMetricsService } from '../problems/functionMetricsService.ts';
import { installRoot as extensionInstallRoot } from '../appIcon.ts';
import { setSceneLibrariesDir } from '../analysis/sceneView.ts';
import { CloudflaredService } from '../dependencies/cloudflaredService.ts';
import { setFolderChangeListener } from '../workspace/workspaceWindows.ts';
import type { HostDisposable } from '@codexr/core/host/codeXRHost';

/**
 * Starts the extension's core inside the IDE (#15): registers the Electron
 * host, then the services built on the core. Everything the core reports is
 * broadcast to every window; each view keeps what concerns it.
 */
export interface CoreServices {
    readonly python: PythonEnvironmentService;
    readonly analysis: AnalysisService;
    /** The program behind "Share through Cloudflare", installed with the IDE's dependencies (#160). */
    readonly cloudflared: CloudflaredService;
    /** #173: the per-function metrics of each window's analysed folder (the Problems panel). */
    readonly metrics: FunctionMetricsService;
}

/** Disposed when the app quits: what the core registered (collaboration profiles...). */
const subscriptions: HostDisposable[] = [];

export function startCore(options: { readonly isSmoke: boolean }): CoreServices {
    // The smoke run must leave no trace in the person's profile (nor in the temp folder).
    const storageDir = options.isSmoke
        ? fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-smoke-core-'))
        : path.join(app.getPath('userData'), 'core');
    if (options.isSmoke) {
        process.once('exit', () => fs.rmSync(storageDir, { recursive: true, force: true }));
    }
    const installRoot = extensionInstallRoot();

    let python: PythonEnvironmentService | null = null;
    // The IDE serves its scenes over plain HTTP: keep them off the LAN, where
    // they would be reachable without pairing and never a secure context.
    // Guests and headsets come in through the tunnel (COLLAB-IDE-2, #366).
    setServerBindHost('127.0.0.1');
    initializeHost(createElectronHost({
        storageDir,
        installRoot,
        mode: app.isPackaged ? 'production' : 'development',
        events: {
            notify: (severity, message) => broadcast(IPC_EVENTS.hostNotification, { severity, message } satisfies HostNotification),
            progress: (update) => {
                broadcast(IPC_EVENTS.progress, update satisfies ProgressEvent);
                if (!update.done) {
                    python?.reportProgress(update.message ?? update.title, update.percent);
                }
            },
        },
    }));
    python = new PythonEnvironmentService(storageDir, (status) => broadcast(IPC_EVENTS.pythonStatusChanged, status));
    // The vendored copies of the scene's CDN libraries (analysis/sceneLibraries.ts); #20 packages them.
    setSceneLibrariesDir(path.join(installRoot, 'test', 'vendor', 'scene-libraries'));
    const metrics = new FunctionMetricsService(python);
    const analysis = new AnalysisService(python, subscriptions, { sceneOpened: (contents, folder) => metrics.analyse(contents, folder) });
    const cloudflared = new CloudflaredService({ globalStorageUri: { fsPath: storageDir }, globalState: getHost().globalState });
    // #139: a window that opens another folder stops serving the old one's scene.
    setFolderChangeListener((contents, root) => {
        void analysis.folderChanged(contents, root);
        metrics.folderChanged(contents, root);
    });
    app.once('will-quit', () => {
        for (const disposable of subscriptions.splice(0)) {
            disposable.dispose();
        }
    });
    return { python, analysis, cloudflared, metrics };
}

function broadcast(event: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.isDestroyed()) {
            win.webContents.send(event, payload);
        }
    }
}
