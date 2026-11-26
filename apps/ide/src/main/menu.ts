import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { IPC_EVENTS, type IdeCommand } from '../shared/api.ts';
import { clearRecentFolders, openRecentFromMenu } from './workspace/workspaceWindows.ts';

/** What Help > About shows of the IDE's dependencies (#161), set once the core runs. */
export interface AboutDependencies {
    describe(): Promise<{ readonly text: string; readonly repairable: boolean }>;
    repair(): void;
}

let aboutDependencies: AboutDependencies | null = null;

export function setAboutDependencies(source: AboutDependencies): void {
    aboutDependencies = source;
}

async function showAbout(win: BrowserWindow | undefined): Promise<void> {
    const versions = `Electron ${process.versions.electron}\nChromium ${process.versions.chrome}\nNode.js ${process.versions.node}`;
    let dependencies = '';
    let repairable = false;
    if (aboutDependencies) {
        try {
            const described = await aboutDependencies.describe();
            dependencies = `\n\nDependencies\n${described.text}`;
            repairable = described.repairable;
        } catch (error) {
            dependencies = `\n\nDependencies\nCould not be checked: ${String(error)}`;
        }
    }
    const options = {
        type: 'info' as const,
        title: 'About Code-XR IDE',
        message: `Code-XR IDE ${app.getVersion()}`,
        detail: `${versions}${dependencies}\n\nLicensed under GPL-3.0.`,
        buttons: repairable ? ['OK', 'Install missing dependencies'] : ['OK'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
    };
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (response === 1) {
        aboutDependencies?.repair();
    }
}

/**
 * The application menu. File > Open Folder… arrived with #14; Edit and View
 * keep the standard roles until the command palette (#18).
 */
export function installApplicationMenu(isDevelopment: boolean, recentFolders: readonly string[] = []): void {
    const isMac = process.platform === 'darwin';
    const template: MenuItemConstructorOptions[] = [
        ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
        {
            label: 'File',
            submenu: [
                {
                    label: 'Open Folder…',
                    accelerator: 'CmdOrCtrl+O',
                    // The renderer asks first if editors hold unsaved changes, then opens the picker.
                    click: (_item, win) => sendCommand(win, 'workspace.openFolder'),
                },
                { label: 'Open Recent', submenu: recentSubmenu(recentFolders) },
                { type: 'separator' },
                { label: 'New File…', accelerator: 'CmdOrCtrl+N', click: (_item, win) => sendCommand(win, 'file.newFile') },
                { label: 'New Folder…', click: (_item, win) => sendCommand(win, 'file.newFolder') },
                { type: 'separator' },
                { label: 'Save', accelerator: 'CmdOrCtrl+S', click: (_item, win) => sendCommand(win, 'file.save') },
                { label: 'Save All', accelerator: 'CmdOrCtrl+Alt+S', click: (_item, win) => sendCommand(win, 'file.saveAll') },
                { type: 'separator' },
                { label: 'Close Editor', accelerator: 'CmdOrCtrl+W', click: (_item, win) => sendCommand(win, 'editor.close') },
                isMac ? { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' } : { role: 'quit' },
            ],
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [
                // #18: every action, by name. The accelerator lives here so it also works while the
                // terminal or the scene view has the focus; F1 is the workbench's own alias.
                { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: (_item, win) => sendCommand(win, 'workbench.commandPalette') },
                { type: 'separator' },
                ...(isDevelopment
                    ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[])
                    : []),
                // #137: the renderer owns the panel; Ctrl+` on every OS, as in VS Code.
                { label: 'Terminal', accelerator: 'Ctrl+`', click: (_item, win) => sendCommand(win, 'terminal.toggle') },
                { label: 'New Terminal', accelerator: 'Ctrl+Shift+`', click: (_item, win) => sendCommand(win, 'terminal.new') },
                { label: 'Close Terminal Panel', click: (_item, win) => sendCommand(win, 'terminal.closePanel') },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        {
            label: 'Go',
            submenu: [
                { label: 'Go to File…', accelerator: 'CmdOrCtrl+P', click: (_item, win) => sendCommand(win, 'workbench.quickOpen') },
                { label: 'Go to Symbol in Editor…', accelerator: 'CmdOrCtrl+Shift+O', click: (_item, win) => sendCommand(win, 'editor.goToSymbol') },
                { label: 'Go to Line/Column…', accelerator: 'Ctrl+G', click: (_item, win) => sendCommand(win, 'editor.goToLine') },
            ],
        },
        { role: 'windowMenu' },
        {
            role: 'help',
            submenu: [
                {
                    label: 'About Code-XR IDE',
                    // #161: the dependencies and their state, with a way to install what is missing.
                    click: (_item, win) => void showAbout(win instanceof BrowserWindow ? win : undefined),
                },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function recentSubmenu(folders: readonly string[]): MenuItemConstructorOptions[] {
    if (folders.length === 0) {
        return [{ label: 'No Recent Folders', enabled: false }];
    }
    return [
        ...folders.map((folder): MenuItemConstructorOptions => ({
            label: folder,
            click: (_item, win) => {
                const target = win instanceof BrowserWindow ? win : BrowserWindow.getFocusedWindow();
                if (target) { void openRecentFromMenu(target, folder); }
            },
        })),
        { type: 'separator' },
        { label: 'Clear Recently Opened', click: () => void clearRecentFolders() },
    ];
}

/** Menu commands the renderer runs (it owns the editors and their unsaved state). */
function sendCommand(win: unknown, command: IdeCommand): void {
    const target = win instanceof BrowserWindow ? win : BrowserWindow.getFocusedWindow();
    target?.webContents.send(IPC_EVENTS.command, command);
}
