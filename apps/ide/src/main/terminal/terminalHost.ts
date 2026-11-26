import { app, BrowserWindow, dialog, type WebContents } from 'electron';
import type * as NodePty from 'node-pty';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC_EVENTS, type TerminalCreated, type TerminalProfileList } from '../../shared/api.ts';
import { JsonKeyValueStore } from '../core/jsonStore.ts';
import { log } from '../log.ts';
import { currentWorkspaceInfo } from '../workspace/workspaceWindows.ts';
import { memoryStore, ProfileRegistry } from './profileRegistry.ts';
import { splitArgs } from './shellProfiles.ts';
import { TerminalService, type PtyProcess, type SpawnOptions } from './terminalService.ts';

/**
 * Wires the terminal (#137) into Electron: node-pty, the settings file, the
 * Windows registry, native dialogs, and the lifetime of each window's ptys.
 * The logic it wires is in `shellProfiles.ts`, `profileRegistry.ts` and
 * `terminalService.ts`, which are unit-tested.
 */
export interface TerminalHost {
    profiles(): Promise<TerminalProfileList>;
    setDefaultProfile(id: unknown): Promise<TerminalProfileList>;
    addCustomProfile(contents: WebContents, args: unknown): Promise<TerminalProfileList>;
    removeCustomProfile(id: unknown): Promise<TerminalProfileList>;
    create(contents: WebContents, profileId: unknown, cols: unknown, rows: unknown): Promise<TerminalCreated>;
    input(contents: WebContents, id: unknown, data: unknown): void;
    resize(contents: WebContents, id: unknown, cols: unknown, rows: unknown): void;
    kill(contents: WebContents, id: unknown): void;
    killAll(): Promise<void>;
}

type NodePtyModule = typeof NodePty;
let nodePty: Promise<NodePtyModule> | undefined;

/**
 * node-pty is a native module, kept out of the bundle (scripts/viteConfigs.mjs)
 * and loaded on the first terminal, so a broken native build costs the
 * terminal and not the whole IDE.
 */
async function spawnPty(file: string, args: readonly string[], options: SpawnOptions): Promise<PtyProcess> {
    nodePty ??= import('node-pty').then((loaded) => {
        const candidate = loaded as NodePtyModule & { default?: NodePtyModule };
        return typeof candidate.spawn === 'function' ? candidate : (candidate.default ?? candidate);
    });
    const pty = await nodePty;
    return pty.spawn(file, [...args], {
        name: options.name,
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
    });
}

/** `reg query` for one value; undefined when the key or value is missing. */
function readRegistry(key: string, value: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        execFile('reg.exe', ['query', key, '/v', value], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
            if (error) {
                resolve(undefined);
                return;
            }
            const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith(value));
            const match = line?.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/);
            resolve(match?.[1]?.trim());
        });
    });
}

function isExecutableFile(file: string): Promise<boolean> {
    return fs.promises.stat(file).then((stat) => stat.isFile(), () => false);
}

export function createTerminalHost(options: { readonly isSmoke: boolean }): TerminalHost {
    const store = options.isSmoke ? memoryStore() : new JsonKeyValueStore(path.join(app.getPath('userData'), 'terminal-settings.json'));
    const registry = new ProfileRegistry(store, {
        platform: process.platform,
        env: process.env,
        exists: isExecutableFile,
        ...(process.platform === 'win32' ? { readRegistry } : {}),
    });
    const service = new TerminalService({
        spawn: spawnPty,
        resolveProfile: (id) => registry.resolve(id),
        env: process.env,
        dataChannel: IPC_EVENTS.terminalData,
        exitChannel: IPC_EVENTS.terminalExit,
    });

    // A window's ptys die with it: closed, crashed, or reloaded (a reloaded
    // page has lost its terminals' views, so their shells would be orphans).
    const tracked = new Set<number>();
    const track = (contents: WebContents): void => {
        if (tracked.has(contents.id)) {
            return;
        }
        const id = contents.id;
        tracked.add(id);
        contents.once('destroyed', () => {
            service.killOwnedBy(id);
            tracked.delete(id);
        });
        contents.on('render-process-gone', () => service.killOwnedBy(id));
        contents.on('did-navigate', () => service.killOwnedBy(id));
    };

    return {
        profiles: () => registry.list(),
        setDefaultProfile: (id) => registry.setDefault(id),
        removeCustomProfile: (id) => registry.removeCustom(id),
        async addCustomProfile(contents, argsText) {
            if (typeof argsText !== 'string' || argsText.length > 8192) {
                throw new Error('Invalid arguments.');
            }
            const args = splitArgs(argsText);
            const owner = BrowserWindow.fromWebContents(contents);
            const pick = { title: 'Choose a shell executable', properties: ['openFile' as const] };
            const picked = owner ? await dialog.showOpenDialog(owner, pick) : await dialog.showOpenDialog(pick);
            const [file] = picked.filePaths;
            if (picked.canceled || !file) {
                return registry.list();
            }
            // The arguments came from the page: the person confirms the exact
            // command line here, in a dialog the page cannot answer.
            const commandLine = [file, ...args].map((part) => (/\s|^$/.test(part) ? `"${part}"` : part)).join(' ');
            const confirm = {
                type: 'question' as const,
                title: 'Add terminal profile',
                message: 'Save this terminal profile?',
                detail: `New terminals started from it will run:\n\n${commandLine}`,
                buttons: ['Save Profile', 'Cancel'],
                defaultId: 0,
                cancelId: 1,
                noLink: true,
            };
            const { response } = owner ? await dialog.showMessageBox(owner, confirm) : await dialog.showMessageBox(confirm);
            if (response !== 0) {
                return registry.list();
            }
            log.info(`Saved terminal profile ${commandLine}`);
            return registry.addCustom(file, args);
        },
        async create(contents, profileId, cols, rows) {
            track(contents);
            const cwd = currentWorkspaceInfo(contents)?.root ?? os.homedir();
            const created = await service.create(contents, profileId, cols, rows, cwd);
            log.info(`Terminal ${created.id}: ${created.profile.name} in ${cwd}`);
            return created;
        },
        input: (contents, id, data) => service.input(contents, id, data),
        resize: (contents, id, cols, rows) => service.resize(contents, id, cols, rows),
        kill: (contents, id) => service.kill(contents, id),
        killAll: () => service.killAll(),
    };
}
