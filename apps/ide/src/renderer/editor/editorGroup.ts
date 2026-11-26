import { MODIFIED_ON_DISK, type CodeXRApi, type FileContent } from '../../shared/api.ts';
import { el, fileIcon, icon } from '../dom.ts';
import { followSystemTheme, monaco } from './monaco.ts';
import { languageName, type EditorStatusState, type EndOfLine, type Indentation, type LanguageInfo } from './editorStatusModel.ts';
import { settingOf, type SettingValues } from '../../shared/settings.ts';
import type { FileFunctionMetrics, MetricThresholds, Problem, ProblemSeverity } from '../../shared/problems.ts';
import { installMetricLens } from './metricLens.ts';
import { closeTargets, cycleTab, discardQuestion, moveTab, type CloseKind, type TabSession } from './tabsModel.ts';
import { EDITORCONFIG_NAME, editorConfigFolders, parseEditorConfig, resolveEditorConfig, type EditorConfigFile, type EditorConfigProperties } from './editorConfig.ts';
import { FORMAT_TIMEOUT_MS, indentationOf, saveRules, whitespaceEdits, type AutoSave, type FileSettings, type SaveReason } from './saveTransforms.ts';

/**
 * The editor area (#14): one Monaco editor, one model per open file, and a
 * tab strip. A tab is dirty while its model differs from what was last read
 * or saved (Monaco's alternative version id, so undoing back to the saved
 * text clears it). Saves send the modification time the file had when it was
 * read, and the main process refuses the write if it moved.
 *
 * Files also follow the disk: when the watcher reports an open file, a clean
 * tab takes the new text as one undoable edit, while a dirty tab keeps the
 * person's text and is marked as conflicting (or deleted) until it is saved.
 *
 * Tabs (#167): the DOM order of the strip is the tab order. A preview tab
 * (italic) is what a single click in the explorer opens; the next preview
 * replaces it, and editing it, double-clicking it or opening it for keeps
 * makes it a normal tab. Tabs drag to reorder, close in groups from their
 * context menu (one question for all the unsaved ones), and the open tabs
 * with their view state are a session the folder restores.
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
const BOM = '\uFEFF';

interface OpenFile {
    readonly path: string;
    readonly model: monaco.editor.ITextModel;
    readonly tab: HTMLElement;
    readonly dirtyMark: HTMLElement;
    savedVersion: number;
    mtimeMs: number;
    /** What the disk did behind an unsaved tab, shown on the tab until the next save. */
    diskState: 'same' | 'changed' | 'deleted';
    viewState: monaco.editor.ICodeEditorViewState | null;
    /** The file starts with a UTF-8 byte order mark, written back on save (#166). */
    bom: boolean;
    /** #167: a preview tab, replaced by the next preview until it is kept. */
    preview: boolean;
    /** #170: what the file's `.editorconfig` files set. */
    config: EditorConfigProperties;
    /** #178: the metric lenses showed "out of date" (unsaved changes) at the last check. */
    lensStale: boolean;
    /** #170: the pending auto save after a delay. */
    autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
    /** #170: a save is being written (an auto save does not start a second one). */
    saving: boolean;
}

export interface OpenOptions {
    /** #167: open as the preview tab (a single click in the explorer). */
    readonly preview?: boolean;
}

/** #173: Monaco's resources for workspace files, and the owner of the Code-XR metric markers. */
const FILE_SCHEME = 'codexr-file';
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
    /** #172: the bar above the editor where the breadcrumbs go (editor/breadcrumbs.ts). */
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
    /** #167: closes a group of tabs around `path` (the active tab by default), asking once about unsaved ones. */
    closeGroup(kind: CloseKind, path?: string): void;
    /** #167: activates the tab `delta` steps away, wrapping around. */
    cycle(delta: number): void;
    /** #167: keeps the active preview tab. */
    keepActive(): void;
    /** #167: the open tabs in order, with view states, for the folder's session. */
    session(): TabSession;
    /** #167: reopens a saved session's tabs (files that are gone are skipped). */
    restore(session: TabSession): Promise<void>;
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
    },
): EditorGroup {
    const tabs = el('div', { className: 'editor-tabs', attrs: { role: 'tablist', 'aria-label': 'Open editors', 'data-testid': 'editor-tabs' } });
    const breadcrumbBar = el('div', { className: 'editor-breadcrumbs', attrs: { 'data-testid': 'breadcrumbs', hidden: '' } });
    const host = el('div', { className: 'editor-host', attrs: { 'data-testid': 'editor-host' } });
    const placeholder = el('div', { className: 'editor-placeholder muted' });
    container.replaceChildren(tabs, breadcrumbBar, host, placeholder);
    container.classList.add('has-editors');

    followSystemTheme();
    const editor = monaco.editor.create(host, {
        automaticLayout: true,
        fontFamily: "ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace",
        fontSize: 13,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        // The default colour provider turns any "#165" (an issue number in a comment) into a
        // colour swatch; CSS, SCSS and LESS keep their own colour decorators.
        defaultColorDecorators: 'never',
        model: null,
    });

    const files = new Map<string, OpenFile>();
    let active: OpenFile | null = null;

    // #173: the metric problems by file; squiggles on the open ones, under their own marker owner.
    let metricProblems = new Map<string, Problem[]>();
    function applyMetricMarkers(file: OpenFile): void {
        const model = file.model;
        monaco.editor.setModelMarkers(model, METRIC_OWNER, (metricProblems.get(file.path) ?? []).map((problem) => {
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
    // #178: a tab with unsaved changes no longer matches the measured file on disk.
    const metricLens = installMetricLens(FILE_SCHEME, {
        isStale: (model) => [...files.values()].some((file) => file.model === model && isDirty(file)),
        showProblems: (path, name) => callbacks.showFunctionProblems?.(path, name),
    });
    monaco.editor.onDidChangeMarkers((resources) => {
        if (resources.some((uri) => uri.scheme === FILE_SCHEME)) {
            callbacks.onMarkersChange?.();
        }
    });
    /** The files in tab order: the strip's DOM order. */
    const ordered = (): OpenFile[] => [...tabs.children].flatMap((tab) => {
        const file = files.get((tab as HTMLElement).dataset['path'] ?? '');
        return file ? [file] : [];
    });
    const sessionChanged = (): void => callbacks.onSessionChange?.();

    // #166: the status bar follows the active editor, at most once a frame.
    let statusFrame = 0;
    function statusState(): EditorStatusState | null {
        const model = active?.model;
        const position = editor.getPosition();
        if (!active || !model || !position) {
            return null;
        }
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
            bom: active.bom,
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
    editor.onDidChangeCursorSelection(scheduleStatus);
    editor.onDidChangeModel(scheduleStatus);
    editor.onDidChangeModelOptions(scheduleStatus);
    editor.onDidChangeModelLanguage(scheduleStatus);
    editor.onDidChangeModelContent((event) => { if (event.eol) { scheduleStatus(); } });

    const isDirty = (file: OpenFile): boolean => file.model.getAlternativeVersionId() !== file.savedVersion;

    let reportedUnsaved = 0;
    function reportUnsaved(force = false): void {
        const count = [...files.values()].filter(isDirty).length;
        if (force || count !== reportedUnsaved) {
            reportedUnsaved = count;
            callbacks.onUnsavedChange?.(count);
        }
    }

    function refreshTab(file: OpenFile): void {
        const dirty = isDirty(file);
        file.tab.classList.toggle('is-dirty', dirty);
        file.tab.classList.toggle('is-conflict', file.diskState === 'changed');
        file.tab.classList.toggle('is-deleted', file.diskState === 'deleted');
        file.dirtyMark.title = file.diskState === 'deleted' ? 'Deleted on disk'
            : file.diskState === 'changed' ? 'Changed on disk; your version is unsaved'
                : dirty ? 'Unsaved changes' : '';
        if (dirty !== file.lensStale) {
            file.lensStale = dirty;
            metricLens.refresh(file.model);
            if (!dirty) {
                callbacks.onFileClean?.(file.path);
            }
        }
        reportUnsaved();
    }

    function showPlaceholder(message: string | null): void {
        placeholder.textContent = message ?? '';
        placeholder.hidden = message === null;
        host.hidden = message !== null;
    }

    function activate(file: OpenFile | null): void {
        if (active && active !== file) {
            active.viewState = editor.saveViewState();
            active.tab.setAttribute('aria-selected', 'false');
            active.tab.tabIndex = -1;
        }
        active = file;
        if (!file) {
            editor.setModel(null);
            showPlaceholder(files.size === 0 ? 'Open a file from the explorer.' : null);
            callbacks.onActiveChange(null);
            return;
        }
        showPlaceholder(null);
        editor.setModel(file.model);
        if (file.viewState) {
            editor.restoreViewState(file.viewState);
        }
        file.tab.setAttribute('aria-selected', 'true');
        file.tab.tabIndex = 0;
        file.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        editor.focus();
        callbacks.onActiveChange(file.path);
    }

    function setPreview(file: OpenFile, preview: boolean): void {
        if (file.preview === preview) {
            return;
        }
        file.preview = preview;
        file.tab.classList.toggle('is-preview', preview);
        file.tab.querySelector('.tab-label')?.setAttribute('aria-description', preview ? 'preview' : '');
        sessionChanged();
    }

    function addTab(content: Extract<FileContent, { kind: 'text' }>, preview = false, before: Element | null = null): OpenFile {
        const name = content.path.split('/').pop() ?? content.path;
        const dirtyMark = el('span', { className: 'tab-dirty', attrs: { 'aria-hidden': 'true' } });
        const close = el('button', { className: 'tab-close', attrs: { type: 'button', title: 'Close', 'aria-label': `Close ${name}`, tabindex: '-1' } }, [icon(CLOSE)]);
        const tab = el('div', {
            className: 'editor-tab',
            attrs: { role: 'tab', 'aria-selected': 'false', tabindex: '-1', title: content.path, 'data-path': content.path, draggable: 'true' },
        }, [fileIcon(name, 'file'), el('span', { className: 'tab-label', text: name }), dirtyMark, close]);
        const uri = monaco.Uri.from({ scheme: FILE_SCHEME, path: `/${content.path}` });
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content.text, undefined, uri);
        const file: OpenFile = {
            path: content.path, model, tab, dirtyMark, savedVersion: model.getAlternativeVersionId(), mtimeMs: content.mtimeMs,
            diskState: 'same', viewState: null, bom: content.text.startsWith(BOM), preview: false,
            config: {}, autoSaveTimer: undefined, saving: false, lensStale: false,
        };
        setPreview(file, preview);
        void applyEditorConfig(file);
        applyMetricMarkers(file);
        metricLens.refresh(model);
        model.onDidChangeContent(() => {
            refreshTab(file);
            scheduleAutoSave(file);
            // Editing keeps a preview tab (a reload from disk leaves it clean, so it stays a preview).
            if (isDirty(file)) { setPreview(file, false); }
        });
        tab.addEventListener('click', (event) => {
            if ((event.target as Element).closest('.tab-close')) {
                close_(file);
            } else {
                activate(file);
            }
        });
        tab.addEventListener('auxclick', (event) => { if (event.button === 1) { close_(file); } });
        tab.addEventListener('dblclick', (event) => {
            if (!(event.target as Element).closest('.tab-close')) { setPreview(file, false); }
        });
        tab.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            activate(file);
            callbacks.showTabMenu?.(file.path, event.clientX, event.clientY);
        });
        tabs.insertBefore(tab, before);
        files.set(file.path, file);
        callbacks.onOpenFilesChange?.();
        return file;
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

    async function applyEditorConfig(file: OpenFile): Promise<void> {
        const folders = editorConfigFolders(file.path);
        const read = await Promise.all(folders.map(async (folder) => ({ folder, file: await readEditorConfig(folder) })));
        if (files.get(file.path) !== file) {
            return; // closed meanwhile
        }
        const had = indentationOf(file.config) !== null;
        file.config = resolveEditorConfig(read.flatMap((entry) => (entry.file ? [{ folder: entry.folder, file: entry.file }] : [])), file.path);
        const indentation = indentationOf(file.config);
        if (indentation) {
            file.model.updateOptions(indentation);
        } else if (had) {
            // The .editorconfig no longer says: back to what the content suggests.
            file.model.detectIndentation(defaultIndent.insertSpaces, defaultIndent.tabSize);
        }
    }

    function scheduleAutoSave(file: OpenFile): void {
        clearTimeout(file.autoSaveTimer);
        if (autoSave !== 'afterDelay' || !isDirty(file) || file.saving) {
            return;
        }
        file.autoSaveTimer = setTimeout(() => {
            if (files.get(file.path) === file) {
                void saveFile(file, 'afterDelay');
            }
        }, autoSaveDelay);
    }

    function saveOnFocusChange(targets: readonly OpenFile[]): void {
        if (autoSave !== 'onFocusChange') {
            return;
        }
        for (const file of targets) {
            if (isDirty(file)) {
                void saveFile(file, 'focusChange');
            }
        }
    }
    editor.onDidBlurEditorText(() => saveOnFocusChange(active ? [active] : []));
    window.addEventListener('blur', () => saveOnFocusChange([...files.values()]));

    function close_(file: OpenFile): void {
        closeFiles([file]);
    }

    /** Closes `targets` after one question about the unsaved ones among them; false if the person said no. */
    function closeFiles(targets: readonly OpenFile[], ask = true): boolean {
        if (targets.length === 0) {
            return true;
        }
        const question = ask ? discardQuestion(targets.map((file) => file.path), new Set(targets.filter(isDirty).map((file) => file.path))) : null;
        if (question !== null && !window.confirm(question)) {
            return false;
        }
        const order = ordered();
        const closing = new Set(targets);
        const activeIndex = active ? order.indexOf(active) : -1;
        for (const file of targets) {
            clearTimeout(file.autoSaveTimer);
            files.delete(file.path);
            file.tab.remove();
            monaco.editor.setModelMarkers(file.model, METRIC_OWNER, []);
            metricLens.forget(file.model);
            file.model.dispose();
        }
        if (active && closing.has(active)) {
            // The neighbour on the right that stays open, else the one on the left.
            const next = order.slice(activeIndex + 1).find((file) => !closing.has(file))
                ?? order.slice(0, activeIndex).reverse().find((file) => !closing.has(file))
                ?? null;
            active = null;
            activate(next);
        }
        reportUnsaved();
        callbacks.onOpenFilesChange?.();
        sessionChanged();
        return true;
    }

    /** The text to write: Monaco keeps a byte order mark outside the model's text, so put it back. */
    function fileText(file: OpenFile): string {
        const text = file.model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true);
        return file.bom && !text.startsWith(BOM) ? BOM + text : text;
    }

    /** #170: formats the active file; rejects on a formatter error or after FORMAT_TIMEOUT_MS. */
    async function formatActive(): Promise<boolean> {
        const action = editor.getAction('editor.action.formatDocument');
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

    /** #170: the save-time edits (format, whitespace, line endings, byte order mark) for `file`. */
    async function prepareSave(file: OpenFile, reason: SaveReason): Promise<void> {
        const rules = saveRules(fileSettings, file.config);
        if (rules.formatOnSave && reason !== 'afterDelay' && file === active && editor.getModel() === file.model) {
            try {
                await formatActive();
            } catch (error) {
                callbacks.onStatus(`${file.path} was saved without formatting: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const cursorLines = reason === 'afterDelay' && file === active
            ? new Set((editor.getSelections() ?? []).flatMap((selection) => [selection.startLineNumber, selection.endLineNumber]))
            : new Set<number>();
        const edits = whitespaceEdits(file.model.getLinesContent(), rules, file.model.getEOL(), cursorLines);
        if (edits.length > 0) {
            const selections = file === active ? editor.getSelections() ?? [] : [];
            file.model.pushEditOperations(selections, edits.map((edit) => ({
                range: new monaco.Range(edit.line, edit.startColumn, edit.line, edit.endColumn),
                text: edit.text,
            })), () => null);
        }
        const eol = rules.endOfLine === 'crlf' ? '\r\n' : rules.endOfLine === 'lf' ? '\n' : null;
        if (eol !== null && file.model.getEOL() !== eol) {
            file.model.pushEOL(eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
        }
        if (rules.bom !== undefined) {
            file.bom = rules.bom;
        }
    }

    async function saveFile(file: OpenFile, reason: SaveReason = 'explicit'): Promise<boolean> {
        if (!isDirty(file)) {
            return true;
        }
        if (reason !== 'explicit' && (file.saving || file.diskState !== 'same')) {
            // An auto save never asks: a file that changed or vanished on disk waits for Save.
            return false;
        }
        clearTimeout(file.autoSaveTimer);
        file.saving = true;
        try {
            return await writeFile(file, reason);
        } finally {
            file.saving = false;
        }
    }

    async function writeFile(file: OpenFile, reason: SaveReason): Promise<boolean> {
        await prepareSave(file, reason);
        const version = file.model.getAlternativeVersionId();
        const write = (expected: number | undefined) => api.writeFile(file.path, fileText(file), expected);
        try {
            let result;
            try {
                result = await write(file.mtimeMs);
            } catch (error) {
                if (!String(error).includes(MODIFIED_ON_DISK)) {
                    throw error;
                }
                if (reason !== 'explicit') {
                    file.diskState = 'changed';
                    refreshTab(file);
                    callbacks.onStatus(`${file.path} changed on disk, so it was not auto-saved. Save it to choose.`);
                    return false;
                }
                if (!window.confirm(`${file.path} changed on disk since it was opened.\n\nOverwrite it with your version?`)) {
                    callbacks.onStatus(`${file.path} was not saved: it changed on disk.`);
                    return false;
                }
                result = await write(undefined);
            }
            file.savedVersion = version;
            file.mtimeMs = result.mtimeMs;
            file.diskState = 'same';
            refreshTab(file);
            if (reason === 'explicit') {
                callbacks.onStatus(`Saved ${file.path}`);
            }
            return true;
        } catch (error) {
            callbacks.onStatus(`Could not save ${file.path}: ${String(error)}`);
            return false;
        }
    }

    /** Re-reads one open file after the watcher reported it. */
    async function followDisk(file: OpenFile): Promise<void> {
        let content: FileContent;
        try {
            content = await api.readFile(file.path);
        } catch {
            if (file.diskState !== 'deleted') {
                file.diskState = 'deleted';
                refreshTab(file);
                callbacks.onStatus(`${file.path} was deleted on disk. Its text stays open until you close the tab.`);
            }
            return;
        }
        if (content.kind !== 'text' || content.mtimeMs === file.mtimeMs) {
            if (file.diskState === 'deleted' && content.kind === 'text') {
                file.diskState = 'same';
                refreshTab(file);
            }
            return;
        }
        if (files.get(file.path) !== file) {
            return; // closed while reading
        }
        if (isDirty(file)) {
            file.diskState = 'changed';
            refreshTab(file);
            callbacks.onStatus(`${file.path} changed on disk. Your unsaved version is kept; saving asks before overwriting.`);
            return;
        }
        file.bom = content.text.startsWith(BOM);
        if (content.text !== fileText(file)) {
            file.model.pushEditOperations([], [{ range: file.model.getFullModelRange(), text: content.text }], () => null);
        }
        file.savedVersion = file.model.getAlternativeVersionId();
        file.mtimeMs = content.mtimeMs;
        file.diskState = 'same';
        refreshTab(file);
        callbacks.onFileClean?.(file.path);
    }

    tabs.addEventListener('keydown', (event) => {
        const order = ordered();
        const index = active ? order.indexOf(active) : -1;
        if (active && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
            const rect = active.tab.getBoundingClientRect();
            callbacks.showTabMenu?.(active.path, rect.left, rect.bottom);
            event.preventDefault();
            return;
        }
        const target = event.key === 'ArrowRight' ? order[index + 1]
            : event.key === 'ArrowLeft' ? order[index - 1]
                : event.key === 'Home' ? order[0]
                    : event.key === 'End' ? order[order.length - 1]
                        : undefined;
        if (target) {
            activate(target);
            target.tab.focus();
            event.preventDefault();
        }
    });

    // #167: drag a tab to reorder; the marker shows which side of the tab under the pointer it lands on.
    let dragged: OpenFile | null = null;
    const clearDropMarks = (): void => {
        for (const tab of tabs.children) {
            tab.classList.remove('is-drop-before', 'is-drop-after');
        }
    };
    const dropTarget = (event: DragEvent): { readonly before: HTMLElement | null; readonly mark: HTMLElement | null; readonly after: boolean } => {
        const over = (event.target as Element).closest<HTMLElement>('.editor-tab');
        if (!over) {
            return { before: null, mark: tabs.lastElementChild as HTMLElement | null, after: true };
        }
        const rect = over.getBoundingClientRect();
        const after = event.clientX > rect.left + rect.width / 2;
        return { before: after ? over.nextElementSibling as HTMLElement | null : over, mark: over, after };
    };
    tabs.addEventListener('dragstart', (event) => {
        const tab = (event.target as Element).closest<HTMLElement>('.editor-tab');
        dragged = tab ? files.get(tab.dataset['path'] ?? '') ?? null : null;
        if (!dragged || !event.dataTransfer) {
            return;
        }
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', dragged.path);
        dragged.tab.classList.add('is-dragging');
    });
    tabs.addEventListener('dragover', (event) => {
        if (!dragged) {
            return;
        }
        event.preventDefault();
        if (event.dataTransfer) { event.dataTransfer.dropEffect = 'move'; }
        clearDropMarks();
        const { mark, after } = dropTarget(event);
        mark?.classList.add(after ? 'is-drop-after' : 'is-drop-before');
    });
    tabs.addEventListener('dragleave', (event) => {
        if (!tabs.contains(event.relatedTarget as Node | null)) { clearDropMarks(); }
    });
    tabs.addEventListener('drop', (event) => {
        if (!dragged) {
            return;
        }
        event.preventDefault();
        const { before } = dropTarget(event);
        const order = moveTab(ordered().map((file) => file.path), dragged.path, before?.dataset['path'] ?? null);
        for (const path of order) {
            const file = files.get(path);
            if (file) { tabs.append(file.tab); }
        }
        setPreview(dragged, false);
        dragged.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        sessionChanged();
    });
    tabs.addEventListener('dragend', () => {
        dragged?.tab.classList.remove('is-dragging');
        dragged = null;
        clearDropMarks();
    });
    // A vertical wheel scrolls an overflowing strip sideways, as in VS Code.
    tabs.addEventListener('wheel', (event) => {
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && tabs.scrollWidth > tabs.clientWidth) {
            tabs.scrollLeft += event.deltaY;
            event.preventDefault();
        }
    }, { passive: false });

    activate(null);

    return {
        activeLineCount: () => (active ? active.model.getLineCount() : null),
        statusState,
        async openAt(path, line, column, length) {
            await this.open(path);
            if (active?.path !== path) {
                return;
            }
            const model = active.model;
            const lineNumber = Math.min(Math.max(1, line), model.getLineCount());
            const selection = new monaco.Selection(lineNumber, column, lineNumber, Math.min(column + length, model.getLineMaxColumn(lineNumber)));
            editor.setSelection(selection);
            editor.revealRangeInCenterIfOutsideViewport(selection);
            editor.focus();
        },
        replaceInOpenFiles(paths, replace) {
            const handled: string[] = [];
            let replacements = 0;
            for (const path of paths) {
                const file = files.get(path);
                if (!file) {
                    continue;
                }
                handled.push(path);
                const result = replace(file.model.getValue());
                if (result.count > 0) {
                    file.model.pushEditOperations([], [{ range: file.model.getFullModelRange(), text: result.text }], () => null);
                    replacements += result.count;
                }
            }
            return { handled, replacements };
        },
        selectedText() {
            const selection = editor.getSelection();
            const model = active?.model;
            if (!selection || !model || selection.isEmpty() || selection.startLineNumber !== selection.endLineNumber) {
                return '';
            }
            return model.getValueInRange(selection);
        },
        async applyAgentEdit(path, expected, text) {
            const file = files.get(path);
            if (!file) {
                return 'not-open';
            }
            if (fileText(file) !== expected) {
                return 'unsaved-changes';
            }
            file.model.pushEditOperations([], [{ range: file.model.getFullModelRange(), text }], () => null);
            return (await saveFile(file, 'explicit')) ? 'saved' : 'save-failed';
        },
                activeSelection() {
            const selection = editor.getSelection();
            const model = active?.model;
            if (!active || !selection || !model || selection.isEmpty()) {
                return null;
            }
            return { path: active.path, startLine: selection.startLineNumber, endLine: selection.endLineNumber, text: model.getValueInRange(selection) };
        },
        showSymbols() {
            if (!active) {
                return;
            }
            editor.focus();
            void editor.getAction('editor.action.quickOutline')?.run();
        },
        setIndentation(indentation) {
            active?.model.updateOptions({ insertSpaces: indentation.insertSpaces, tabSize: indentation.tabSize, indentSize: indentation.tabSize });
            editor.focus();
        },
        setEndOfLine(eol) {
            active?.model.pushEOL(eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
            editor.focus();
        },
        setLanguage(languageId) {
            if (active) {
                monaco.editor.setModelLanguage(active.model, languageId);
            }
            editor.focus();
        },
        languages: () => monaco.languages.getLanguages(),
        breadcrumbBar,
        activeModel: () => (active ? { path: active.path, model: active.model } : null),
        goToLine(line, column, focus = true) {
            if (!active) {
                return;
            }
            const lineNumber = Math.min(Math.max(1, line), active.model.getLineCount());
            const maxColumn = active.model.getLineMaxColumn(lineNumber);
            const position = { lineNumber, column: Math.min(Math.max(1, column ?? 1), maxColumn) };
            editor.setPosition(position);
            editor.revealPositionInCenterIfOutsideViewport(position);
            if (focus) {
                editor.focus();
            }
        },
        async open(path: string, options: OpenOptions = {}): Promise<void> {
            const existing = files.get(path);
            if (existing) {
                if (!options.preview) {
                    setPreview(existing, false);
                }
                activate(existing);
                return;
            }
            let content: FileContent;
            try {
                content = await api.readFile(path);
            } catch (error) {
                callbacks.onStatus(`Could not open ${path}: ${String(error)}`);
                return;
            }
            if (content.kind !== 'text') {
                const size = `${(content.size / (1024 * 1024)).toFixed(1)} MB`;
                callbacks.onStatus(content.kind === 'binary' ? `${path} is a binary file.` : `${path} is too large to edit (${size}).`);
                return;
            }
            const already = files.get(path);
            if (already) {
                // Opened meanwhile (a double click's first click opened the preview).
                if (!options.preview) {
                    setPreview(already, false);
                }
                activate(already);
                return;
            }
            // A new preview takes the place of the current one, unless that one was edited meanwhile.
            const previous = options.preview ? ordered().find((file) => file.preview && !isDirty(file)) : undefined;
            const file = addTab(content, options.preview === true, previous?.tab ?? null);
            activate(file);
            if (previous) {
                closeFiles([previous], false);
            }
            sessionChanged();
        },
        closeGroup(kind: CloseKind, path?: string): void {
            const order = ordered();
            const targets = closeTargets(kind, order.map((file) => ({ path: file.path, dirty: isDirty(file) })), path ?? active?.path ?? null);
            closeFiles(targets.flatMap((target) => { const file = files.get(target); return file ? [file] : []; }));
        },
        cycle(delta: number): void {
            const next = cycleTab(ordered().map((file) => file.path), active?.path ?? null, delta);
            const file = next === null ? undefined : files.get(next);
            if (file) {
                activate(file);
            }
        },
        applySettings(settings: SettingValues): void {
            const snapshot = { effective: settings };
            const lineHeight = settingOf<number>(snapshot, 'editor.lineHeight');
            editor.updateOptions({
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
            });
            // #170: saving.
            fileSettings = {
                trimTrailingWhitespace: settingOf<boolean>(snapshot, 'files.trimTrailingWhitespace'),
                insertFinalNewline: settingOf<boolean>(snapshot, 'files.insertFinalNewline'),
                formatOnSave: settingOf<boolean>(snapshot, 'editor.formatOnSave'),
            };
            autoSave = settingOf<AutoSave>(snapshot, 'files.autoSave');
            autoSaveDelay = settingOf<number>(snapshot, 'files.autoSaveDelay');
            defaultIndent = { insertSpaces: settingOf<boolean>(snapshot, 'editor.insertSpaces'), tabSize: settingOf<number>(snapshot, 'editor.tabSize') };
            for (const file of files.values()) {
                scheduleAutoSave(file);
            }
        },
        async formatDocument(): Promise<boolean> {
            if (!active) {
                return false;
            }
            try {
                return await formatActive();
            } catch (error) {
                callbacks.onStatus(`Could not format ${active.path}: ${error instanceof Error ? error.message : String(error)}`);
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
                const file = files.get(path);
                if (file) {
                    applyMetricMarkers(file);
                }
            }
        },
        keepActive(): void {
            if (active) {
                setPreview(active, false);
            }
        },
        session(): TabSession {
            if (active) {
                active.viewState = editor.saveViewState();
            }
            return {
                tabs: ordered().map((file) => ({ path: file.path, viewState: file.viewState })),
                active: active?.path ?? null,
                preview: ordered().find((file) => file.preview)?.path ?? null,
            };
        },
        async restore(session: TabSession): Promise<void> {
            for (const saved of session.tabs) {
                if (files.has(saved.path)) {
                    continue;
                }
                let content: FileContent;
                try {
                    content = await api.readFile(saved.path);
                } catch {
                    continue; // gone since: skipped
                }
                if (content.kind !== 'text' || files.has(saved.path)) {
                    continue;
                }
                const file = addTab(content, saved.path === session.preview);
                file.viewState = (saved.viewState as monaco.editor.ICodeEditorViewState | null) ?? null;
            }
            const target = (session.active === null ? undefined : files.get(session.active)) ?? ordered()[0] ?? null;
            if (target) {
                activate(target);
            }
            sessionChanged();
        },
        async save(): Promise<void> {
            if (active) {
                await saveFile(active);
            }
        },
        async saveAll(): Promise<void> {
            const results = await Promise.all([...files.values()].map((file) => saveFile(file)));
            const failed = results.filter((ok) => !ok).length;
            if (failed === 0) {
                callbacks.onStatus('All files saved');
            }
            // Always report after Save All: the window may be waiting on it to close.
            reportUnsaved(true);
        },
        closeActive(): void {
            if (active) {
                close_(active);
            }
        },
        reset(): void {
            for (const file of ordered()) {
                file.tab.remove();
                monaco.editor.setModelMarkers(file.model, METRIC_OWNER, []);
                file.model.dispose();
            }
            files.clear();
            editorConfigs = new Map();
            active = null;
            activate(null);
            reportUnsaved();
            callbacks.onOpenFilesChange?.();
        },
        dirtyPaths: () => [...files.values()].filter(isDirty).map((file) => file.path),
        openPaths: () => [...files.keys()],
        async entryMoved(from: string, to: string | null): Promise<void> {
            const affected = [...files.values()].filter((file) => file.path === from || file.path.startsWith(`${from}/`));
            const reopen: string[] = [];
            let activePath: string | null = null;
            for (const file of affected) {
                if (isDirty(file)) {
                    file.diskState = 'deleted';
                    refreshTab(file);
                    continue;
                }
                if (to !== null) {
                    const moved = to + file.path.slice(from.length);
                    reopen.push(moved);
                    if (file === active) { activePath = moved; }
                }
                close_(file);
            }
            for (const path of reopen) {
                await this.open(path);
            }
            if (activePath) {
                await this.open(activePath);
            }
        },
        async onDiskChanged(paths: readonly string[]): Promise<void> {
            const changed = new Set(paths);
            // #170: an .editorconfig changed: read them again and re-apply them to every open file.
            if (paths.some((path) => path === EDITORCONFIG_NAME || path.endsWith(`/${EDITORCONFIG_NAME}`))) {
                editorConfigs = new Map();
                await Promise.all([...files.values()].map(applyEditorConfig));
            }
            await Promise.all([...files.values()].filter((file) => changed.has(file.path)).map(followDisk));
        },
    };
}
