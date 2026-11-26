import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { IPC_EVENTS, type IdeCommand } from '../shared/api.ts';

/**
 * The application menu. File > Open Folder… arrived with #14; Edit and View
 * keep the standard roles until the command palette (#18).
 */
export function installApplicationMenu(isDevelopment: boolean): void {
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

/** Menu commands the renderer runs (it owns the editors and their unsaved state). */
function sendCommand(win: unknown, command: IdeCommand): void {
    const target = win instanceof BrowserWindow ? win : BrowserWindow.getFocusedWindow();
    target?.webContents.send(IPC_EVENTS.command, command);
}
