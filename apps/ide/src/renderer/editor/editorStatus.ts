import { el } from '../dom.ts';
import { editorStatusTexts, type EditorStatusState } from './editorStatusModel.ts';

/**
 * The active editor's items in the status bar (#166), as in VS Code:
 * `Ln 12, Col 5`, `Spaces: 4`, `UTF-8`, `LF`, `TypeScript`. Each one but the
 * encoding is a button that opens its picker; all are hidden without an
 * active editor.
 */

export interface EditorStatusActions {
    goToLine(): void;
    pickIndentation(): void;
    pickEndOfLine(): void;
    pickLanguage(): void;
}

export interface EditorStatusView {
    show(state: EditorStatusState | null): void;
}

export function createEditorStatus(container: HTMLElement, actions: EditorStatusActions): EditorStatusView {
    const item = (testId: string, title: string, run?: () => void): HTMLElement => {
        const node = run
            ? el('button', { className: 'status-item', attrs: { type: 'button', title, 'data-testid': testId } })
            : el('span', { className: 'status-item is-static', attrs: { title, 'data-testid': testId } });
        if (run) {
            node.addEventListener('click', run);
        }
        return node;
    };
    const position = item('status-position', 'Go to Line/Column', actions.goToLine);
    const indentation = item('status-indentation', 'Select Indentation', actions.pickIndentation);
    const encoding = item('status-encoding', 'File encoding (files are read and written as UTF-8)');
    const eol = item('status-eol', 'Select End of Line Sequence', actions.pickEndOfLine);
    const language = item('status-language', 'Select Language Mode', actions.pickLanguage);
    container.replaceChildren(position, indentation, encoding, eol, language);
    container.hidden = true;

    return {
        show(state) {
            container.hidden = state === null;
            if (!state) {
                return;
            }
            const texts = editorStatusTexts(state);
            position.textContent = texts.position;
            indentation.textContent = texts.indentation;
            encoding.textContent = texts.encoding;
            eol.textContent = texts.eol;
            language.textContent = texts.language;
        },
    };
}
