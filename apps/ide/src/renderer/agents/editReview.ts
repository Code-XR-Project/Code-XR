import type { editor } from 'monaco-editor';
import type { EditReviewRequest, EditReviewResult } from '../../shared/agents.ts';
import { applyHunks, diffLines, type Hunk } from '../../shared/lineDiff.ts';
import { el } from '../dom.ts';

/**
 * The review of a change an agent proposes (A8): a Monaco diff over the
 * editor area, the change's hunks to accept or reject one by one, and the
 * write of what was accepted through the window's normal save path. Reviews
 * come one at a time; the next waits for the current one.
 */

export interface EditReviewHooks {
    /** Writes into an open editor and saves it (undoable); 'not-open' when the file has no tab. */
    applyInEditor(path: string, expected: string, text: string): Promise<'saved' | 'not-open' | 'unsaved-changes' | 'save-failed'>;
    writeFile(path: string, text: string, expectedMtimeMs?: number): Promise<unknown>;
    createFile(parent: string, name: string): Promise<string>;
    onStatus(message: string): void;
}

type DiffEditor = editor.IStandaloneDiffEditor;

export function createEditReviewer(host: HTMLElement, hooks: EditReviewHooks): (request: EditReviewRequest) => Promise<EditReviewResult> {
    let queue: Promise<unknown> = Promise.resolve();
    return (request) => {
        const next = queue.then(() => review(host, hooks, request));
        queue = next.catch(() => undefined);
        return next;
    };
}

async function review(host: HTMLElement, hooks: EditReviewHooks, request: EditReviewRequest): Promise<EditReviewResult> {
    const hunks = diffLines(request.original, request.proposed);
    const accepted = new Set(hunks.map((_, index) => index));
    const { monaco } = await import('../editor/monaco.ts');

    const diffHost = el('div', { className: 'edit-review-diff' });
    const list = el('ol', { className: 'edit-review-hunks', attrs: { 'aria-label': 'Changes' } });
    const applySelected = el('button', { className: 'primary-button', attrs: { type: 'button', 'data-action': 'apply-selected' } });
    const acceptAll = el('button', { className: 'secondary-button', text: 'Accept all', attrs: { type: 'button', 'data-action': 'accept-all' } });
    const reject = el('button', { className: 'secondary-button', text: 'Reject', attrs: { type: 'button', 'data-action': 'reject' } });
    const error = el('p', { className: 'error small', attrs: { role: 'alert', hidden: '' } });
    const layer = el('div', { className: 'edit-review', attrs: { role: 'dialog', 'aria-modal': 'false', 'aria-label': `Review change to ${request.path}`, 'data-testid': 'edit-review' } }, [
        el('div', { className: 'edit-review-head' }, [
            el('div', { className: 'edit-review-title' }, [
                el('span', { className: 'edit-review-kicker', text: request.isNew ? 'New file proposed by an agent' : 'Change proposed by an agent' }),
                el('code', { className: 'edit-review-path', text: request.path }),
                ...(request.summary ? [el('span', { className: 'muted small edit-review-summary', text: request.summary })] : []),
            ]),
            el('div', { className: 'env-actions' }, [applySelected, acceptAll, reject]),
        ]),
        error,
        el('div', { className: 'edit-review-body' }, [list, diffHost]),
    ]);

    const refreshButton = (): void => {
        applySelected.textContent = `Apply ${accepted.size} of ${hunks.length}`;
        applySelected.disabled = accepted.size === 0;
    };
    let diff: DiffEditor | null = null;
    list.replaceChildren(...hunks.map((hunk, index) => {
        const box = el('input', { attrs: { type: 'checkbox', 'data-hunk': String(index), 'aria-label': `Accept change ${index + 1}` } });
        box.checked = true;
        box.addEventListener('change', () => {
            if (box.checked) {
                accepted.add(index);
            } else {
                accepted.delete(index);
            }
            refreshButton();
        });
        const jump = el('button', { className: 'edit-review-hunk-label', text: hunkLabel(hunk, index), attrs: { type: 'button', title: 'Show this change' } });
        jump.addEventListener('click', () => {
            diff?.getModifiedEditor().revealLineInCenter(hunk.modifiedStart + 1);
            diff?.getOriginalEditor().revealLineInCenter(Math.max(1, hunk.originalStart + 1));
        });
        return el('li', { className: 'edit-review-hunk' }, [box, jump]);
    }));
    refreshButton();

    host.append(layer);
    const tag = encodeURIComponent(request.id);
    const original = monaco.editor.createModel(request.original, undefined, monaco.Uri.parse(`agent-review:/original/${tag}/${request.path}`));
    const proposed = monaco.editor.createModel(request.proposed, undefined, monaco.Uri.parse(`agent-review:/proposed/${tag}/${request.path}`));
    diff = monaco.editor.createDiffEditor(diffHost, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: host.clientWidth > 900,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
    });
    diff.setModel({ original, modified: proposed });
    applySelected.focus();

    return new Promise<EditReviewResult>((resolve) => {
        const finish = (result: EditReviewResult): void => {
            diff?.dispose();
            original.dispose();
            proposed.dispose();
            layer.remove();
            resolve(result);
        };
        const apply = async (chosen: ReadonlySet<number>): Promise<void> => {
            for (const button of [applySelected, acceptAll, reject]) {
                button.disabled = true;
            }
            const text = applyHunks(request.original, hunks, chosen);
            const failure = await write(hooks, request, text);
            if (failure?.final) {
                hooks.onStatus(failure.message);
                finish({ outcome: 'failed', accepted: 0, total: hunks.length, message: failure.message });
                return;
            }
            if (failure) {
                // Stays open: the person can save the other file and try again, or reject.
                error.hidden = false;
                error.textContent = failure.message;
                reject.disabled = false;
                acceptAll.disabled = false;
                refreshButton();
                return;
            }
            hooks.onStatus(`Applied ${chosen.size} of ${hunks.length} changes to ${request.path}.`);
            finish({ outcome: 'applied', accepted: chosen.size, total: hunks.length });
        };
        applySelected.addEventListener('click', () => void apply(accepted));
        acceptAll.addEventListener('click', () => void apply(new Set(hunks.map((_, index) => index))));
        reject.addEventListener('click', () => finish({ outcome: 'rejected', accepted: 0, total: hunks.length }));
    });
}

/** Writes the accepted text; resolves with a reason when it could not (`final` when trying again cannot help). */
async function write(hooks: EditReviewHooks, request: EditReviewRequest, text: string): Promise<{ readonly message: string; readonly final: boolean } | null> {
    try {
        if (request.isNew) {
            const slash = request.path.lastIndexOf('/');
            await hooks.createFile(slash < 0 ? '' : request.path.slice(0, slash), request.path.slice(slash + 1));
            await hooks.writeFile(request.path, text);
            return null;
        }
        const inEditor = await hooks.applyInEditor(request.path, request.original, text);
        switch (inEditor) {
            case 'saved':
                return null;
            case 'unsaved-changes':
                return { message: `${request.path} has unsaved changes in the editor. Save or revert them, then apply again.`, final: false };
            case 'save-failed':
                return { message: `${request.path} could not be saved (it may have changed on disk). The change is in the editor; undo it there with Ctrl/Cmd+Z if needed.`, final: true };
            case 'not-open':
                await hooks.writeFile(request.path, text, request.originalMtimeMs ?? undefined);
                return null;
        }
    } catch (failure) {
        return { message: (failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), final: true };
    }
}

function hunkLabel(hunk: Hunk, index: number): string {
    const removed = hunk.originalCount;
    const added = hunk.lines.length;
    const where = removed > 0 ? `line ${hunk.originalStart + 1}` : `after line ${hunk.originalStart}`;
    return `${index + 1}. ${where}: +${added} −${removed}`;
}
