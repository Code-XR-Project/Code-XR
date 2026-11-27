import { monaco } from '../editor/monaco.ts';

/**
 * The Monaco side-by-side diff of the Changes tab (AF5, #270): read-only,
 * the file at its review base on the left and on disk on the right. Imported
 * lazily by changesView.ts, in the editor's chunk (the tab only exists inside
 * the editor group, which has already loaded Monaco). The models' URIs carry
 * the file's path so Monaco picks the language from its extension.
 */

export interface ChangesDiff {
    show(path: string, oldText: string, newText: string): void;
    clear(): void;
    dispose(): void;
}

let sequence = 0;

export function createChangesDiff(host: HTMLElement): ChangesDiff {
    const editor = monaco.editor.createDiffEditor(host, {
        automaticLayout: true,
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        fontFamily: "ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace",
        fontSize: 13,
        scrollBeyondLastLine: false,
    });
    let models: { original: ReturnType<typeof monaco.editor.createModel>; modified: ReturnType<typeof monaco.editor.createModel> } | null = null;

    function release(): void {
        editor.setModel(null);
        models?.original.dispose();
        models?.modified.dispose();
        models = null;
    }

    return {
        show(path, oldText, newText) {
            const id = ++sequence;
            const next = {
                original: monaco.editor.createModel(oldText, undefined, monaco.Uri.from({ scheme: 'codexr-review-base', path: `/${id}/${path}` })),
                modified: monaco.editor.createModel(newText, undefined, monaco.Uri.from({ scheme: 'codexr-review-disk', path: `/${id}/${path}` })),
            };
            release();
            models = next;
            editor.setModel(next);
        },
        clear: release,
        dispose() {
            release();
            editor.dispose();
        },
    };
}
