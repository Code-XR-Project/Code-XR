import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { openFolderFromMenu } from './workspace/workspaceWindows.ts';
import { log } from './log.ts';

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
                    click: (_item, win) => {
                        const target = win instanceof BrowserWindow ? win : BrowserWindow.getFocusedWindow();
                        if (target) {
                            openFolderFromMenu(target).catch((error: unknown) => log.error('Open Folder failed.', error));
                        }
                    },
                },
                { type: 'separator' },
                isMac ? { role: 'close' } : { role: 'quit' },
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
