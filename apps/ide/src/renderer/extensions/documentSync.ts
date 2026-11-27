import type { DocumentEvent, EditorStateData } from '../../shared/extensionLanguageProtocol.ts';
import { MAX_SYNCED_DOCUMENT_LENGTH } from '../../shared/extensionLanguageProtocol.ts';
import type { ExtensionsApi } from '../../shared/extensions.ts';
import { monaco } from '../editor/monaco.ts';
import { workspacePathOf } from '../lsp/lspConvert.ts';
import { changesOf, fromMonacoPosition, fromMonacoRange } from './languageBridgeModel.ts';

/**
 * Tells the extension host what the editor has open (#260): every Monaco
 * model of a workspace file (`codexr-file:` URIs) is announced when it is
 * created, each content change as Monaco reports it, and its closing; and
 * which editor is active, with its selections. Events go out in order,
 * batched once per task; `flush` sends what is waiting right away (a
 * provider request must not overtake the change it depends on).
 */

export const FILE_SCHEME = 'codexr-file';
const EDITOR_STATE_DELAY_MS = 60;

export interface DocumentSync {
    /** Sends the waiting events now. */
    flush(): void;
    /** The editor showing a workspace file that was focused last, if any. */
    activeEditor(): monaco.editor.ICodeEditor | null;
    /** The document at `path` was saved (the editor group says so). */
    saved(path: string): void;
    /** The workspace path of a model the host follows, or null. */
    pathOf(model: monaco.editor.ITextModel): string | null;
    dispose(): void;
}

export function installDocumentSync(extensions: ExtensionsApi): DocumentSync {
    const followed = new Map<monaco.editor.ITextModel, { path: string; subscription: monaco.IDisposable }>();
    let queue: DocumentEvent[] = [];
    let scheduled = false;
    let active: monaco.editor.ICodeEditor | null = null;
    let editorTimer: ReturnType<typeof setTimeout> | undefined;
    const disposables: monaco.IDisposable[] = [];

    function flush(): void {
        scheduled = false;
        if (queue.length === 0) {
            return;
        }
        const events = queue;
        queue = [];
        extensions.documentEvents(events).catch(() => undefined);
    }

    function push(event: DocumentEvent): void {
        queue.push(event);
        if (!scheduled) {
            scheduled = true;
            queueMicrotask(flush);
        }
    }

    function follow(model: monaco.editor.ITextModel): void {
        if (model.uri.scheme !== FILE_SCHEME || followed.has(model) || model.getValueLength() > MAX_SYNCED_DOCUMENT_LENGTH) {
            return;
        }
        const path = workspacePathOf(model.uri.path);
        if (path === '') {
            return;
        }
        const subscription = model.onDidChangeContent((event) => {
            push({ kind: 'change', path, version: model.getVersionId(), changes: changesOf(event.changes) });
        });
        followed.set(model, { path, subscription });
        push({ kind: 'open', path, languageId: model.getLanguageId(), version: model.getVersionId(), text: model.getValue() });
    }

    function unfollow(model: monaco.editor.ITextModel): void {
        const entry = followed.get(model);
        if (!entry) {
            return;
        }
        entry.subscription.dispose();
        followed.delete(model);
        push({ kind: 'close', path: entry.path });
        if (active?.getModel() === model) {
            setActive(null);
        }
    }

    function editorState(editor: monaco.editor.ICodeEditor | null): EditorStateData | null {
        const model = editor?.getModel();
        const entry = model ? followed.get(model) : undefined;
        if (!editor || !model || !entry) {
            return null;
        }
        const options = model.getOptions();
        return {
            path: entry.path,
            selections: (editor.getSelections() ?? []).map((selection) => ({
                anchor: fromMonacoPosition({ lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn }),
                active: fromMonacoPosition(selection.getPosition()),
            })),
            visibleRanges: editor.getVisibleRanges().map((range) => fromMonacoRange(range)),
            tabSize: options.tabSize,
            insertSpaces: options.insertSpaces,
        };
    }

    function sendEditor(): void {
        clearTimeout(editorTimer);
        editorTimer = undefined;
        push({ kind: 'editor', editor: editorState(active) });
    }

    /** Selections and scrolling move often: the host hears about them a little later, once. */
    function editorChangedSoon(): void {
        if (editorTimer === undefined) {
            editorTimer = setTimeout(sendEditor, EDITOR_STATE_DELAY_MS);
        }
    }

    function setActive(editor: monaco.editor.ICodeEditor | null): void {
        const model = editor?.getModel();
        const next = editor && model && followed.has(model) ? editor : null;
        if (next === active && next === null) {
            return;
        }
        active = next;
        sendEditor();
    }

    function watchEditor(editor: monaco.editor.ICodeEditor): void {
        const subscriptions = [
            editor.onDidFocusEditorText(() => setActive(editor)),
            editor.onDidChangeModel(() => {
                const model = editor.getModel();
                if (model) {
                    follow(model);
                }
                // A tab switch: the editor showing it is the one the person works in.
                if (editor === active || (model && model.uri.scheme === FILE_SCHEME)) {
                    setActive(editor);
                }
            }),
            editor.onDidChangeCursorSelection(() => {
                if (editor === active) {
                    editorChangedSoon();
                }
            }),
            editor.onDidScrollChange((event) => {
                if (editor === active && event.scrollTopChanged) {
                    editorChangedSoon();
                }
            }),
        ];
        editor.onDidDispose(() => {
            subscriptions.forEach((subscription) => subscription.dispose());
            if (editor === active) {
                setActive(null);
            }
        });
        if (!active) {
            setActive(editor);
        }
    }

    monaco.editor.getModels().forEach(follow);
    disposables.push(
        monaco.editor.onDidCreateModel(follow),
        monaco.editor.onWillDisposeModel(unfollow),
        monaco.editor.onDidChangeModelLanguage(({ model }) => {
            const entry = followed.get(model);
            if (entry) {
                push({ kind: 'language', path: entry.path, languageId: model.getLanguageId() });
            }
        }),
        monaco.editor.onDidCreateEditor(watchEditor),
    );
    monaco.editor.getEditors().forEach(watchEditor);

    return {
        flush() {
            if (editorTimer !== undefined) {
                sendEditor();
            }
            flush();
        },
        activeEditor: () => active,
        saved(path) {
            if ([...followed.values()].some((entry) => entry.path === path)) {
                push({ kind: 'save', path });
            }
        },
        pathOf: (model) => followed.get(model)?.path ?? null,
        dispose() {
            disposables.forEach((disposable) => disposable.dispose());
            for (const entry of followed.values()) {
                entry.subscription.dispose();
            }
            followed.clear();
            clearTimeout(editorTimer);
        },
    };
}
