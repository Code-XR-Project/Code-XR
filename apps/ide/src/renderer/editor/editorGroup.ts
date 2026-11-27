import { MODIFIED_ON_DISK, type CodeXRApi, type FileContent } from '../../shared/api.ts';
import { el, fileIcon, icon } from '../dom.ts';
import { followSystemTheme, monaco } from './monaco.ts';
import { languageName, type EditorStatusState, type EndOfLine, type Indentation, type LanguageInfo } from './editorStatusModel.ts';
import { settingOf, type SettingValues } from '../../shared/settings.ts';
import type { FileFunctionMetrics, MetricThresholds, Problem, ProblemSeverity } from '../../shared/problems.ts';
import { installMetricLens } from './metricLens.ts';
import { installGitDecorations, type GitDecorationsHooks } from './gitDecorations.ts';
import { installDebugDecorations, type DebugDecorationsHooks } from './debugDecorations.ts';
import { createMarkdownPreview, type MarkdownPreview } from './markdownPreview.ts';
import { isMarkdownPath } from './markdownPath.ts';
import type { CustomEditorContext, CustomEditorInput, CustomEditorResolver, CustomEditorView } from './customEditor.ts';
import { compareFilesId, compareSavedId, CustomEditorRegistry, parseCompareId } from './customEditorRegistry.ts';
import { createCompareView, type CompareSide } from './compareTab.ts';
import {
    clampSplit, closeTargets, cycleTab, DEFAULT_SPLIT, discardQuestion, moveTab,
    type CloseKind, type GroupSession, type TabSession,
} from './tabsModel.ts';
import { EDITORCONFIG_NAME, editorConfigFolders, parseEditorConfig, resolveEditorConfig, type EditorConfigFile, type EditorConfigProperties } from './editorConfig.ts';
import { FORMAT_TIMEOUT_MS, indentationOf, saveRules, whitespaceEdits, type AutoSave, type FileSettings, type SaveReason } from './saveTransforms.ts';

/**
 * The editor area (#14): one model per open file, and one or two editor
 * groups, each a tab strip over its own Monaco editor (#168: the second group
 * is a split to the right). A file open in both groups is one document: one
 * model, so edits show in both, and one dirty state. A tab is dirty while its
 * model differs from what was last read or saved (Monaco's alternative version
 * id, so undoing back to the saved text clears it). Saves send the
 * modification time the file had when it was read, and the main process
 * refuses the write if it moved.
 *
 * Files also follow the disk: when the watcher reports an open file, a clean
 * tab takes the new text as one undoable edit, while a dirty tab keeps the
 * person's text and is marked as conflicting (or deleted) until it is saved.
 *
 * Tabs (#167): the DOM order of a strip is its tab order. A preview tab
 * (italic) is what a single click in the explorer opens; the next preview in
 * the same group replaces it, and editing it, double-clicking it or opening it
 * for keeps makes it a normal tab. Tabs drag to reorder, or to the other group
 * (#168), close in groups from their context menu (one question for all the
 * unsaved ones), and the open tabs of both groups with their view states and
 * the split are a session the folder restores. Closing the last tab of the
 * second group removes the split.
 *
 * Saving (#170): a save formats the file (if asked, and never waiting on a
 * formatter that fails), trims trailing whitespace and adds the final newline
 * as one undoable edit, then writes; a project's `.editorconfig` overrides
 * the settings per file and sets its indentation when it opens. Auto save
 * runs after a delay (leaving the lines being typed on alone) or when the
 * editor loses the focus, and never asks a question: a file that changed on
 * disk waits for an explicit save.
 */

const CLOSE = 'M6 6l12 12M18 6L6 18';
const BOM = '﻿';
/** #253: the id prefix of a Markdown preview tab (`markdown-preview:docs/a.md`). */
const MARKDOWN_PREVIEW_PREFIX = 'markdown-preview:';
/** #168: at most two groups, side by side. */
const MAX_GROUPS = 2;

/** An open file: its model and everything about its text, shared by the groups that show it. */
interface Doc {
    readonly path: string;
    readonly model: monaco.editor.ITextModel;
    savedVersion: number;
    mtimeMs: number;
    /** What the disk did behind an unsaved file, shown on its tabs until the next save. */
    diskState: 'same' | 'changed' | 'deleted';
    /** The file starts with a UTF-8 byte order mark, written back on save (#166). */
    bom: boolean;
    /** #170: what the file's `.editorconfig` files set. */
    config: EditorConfigProperties;
    /** #178: the metric lenses showed "out of date" (unsaved changes) at the last check. */
    lensStale: boolean;
    /** #170: the pending auto save after a delay. */
    autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
    /** #170: a save is being written (an auto save does not start a second one). */
    saving: boolean;
    readonly listener: monaco.IDisposable;
    /** #256: a custom tab's input (its model is an empty placeholder, never shown); null for a text file. */
    readonly custom: CustomEditorInput | null;
    /** #256: the dot a custom view asked for. */
    customDirty: boolean;
}

/** A document's tab in one group. */
interface Tab {
    readonly doc: Doc;
    readonly group: Group;
    readonly element: HTMLElement;
    readonly dirtyMark: HTMLElement;
    viewState: monaco.editor.ICodeEditorViewState | null;
    /** #167: a preview tab, replaced by the next preview of its group until it is kept. */
    preview: boolean;
    /** #256: this tab's view of a custom input (null for a text file). */
    readonly view: CustomEditorView | null;
    readonly label: HTMLElement;
}

/** An editor group (#168): a tab strip over a Monaco editor. */
interface Group {
    readonly root: HTMLElement;
    readonly strip: HTMLElement;
    readonly host: HTMLElement;
    readonly placeholder: HTMLElement;
    /** #256: where the active custom tab's element goes, in place of the editor. */
    readonly customHost: HTMLElement;
    readonly editor: monaco.editor.IStandaloneCodeEditor;
    readonly sceneShown: monaco.editor.IContextKey<boolean>;
    readonly tabs: Map<string, Tab>;
    active: Tab | null;
    readonly disposables: monaco.IDisposable[];
}

export interface OpenOptions {
    /** #167: open as the preview tab (a single click in the explorer). */
    readonly preview?: boolean;
}

/** #173: Monaco's resources for workspace files, and the owner of the Code-XR metric markers. */
const FILE_SCHEME = 'codexr-file';
/** #256: the placeholder models of custom tabs; nothing (languages, lenses, markers) follows this scheme. */
const CUSTOM_SCHEME = 'codexr-custom';
const METRIC_OWNER = 'codexr-metrics';
const MARKER_SEVERITY: Record<ProblemSeverity, monaco.MarkerSeverity> = {
    error: monaco.MarkerSeverity.Error,
    warning: monaco.MarkerSeverity.Warning,
    info: monaco.MarkerSeverity.Info,
};
function markerSeverity(severity: monaco.MarkerSeverity): ProblemSeverity {
    return severity >= monaco.MarkerSeverity.Error ? 'error' : severity >= monaco.MarkerSeverity.Warning ? 'warning' : 'info';
}

export interface EditorGroup {
    open(path: string, options?: OpenOptions): Promise<void>;
    save(): Promise<void>;
    saveAll(): Promise<void>;
    closeActive(): void;
    /** Drops every editor (the workspace changed). Unsaved files must be dealt with first. */
    reset(): void;
    readonly dirtyPaths: () => readonly string[];
    /** Workspace-relative paths of every open file (they are watched). */
    openPaths(): string[];
    /** The watcher reported `paths`; open files among them are re-read. */
    onDiskChanged(paths: readonly string[]): Promise<void>;
    /**
     * An entry was renamed (`to`) or trashed (`to` null) from the explorer.
     * Clean tabs at or below it follow it (or close); unsaved tabs stay open
     * and are marked deleted on disk, so no typing is lost.
     */
    entryMoved(from: string, to: string | null): Promise<void>;
    /** Lines of the active file, or null when no file is active (#18: go to line). */
    activeLineCount(): number | null;
    /** Moves the cursor of the active file to `line` (and `column`), centred, and focuses the editor (unless `focus` is false). */
    goToLine(line: number, column?: number, focus?: boolean): void;
    /** #172: the active file's path and model, for its outline; null without one. */
    activeModel(): { readonly path: string; readonly model: monaco.editor.ITextModel } | null;
    /** #172: the bar above the active group's editor where the breadcrumbs go (editor/breadcrumbs.ts). */
    readonly breadcrumbBar: HTMLElement;
    /** #165: opens `path` and selects `length` characters from `line`:`column` (a search match). */
    openAt(path: string, line: number, column: number, length: number): Promise<void>;
    /**
     * #165: replaces in the open files among `paths`, as one undoable edit each
     * (the tab becomes unsaved); returns the paths it handled and the count.
     */
    replaceInOpenFiles(paths: readonly string[], replace: (text: string) => { text: string; count: number }): { handled: string[]; replacements: number };
    /** The active editor's selection when it is on one line, for the Search view's query. */
    selectedText(): string;
    /** The active editor's selection on any number of lines, for an agent's context (epic #189, A6); null when empty. */
    activeSelection(): { readonly path: string; readonly startLine: number; readonly endLine: number; readonly text: string } | null;
    /**
     * Epic #189 (A8): writes an agent's accepted change into an open file as
     * one undoable edit and saves it through the normal path. Refuses when
     * the editor's text is not the one the agent saw (unsaved edits).
     */
    applyAgentEdit(path: string, expected: string, text: string): Promise<'saved' | 'not-open' | 'unsaved-changes' | 'save-failed'>;
    /** #164: Monaco's own outline of the active file ("@" in quick open), where its language has symbols. */
    showSymbols(): void;
    /** #166: the status bar's choices, applied to the active file. */
    setIndentation(indentation: Indentation): void;
    /** Changes the line endings as one undoable edit (the tab becomes dirty). */
    setEndOfLine(eol: EndOfLine): void;
    setLanguage(languageId: string): void;
    languages(): readonly LanguageInfo[];
    /** The active file's status, or null without one. */
    statusState(): EditorStatusState | null;
    /** #167: closes a group of tabs around `path` (the active tab by default) in the active group, asking once about unsaved ones. */
    closeGroup(kind: CloseKind, path?: string): void;
    /** #167: activates the tab `delta` steps away in the active group, wrapping around. */
    cycle(delta: number): void;
    /** #167: keeps the active preview tab. */
    keepActive(): void;
    /** #167: the open tabs of both groups in order, with view states and the split, for the folder's session. */
    session(): TabSession;
    /** #167: reopens a saved session's tabs (files that are gone are skipped). */
    restore(session: TabSession): Promise<void>;
    /**
     * #168: opens `path` (the active file by default) in the group on the
     * right, creating it the first time, and focuses it. With two groups,
     * from the right one it opens in the left one.
     */
    split(path?: string): Promise<void>;
    /** #168: focuses group `index` (0 left, 1 right); false when there is no such group. */
    focusGroup(index: number): boolean;
    /** #168: how many groups are open (1 or 2). */
    groupCount(): number;
    /** #179: opens the Markdown preview beside the groups on the active file; false when it is not Markdown. */
    openMarkdownPreview(): boolean;
    /** #253: opens the active Markdown file's preview as a tab of its own (Ctrl+Shift+V); false when it is not Markdown. */
    openMarkdownPreviewTab(): boolean;
    /** #256: the id of the active group's active tab (a file path, or a custom id such as `chat:...`); null without one. */
    activeTabId(): string | null;
    /** #288: compares the active file (or `path`) with its text on disk; false without a text file. */
    compareWithSaved(path?: string): boolean;
    /** #288: compares two workspace files in a tab, `left` as the original. */
    compareFiles(left: string, right: string): void;
    closeMarkdownPreview(): void;
    canPreviewMarkdown(): boolean;
    markdownPreviewOpen(): boolean;
    /**
     * #256: opens a custom tab (a view of its own instead of a text editor)
     * in the active group, or activates the one with the same id.
     */
    openCustom(input: CustomEditorInput, options?: OpenOptions): void;
    /**
     * #256: adds a resolver that turns an id into a custom input: a file being
     * opened (the PDF and image viewers) or a tab of a saved session. The
     * returned function removes it.
     */
    registerCustomEditor(resolver: CustomEditorResolver): () => void;
    /** #18: applies the editor settings in force. */
    applySettings(settings: SettingValues): void;
    /** #170: formats the active file with its language's formatter; false when it has none. */
    formatDocument(): Promise<boolean>;
    /** #173: what the languages report on the open files (Monaco's markers), the metric ones left out. */
    editorProblems(): Problem[];
    /** #173: the Code-XR metric problems, drawn as squiggles in the open files and in the ones opened later. */
    setMetricProblems(problems: readonly Problem[]): void;
    /** #178: the measured functions as lenses and a complexity strip; `enabled` is the setting. */
    setFunctionMetrics(files: readonly FileFunctionMetrics[], thresholds: MetricThresholds, enabled: boolean): void;
    /** #178: a scene is shown beside the code; the editor's context menu offers "Reveal in XR Scene" only then. */
    setSceneShown(shown: boolean): void;
    /** #175: the repository changed (commit, checkout, stage): the gutter markers and the blame are read again. */
    gitChanged(): void;
    /** #180: the breakpoints of `path` (every file when null) changed; redraw them. */
    breakpointsChanged(path: string | null): void;
    /** #180: the line a paused debug session is on (null: running or ended). */
    setExecutionPoint(point: { readonly path: string; readonly line: number; readonly top: boolean } | null): void;
}

export function createEditorGroup(
    container: HTMLElement,
    api: CodeXRApi['workspace'],
    callbacks: {
        onStatus(message: string): void;
        onActiveChange(path: string | null): void;
        /** The number of tabs with unsaved changes moved (or a save ended). */
        onUnsavedChange?(count: number): void;
        /** The set of open files changed. */
        onOpenFilesChange?(): void;
        /** #166: the cursor, indentation, line endings or language of the active file changed (null: no file). */
        onStatusState?(state: EditorStatusState | null): void;
        /** #167: the tabs' order, preview state or view states changed (the session is worth saving). */
        onSessionChange?(): void;
        /** #167: the tab context menu's Copy Path / Copy Relative Path and Reveal in Explorer. */
        copyPath?(path: string, kind: 'absolute' | 'relative'): void;
        revealInExplorer?(path: string): void;
        /** #167: shows the tab context menu (the workbench owns menus and keybinding labels). */
        showTabMenu?(path: string, x: number, y: number): void;
        /** #173: a language's markers changed on an open file. */
        onMarkersChange?(): void;
        /** #178: a lens over a function past a limit was clicked. */
        showFunctionProblems?(path: string, name: string): void;
        /** #172: a tab's text matches the disk again (saved, reloaded, or undone back): its outline may be measured again. */
        onFileClean?(path: string): void;
        /** #178: "Reveal in XR Scene" from the editor's context menu, on the active file. */
        revealInScene?(path: string): void;
        /** #175: the files' text at HEAD and their blame, from the main process (null when Git has nothing to say). */
        git?: GitDecorationsHooks;
        /** #180: the breakpoints in the glyph margin, owned by the debugger. */
        debug?: DebugDecorationsHooks;
    },
): EditorGroup {
    const groupsRow = el('div', { className: 'editor-groups', attrs: { 'data-testid': 'editor-groups' } });
    const breadcrumbBar = el('div', { className: 'editor-breadcrumbs', attrs: { 'data-testid': 'breadcrumbs', hidden: '' } });
    const splitSash = el('div', {
        className: 'editor-split-sash',
        attrs: {
            role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': 'Resize the editor groups',
            title: 'Drag to resize, double-click to reset', 'data-testid': 'sash-editor-split', hidden: '',
        },
    });
    // #179: the Markdown preview, a pane to the right of the groups with its own sash.
    const previewSash = el('div', {
        className: 'editor-split-sash',
        attrs: {
            role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': 'Resize the Markdown preview',
            title: 'Drag to resize, double-click to reset', 'data-testid': 'sash-markdown-preview',
        },
    });
    container.replaceChildren(groupsRow);
    container.classList.add('has-editors');

    followSystemTheme();
    /** The options every editor gets; settings and the scene flag update them in every group. */
    let editorOptions: monaco.editor.IEditorOptions = {
        automaticLayout: true,
        fontFamily: "ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace",
        fontSize: 13,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        // The default colour provider turns any "#165" (an issue number in a comment) into a
        // colour swatch; CSS, SCSS and LESS keep their own colour decorators.
        defaultColorDecorators: 'never',
        // #180: breakpoints are set by clicking left of the line numbers.
        glyphMargin: callbacks.debug !== undefined,
    };
    let sceneIsShown = false;

    const docs = new Map<string, Doc>();
    const groups: Group[] = [];
    let current!: Group;
    let split = DEFAULT_SPLIT;
    let preview: MarkdownPreview | null = null;
    /** The document the preview follows: the last Markdown file made active while it is open. */
    let previewDoc: Doc | null = null;
    let previewShare = DEFAULT_SPLIT;

    /** The active tab of the active group. */
    const activeTab = (): Tab | null => current.active;
    /** The active text document: null when the active tab is a custom one (#256), so text commands leave it alone. */
    const activeDoc = (): Doc | null => {
        const doc = current.active?.doc ?? null;
        return doc?.custom ? null : doc;
    };
    const customEditors = new CustomEditorRegistry<CustomEditorInput>();
    // #253: a Markdown file's preview as a tab of its own; it follows the open file's text, or the disk.
    customEditors.register((id) => {
        if (!id.startsWith(MARKDOWN_PREVIEW_PREFIX)) {
            return null;
        }
        const path = id.slice(MARKDOWN_PREVIEW_PREFIX.length);
        const name = path.slice(path.lastIndexOf('/') + 1);
        return { id, title: `Preview ${name}`, iconName: name, filePath: path, create: (context) => markdownPreviewTab(path, context) };
    });
    // #288: comparisons (Compare with Saved, Compare with Selected) on the diff editor.
    customEditors.register((id) => {
        const target = parseCompareId(id);
        if (!target) {
            return null;
        }
        const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
        const diskText = (path: string) => async (): Promise<string | null> => {
            const content = await api.readFile(path);
            return content.kind === 'text' ? content.text : null;
        };
        /** A side over an open file follows its model; otherwise its text on disk. */
        const side = (path: string, live: boolean): CompareSide => {
            const doc = docs.get(path);
            return live && doc && !doc.custom ? { path, model: doc.model, read: diskText(path) } : { path, read: diskText(path) };
        };
        const create = (original: CompareSide, modified: CompareSide) => (context: CustomEditorContext): CustomEditorView => createCompareView({
            original, modified, editorOptions,
            onLiveModelGone: () => context.close(),
            onStatus: (message) => callbacks.onStatus(message),
        });
        if (target.kind === 'saved') {
            const name = nameOf(target.path);
            return {
                id, title: `${name} (Saved) \u2194 ${name}`, iconName: name, filePath: target.path,
                create: (context) => create(side(target.path, false), side(target.path, true))(context),
            };
        }
        return {
            id, title: `${nameOf(target.left)} \u2194 ${nameOf(target.right)}`, iconName: nameOf(target.right), filePath: target.right, alsoWatches: [target.left],
            create: (context) => create(side(target.left, true), side(target.right, true))(context),
        };
    });
    const tabsOf = (doc: Doc): Tab[] => groups.flatMap((group) => {
        const tab = group.tabs.get(doc.path);
        return tab?.doc === doc ? [tab] : [];
    });

    // #173: the metric problems by file; squiggles on the open ones, under their own marker owner.
    let metricProblems = new Map<string, Problem[]>();
    function applyMetricMarkers(doc: Doc): void {
        const model = doc.model;
        monaco.editor.setModelMarkers(model, METRIC_OWNER, (metricProblems.get(doc.path) ?? []).map((problem) => {
            const line = Math.min(Math.max(1, problem.startLine), model.getLineCount());
            return {
                severity: MARKER_SEVERITY[problem.severity],
                message: problem.message,
                source: problem.source,
                ...(problem.code ? { code: problem.code } : {}),
                startLineNumber: line,
                startColumn: model.getLineFirstNonWhitespaceColumn(line) || 1,
                endLineNumber: line,
                endColumn: model.getLineMaxColumn(line),
            };
        }));
    }
    const isDirty = (doc: Doc): boolean => doc.model.getAlternativeVersionId() !== doc.savedVersion;
    // #178: a tab with unsaved changes no longer matches the measured file on disk.
    const metricLens = installMetricLens(FILE_SCHEME, {
        isStale: (model) => [...docs.values()].some((doc) => doc.model === model && isDirty(doc)),
        showProblems: (path, name) => callbacks.showFunctionProblems?.(path, name),
    });
    // #175: change markers against HEAD and the cursor line's blame.
    const gitDecorations = callbacks.git ? installGitDecorations(callbacks.git) : null;
    // #180: breakpoints and the paused line.
    const debugDecorations = callbacks.debug ? installDebugDecorations(callbacks.debug) : null;
    monaco.editor.onDidChangeMarkers((resources) => {
        if (resources.some((uri) => uri.scheme === FILE_SCHEME)) {
            callbacks.onMarkersChange?.();
        }
    });
    /** A group's tabs in order: its strip's DOM order. */
    const ordered = (group: Group): Tab[] => [...group.strip.children].flatMap((element) => {
        const tab = group.tabs.get((element as HTMLElement).dataset['path'] ?? '');
        return tab ? [tab] : [];
    });
    const sessionChanged = (): void => callbacks.onSessionChange?.();

    // #166: the status bar follows the active editor, at most once a frame.
    let statusFrame = 0;
    function statusState(): EditorStatusState | null {
        const doc = activeDoc();
        const editor = current.editor;
        const position = editor.getPosition();
        if (!doc || !position) {
            return null;
        }
        const model = doc.model;
        const selections = editor.getSelections() ?? [];
        const selectedChars = selections.reduce((sum, selection) => sum + model.getValueLengthInRange(selection), 0);
        const options = model.getOptions();
        const languageId = model.getLanguageId();
        return {
            line: position.lineNumber,
            column: position.column,
            selectedChars,
            selections: selections.length,
            insertSpaces: options.insertSpaces,
            tabSize: options.tabSize,
            eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
            bom: doc.bom,
            languageId,
            languageName: languageName(monaco.languages.getLanguages().find((language) => language.id === languageId), languageId),
        };
    }
    function scheduleStatus(): void {
        if (!callbacks.onStatusState || statusFrame !== 0) {
            return;
        }
        statusFrame = requestAnimationFrame(() => {
            statusFrame = 0;
            callbacks.onStatusState?.(statusState());
        });
    }

    let reportedUnsaved = 0;
    function reportUnsaved(force = false): void {
        const count = [...docs.values()].filter(isDirty).length;
        if (force || count !== reportedUnsaved) {
            reportedUnsaved = count;
            callbacks.onUnsavedChange?.(count);
        }
    }

    /** Draws a document's state on every tab that shows it. */
    function refreshDoc(doc: Doc): void {
        const dirty = isDirty(doc) || doc.customDirty;
        const title = doc.diskState === 'deleted' ? 'Deleted on disk'
            : doc.diskState === 'changed' ? 'Changed on disk; your version is unsaved'
                : dirty ? 'Unsaved changes' : '';
        for (const tab of tabsOf(doc)) {
            tab.element.classList.toggle('is-dirty', dirty);
            tab.element.classList.toggle('is-conflict', doc.diskState === 'changed');
            tab.element.classList.toggle('is-deleted', doc.diskState === 'deleted');
            tab.dirtyMark.title = title;
        }
        if (dirty !== doc.lensStale) {
            doc.lensStale = dirty;
            metricLens.refresh(doc.model);
            if (!dirty) {
                callbacks.onFileClean?.(doc.path);
            }
        }
        reportUnsaved();
    }

    function showPlaceholder(group: Group, message: string | null): void {
        group.placeholder.textContent = message ?? '';
        group.placeholder.hidden = message === null;
        group.host.hidden = message !== null;
    }

    /** Makes `group` the one the commands, the status bar and the breadcrumbs follow. */
    function focusGroupInternal(group: Group, notify = true): void {
        const changed = current !== group;
        current = group;
        for (const other of groups) {
            other.root.classList.toggle('is-active-group', other === group);
        }
        if (breadcrumbBar.parentElement !== group.root) {
            group.root.insertBefore(breadcrumbBar, group.host);
        }
        if (changed && notify) {
            callbacks.onActiveChange(group.active?.doc.path ?? null);
            scheduleStatus();
            sessionChanged();
        }
    }

    /** #256: takes the shown custom view out of `group` (another tab, or none, takes its place). */
    function hideCustomView(group: Group): void {
        const shown = group.customHost.firstElementChild;
        if (!shown) {
            return;
        }
        const owner = [...group.tabs.values()].find((candidate) => candidate.view?.element === shown);
        owner?.view?.onHide?.();
        shown.remove();
    }

    function activate(group: Group, tab: Tab | null, focus = true): void {
        const previous = group.active;
        if (previous && previous !== tab) {
            if (!previous.view) {
                previous.viewState = group.editor.saveViewState();
            }
            previous.element.setAttribute('aria-selected', 'false');
            previous.element.tabIndex = -1;
        }
        group.active = tab;
        const wasCurrent = current === group;
        focusGroupInternal(group, false);
        if (group.customHost.firstElementChild !== (tab?.view?.element ?? null)) {
            hideCustomView(group);
        }
        group.customHost.hidden = !tab?.view;
        if (!tab) {
            group.editor.setModel(null);
            showPlaceholder(group, docs.size === 0 ? 'Open a file from the explorer.' : null);
            callbacks.onActiveChange(null);
            return;
        }
        showPlaceholder(group, null);
        if (tab.view) {
            group.host.hidden = true;
            group.editor.setModel(null);
            if (!tab.view.element.isConnected) {
                group.customHost.append(tab.view.element);
                tab.view.onShow?.();
            }
        } else if (group.editor.getModel() !== tab.doc.model) {
            group.editor.setModel(tab.doc.model);
            if (tab.viewState) {
                group.editor.restoreViewState(tab.viewState);
            }
        }
        tab.element.setAttribute('aria-selected', 'true');
        tab.element.tabIndex = 0;
        tab.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (focus) {
            if (tab.view) {
                tab.view.focus?.();
            } else {
                group.editor.focus();
            }
        }
        callbacks.onActiveChange(tab.doc.path);
        followPreview(tab.doc);
        if (!wasCurrent) {
            scheduleStatus();
            sessionChanged();
        }
    }

    function setPreview(tab: Tab, preview: boolean): void {
        if (tab.preview === preview) {
            return;
        }
        tab.preview = preview;
        tab.element.classList.toggle('is-preview', preview);
        tab.element.querySelector('.tab-label')?.setAttribute('aria-description', preview ? 'preview' : '');
        sessionChanged();
    }

    function createDoc(content: Extract<FileContent, { kind: 'text' }>): Doc {
        const uri = monaco.Uri.from({ scheme: FILE_SCHEME, path: `/${content.path}` });
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content.text, undefined, uri);
        const doc: Doc = {
            path: content.path, model, savedVersion: model.getAlternativeVersionId(), mtimeMs: content.mtimeMs,
            diskState: 'same', bom: content.text.startsWith(BOM), config: {}, autoSaveTimer: undefined, saving: false, lensStale: false,
            custom: null, customDirty: false,
            listener: model.onDidChangeContent(() => {
                refreshDoc(doc);
                scheduleAutoSave(doc);
                // Editing keeps a preview tab (a reload from disk leaves it clean, so it stays a preview).
                if (isDirty(doc)) {
                    for (const tab of tabsOf(doc)) { setPreview(tab, false); }
                }
                if (previewDoc === doc) {
                    preview?.update(doc.model.getValue());
                }
            }),
        };
        docs.set(doc.path, doc);
        void applyEditorConfig(doc);
        applyMetricMarkers(doc);
        metricLens.refresh(model);
        gitDecorations?.attach(model, doc.path);
        debugDecorations?.attach(model, doc.path);
        callbacks.onOpenFilesChange?.();
        return doc;
    }

    /** The workspace files a document follows on disk: its own path, or what its custom input names. */
    function watchedPaths(doc: Doc): string[] {
        if (!doc.custom) {
            return [doc.path];
        }
        return [...(doc.custom.filePath === undefined ? [] : [doc.custom.filePath]), ...(doc.custom.alsoWatches ?? [])];
    }

    /** #256: a custom tab's document: an empty placeholder model under its own scheme, never shown or saved. */
    function createCustomDoc(input: CustomEditorInput): Doc {
        const uri = monaco.Uri.from({ scheme: CUSTOM_SCHEME, path: `/${input.id}` });
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel('', 'plaintext', uri);
        const doc: Doc = {
            path: input.id, model, savedVersion: model.getAlternativeVersionId(), mtimeMs: 0,
            diskState: 'same', bom: false, config: {}, autoSaveTimer: undefined, saving: false, lensStale: false,
            listener: { dispose: () => undefined }, custom: input, customDirty: false,
        };
        docs.set(doc.path, doc);
        callbacks.onOpenFilesChange?.();
        return doc;
    }

    /** #256: the document for a custom input, or for a file a resolver claims; null when nothing claims `id`. */
    function customDocFor(id: string): Doc | null {
        const known = docs.get(id);
        if (known) {
            return known.custom ? known : null;
        }
        const input = customEditors.resolve(id);
        return input && input.id === id ? createCustomDoc(input) : null;
    }

    function disposeDoc(doc: Doc): void {
        clearTimeout(doc.autoSaveTimer);
        docs.delete(doc.path);
        doc.listener.dispose();
        if (previewDoc === doc) {
            previewDoc = null; // the preview keeps its last rendering until another Markdown file is active
        }
        monaco.editor.setModelMarkers(doc.model, METRIC_OWNER, []);
        metricLens.forget(doc.model);
        gitDecorations?.forget(doc.model);
        debugDecorations?.forget(doc.model);
        doc.model.dispose();
    }

    function addTab(group: Group, doc: Doc, preview = false, before: Element | null = null): Tab {
        const name = doc.custom ? doc.custom.title : doc.path.split('/').pop() ?? doc.path;
        const dirtyMark = el('span', { className: 'tab-dirty', attrs: { 'aria-hidden': 'true' } });
        const close = el('button', { className: 'tab-close', attrs: { type: 'button', title: 'Close', 'aria-label': `Close ${name}`, tabindex: '-1' } }, [icon(CLOSE)]);
        const label = el('span', { className: 'tab-label', text: name });
        const element = el('div', {
            className: 'editor-tab',
            attrs: { role: 'tab', 'aria-selected': 'false', tabindex: '-1', title: doc.custom?.filePath ?? doc.custom?.title ?? doc.path, 'data-path': doc.path, draggable: 'true' },
        }, [fileIcon(doc.custom?.iconName ?? name, 'file'), label, dirtyMark, close]);
        let view: CustomEditorView | null = null;
        if (doc.custom) {
            const context: CustomEditorContext = {
                id: doc.path,
                setTitle: (title) => {
                    label.textContent = title;
                    close.setAttribute('aria-label', `Close ${title}`);
                    if (!doc.custom?.filePath) { element.title = title; }
                },
                setDirty: (dirty) => {
                    doc.customDirty = dirty;
                    refreshDoc(doc);
                },
                close: () => {
                    if (tab.group.tabs.get(doc.path) === tab) { closeTabs(tab.group, [tab]); }
                },
                status: (message) => callbacks.onStatus(message),
            };
            view = doc.custom.create(context);
        }
        const tab: Tab = { doc, group, element, dirtyMark, viewState: null, preview: false, view, label };
        setPreview(tab, preview);
        element.addEventListener('click', (event) => {
            if ((event.target as Element).closest('.tab-close')) {
                closeTabs(group, [tab]);
            } else {
                activate(group, tab);
            }
        });
        element.addEventListener('auxclick', (event) => { if (event.button === 1) { closeTabs(group, [tab]); } });
        element.addEventListener('dblclick', (event) => {
            if (!(event.target as Element).closest('.tab-close')) { setPreview(tab, false); }
        });
        element.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            activate(group, tab);
            callbacks.showTabMenu?.(doc.path, event.clientX, event.clientY);
        });
        group.strip.insertBefore(element, before);
        group.tabs.set(doc.path, tab);
        refreshDoc(doc);
        return tab;
    }

    // #170: the save settings in force, and the .editorconfig files read so far (by folder).
    let fileSettings: FileSettings = { trimTrailingWhitespace: false, insertFinalNewline: false, formatOnSave: false };
    let autoSave: AutoSave = 'off';
    let autoSaveDelay = 1000;
    let defaultIndent = { insertSpaces: true, tabSize: 4 };
    let editorConfigs = new Map<string, Promise<EditorConfigFile | null>>();

    function readEditorConfig(folder: string): Promise<EditorConfigFile | null> {
        let pending = editorConfigs.get(folder);
        if (!pending) {
            const path = folder === '' ? EDITORCONFIG_NAME : `${folder}/${EDITORCONFIG_NAME}`;
            pending = api.readFile(path).then(
                (content) => (content.kind === 'text' ? parseEditorConfig(content.text) : null),
                () => null,
            );
            editorConfigs.set(folder, pending);
        }
        return pending;
    }

    async function applyEditorConfig(doc: Doc): Promise<void> {
        const folders = editorConfigFolders(doc.path);
        const read = await Promise.all(folders.map(async (folder) => ({ folder, file: await readEditorConfig(folder) })));
        if (docs.get(doc.path) !== doc) {
            return; // closed meanwhile
        }
        const had = indentationOf(doc.config) !== null;
        doc.config = resolveEditorConfig(read.flatMap((entry) => (entry.file ? [{ folder: entry.folder, file: entry.file }] : [])), doc.path);
        const indentation = indentationOf(doc.config);
        if (indentation) {
            doc.model.updateOptions(indentation);
        } else if (had) {
            // The .editorconfig no longer says: back to what the content suggests.
            doc.model.detectIndentation(defaultIndent.insertSpaces, defaultIndent.tabSize);
        }
    }

    function scheduleAutoSave(doc: Doc): void {
        clearTimeout(doc.autoSaveTimer);
        if (autoSave !== 'afterDelay' || !isDirty(doc) || doc.saving) {
            return;
        }
        doc.autoSaveTimer = setTimeout(() => {
            if (docs.get(doc.path) === doc) {
                void saveFile(doc, 'afterDelay');
            }
        }, autoSaveDelay);
    }

    function saveOnFocusChange(targets: readonly Doc[]): void {
        if (autoSave !== 'onFocusChange') {
            return;
        }
        for (const doc of targets) {
            if (isDirty(doc)) {
                void saveFile(doc, 'focusChange');
            }
        }
    }
    window.addEventListener('blur', () => saveOnFocusChange([...docs.values()]));

    /**
     * Closes `targets` (tabs of `group`) after one question about the unsaved
     * files that no other group still shows; false if the person said no. A
     * document goes when its last tab does; an emptied second group goes too,
     * unless `collapse` is false (a rename reopens its tabs).
     */
    function closeTabs(group: Group, targets: readonly Tab[], ask = true, collapse = true): boolean {
        if (targets.length === 0) {
            return true;
        }
        const closing = new Set(targets);
        const leaving = targets.filter((tab) => tabsOf(tab.doc).every((other) => closing.has(other)));
        // #256: a custom view may keep its tab open (it asks its own question).
        if (ask && targets.some((tab) => tab.view?.canClose?.() === false)) {
            return false;
        }
        const question = ask ? discardQuestion(targets.map((tab) => tab.doc.path), new Set(leaving.filter((tab) => isDirty(tab.doc)).map((tab) => tab.doc.path))) : null;
        if (question !== null && !window.confirm(question)) {
            return false;
        }
        const order = ordered(group);
        const activeIndex = group.active ? order.indexOf(group.active) : -1;
        for (const tab of targets) {
            group.tabs.delete(tab.doc.path);
            tab.element.remove();
            disposeView(tab);
        }
        for (const tab of leaving) {
            disposeDoc(tab.doc);
        }
        if (group.active && closing.has(group.active)) {
            // The neighbour on the right that stays open, else the one on the left.
            const next = order.slice(activeIndex + 1).find((tab) => !closing.has(tab))
                ?? order.slice(0, activeIndex).reverse().find((tab) => !closing.has(tab))
                ?? null;
            group.active = null;
            if (next || !collapse || groups.length === 1) {
                activate(group, next, group === current);
            }
        }
        if (collapse) {
            collapseEmptyGroups();
        }
        reportUnsaved();
        if (leaving.length > 0) {
            callbacks.onOpenFilesChange?.();
        }
        sessionChanged();
        return true;
    }

    /** #256: a closing tab's custom view leaves its group for good. */
    function disposeView(tab: Tab): void {
        if (!tab.view) {
            return;
        }
        if (tab.view.element.isConnected) {
            tab.view.onHide?.();
            tab.view.element.remove();
        }
        tab.view.dispose?.();
    }

    /** #168: a group left without tabs goes, as long as another one stays. */
    function collapseEmptyGroups(): void {
        for (const group of [...groups]) {
            if (groups.length > 1 && group.tabs.size === 0) {
                removeGroup(group);
            }
        }
    }

    /** The text to write: Monaco keeps a byte order mark outside the model's text, so put it back. */
    function fileText(doc: Doc): string {
        const text = doc.model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true);
        return doc.bom && !text.startsWith(BOM) ? BOM + text : text;
    }

    /** #170: formats the active file; rejects on a formatter error or after FORMAT_TIMEOUT_MS. */
    async function formatActive(): Promise<boolean> {
        const action = current.editor.getAction('editor.action.formatDocument');
        if (!action || !action.isSupported()) {
            return false;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`the formatter took longer than ${FORMAT_TIMEOUT_MS / 1000} s`)), FORMAT_TIMEOUT_MS);
        });
        try {
            await Promise.race([action.run(), timeout]);
        } finally {
            clearTimeout(timer);
        }
        return true;
    }

    /** #170: the save-time edits (format, whitespace, line endings, byte order mark) for `doc`. */
    async function prepareSave(doc: Doc, reason: SaveReason): Promise<void> {
        const rules = saveRules(fileSettings, doc.config);
        const isActive = doc === activeDoc() && current.editor.getModel() === doc.model;
        if (rules.formatOnSave && reason !== 'afterDelay' && isActive) {
            try {
                await formatActive();
            } catch (error) {
                callbacks.onStatus(`${doc.path} was saved without formatting: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const cursorLines = reason === 'afterDelay' && isActive
            ? new Set((current.editor.getSelections() ?? []).flatMap((selection) => [selection.startLineNumber, selection.endLineNumber]))
            : new Set<number>();
        const edits = whitespaceEdits(doc.model.getLinesContent(), rules, doc.model.getEOL(), cursorLines);
        if (edits.length > 0) {
            const selections = isActive ? current.editor.getSelections() ?? [] : [];
            doc.model.pushEditOperations(selections, edits.map((edit) => ({
                range: new monaco.Range(edit.line, edit.startColumn, edit.line, edit.endColumn),
                text: edit.text,
            })), () => null);
        }
        const eol = rules.endOfLine === 'crlf' ? '\r\n' : rules.endOfLine === 'lf' ? '\n' : null;
        if (eol !== null && doc.model.getEOL() !== eol) {
            doc.model.pushEOL(eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
        }
        if (rules.bom !== undefined) {
            doc.bom = rules.bom;
        }
    }

    async function saveFile(doc: Doc, reason: SaveReason = 'explicit'): Promise<boolean> {
        if (!isDirty(doc)) {
            return true;
        }
        if (reason !== 'explicit' && (doc.saving || doc.diskState !== 'same')) {
            // An auto save never asks: a file that changed or vanished on disk waits for Save.
            return false;
        }
        clearTimeout(doc.autoSaveTimer);
        doc.saving = true;
        try {
            return await writeFile(doc, reason);
        } finally {
            doc.saving = false;
        }
    }

    async function writeFile(doc: Doc, reason: SaveReason): Promise<boolean> {
        await prepareSave(doc, reason);
        const version = doc.model.getAlternativeVersionId();
        const write = (expected: number | undefined) => api.writeFile(doc.path, fileText(doc), expected);
        try {
            let result;
            try {
                result = await write(doc.mtimeMs);
            } catch (error) {
                if (!String(error).includes(MODIFIED_ON_DISK)) {
                    throw error;
                }
                if (reason !== 'explicit') {
                    doc.diskState = 'changed';
                    refreshDoc(doc);
                    callbacks.onStatus(`${doc.path} changed on disk, so it was not auto-saved. Save it to choose.`);
                    return false;
                }
                if (!window.confirm(`${doc.path} changed on disk since it was opened.\n\nOverwrite it with your version?`)) {
                    callbacks.onStatus(`${doc.path} was not saved: it changed on disk.`);
                    return false;
                }
                result = await write(undefined);
            }
            doc.savedVersion = version;
            doc.mtimeMs = result.mtimeMs;
            doc.diskState = 'same';
            refreshDoc(doc);
            if (reason === 'explicit') {
                callbacks.onStatus(`Saved ${doc.path}`);
            }
            return true;
        } catch (error) {
            callbacks.onStatus(`Could not save ${doc.path}: ${String(error)}`);
            return false;
        }
    }

    /** Re-reads one open file after the watcher reported it. */
    async function followDisk(doc: Doc): Promise<void> {
        if (doc.custom) {
            // #256: a file viewer reads its file again (or finds it gone) on its own.
            for (const tab of tabsOf(doc)) {
                tab.view?.fileChanged?.('changed');
            }
            return;
        }
        let content: FileContent;
        try {
            content = await api.readFile(doc.path);
        } catch {
            if (doc.diskState !== 'deleted') {
                doc.diskState = 'deleted';
                refreshDoc(doc);
                callbacks.onStatus(`${doc.path} was deleted on disk. Its text stays open until you close the tab.`);
            }
            return;
        }
        if (content.kind !== 'text' || content.mtimeMs === doc.mtimeMs) {
            if (doc.diskState === 'deleted' && content.kind === 'text') {
                doc.diskState = 'same';
                refreshDoc(doc);
            }
            return;
        }
        if (docs.get(doc.path) !== doc) {
            return; // closed while reading
        }
        if (isDirty(doc)) {
            doc.diskState = 'changed';
            refreshDoc(doc);
            callbacks.onStatus(`${doc.path} changed on disk. Your unsaved version is kept; saving asks before overwriting.`);
            return;
        }
        doc.bom = content.text.startsWith(BOM);
        if (content.text !== fileText(doc)) {
            doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: content.text }], () => null);
        }
        doc.savedVersion = doc.model.getAlternativeVersionId();
        doc.mtimeMs = content.mtimeMs;
        doc.diskState = 'same';
        refreshDoc(doc);
        callbacks.onFileClean?.(doc.path);
    }

    // #167/#168: dragging a tab, within its strip or to the other group's.
    let dragged: Tab | null = null;
    const clearDropMarks = (): void => {
        for (const group of groups) {
            for (const element of group.strip.children) {
                element.classList.remove('is-drop-before', 'is-drop-after');
            }
            group.strip.classList.remove('is-drop-target');
        }
    };

    /** Opens `doc` in `group` (a tab of its own there), or activates the tab it already has. */
    function showDoc(group: Group, doc: Doc, options: { preview?: boolean; before?: Element | null; viewState?: monaco.editor.ICodeEditorViewState | null; focus?: boolean } = {}): Tab {
        const existing = group.tabs.get(doc.path);
        if (existing) {
            if (!options.preview) {
                setPreview(existing, false);
            }
            activate(group, existing, options.focus ?? true);
            return existing;
        }
        // A new preview takes the place of the group's current one, unless that one was edited meanwhile.
        const previous = options.preview ? ordered(group).find((tab) => tab.preview && !isDirty(tab.doc)) : undefined;
        const tab = addTab(group, doc, options.preview === true, options.before ?? previous?.element ?? null);
        tab.viewState = options.viewState ?? null;
        activate(group, tab, options.focus ?? true);
        if (previous) {
            closeTabs(group, [previous], false);
        }
        sessionChanged();
        return tab;
    }

    function createGroup(): Group {
        const strip = el('div', { className: 'editor-tabs', attrs: { role: 'tablist', 'aria-label': 'Open editors', 'data-testid': 'editor-tabs' } });
        const host = el('div', { className: 'editor-host', attrs: { 'data-testid': 'editor-host' } });
        const placeholder = el('div', { className: 'editor-placeholder muted' });
        const customHost = el('div', { className: 'editor-custom-host', attrs: { 'data-testid': 'editor-custom-host', hidden: '' } });
        const root = el('div', { className: 'editor-group', attrs: { 'data-testid': 'editor-group' } }, [strip, host, customHost, placeholder]);
        const editor = monaco.editor.create(host, { ...editorOptions, model: null });
        const sceneShown = editor.createContextKey<boolean>('codexrSceneShown', sceneIsShown);
        const group: Group = { root, strip, host, placeholder, customHost, editor, sceneShown, tabs: new Map(), active: null, disposables: [] };
        const ifCurrent = (listener: () => void) => () => { if (current === group) { listener(); } };
        group.disposables.push(
            editor.onDidChangeCursorSelection(ifCurrent(scheduleStatus)),
            editor.onDidChangeModel(ifCurrent(scheduleStatus)),
            editor.onDidChangeModelOptions(ifCurrent(scheduleStatus)),
            editor.onDidChangeModelLanguage(ifCurrent(scheduleStatus)),
            editor.onDidChangeModelContent((event) => { if (event.eol && current === group) { scheduleStatus(); } }),
            editor.onDidFocusEditorWidget(() => focusGroupInternal(group)),
            editor.onDidScrollChange((event) => { if (event.scrollTopChanged) { syncPreview(group); } }),
            editor.onDidBlurEditorText(() => saveOnFocusChange(group.active ? [group.active.doc] : [])),
            // #178: the context menu entry follows the scene (Monaco hides an action whose precondition is false).
            editor.addAction({
                id: 'codexr.revealInScene',
                label: 'Reveal in XR Scene',
                precondition: 'codexrSceneShown',
                contextMenuGroupId: 'codexr',
                contextMenuOrder: 1,
                run: () => {
                    if (group.active) {
                        callbacks.revealInScene?.(group.active.doc.path);
                    }
                },
            }),
        );
        if (gitDecorations) {
            group.disposables.push(gitDecorations.addEditor(editor));
        }
        if (debugDecorations) {
            group.disposables.push(debugDecorations.addEditor(editor));
        }
        root.addEventListener('mousedown', () => focusGroupInternal(group), true);

        strip.addEventListener('keydown', (event) => {
            const order = ordered(group);
            const active = group.active;
            const index = active ? order.indexOf(active) : -1;
            if (active && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
                const rect = active.element.getBoundingClientRect();
                callbacks.showTabMenu?.(active.doc.path, rect.left, rect.bottom);
                event.preventDefault();
                return;
            }
            const target = event.key === 'ArrowRight' ? order[index + 1]
                : event.key === 'ArrowLeft' ? order[index - 1]
                    : event.key === 'Home' ? order[0]
                        : event.key === 'End' ? order[order.length - 1]
                            : undefined;
            if (target) {
                activate(group, target);
                target.element.focus();
                event.preventDefault();
            }
        });

        const dropTarget = (event: DragEvent): { readonly before: HTMLElement | null; readonly mark: HTMLElement | null; readonly after: boolean } => {
            const over = (event.target as Element).closest<HTMLElement>('.editor-tab');
            if (!over) {
                return { before: null, mark: strip.lastElementChild as HTMLElement | null, after: true };
            }
            const rect = over.getBoundingClientRect();
            const after = event.clientX > rect.left + rect.width / 2;
            return { before: after ? over.nextElementSibling as HTMLElement | null : over, mark: over, after };
        };
        strip.addEventListener('dragstart', (event) => {
            const element = (event.target as Element).closest<HTMLElement>('.editor-tab');
            dragged = element ? group.tabs.get(element.dataset['path'] ?? '') ?? null : null;
            if (!dragged || !event.dataTransfer) {
                return;
            }
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', dragged.doc.path);
            dragged.element.classList.add('is-dragging');
        });
        strip.addEventListener('dragover', (event) => {
            if (!dragged) {
                return;
            }
            event.preventDefault();
            if (event.dataTransfer) { event.dataTransfer.dropEffect = 'move'; }
            clearDropMarks();
            const { mark, after } = dropTarget(event);
            if (mark) {
                mark.classList.add(after ? 'is-drop-after' : 'is-drop-before');
            } else {
                strip.classList.add('is-drop-target');
            }
        });
        strip.addEventListener('dragleave', (event) => {
            if (!strip.contains(event.relatedTarget as Node | null)) { clearDropMarks(); }
        });
        strip.addEventListener('drop', (event) => {
            const moving = dragged;
            if (!moving) {
                return;
            }
            event.preventDefault();
            const { before } = dropTarget(event);
            if (moving.group !== group) {
                moveTabToGroup(moving, group, before);
                return;
            }
            const order = moveTab(ordered(group).map((tab) => tab.doc.path), moving.doc.path, before?.dataset['path'] ?? null);
            for (const path of order) {
                const tab = group.tabs.get(path);
                if (tab) { strip.append(tab.element); }
            }
            setPreview(moving, false);
            moving.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            sessionChanged();
        });
        strip.addEventListener('dragend', () => {
            dragged?.element.classList.remove('is-dragging');
            dragged = null;
            clearDropMarks();
        });
        // A vertical wheel scrolls an overflowing strip sideways, as in VS Code.
        strip.addEventListener('wheel', (event) => {
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && strip.scrollWidth > strip.clientWidth) {
                strip.scrollLeft += event.deltaY;
                event.preventDefault();
            }
        }, { passive: false });

        if (groups.length > 0) {
            groupsRow.append(splitSash, root);
        } else {
            groupsRow.append(root);
        }
        groups.push(group);
        layoutGroups();
        return group;
    }

    function removeGroup(group: Group): void {
        const index = groups.indexOf(group);
        if (index < 0 || groups.length === 1) {
            return;
        }
        groups.splice(index, 1);
        for (const disposable of group.disposables) {
            disposable.dispose();
        }
        group.editor.dispose();
        group.root.remove();
        splitSash.remove();
        const remaining = groups[0];
        if (remaining) {
            if (current === group) {
                activate(remaining, remaining.active);
            }
            focusGroupInternal(remaining, false);
        }
        layoutGroups();
        sessionChanged();
    }

    /** #168: a tab dropped on the other group moves there (the file's model goes with it, unchanged). */
    function moveTabToGroup(tab: Tab, target: Group, before: Element | null): void {
        const viewState = tab.group.active === tab && !tab.view ? tab.group.editor.saveViewState() : tab.viewState;
        const preview = tab.preview;
        showDoc(target, tab.doc, { before: target.tabs.has(tab.doc.path) ? null : before, viewState, preview });
        closeTabs(tab.group, [tab], false);
        sessionChanged();
    }

    function layoutGroups(): void {
        const [first, second] = groups;
        splitSash.hidden = !second;
        container.classList.toggle('is-split', Boolean(second));
        if (first) {
            // With the preview open, the groups share what it leaves.
            const groupsShare = preview ? 1 - previewShare : 1;
            first.root.style.flex = second ? `0 1 ${(split * groupsShare * 100).toFixed(3)}%` : '1 1 auto';
        }
        if (second) {
            second.root.style.flex = '1 1 0';
        }
        if (preview) {
            preview.element.style.flex = `0 1 ${(previewShare * 100).toFixed(3)}%`;
            if (first && !second) {
                first.root.style.flex = '1 1 0';
            }
            previewSash.setAttribute('aria-valuenow', String(Math.round((1 - previewShare) * 100)));
        }
        splitSash.setAttribute('aria-valuenow', String(Math.round(split * 100)));
        splitSash.setAttribute('aria-valuemin', '15');
        splitSash.setAttribute('aria-valuemax', '85');
    }

    function setSplit(value: number): void {
        split = clampSplit(value);
        layoutGroups();
        sessionChanged();
    }
    splitSash.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        splitSash.setPointerCapture(event.pointerId);
        const rect = groupsRow.getBoundingClientRect();
        const move = (moveEvent: PointerEvent): void => {
            const width = rect.width * (preview ? 1 - previewShare : 1);
            if (width > 0) {
                setSplit((moveEvent.clientX - rect.left) / width);
            }
        };
        const up = (): void => {
            splitSash.removeEventListener('pointermove', move);
            splitSash.removeEventListener('pointerup', up);
            splitSash.removeEventListener('pointercancel', up);
        };
        splitSash.addEventListener('pointermove', move);
        splitSash.addEventListener('pointerup', up);
        splitSash.addEventListener('pointercancel', up);
    });
    splitSash.addEventListener('dblclick', () => setSplit(DEFAULT_SPLIT));
    splitSash.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowLeft' ? -0.02 : event.key === 'ArrowRight' ? 0.02 : 0;
        if (step !== 0) {
            setSplit(split + step);
            event.preventDefault();
        }
    });

    function setPreviewShare(value: number): void {
        previewShare = clampSplit(value);
        layoutGroups();
    }
    previewSash.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        previewSash.setPointerCapture(event.pointerId);
        const rect = groupsRow.getBoundingClientRect();
        const move = (moveEvent: PointerEvent): void => {
            if (rect.width > 0) {
                setPreviewShare((rect.right - moveEvent.clientX) / rect.width);
            }
        };
        const up = (): void => {
            previewSash.removeEventListener('pointermove', move);
            previewSash.removeEventListener('pointerup', up);
            previewSash.removeEventListener('pointercancel', up);
        };
        previewSash.addEventListener('pointermove', move);
        previewSash.addEventListener('pointerup', up);
        previewSash.addEventListener('pointercancel', up);
    });
    previewSash.addEventListener('dblclick', () => setPreviewShare(DEFAULT_SPLIT));
    previewSash.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowLeft' ? 0.02 : event.key === 'ArrowRight' ? -0.02 : 0;
        if (step !== 0) {
            setPreviewShare(previewShare + step);
            event.preventDefault();
        }
    });

    /** #179: the preview takes the active Markdown file; another kind of file leaves it on the last one. */
    function followPreview(doc: Doc): void {
        if (!preview || previewDoc === doc || !isMarkdownDoc(doc)) {
            return;
        }
        previewDoc = doc;
        preview.show(doc.path, doc.model.getValue());
        const group = groups.find((candidate) => candidate.active?.doc === doc);
        if (group) {
            syncPreview(group);
        }
    }
    const isMarkdownDoc = (doc: Doc): boolean => doc.model.getLanguageId() === 'markdown' || isMarkdownPath(doc.path);

    function syncPreview(group: Group): void {
        if (preview && previewDoc && group.active?.doc === previewDoc) {
            preview.scrollToLine(group.editor.getVisibleRanges()[0]?.startLineNumber ?? 1);
        }
    }

    /** #253: the view of a Markdown preview tab: the open file's live text, else the file on disk. */
    function markdownPreviewTab(path: string, context: CustomEditorContext): CustomEditorView {
        const view = createMarkdownPreview({
            readImage: (image) => api.readImage(image),
            openExternalLink: (url) => api.openExternalLink(url),
            openFile: (target) => void openIn(current, target),
            onStatus: (message) => callbacks.onStatus(message),
            onClose: () => context.close(),
        });
        view.element.classList.add('is-tab');
        let subscription: monaco.IDisposable | null = null;
        let disposed = false;
        const follow = async (): Promise<void> => {
            const doc = docs.get(path);
            if (doc && !doc.custom) {
                if (!subscription) {
                    subscription = doc.model.onDidChangeContent(() => view.update(doc.model.getValue()));
                    doc.model.onWillDispose(() => { subscription?.dispose(); subscription = null; });
                }
                view.show(path, doc.model.getValue());
                return;
            }
            try {
                const content = await api.readFile(path);
                if (!disposed) {
                    view.show(path, content.kind === 'text' ? content.text : `*${path} cannot be previewed (${content.kind}).*`);
                }
            } catch {
                if (!disposed) {
                    view.show(path, `*${path} is gone.*`);
                }
            }
        };
        void follow();
        return {
            element: view.element,
            onShow: () => void follow(),
            fileChanged: () => { if (!subscription) { void follow(); } },
            dispose: () => {
                disposed = true;
                subscription?.dispose();
                view.dispose();
            },
        };
    }

    function openPreview(): boolean {
        const doc = activeDoc();
        if (!doc || !isMarkdownDoc(doc)) {
            return false;
        }
        if (!preview) {
            preview = createMarkdownPreview({
                readImage: (path) => api.readImage(path),
                openExternalLink: (url) => api.openExternalLink(url),
                openFile: (path) => void openIn(current, path),
                onStatus: (message) => callbacks.onStatus(message),
                onClose: () => closePreview(),
            });
            groupsRow.append(previewSash, preview.element);
            container.classList.add('has-preview');
        }
        previewDoc = null;
        followPreview(doc);
        layoutGroups();
        return true;
    }

    function closePreview(): void {
        if (!preview) {
            return;
        }
        preview.dispose();
        previewSash.remove();
        preview = null;
        previewDoc = null;
        container.classList.remove('has-preview');
        layoutGroups();
        current.editor.focus();
    }

    /** Opens `path` in `group`: the document if it is already open (in either group), else read from disk. */
    async function openIn(group: Group, path: string, options: OpenOptions & { viewState?: monaco.editor.ICodeEditorViewState | null; focus?: boolean } = {}): Promise<Tab | null> {
        const known = docs.get(path) ?? customDocFor(path);
        if (known) {
            return showDoc(group, known, options);
        }
        let content: FileContent;
        try {
            content = await api.readFile(path);
        } catch (error) {
            callbacks.onStatus(`Could not open ${path}: ${String(error)}`);
            return null;
        }
        if (content.kind !== 'text') {
            const size = `${(content.size / (1024 * 1024)).toFixed(1)} MB`;
            callbacks.onStatus(content.kind === 'binary' ? `${path} is a binary file.` : `${path} is too large to edit (${size}).`);
            return null;
        }
        if (!groups.includes(group)) {
            return null; // the group went while reading
        }
        // Opened meanwhile (a double click's first click opened the preview): reuse it.
        const doc = docs.get(path) ?? createDoc(content);
        return showDoc(group, doc, options);
    }

    /** Restores one group's saved tabs into `group`. */
    async function restoreGroup(group: Group, saved: GroupSession): Promise<void> {
        for (const entry of saved.tabs) {
            if (group.tabs.has(entry.path)) {
                continue;
            }
            let doc = docs.get(entry.path) ?? customDocFor(entry.path) ?? undefined;
            if (!doc) {
                let content: FileContent;
                try {
                    content = await api.readFile(entry.path);
                } catch {
                    continue; // gone since: skipped
                }
                if (content.kind !== 'text' || group.tabs.has(entry.path)) {
                    continue;
                }
                doc = docs.get(entry.path) ?? createDoc(content);
            }
            const tab = addTab(group, doc, entry.path === saved.preview);
            tab.viewState = (entry.viewState as monaco.editor.ICodeEditorViewState | null) ?? null;
        }
        const target = (saved.active === null ? undefined : group.tabs.get(saved.active)) ?? ordered(group)[0] ?? null;
        if (target) {
            activate(group, target, false);
        }
    }

    function groupSession(group: Group): GroupSession {
        if (group.active && !group.active.view) {
            group.active.viewState = group.editor.saveViewState();
        }
        const tabs = ordered(group);
        return {
            tabs: tabs.map((tab) => ({ path: tab.doc.path, viewState: tab.viewState })),
            active: group.active?.doc.path ?? null,
            preview: tabs.find((tab) => tab.preview)?.doc.path ?? null,
        };
    }

    current = createGroup();
    activate(current, null);

    return {
        activeLineCount: () => activeDoc()?.model.getLineCount() ?? null,
        statusState,
        async openAt(path, line, column, length) {
            await this.open(path);
            const doc = activeDoc();
            if (doc?.path !== path) {
                return;
            }
            const model = doc.model;
            const lineNumber = Math.min(Math.max(1, line), model.getLineCount());
            const selection = new monaco.Selection(lineNumber, column, lineNumber, Math.min(column + length, model.getLineMaxColumn(lineNumber)));
            current.editor.setSelection(selection);
            current.editor.revealRangeInCenterIfOutsideViewport(selection);
            current.editor.focus();
        },
        replaceInOpenFiles(paths, replace) {
            const handled: string[] = [];
            let replacements = 0;
            for (const path of paths) {
                const doc = docs.get(path);
                if (!doc || doc.custom) {
                    continue;
                }
                handled.push(path);
                const result = replace(doc.model.getValue());
                if (result.count > 0) {
                    doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: result.text }], () => null);
                    replacements += result.count;
                }
            }
            return { handled, replacements };
        },
        selectedText() {
            const selection = current.editor.getSelection();
            const model = activeDoc()?.model;
            if (!selection || !model || selection.isEmpty() || selection.startLineNumber !== selection.endLineNumber) {
                return '';
            }
            return model.getValueInRange(selection);
        },
        async applyAgentEdit(path, expected, text) {
            const doc = docs.get(path);
            if (!doc || doc.custom) {
                return 'not-open';
            }
            if (fileText(doc) !== expected) {
                return 'unsaved-changes';
            }
            doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text }], () => null);
            return (await saveFile(doc, 'explicit')) ? 'saved' : 'save-failed';
        },
        activeSelection() {
            const selection = current.editor.getSelection();
            const doc = activeDoc();
            if (!doc || !selection || selection.isEmpty()) {
                return null;
            }
            return { path: doc.path, startLine: selection.startLineNumber, endLine: selection.endLineNumber, text: doc.model.getValueInRange(selection) };
        },
        showSymbols() {
            if (!activeDoc()) {
                return;
            }
            current.editor.focus();
            void current.editor.getAction('editor.action.quickOutline')?.run();
        },
        setIndentation(indentation) {
            activeDoc()?.model.updateOptions({ insertSpaces: indentation.insertSpaces, tabSize: indentation.tabSize, indentSize: indentation.tabSize });
            current.editor.focus();
        },
        setEndOfLine(eol) {
            activeDoc()?.model.pushEOL(eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
            current.editor.focus();
        },
        setLanguage(languageId) {
            const doc = activeDoc();
            if (doc) {
                monaco.editor.setModelLanguage(doc.model, languageId);
            }
            current.editor.focus();
        },
        languages: () => monaco.languages.getLanguages(),
        breadcrumbBar,
        setSceneShown(shown): void {
            sceneIsShown = shown;
            for (const group of groups) {
                group.sceneShown.set(shown);
            }
        },
        activeModel: () => {
            const doc = activeDoc();
            return doc ? { path: doc.path, model: doc.model } : null;
        },
        goToLine(line, column, focus = true) {
            const doc = activeDoc();
            if (!doc) {
                return;
            }
            const lineNumber = Math.min(Math.max(1, line), doc.model.getLineCount());
            const maxColumn = doc.model.getLineMaxColumn(lineNumber);
            const position = { lineNumber, column: Math.min(Math.max(1, column ?? 1), maxColumn) };
            current.editor.setPosition(position);
            current.editor.revealPositionInCenterIfOutsideViewport(position);
            if (focus) {
                current.editor.focus();
            }
        },
        async open(path: string, options: OpenOptions = {}): Promise<void> {
            await openIn(current, path, options);
        },
        async split(path?: string): Promise<void> {
            const source = current;
            const target = path ?? source.active?.doc.path;
            if (!target) {
                return;
            }
            const viewState = source.active?.doc.path === target ? source.editor.saveViewState() : null;
            const other = groups.find((group) => group !== source) ?? (groups.length < MAX_GROUPS ? createGroup() : source);
            await openIn(other, target, { viewState });
        },
        focusGroup(index: number): boolean {
            const group = groups[index];
            if (!group) {
                return false;
            }
            focusGroupInternal(group);
            if (group.active) {
                group.editor.focus();
            } else {
                group.root.focus();
            }
            return true;
        },
        groupCount: () => groups.length,
        openCustom(input: CustomEditorInput, options: OpenOptions = {}): void {
            const doc = docs.get(input.id) ?? createCustomDoc(input);
            if (!doc.custom) {
                callbacks.onStatus(`${input.id} is already open as a file.`);
                return;
            }
            showDoc(current, doc, options);
        },
        registerCustomEditor: (resolver: CustomEditorResolver) => customEditors.register(resolver),
        openMarkdownPreview: () => openPreview(),
        activeTabId: () => current.active?.doc.path ?? null,
        compareWithSaved(path?: string): boolean {
            const doc = path === undefined ? activeDoc() : docs.get(path) ?? null;
            if (!doc || doc.custom) {
                return false;
            }
            const input = customEditors.resolve(compareSavedId(doc.path));
            if (input) {
                showDoc(current, docs.get(input.id) ?? createCustomDoc(input));
            }
            return input !== null;
        },
        compareFiles(left: string, right: string): void {
            const input = customEditors.resolve(compareFilesId(left, right));
            if (input) {
                showDoc(current, docs.get(input.id) ?? createCustomDoc(input));
            }
        },
        openMarkdownPreviewTab: () => {
            const doc = activeDoc();
            const input = doc && isMarkdownDoc(doc) ? customEditors.resolve(`${MARKDOWN_PREVIEW_PREFIX}${doc.path}`) : null;
            if (!input) {
                return false;
            }
            showDoc(current, docs.get(input.id) ?? createCustomDoc(input));
            return true;
        },
        closeMarkdownPreview: () => closePreview(),
        canPreviewMarkdown: () => {
            const doc = activeDoc();
            return doc !== null && isMarkdownDoc(doc);
        },
        markdownPreviewOpen: () => preview !== null,
        closeGroup(kind: CloseKind, path?: string): void {
            const group = current;
            const order = ordered(group);
            const targets = closeTargets(kind, order.map((tab) => ({ path: tab.doc.path, dirty: isDirty(tab.doc) })), path ?? group.active?.doc.path ?? null);
            closeTabs(group, targets.flatMap((target) => { const tab = group.tabs.get(target); return tab ? [tab] : []; }));
        },
        cycle(delta: number): void {
            const group = current;
            const next = cycleTab(ordered(group).map((tab) => tab.doc.path), group.active?.doc.path ?? null, delta);
            const tab = next === null ? undefined : group.tabs.get(next);
            if (tab) {
                activate(group, tab);
            }
        },
        applySettings(settings: SettingValues): void {
            const snapshot = { effective: settings };
            const lineHeight = settingOf<number>(snapshot, 'editor.lineHeight');
            const options: monaco.editor.IEditorOptions = {
                fontSize: settingOf<number>(snapshot, 'editor.fontSize'),
                fontFamily: settingOf<string>(snapshot, 'editor.fontFamily'),
                lineHeight,
                tabSize: settingOf<number>(snapshot, 'editor.tabSize'),
                insertSpaces: settingOf<boolean>(snapshot, 'editor.insertSpaces'),
                detectIndentation: settingOf<boolean>(snapshot, 'editor.detectIndentation'),
                wordWrap: settingOf<'off' | 'on' | 'bounded'>(snapshot, 'editor.wordWrap'),
                lineNumbers: settingOf<'on' | 'off' | 'relative'>(snapshot, 'editor.lineNumbers'),
                renderWhitespace: settingOf<'none' | 'boundary' | 'selection' | 'trailing' | 'all'>(snapshot, 'editor.renderWhitespace'),
                minimap: { enabled: settingOf<boolean>(snapshot, 'editor.minimap.enabled') },
                stickyScroll: { enabled: settingOf<boolean>(snapshot, 'editor.stickyScroll.enabled') },
                bracketPairColorization: { enabled: settingOf<boolean>(snapshot, 'editor.bracketPairColorization.enabled') },
                cursorBlinking: settingOf<'blink' | 'smooth' | 'phase' | 'expand' | 'solid'>(snapshot, 'editor.cursorBlinking'),
                smoothScrolling: settingOf<boolean>(snapshot, 'editor.smoothScrolling'),
            } as monaco.editor.IEditorOptions;
            editorOptions = { ...editorOptions, ...options };
            for (const group of groups) {
                group.editor.updateOptions(options);
            }
            gitDecorations?.setBlameEnabled(settingOf<boolean>(snapshot, 'git.blame.inline'));
            // #170: saving.
            fileSettings = {
                trimTrailingWhitespace: settingOf<boolean>(snapshot, 'files.trimTrailingWhitespace'),
                insertFinalNewline: settingOf<boolean>(snapshot, 'files.insertFinalNewline'),
                formatOnSave: settingOf<boolean>(snapshot, 'editor.formatOnSave'),
            };
            autoSave = settingOf<AutoSave>(snapshot, 'files.autoSave');
            autoSaveDelay = settingOf<number>(snapshot, 'files.autoSaveDelay');
            defaultIndent = { insertSpaces: settingOf<boolean>(snapshot, 'editor.insertSpaces'), tabSize: settingOf<number>(snapshot, 'editor.tabSize') };
            for (const doc of docs.values()) {
                scheduleAutoSave(doc);
            }
        },
        async formatDocument(): Promise<boolean> {
            const doc = activeDoc();
            if (!doc) {
                return false;
            }
            try {
                return await formatActive();
            } catch (error) {
                callbacks.onStatus(`Could not format ${doc.path}: ${error instanceof Error ? error.message : String(error)}`);
                return true;
            }
        },
        editorProblems(): Problem[] {
            return monaco.editor.getModelMarkers({}).flatMap((marker) => {
                if (marker.owner === METRIC_OWNER || marker.resource.scheme !== FILE_SCHEME || marker.severity < monaco.MarkerSeverity.Info) {
                    return [];
                }
                const code = typeof marker.code === 'string' ? marker.code : marker.code?.value;
                return [{
                    path: marker.resource.path.replace(/^\//, ''),
                    severity: markerSeverity(marker.severity),
                    message: marker.message,
                    source: marker.source ?? marker.owner,
                    origin: 'editor' as const,
                    ...(code ? { code } : {}),
                    startLine: marker.startLineNumber,
                    startColumn: marker.startColumn,
                    endLine: marker.endLineNumber,
                    endColumn: marker.endColumn,
                }];
            });
        },
        gitChanged(): void {
            gitDecorations?.repositoryChanged();
        },
        breakpointsChanged(path: string | null): void {
            debugDecorations?.refresh(path);
        },
        setExecutionPoint(point): void {
            debugDecorations?.setExecutionPoint(point);
        },
        setFunctionMetrics(metricFiles: readonly FileFunctionMetrics[], thresholds: MetricThresholds, enabled: boolean): void {
            metricLens.update(metricFiles, thresholds, enabled);
        },
        setMetricProblems(problems: readonly Problem[]): void {
            const next = new Map<string, Problem[]>();
            for (const problem of problems) {
                next.set(problem.path, [...(next.get(problem.path) ?? []), problem]);
            }
            const touched = new Set([...metricProblems.keys(), ...next.keys()]);
            metricProblems = next;
            for (const path of touched) {
                const doc = docs.get(path);
                if (doc) {
                    applyMetricMarkers(doc);
                }
            }
        },
        keepActive(): void {
            const tab = activeTab();
            if (tab) {
                setPreview(tab, false);
            }
        },
        session(): TabSession {
            const [first, second] = groups;
            const firstSession = first ? groupSession(first) : { tabs: [], active: null, preview: null };
            if (!second) {
                return firstSession;
            }
            return { ...firstSession, second: groupSession(second), split, focus: current === second ? 1 : 0 };
        },
        async restore(session: TabSession): Promise<void> {
            const first = groups[0] ?? current;
            await restoreGroup(first, session);
            if (session.second && session.second.tabs.length > 0) {
                split = clampSplit(session.split ?? DEFAULT_SPLIT);
                const second = groups[1] ?? createGroup();
                await restoreGroup(second, session.second);
                collapseEmptyGroups();
            }
            const focus = groups[session.focus ?? 0] ?? groups[0];
            if (focus) {
                activate(focus, focus.active, false);
            }
            layoutGroups();
            sessionChanged();
        },
        async save(): Promise<void> {
            const doc = activeDoc();
            if (doc) {
                await saveFile(doc);
            }
        },
        async saveAll(): Promise<void> {
            const results = await Promise.all([...docs.values()].map((doc) => saveFile(doc)));
            const failed = results.filter((ok) => !ok).length;
            if (failed === 0) {
                callbacks.onStatus('All files saved');
            }
            // Always report after Save All: the window may be waiting on it to close.
            reportUnsaved(true);
        },
        closeActive(): void {
            const tab = activeTab();
            if (tab) {
                closeTabs(current, [tab]);
            }
        },
        reset(): void {
            closePreview();
            for (const group of [...groups].reverse()) {
                for (const tab of group.tabs.values()) {
                    tab.element.remove();
                    disposeView(tab);
                }
                group.tabs.clear();
                group.active = null;
                removeGroup(group);
            }
            for (const doc of [...docs.values()]) {
                disposeDoc(doc);
            }
            editorConfigs = new Map();
            const only = groups[0];
            if (only) {
                activate(only, null);
            }
            reportUnsaved();
            callbacks.onOpenFilesChange?.();
        },
        dirtyPaths: () => [...docs.values()].filter(isDirty).map((doc) => doc.path),
        openPaths: () => [...new Set([...docs.values()].flatMap(watchedPaths))],
        async entryMoved(from: string, to: string | null): Promise<void> {
            const affected = [...docs.values()].filter((doc) => doc.path === from || doc.path.startsWith(`${from}/`));
            const reopen: { group: Group; path: string; active: boolean }[] = [];
            for (const doc of affected) {
                if (isDirty(doc)) {
                    doc.diskState = 'deleted';
                    refreshDoc(doc);
                    continue;
                }
                for (const tab of tabsOf(doc)) {
                    if (to !== null) {
                        reopen.push({ group: tab.group, path: to + doc.path.slice(from.length), active: tab.group.active === tab });
                    }
                    closeTabs(tab.group, [tab], true, false);
                }
            }
            const focused = current;
            for (const entry of reopen) {
                await openIn(entry.group, entry.path, { focus: false });
            }
            for (const entry of reopen.filter((item) => item.active)) {
                await openIn(entry.group, entry.path, { focus: false });
            }
            collapseEmptyGroups();
            for (const group of groups) {
                if (!group.active) {
                    activate(group, ordered(group)[0] ?? null, false);
                }
            }
            if (groups.includes(focused)) {
                focusGroupInternal(focused);
            }
        },
        async onDiskChanged(paths: readonly string[]): Promise<void> {
            const changed = new Set(paths);
            // #170: an .editorconfig changed: read them again and re-apply them to every open file.
            if (paths.some((path) => path === EDITORCONFIG_NAME || path.endsWith(`/${EDITORCONFIG_NAME}`))) {
                editorConfigs = new Map();
                await Promise.all([...docs.values()].filter((doc) => !doc.custom).map(applyEditorConfig));
            }
            await Promise.all([...docs.values()].filter((doc) => watchedPaths(doc).some((path) => changed.has(path))).map(followDisk));
        },
    };
}
