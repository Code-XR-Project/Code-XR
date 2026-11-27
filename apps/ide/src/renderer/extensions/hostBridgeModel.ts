/**
 * Pure parts of the host bridge (#259), unit-tested in Node: which workbench
 * action a VS Code command an extension runs maps to, and the status bar text
 * of an extension without its `$(icon)` references.
 */

export type BuiltinCommand =
    | { readonly kind: 'workbench'; readonly id: string }
    | { readonly kind: 'search-extensions'; readonly query: string }
    | { readonly kind: 'reload' }
    | { readonly kind: 'unknown' };

/** VS Code's command ids that extensions run, and the IDE's command doing the same. */
export const VSCODE_COMMAND_ALIASES: Readonly<Record<string, string>> = {
    'workbench.action.showCommands': 'workbench.commandPalette',
    'workbench.action.quickOpen': 'workbench.quickOpen',
    'workbench.action.gotoLine': 'editor.goToLine',
    'workbench.action.gotoSymbol': 'editor.goToSymbol',
    'editor.action.formatDocument': 'editor.formatDocument',
    'workbench.action.files.newUntitledFile': 'file.newFile',
    'workbench.action.files.save': 'file.save',
    'workbench.action.files.saveAll': 'file.saveAll',
    'workbench.action.files.openFolder': 'workspace.openFolder',
    'workbench.action.closeActiveEditor': 'editor.close',
    'workbench.action.closeAllEditors': 'editor.closeAll',
    'workbench.action.closeOtherEditors': 'editor.closeOthers',
    'workbench.action.nextEditor': 'editor.next',
    'workbench.action.previousEditor': 'editor.previous',
    'workbench.action.splitEditor': 'editor.splitRight',
    'workbench.action.splitEditorRight': 'editor.splitRight',
    'workbench.action.openSettings': 'workbench.openSettings',
    'workbench.action.openSettingsJson': 'workbench.openSettings',
    'workbench.action.openGlobalSettings': 'workbench.openSettings',
    'workbench.action.openGlobalKeybindings': 'workbench.openKeybindings',
    'workbench.action.selectTheme': 'workbench.selectTheme',
    'workbench.action.togglePanel': 'view.togglePanel',
    'workbench.action.toggleSidebarVisibility': 'view.toggleSideBar',
    'workbench.action.toggleZenMode': 'view.toggleZenMode',
    'workbench.action.terminal.toggleTerminal': 'terminal.toggle',
    'workbench.action.terminal.new': 'terminal.new',
    'workbench.action.output.toggleOutput': 'workbench.output.show',
    'workbench.actions.view.problems': 'workbench.problems.show',
    'workbench.action.problems.focus': 'workbench.problems.show',
    'workbench.view.explorer': 'view.showExplorer',
    'workbench.view.search': 'search.show',
    'workbench.view.extensions': 'extensions.showView',
    'workbench.action.tasks.runTask': 'workbench.action.tasks.runTask',
    'revealInExplorer': 'file.revealInExplorer',
    'copyFilePath': 'file.copyPath',
    'copyRelativeFilePath': 'file.copyRelativePath',
    'markdown.showPreviewToSide': 'markdown.showPreviewToSide',
};

/**
 * The workbench's action for command `id` run by an extension with `args`
 * (in the host's wire format). `vscode.open` and `setContext` never get here:
 * the host handles them, since opening a file goes through the main
 * process's folder check.
 */
export function builtinCommandFor(id: string, args: readonly unknown[]): BuiltinCommand {
    switch (id) {
        case 'workbench.extensions.search':
            return { kind: 'search-extensions', query: typeof args[0] === 'string' ? args[0] : '' };
        case 'workbench.action.reloadWindow':
            return { kind: 'reload' };
        default:
            return { kind: 'workbench', id: VSCODE_COMMAND_ALIASES[id] ?? id };
    }
}

/** An extension's status text with `$(name)` and `$(name~spin)` icon references removed (the IDE has no codicons). */
export function statusText(text: string): string {
    return text.replace(/\$\([a-z0-9-]+(?:~[a-z]+)?\)/gi, '').replace(/\s{2,}/g, ' ').trim();
}
