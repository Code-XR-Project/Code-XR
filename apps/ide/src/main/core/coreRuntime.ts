import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeHost } from '@codexr/core/host/hostRegistry';
import { IPC_EVENTS, type HostNotification } from '../../shared/api.ts';
import { createElectronHost } from './electronHost.ts';
import { PythonEnvironmentService } from '../python/pythonEnvironment.ts';

/**
 * Starts the extension's core inside the IDE (#15): registers the Electron
 * host, then the services built on the core. Everything the core reports is
 * broadcast to every window; each view keeps what concerns it.
 */
export interface CoreServices {
    readonly python: PythonEnvironmentService;
}

export function startCore(options: { readonly isSmoke: boolean }): CoreServices {
    // The smoke run must leave no trace in the person's profile (nor in the temp folder).
    const storageDir = options.isSmoke
        ? fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-smoke-core-'))
        : path.join(app.getPath('userData'), 'core');
    if (options.isSmoke) {
        process.once('exit', () => fs.rmSync(storageDir, { recursive: true, force: true }));
    }
    // Unpackaged, out/main/index.cjs sits in apps/ide: the extension package is apps/vscode-extension.
    const installRoot = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..', '..', 'vscode-extension');

    let python: PythonEnvironmentService | null = null;
    initializeHost(createElectronHost({
        storageDir,
        installRoot,
        mode: app.isPackaged ? 'production' : 'development',
        events: {
            notify: (severity, message) => broadcast(IPC_EVENTS.hostNotification, { severity, message } satisfies HostNotification),
            progress: (update) => {
                if (!update.done) {
                    python?.reportProgress(update.message ?? update.title, update.percent);
                }
            },
        },
    }));
    python = new PythonEnvironmentService(storageDir, (status) => broadcast(IPC_EVENTS.pythonStatusChanged, status));
    return { python };
}

function broadcast(event: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.isDestroyed()) {
            win.webContents.send(event, payload);
        }
    }
}
