import type { CommandDefinition, CommandRegistry } from './commandRegistry.ts';
import type { CloseKind } from '../editor/tabsModel.ts';
import { MENU_KEYBINDINGS } from '../../shared/keybindings.ts';
import type { FileAnalysisKind, ProjectAnalysisKind } from '../../shared/api.ts';

export { MENU_KEYBINDINGS };

/**
 * The IDE's built-in commands (#18). Each feature hands in what it can do and
 * this module gives it a name, a category and a key. Keys marked `menu` come
 * from `MENU_KEYBINDINGS` (shared/keybindings.ts), the same table
 * `src/main/menu.ts` reads, so the two cannot disagree.
 */

export interface WorkbenchCommandTargets {
    openCommandPalette(): void;
    goToLine(): void;
    quickOpen(): void;
    goToSymbol(): void;
    hasActiveEditor(): boolean;
    /** #256: any tab is active, a text editor or a custom one (a PDF, an image). */
    hasActiveTab(): boolean;
    changeIndentation(): void;
    changeEndOfLine(): void;
    changeLanguageMode(): void;
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
    showOutput(): void;
    showProblems(): void;
    showView(view: 'explorer' | 'search' | 'analysis' | 'xr' | 'settings'): void;
    openSettings(): void;
    openFolderSettingsFile(): void;
    openKeybindings(): void;
    selectColorTheme(): void;
    formatDocument(): void;
    showSearch(): void;
    analyseProject(kind: ProjectAnalysisKind): void;
    canAnalyse(): boolean;
    /** #16: the active editor's file, in XR or as a LivePanel. */
    analyseActiveFile(kind: FileAnalysisKind): void;
    canAnalyseActiveFile(): boolean;
    setUpPython(): void;
    closeScene(): void;
    hasScene(): boolean;
    toggleSideBar(): void;
    togglePanel(): void;
    toggleMaximizedPanel(): void;
    hasPanel(): boolean;
    toggleZenMode(): void;
    resetLayout(): void;
    closeEditors(kind: CloseKind): void;
    cycleEditor(delta: number): void;
    keepEditor(): void;
    copyActivePath(kind: 'absolute' | 'relative'): void;
    revealActiveFile(): void;
    revealActiveFileInScene(): void;
    hasEditors(): boolean;
    /** #168: opens the active file in the other editor group, creating it on first use. */
    splitEditor(): void;
    /** #168: focuses group 0 or 1; returns false when that group does not exist. */
    focusEditorGroup(index: number): boolean;
    /** #177: trust, or restrict, the open folder. */
    manageWorkspaceTrust(): void;
    /** #179: the Markdown preview beside the editor, on the active file. */
    openMarkdownPreview(): void;
    /** #253: the preview as a tab of its own. */
    openMarkdownPreviewTab(): void;
    canPreviewMarkdown(): boolean;
    /** #176: the folder's tasks, the active file with its interpreter, and the user tasks file. */
    runTask(): void;
    runCurrentFile(): void;
    configureTasks(): void;
    /** #175: turns the cursor line's blame on or off (the user setting). */
    toggleInlineBlame(): void;
}

export function workbenchCommands(targets: WorkbenchCommandTargets): CommandDefinition[] {
    const menu = (id: string): Pick<CommandDefinition, 'keybinding' | 'keybindingSource'> => {
        const keybinding = MENU_KEYBINDINGS[id];
        return keybinding ? { keybinding, keybindingSource: 'menu' } : {};
    };
    return [
        { id: 'workbench.commandPalette', category: 'View', title: 'Command Palette…', ...menu('workbench.commandPalette'), secondaryKeybindings: ['F1'], recordRecent: false, run: targets.openCommandPalette },
        { id: 'workbench.quickOpen', category: 'Go', title: 'Go to File…', ...menu('workbench.quickOpen'), recordRecent: false, run: targets.quickOpen },
        { id: 'editor.goToSymbol', category: 'Go', title: 'Go to Symbol in Editor…', ...menu('editor.goToSymbol'), enabled: targets.hasActiveEditor, run: targets.goToSymbol },
        { id: 'editor.goToLine', category: 'Go', title: 'Go to Line/Column…', ...menu('editor.goToLine'), enabled: targets.hasActiveEditor, run: targets.goToLine },
        { id: 'editor.formatDocument', category: 'Editor', title: 'Format Document', keybinding: 'Shift+Alt+F', enabled: targets.hasActiveEditor, run: targets.formatDocument },
        { id: 'editor.changeIndentation', category: 'Editor', title: 'Indent Using…', enabled: targets.hasActiveEditor, run: targets.changeIndentation },
        { id: 'editor.changeEndOfLine', category: 'Editor', title: 'Change End of Line Sequence', enabled: targets.hasActiveEditor, run: targets.changeEndOfLine },
        { id: 'editor.changeLanguageMode', category: 'Editor', title: 'Change Language Mode', enabled: targets.hasActiveEditor, run: targets.changeLanguageMode },
        { id: 'workspace.openFolder', category: 'File', title: 'Open Folder…', ...menu('workspace.openFolder'), run: targets.openFolder },
        { id: 'file.newFile', category: 'File', title: 'New File…', ...menu('file.newFile'), enabled: targets.hasFolder, run: targets.newFile },
        { id: 'file.newFolder', category: 'File', title: 'New Folder…', enabled: targets.hasFolder, run: targets.newFolder },
        { id: 'file.save', category: 'File', title: 'Save', ...menu('file.save'), enabled: targets.hasActiveEditor, run: targets.save },
        { id: 'file.saveAll', category: 'File', title: 'Save All', ...menu('file.saveAll'), run: targets.saveAll },
        { id: 'editor.close', category: 'View', title: 'Close Editor', ...menu('editor.close'), enabled: targets.hasActiveTab, run: targets.closeEditor },
        { id: 'editor.closeOthers', category: 'View', title: 'Close Other Editors', enabled: targets.hasActiveTab, run: () => targets.closeEditors('others') },
        { id: 'editor.closeToTheRight', category: 'View', title: 'Close Editors to the Right', enabled: targets.hasActiveTab, run: () => targets.closeEditors('right') },
        { id: 'editor.closeSaved', category: 'View', title: 'Close Saved Editors', keybinding: 'CmdOrCtrl+K U', enabled: targets.hasEditors, run: () => targets.closeEditors('saved') },
        { id: 'editor.closeAll', category: 'View', title: 'Close All Editors', keybinding: 'CmdOrCtrl+K W', enabled: targets.hasEditors, run: () => targets.closeEditors('all') },
        { id: 'editor.next', category: 'View', title: 'Open Next Editor', keybinding: 'Ctrl+PageDown', secondaryKeybindings: ['Ctrl+Tab'], enabled: targets.hasEditors, recordRecent: false, run: () => targets.cycleEditor(1) },
        { id: 'editor.previous', category: 'View', title: 'Open Previous Editor', keybinding: 'Ctrl+PageUp', secondaryKeybindings: ['Ctrl+Shift+Tab'], enabled: targets.hasEditors, recordRecent: false, run: () => targets.cycleEditor(-1) },
        { id: 'editor.splitRight', category: 'View', title: 'Split Editor Right', keybinding: 'CmdOrCtrl+\\', enabled: targets.hasActiveTab, run: targets.splitEditor },
        { id: 'workbench.focusFirstEditorGroup', category: 'View', title: 'Focus First Editor Group', keybinding: 'CmdOrCtrl+1', recordRecent: false, run: () => { targets.focusEditorGroup(0); } },
        { id: 'workbench.focusSecondEditorGroup', category: 'View', title: 'Focus Second Editor Group', keybinding: 'CmdOrCtrl+2', recordRecent: false, run: () => { if (!targets.focusEditorGroup(1)) { targets.splitEditor(); } } },
        { id: 'workbench.trust.manage', category: 'Workspaces', title: 'Manage Workspace Trust', enabled: targets.hasFolder, run: targets.manageWorkspaceTrust },
        { id: 'markdown.showPreviewToSide', category: 'Markdown', title: 'Open Preview to the Side', keybinding: 'CmdOrCtrl+K V', enabled: targets.canPreviewMarkdown, run: targets.openMarkdownPreview },
        { id: 'markdown.showPreview', category: 'Markdown', title: 'Open Preview', keybinding: 'CmdOrCtrl+Shift+V', enabled: targets.canPreviewMarkdown, run: targets.openMarkdownPreviewTab },
        { id: 'editor.keep', category: 'View', title: 'Keep Editor', keybinding: 'CmdOrCtrl+K Enter', enabled: targets.hasActiveTab, run: targets.keepEditor },
        { id: 'file.copyPath', category: 'File', title: 'Copy Path of Active File', enabled: targets.hasActiveTab, run: () => targets.copyActivePath('absolute') },
        { id: 'file.copyRelativePath', category: 'File', title: 'Copy Relative Path of Active File', enabled: targets.hasActiveTab, run: () => targets.copyActivePath('relative') },
        { id: 'file.revealInExplorer', category: 'File', title: 'Reveal Active File in Explorer', enabled: targets.hasActiveTab, run: targets.revealActiveFile },
        { id: 'workbench.action.tasks.runTask', category: 'Tasks', title: 'Run Task', enabled: targets.hasFolder, run: targets.runTask },
        { id: 'workbench.action.tasks.configureTaskRunner', category: 'Tasks', title: 'Configure Tasks', enabled: targets.hasFolder, run: targets.configureTasks },
        { id: 'workbench.action.runCurrentFile', category: 'Run', title: 'Run Current File', keybinding: 'CmdOrCtrl+F5', enabled: targets.hasActiveEditor, run: targets.runCurrentFile },
        { id: 'git.blame.toggleInline', category: 'Git', title: 'Toggle Inline Blame', run: targets.toggleInlineBlame },
        { id: 'terminal.toggle', category: 'View', title: 'Toggle Terminal', ...menu('terminal.toggle'), run: targets.toggleTerminal },
        { id: 'terminal.new', category: 'Terminal', title: 'Create New Terminal', ...menu('terminal.new'), run: targets.newTerminal },
        { id: 'terminal.closePanel', category: 'Terminal', title: 'Close Terminal Panel', run: targets.closeTerminalPanel },
        { id: 'workbench.problems.show', category: 'View', title: 'Show Problems', keybinding: 'CmdOrCtrl+Shift+M', run: targets.showProblems },
        { id: 'workbench.output.show', category: 'View', title: 'Show Output', keybinding: 'CmdOrCtrl+Shift+U', run: targets.showOutput },
        { id: 'view.showExplorer', category: 'View', title: 'Show Explorer', keybinding: 'CmdOrCtrl+Shift+E', run: () => targets.showView('explorer') },
        { id: 'search.show', category: 'View', title: 'Search in Files', keybinding: 'CmdOrCtrl+Shift+F', enabled: targets.hasFolder, run: targets.showSearch },
        { id: 'view.toggleSideBar', category: 'View', title: 'Toggle Side Bar Visibility', ...menu('view.toggleSideBar'), run: targets.toggleSideBar },
        { id: 'view.togglePanel', category: 'View', title: 'Toggle Panel Visibility', ...menu('view.togglePanel'), run: targets.togglePanel },
        { id: 'view.toggleMaximizedPanel', category: 'View', title: 'Toggle Maximized Panel', enabled: targets.hasPanel, run: targets.toggleMaximizedPanel },
        { id: 'view.toggleZenMode', category: 'View', title: 'Toggle Zen Mode', keybinding: 'CmdOrCtrl+K Z', run: targets.toggleZenMode },
        { id: 'view.resetLayout', category: 'View', title: 'Reset Layout', run: targets.resetLayout },
        { id: 'workbench.openSettings', category: 'Preferences', title: 'Open Settings', ...menu('workbench.openSettings'), run: targets.openSettings },
        { id: 'workbench.selectTheme', category: 'Preferences', title: 'Color Theme', keybinding: 'CmdOrCtrl+K CmdOrCtrl+T', run: targets.selectColorTheme },
        { id: 'workbench.openKeybindings', category: 'Preferences', title: 'Open Keyboard Shortcuts', keybinding: 'CmdOrCtrl+K S', run: targets.openKeybindings },
        { id: 'workbench.openFolderSettingsFile', category: 'Preferences', title: 'Open Folder Settings (JSON)', enabled: targets.hasFolder, run: targets.openFolderSettingsFile },
        { id: 'view.showAnalysis', category: 'View', title: 'Show Analysis', run: () => targets.showView('analysis') },
        { id: 'view.showXrScene', category: 'View', title: 'Show XR Scene', run: () => targets.showView('xr') },
        { id: 'codexr.analyseProjectXrDeep', category: 'Code-XR', title: 'Analyse Project in XR (Deep)', enabled: targets.canAnalyse, run: () => targets.analyseProject('xr-deep') },
        { id: 'codexr.analyseProjectLivePanelDeep', category: 'Code-XR', title: 'Analyse Project as LivePanel (Deep)', enabled: targets.canAnalyse, run: () => targets.analyseProject('livepanel-deep') },
        { id: 'codexr.analyseFileXr', category: 'Code-XR', title: 'Analyse Active File in XR', enabled: targets.canAnalyseActiveFile, run: () => targets.analyseActiveFile('xr-file') },
        { id: 'codexr.analyseFileLivePanel', category: 'Code-XR', title: 'Analyse Active File as LivePanel', enabled: targets.canAnalyseActiveFile, run: () => targets.analyseActiveFile('livepanel-file') },
        { id: 'codexr.setUpPython', category: 'Code-XR', title: 'Set Up or Repair the Python Environment', run: targets.setUpPython },
        { id: 'codexr.revealInScene', category: 'Code-XR', title: 'Reveal Active File in XR Scene', enabled: () => targets.hasScene() && targets.hasActiveEditor(), run: targets.revealActiveFileInScene },
        { id: 'codexr.closeScene', category: 'Code-XR', title: 'Close the XR Scene', enabled: targets.hasScene, run: targets.closeScene },
    ];
}

/** Registers the built-in commands; throws on a duplicate ID like any registration. */
export function registerWorkbenchCommands(registry: CommandRegistry, targets: WorkbenchCommandTargets): void {
    for (const command of workbenchCommands(targets)) {
        registry.register(command);
    }
}
