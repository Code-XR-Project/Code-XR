import { MODIFIED_ON_DISK, type CodeXRApi, type FileContent } from '../../shared/api.ts';
import { el, icon } from '../dom.ts';
import { followSystemTheme, monaco } from './monaco.ts';

/**
 * The editor area (#14): one Monaco editor, one model per open file, and a
 * tab strip. A tab is dirty while its model differs from what was last read
 * or saved (Monaco's alternative version id, so undoing back to the saved
 * text clears it). Saves send the modification time the file had when it was
 * read, and the main process refuses the write if it moved.
 */

const CLOSE = 'M6 6l12 12M18 6L6 18';

interface OpenFile {
    readonly path: string;
    readonly model: monaco.editor.ITextModel;
    readonly tab: HTMLElement;
    readonly dirtyMark: HTMLElement;
    savedVersion: number;
    mtimeMs: number;
    viewState: monaco.editor.ICodeEditorViewState | null;
}

export interface EditorGroup {
    open(path: string): Promise<void>;
    save(): Promise<void>;
    saveAll(): Promise<void>;
    closeActive(): void;
    /** Drops every editor (the workspace changed). Unsaved files must be dealt with first. */
    reset(): void;
    readonly dirtyPaths: () => readonly string[];
}

export function createEditorGroup(
    container: HTMLElement,
    api: CodeXRApi['workspace'],
    callbacks: { onStatus(message: string): void; onActiveChange(path: string | null): void },
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
        model: null,
    });

    const files = new Map<string, OpenFile>();
    let active: OpenFile | null = null;

    const isDirty = (file: OpenFile): boolean => file.model.getAlternativeVersionId() !== file.savedVersion;

    function refreshTab(file: OpenFile): void {
        const dirty = isDirty(file);
        file.tab.classList.toggle('is-dirty', dirty);
        file.dirtyMark.title = dirty ? 'Unsaved changes' : '';
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

    function addTab(content: Extract<FileContent, { kind: 'text' }>): OpenFile {
        const name = content.path.split('/').pop() ?? content.path;
        const dirtyMark = el('span', { className: 'tab-dirty', attrs: { 'aria-hidden': 'true' } });
        const close = el('button', { className: 'tab-close', attrs: { type: 'button', title: 'Close', 'aria-label': `Close ${name}`, tabindex: '-1' } }, [icon(CLOSE)]);
        const tab = el('div', {
            className: 'editor-tab',
            attrs: { role: 'tab', 'aria-selected': 'false', tabindex: '-1', title: content.path, 'data-path': content.path },
        }, [el('span', { className: 'tab-label', text: name }), dirtyMark, close]);
        const uri = monaco.Uri.from({ scheme: 'codexr-file', path: `/${content.path}` });
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content.text, undefined, uri);
        const file: OpenFile = { path: content.path, model, tab, dirtyMark, savedVersion: model.getAlternativeVersionId(), mtimeMs: content.mtimeMs, viewState: null };
        model.onDidChangeContent(() => refreshTab(file));
        tab.addEventListener('click', (event) => {
            if ((event.target as Element).closest('.tab-close')) {
                close_(file);
            } else {
                activate(file);
            }
        });
        tab.addEventListener('auxclick', (event) => { if (event.button === 1) { close_(file); } });
        tabs.append(tab);
        files.set(file.path, file);
        return file;
    }

    function close_(file: OpenFile): void {
        if (isDirty(file) && !window.confirm(`${file.path} has unsaved changes. Close it and discard them?`)) {
            return;
        }
        const order = [...files.values()];
        const index = order.indexOf(file);
        files.delete(file.path);
        file.tab.remove();
        file.model.dispose();
        if (active === file) {
            active = null;
            activate(order[index + 1] ?? order[index - 1] ?? null);
        }
    }

    async function saveFile(file: OpenFile): Promise<boolean> {
        if (!isDirty(file)) {
            return true;
        }
        const version = file.model.getAlternativeVersionId();
        try {
            const result = await api.writeFile(file.path, file.model.getValue(), file.mtimeMs);
            file.savedVersion = version;
            file.mtimeMs = result.mtimeMs;
            refreshTab(file);
            callbacks.onStatus(`Saved ${file.path}`);
            return true;
        } catch (error) {
            callbacks.onStatus(String(error).includes(MODIFIED_ON_DISK)
                ? `${file.path} changed on disk since it was opened; not saved.`
                : `Could not save ${file.path}: ${String(error)}`);
            return false;
        }
    }

    tabs.addEventListener('keydown', (event) => {
        const order = [...files.values()];
        const index = active ? order.indexOf(active) : -1;
        const target = event.key === 'ArrowRight' ? order[index + 1] : event.key === 'ArrowLeft' ? order[index - 1] : undefined;
        if (target) {
            activate(target);
            target.tab.focus();
            event.preventDefault();
        }
    });

    activate(null);

    return {
        async open(path: string): Promise<void> {
            const existing = files.get(path);
            if (existing) {
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
            activate(files.get(path) ?? addTab(content));
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
        },
        closeActive(): void {
            if (active) {
                close_(active);
            }
        },
        reset(): void {
            for (const file of files.values()) {
                file.tab.remove();
                file.model.dispose();
            }
            files.clear();
            active = null;
            activate(null);
        },
        dirtyPaths: () => [...files.values()].filter(isDirty).map((file) => file.path),
    };
}
