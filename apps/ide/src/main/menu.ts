import { app, dialog, Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * The application menu. Only standard roles for now: File, Edit and View get
 * their real commands with the editor (#14) and the command palette (#18).
 */
export function installApplicationMenu(isDevelopment: boolean): void {
    const isMac = process.platform === 'darwin';
    const template: MenuItemConstructorOptions[] = [
        ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
        { label: 'File', submenu: [isMac ? { role: 'close' } : { role: 'quit' }] },
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
