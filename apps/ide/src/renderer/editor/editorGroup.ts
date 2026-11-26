import { MODIFIED_ON_DISK, type CodeXRApi, type FileContent } from '../../shared/api.ts';
import { el, fileIcon, icon } from '../dom.ts';
import { followSystemTheme, monaco } from './monaco.ts';
import { languageName, type EditorStatusState, type EndOfLine, type Indentation, type LanguageInfo } from './editorStatusModel.ts';
import { settingOf, type SettingValues } from '../../shared/settings.ts';
import { closeTargets, cycleTab, discardQuestion, moveTab, type CloseKind, type TabSession } from './tabsModel.ts';

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
}

export interface OpenOptions {
    /** #167: open as the preview tab (a single click in the explorer). */
    readonly preview?: boolean;
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
    /** Moves the cursor of the active file to `line` (and `column`), centred, and focuses the editor. */
    goToLine(line: number, column?: number): void;
    /** #165: opens `path` and selects `length` characters from `line`:`column` (a search match). */
    openAt(path: string, line: number, column: number, length: number): Promise<void>;
    /**
     * #165: replaces in the open files among `paths`, as one undoable edit each
     * (the tab becomes unsaved); returns the paths it handled and the count.
     */
    replaceInOpenFiles(paths: readonly string[], replace: (text: string) => { text: string; count: number }): { handled: string[]; replacements: number };
    /** The active editor's selection when it is on one line, for the Search view's query. */
    selectedText(): string;
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
    },
): EditorGroup {
    const tabs = el('div', { className: 'editor-tabs', attrs: { role: 'tablist', 'aria-label': 'Open editors', 'data-testid': 'editor-tabs' } });
    const host = el('div', { className: 'editor-host', attrs: { 'data-testid': 'editor-host' } });
    const placeholder = el('div', { className: 'editor-placeholder muted' });
    container.replaceChildren(tabs, host, placeholder);
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
        const uri = monaco.Uri.from({ scheme: 'codexr-file', path: `/${content.path}` });
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content.text, undefined, uri);
        const file: OpenFile = {
            path: content.path, model, tab, dirtyMark, savedVersion: model.getAlternativeVersionId(), mtimeMs: content.mtimeMs,
            diskState: 'same', viewState: null, bom: content.text.startsWith(BOM), preview: false,
        };
        setPreview(file, preview);
        model.onDidChangeContent(() => {
            refreshTab(file);
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
            files.delete(file.path);
            file.tab.remove();
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

    async function saveFile(file: OpenFile): Promise<boolean> {
        if (!isDirty(file)) {
            return true;
        }
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
            callbacks.onStatus(`Saved ${file.path}`);
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
        goToLine(line, column) {
            if (!active) {
                return;
            }
            const lineNumber = Math.min(Math.max(1, line), active.model.getLineCount());
            const maxColumn = active.model.getLineMaxColumn(lineNumber);
            const position = { lineNumber, column: Math.min(Math.max(1, column ?? 1), maxColumn) };
            editor.setPosition(position);
            editor.revealPositionInCenterIfOutsideViewport(position);
            editor.focus();
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
            const results = await Promise.all([...files.values()].map(saveFile));
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
                file.model.dispose();
            }
            files.clear();
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
            await Promise.all([...files.values()].filter((file) => changed.has(file.path)).map(followDisk));
        },
    };
}
