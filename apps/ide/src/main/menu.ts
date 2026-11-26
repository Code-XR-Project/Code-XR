import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { IPC_EVENTS, type IdeCommand } from '../shared/api.ts';
import { clearRecentFolders, openRecentFromMenu } from './workspace/workspaceWindows.ts';

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
        { role: 'windowMenu' },
        {
            role: 'help',
            submenu: [
                {
                    label: 'About Code-XR IDE',
                    click: () => {
                        void dialog.showMessageBox({
                            type: 'info',
                            title: 'About Code-XR IDE',
                            message: `Code-XR IDE ${app.getVersion()}`,
                            detail: `Electron ${process.versions.electron}\nChromium ${process.versions.chrome}\nNode.js ${process.versions.node}\n\nLicensed under GPL-3.0.`,
                        });
                    },
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
