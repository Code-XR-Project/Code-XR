import type { CommandDefinition, CommandRegistry } from './commandRegistry.ts';

/**
 * The IDE's built-in commands (#18). Each feature hands in what it can do and
 * this module gives it a name, a category and a key. Keys marked `menu` must
 * match the accelerators in `src/main/menu.ts` (the menu owns them); the
 * unit test checks that the two lists agree.
 */

export interface WorkbenchCommandTargets {
    openCommandPalette(): void;
    goToLine(): void;
    hasActiveEditor(): boolean;
    openFolder(): void;
    hasFolder(): boolean;
    newFile(): void;
    newFolder(): void;
    save(): void;
    saveAll(): void;
    closeEditor(): void;
    toggleTerminal(): void;
    newTerminal(): void;
    closeTerminalPanel(): void;
    showView(view: 'explorer' | 'analysis' | 'xr'): void;
    analyseProject(): void;
    canAnalyse(): boolean;
    setUpPython(): void;
    closeScene(): void;
    hasScene(): boolean;
}

/** The menu's accelerators, by command ID: the single place both sides are checked against. */
export const MENU_KEYBINDINGS: Readonly<Record<string, string>> = {
    'workbench.commandPalette': 'CmdOrCtrl+Shift+P',
    'editor.goToLine': 'Ctrl+G',
    'workspace.openFolder': 'CmdOrCtrl+O',
    'file.newFile': 'CmdOrCtrl+N',
    'file.save': 'CmdOrCtrl+S',
    'file.saveAll': 'CmdOrCtrl+Alt+S',
    'editor.close': 'CmdOrCtrl+W',
    'terminal.toggle': 'Ctrl+`',
    'terminal.new': 'Ctrl+Shift+`',
};

export function workbenchCommands(targets: WorkbenchCommandTargets): CommandDefinition[] {
    const menu = (id: string): Pick<CommandDefinition, 'keybinding' | 'keybindingSource'> => {
        const keybinding = MENU_KEYBINDINGS[id];
        return keybinding ? { keybinding, keybindingSource: 'menu' } : {};
    };
    return [
        { id: 'workbench.commandPalette', category: 'View', title: 'Command Palette…', ...menu('workbench.commandPalette'), secondaryKeybindings: ['F1'], recordRecent: false, run: targets.openCommandPalette },
        { id: 'editor.goToLine', category: 'Go', title: 'Go to Line/Column…', ...menu('editor.goToLine'), enabled: targets.hasActiveEditor, run: targets.goToLine },
        { id: 'workspace.openFolder', category: 'File', title: 'Open Folder…', ...menu('workspace.openFolder'), run: targets.openFolder },
        { id: 'file.newFile', category: 'File', title: 'New File…', ...menu('file.newFile'), enabled: targets.hasFolder, run: targets.newFile },
        { id: 'file.newFolder', category: 'File', title: 'New Folder…', enabled: targets.hasFolder, run: targets.newFolder },
        { id: 'file.save', category: 'File', title: 'Save', ...menu('file.save'), enabled: targets.hasActiveEditor, run: targets.save },
        { id: 'file.saveAll', category: 'File', title: 'Save All', ...menu('file.saveAll'), run: targets.saveAll },
        { id: 'editor.close', category: 'View', title: 'Close Editor', ...menu('editor.close'), enabled: targets.hasActiveEditor, run: targets.closeEditor },
        { id: 'terminal.toggle', category: 'View', title: 'Toggle Terminal', ...menu('terminal.toggle'), run: targets.toggleTerminal },
        { id: 'terminal.new', category: 'Terminal', title: 'Create New Terminal', ...menu('terminal.new'), run: targets.newTerminal },
        { id: 'terminal.closePanel', category: 'Terminal', title: 'Close Terminal Panel', run: targets.closeTerminalPanel },
        { id: 'view.showExplorer', category: 'View', title: 'Show Explorer', keybinding: 'CmdOrCtrl+Shift+E', run: () => targets.showView('explorer') },
        { id: 'view.showAnalysis', category: 'View', title: 'Show Analysis', run: () => targets.showView('analysis') },
        { id: 'view.showXrScene', category: 'View', title: 'Show XR Scene', run: () => targets.showView('xr') },
        { id: 'codexr.analyseProjectXrDeep', category: 'Code-XR', title: 'Analyse Project in XR (Deep)', enabled: targets.canAnalyse, run: targets.analyseProject },
        { id: 'codexr.setUpPython', category: 'Code-XR', title: 'Set Up or Repair the Python Environment', run: targets.setUpPython },
        { id: 'codexr.closeScene', category: 'Code-XR', title: 'Close the XR Scene', enabled: targets.hasScene, run: targets.closeScene },
    ];
}

/** Registers the built-in commands; throws on a duplicate ID like any registration. */
export function registerWorkbenchCommands(registry: CommandRegistry, targets: WorkbenchCommandTargets): void {
    for (const command of workbenchCommands(targets)) {
        registry.register(command);
    }
}
