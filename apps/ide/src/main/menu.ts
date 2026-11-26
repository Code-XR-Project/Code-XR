import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { IPC_EVENTS, type IdeCommand } from '../shared/api.ts';
import { isChord, isValidKeybinding, MENU_KEYBINDINGS } from '../shared/keybindings.ts';
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

/** The accelerators the renderer resolved from the user's keybindings (#18, part 3), by command ID. */
let acceleratorOverrides: Readonly<Record<string, string | null>> = {};
let lastMenu: { readonly isDevelopment: boolean; readonly recentFolders: readonly string[] } | null = null;

/**
 * Takes the menu accelerators the renderer resolved (#18, part 3) and
 * rebuilds the menu if they changed. Only commands the menu owns, and only
 * single-stroke accelerators, are accepted: a chord cannot be a menu key.
 */
export function setMenuAccelerators(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Menu accelerators must be an object.');
    }
    const next: Record<string, string | null> = {};
    for (const [id, accelerator] of Object.entries(value as Record<string, unknown>)) {
        if (!Object.hasOwn(MENU_KEYBINDINGS, id)) {
            continue;
        }
        if (accelerator === null) {
            next[id] = null;
        } else if (typeof accelerator === 'string' && isValidKeybinding(accelerator) && !isChord(accelerator)) {
            next[id] = accelerator;
        }
    }
    if (JSON.stringify(next) === JSON.stringify(acceleratorOverrides)) {
        return;
    }
    acceleratorOverrides = next;
    if (lastMenu) {
        installApplicationMenu(lastMenu.isDevelopment, lastMenu.recentFolders);
    }
}

function acceleratorFor(id: string): string | undefined {
    return Object.hasOwn(acceleratorOverrides, id) ? acceleratorOverrides[id] ?? undefined : MENU_KEYBINDINGS[id];
}

/** A menu item that runs a renderer command, with the command's accelerator (built-in or the user's). */
function command(label: string, id: IdeCommand): MenuItemConstructorOptions {
    const accelerator = acceleratorFor(id);
    return { label, ...(accelerator ? { accelerator } : {}), click: (_item, win) => sendCommand(win, id) };
}

/**
 * The application menu. File > Open Folder… arrived with #14; Edit and View
 * keep the standard roles until the command palette (#18). Command items take
 * their accelerators from `MENU_KEYBINDINGS` and the user's keybindings.
 */
export function installApplicationMenu(isDevelopment: boolean, recentFolders: readonly string[] = []): void {
    lastMenu = { isDevelopment, recentFolders };
    const isMac = process.platform === 'darwin';
    const template: MenuItemConstructorOptions[] = [
        ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
        {
            label: 'File',
            submenu: [
                // The renderer asks first if editors hold unsaved changes, then opens the picker.
                command('Open Folder…', 'workspace.openFolder'),
                { label: 'Open Recent', submenu: recentSubmenu(recentFolders) },
                { type: 'separator' },
                command('New File…', 'file.newFile'),
                command('New Folder…', 'file.newFolder'),
                { type: 'separator' },
                command('Save', 'file.save'),
                command('Save All', 'file.saveAll'),
                { type: 'separator' },
                command('Close Editor', 'editor.close'),
                { type: 'separator' },
                // #18: the Settings view (the renderer owns it).
                { label: 'Preferences', submenu: [command('Settings', 'workbench.openSettings'), command('Keyboard Shortcuts', 'workbench.openKeybindings'), command('Color Theme', 'workbench.selectTheme')] },
                { type: 'separator' },
                isMac ? { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' } : { role: 'quit' },
            ],
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [
                // #18: every action, by name. The accelerator lives here so it also works while the
                // terminal or the scene view has the focus; F1 is the workbench's own alias.
                command('Command Palette…', 'workbench.commandPalette'),
                { type: 'separator' },
                {
                    // #169: the renderer owns the layout. Zen mode's Ctrl/Cmd+K Z is a chord, which a menu
                    // accelerator cannot express: the workbench listens for it.
                    label: 'Appearance',
                    submenu: [
                        command('Side Bar', 'view.toggleSideBar'),
                        command('Panel', 'view.togglePanel'),
                        command('Maximize Panel', 'view.toggleMaximizedPanel'),
                        command('Zen Mode', 'view.toggleZenMode'),
                        { type: 'separator' },
                        command('Reset Layout', 'view.resetLayout'),
                    ],
                },
                { type: 'separator' },
                ...(isDevelopment
                    ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[])
                    : []),
                // #137: the renderer owns the panel; Ctrl+` on every OS, as in VS Code.
                command('Terminal', 'terminal.toggle'),
                command('New Terminal', 'terminal.new'),
                command('Close Terminal Panel', 'terminal.closePanel'),
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
                command('Go to File…', 'workbench.quickOpen'),
                command('Go to Symbol in Editor…', 'editor.goToSymbol'),
                command('Go to Line/Column…', 'editor.goToLine'),
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
