import type { GitChange } from '../../shared/git.ts';
import { el, fileIcon, icon } from '../dom.ts';
import { followSystemTheme, monaco } from '../editor/monaco.ts';
import { letterTitle, splitPath } from './scmModel.ts';

/**
 * The diff view of Source Control (#17): Monaco's diff editor, read-only,
 * over the editor area: the file at HEAD on the left, the working tree on the
 * right. Loaded on the first "Open Changes", in the editor's chunk, so the
 * view costs nothing until then. Escape or the close button dismisses it.
 */

export interface DiffHooks {
    headContent(path: string): Promise<string | null>;
    /** The working-tree text; null when the file is gone or not text. */
    readFile(path: string): Promise<string | null>;
    openFile(path: string): void;
    onClose(): void;
}

let sequence = 0;
let themed = false;

export async function showDiff(editorArea: HTMLElement, change: GitChange, hooks: DiffHooks): Promise<{ dispose(): void }> {
    const [original, modified] = await Promise.all([
        change.letter === 'A' || change.letter === 'U' ? Promise.resolve('') : hooks.headContent(change.origPath ?? change.path).then((text) => text ?? ''),
        change.letter === 'D' ? Promise.resolve('') : hooks.readFile(change.path).then((text) => text ?? ''),
    ]);
    const { name, folder } = splitPath(change.path);
    const id = ++sequence;
    const originalModel = monaco.editor.createModel(original, undefined, monaco.Uri.from({ scheme: 'codexr-git-head', path: `/${id}/${change.origPath ?? change.path}` }));
    const modifiedModel = monaco.editor.createModel(modified, undefined, monaco.Uri.from({ scheme: 'codexr-git-tree', path: `/${id}/${change.path}` }));

    const closeButton = el('button', { className: 'icon-button', attrs: { type: 'button', title: 'Close', 'aria-label': 'Close the changes', 'data-testid': 'scm-diff-close' } }, [icon('M6 6l12 12M18 6L6 18')]);
    const openButton = el('button', { className: 'secondary-button scm-diff-open', attrs: { type: 'button', 'data-testid': 'scm-diff-open-file' }, text: 'Open File' });
    openButton.hidden = change.letter === 'D';
    const host = el('div', { className: 'scm-diff-host' });
    const overlay = el('section', { className: 'scm-diff', attrs: { 'aria-label': `Changes of ${change.path}`, 'data-testid': 'scm-diff', tabindex: '-1' } }, [
        el('header', { className: 'scm-diff-header' }, [
            fileIcon(name, 'file'),
            el('span', { className: 'scm-diff-title', text: `${name} (HEAD ↔ Working Tree)` }),
            el('span', { className: 'muted scm-diff-folder', text: `${folder} - ${letterTitle(change.letter)}` }),
            el('span', { className: 'scm-diff-actions' }, [openButton, closeButton]),
        ]),
        host,
    ]);
    editorArea.append(overlay);

    if (!themed) {
        themed = true;
        followSystemTheme();
    }
    const editor = monaco.editor.createDiffEditor(host, {
        automaticLayout: true,
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        fontFamily: "ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace",
        fontSize: 13,
        scrollBeyondLastLine: false,
    });
    editor.setModel({ original: originalModel, modified: modifiedModel });

    let disposed = false;
    const dispose = (): void => {
        if (disposed) {
            return;
        }
        disposed = true;
        editor.dispose();
        originalModel.dispose();
        modifiedModel.dispose();
        overlay.remove();
        hooks.onClose();
    };
    closeButton.addEventListener('click', dispose);
    openButton.addEventListener('click', () => {
        dispose();
        hooks.openFile(change.path);
    });
    overlay.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            dispose();
        }
    });
    overlay.focus();
    return { dispose };
}
