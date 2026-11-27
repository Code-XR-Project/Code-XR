import { el } from '../dom.ts';
import type { CustomEditorView } from './customEditor.ts';
import { monaco } from './monaco.ts';

/**
 * #288: a comparison of two texts in an editor tab, on Monaco's diff editor.
 * A side is either a live model (an open file: its edits show, and the
 * right-hand side stays editable, as in VS Code's Compare with Saved) or a
 * text read once (the file on disk), held in a model of its own and read
 * again when the file changes.
 */

/** One side of a comparison. */
export interface CompareSide {
    /** Workspace path, for the language and the labels. */
    readonly path: string;
    /** The open file's model: the side follows it (and the right side is editable). Absent: `read` is shown. */
    readonly model?: monaco.editor.ITextModel;
    /** The side's text when it has no live model (or the saved text); null when it is gone. */
    read(): Promise<string | null>;
}

export interface CompareOptions {
    readonly original: CompareSide;
    readonly modified: CompareSide;
    /** The editor options of the groups (font, size, whitespace). */
    readonly editorOptions: monaco.editor.IEditorOptions;
    /** A live side's model is going away (its file closed): the tab should close. */
    onLiveModelGone(): void;
    onStatus(message: string): void;
}

let sequence = 0;

/** The language Monaco would pick for `path`, so both sides colour alike. */
function languageOf(path: string): string | undefined {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    const dot = name.lastIndexOf('.');
    const extension = dot >= 0 ? name.slice(dot) : '';
    return monaco.languages.getLanguages().find((language) => language.extensions?.includes(extension) || language.filenames?.some((file) => file.toLowerCase() === name))?.id;
}

export function createCompareView(options: CompareOptions): CustomEditorView {
    const host = el('div', { className: 'compare-host' });
    const element = el('div', { className: 'compare-view', attrs: { 'data-testid': 'compare-view' } }, [host]);
    const id = ++sequence;
    const owned: monaco.editor.ITextModel[] = [];
    const subscriptions: monaco.IDisposable[] = [];
    let disposed = false;

    function sideModel(side: CompareSide, role: 'original' | 'modified'): monaco.editor.ITextModel {
        if (side.model) {
            subscriptions.push(side.model.onWillDispose(() => { if (!disposed) { options.onLiveModelGone(); } }));
            return side.model;
        }
        const model = monaco.editor.createModel('', languageOf(side.path), monaco.Uri.from({ scheme: 'codexr-compare', path: `/${id}/${role}/${side.path}` }));
        owned.push(model);
        return model;
    }

    const original = sideModel(options.original, 'original');
    const modified = sideModel(options.modified, 'modified');
    const editor = monaco.editor.createDiffEditor(host, {
        ...options.editorOptions as monaco.editor.IDiffEditorConstructionOptions,
        automaticLayout: true,
        renderSideBySide: true,
        originalEditable: false,
        readOnly: options.modified.model === undefined,
        glyphMargin: false,
        scrollBeyondLastLine: false,
    });
    editor.setModel({ original, modified });

    /** Reads the sides that are not live again (the file changed on disk). */
    async function reload(): Promise<void> {
        const sides: [CompareSide, monaco.editor.ITextModel][] = [[options.original, original], [options.modified, modified]];
        await Promise.all(sides.filter(([side]) => !side.model).map(async ([side, model]) => {
            let text: string | null;
            try {
                text = await side.read();
            } catch {
                text = null;
            }
            if (disposed) {
                return;
            }
            if (text === null) {
                options.onStatus(`${side.path} cannot be compared: it is gone, binary or too large.`);
            }
            if (model.getValue() !== (text ?? '')) {
                model.setValue(text ?? '');
            }
        }));
    }
    void reload();

    return {
        element,
        focus: () => editor.getModifiedEditor().focus(),
        fileChanged: () => void reload(),
        dispose: () => {
            disposed = true;
            for (const subscription of subscriptions) {
                subscription.dispose();
            }
            editor.dispose();
            for (const model of owned) {
                model.dispose();
            }
        },
    };
}
