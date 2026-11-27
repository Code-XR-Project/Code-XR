import { monaco } from '../editor/monaco.ts';
import type { ContextKeys } from './contextKeys.ts';
import { resourceContext, type MenuGroup } from './menuModel.ts';

/**
 * #261: the entries extensions add to the editor's context menu
 * (`editor/context`), as Monaco actions of each editor. They are rebuilt when
 * the editor shows another file or language, when a context key changes, and
 * when the selection becomes empty or not (`editorHasSelection` is a common
 * `when`); the command gets the file's URI, as in VS Code.
 */

export interface EditorMenusDeps {
    readonly contextKeys: ContextKeys;
    menu(menu: string, extra: Readonly<Record<string, unknown>>): MenuGroup[];
    /** The workspace path of a model the editor group opened; null for anything else. */
    pathOf(model: monaco.editor.ITextModel): string | null;
    run(command: string, path: string): void;
}

interface Tracked {
    actions: monaco.IDisposable[];
    hasSelection: boolean;
    readonly listeners: monaco.IDisposable[];
}

let sequence = 0;

export function installEditorMenus(deps: EditorMenusDeps): () => void {
    const tracked = new Map<monaco.editor.ICodeEditor, Tracked>();

    function rebuild(editor: monaco.editor.ICodeEditor): void {
        const entry = tracked.get(editor);
        if (!entry) {
            return;
        }
        for (const action of entry.actions) {
            action.dispose();
        }
        entry.actions = [];
        const model = editor.getModel();
        const path = model ? deps.pathOf(model) : null;
        if (!model || !path) {
            return;
        }
        const languageId = model.getLanguageId();
        const groups = deps.menu('editor/context', {
            ...resourceContext(path, languageId),
            editorLangId: languageId,
            editorFocus: true,
            editorTextFocus: true,
            editorHasSelection: entry.hasSelection,
            editorReadonly: editor.getOption(monaco.editor.EditorOption.readOnly),
            activeEditor: 'workbench.editors.files.textFileEditor',
        });
        groups.forEach((group, groupIndex) => {
            group.actions.forEach((action, index) => {
                const add = (editor as monaco.editor.IStandaloneCodeEditor).addAction?.bind(editor);
                if (!add) {
                    return;
                }
                entry.actions.push(add({
                    id: `codexr.extension.${action.command}.${++sequence}`,
                    label: action.title,
                    // After Monaco's own groups, in the extension's order; a disabled entry shows greyed out.
                    contextMenuGroupId: `9${String(groupIndex).padStart(2, '0')}_${group.group || 'extension'}`,
                    contextMenuOrder: index,
                    ...(action.enabled ? {} : { precondition: 'false' }),
                    run: () => deps.run(action.command, path),
                }));
            });
        });
    }

    function track(editor: monaco.editor.ICodeEditor): void {
        if (tracked.has(editor) || typeof (editor as Partial<monaco.editor.IStandaloneCodeEditor>).addAction !== 'function') {
            return;
        }
        const entry: Tracked = { actions: [], hasSelection: false, listeners: [] };
        tracked.set(editor, entry);
        entry.listeners.push(
            editor.onDidChangeModel(() => rebuild(editor)),
            editor.onDidChangeModelLanguage(() => rebuild(editor)),
            editor.onDidChangeCursorSelection((event) => {
                const hasSelection = !event.selection.isEmpty();
                if (hasSelection !== entry.hasSelection) {
                    entry.hasSelection = hasSelection;
                    rebuild(editor);
                }
            }),
            editor.onDidDispose(() => {
                for (const disposable of [...entry.actions, ...entry.listeners]) {
                    disposable.dispose();
                }
                tracked.delete(editor);
            }),
        );
        rebuild(editor);
    }

    const created = monaco.editor.onDidCreateEditor(track);
    monaco.editor.getEditors().forEach(track);
    const stopContext = deps.contextKeys.onDidChange(() => {
        for (const editor of tracked.keys()) {
            rebuild(editor);
        }
    });
    return () => {
        created.dispose();
        stopContext();
        for (const [, entry] of tracked) {
            for (const disposable of [...entry.actions, ...entry.listeners]) {
                disposable.dispose();
            }
        }
        tracked.clear();
    };
}
