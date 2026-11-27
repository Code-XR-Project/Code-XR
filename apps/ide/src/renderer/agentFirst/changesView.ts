import type { AgentSessionsApi, ChangedFileView, ChatChanges } from '../../shared/agentSession.ts';
import { el, fileIcon } from '../dom.ts';
import type { ChangesDiff } from './changesDiff.ts';
import { changesSummary, nextSelection, statusLetter } from './changesModel.ts';

/**
 * The Changes tab of a chat (AF5, #270): every file the chat changed that
 * still awaits review, with its status and line counts, a Monaco diff of the
 * selected one (its review base on the left, the disk on the right), and Keep
 * or Undo per file or for all. It refreshes when the chat reports a new
 * pending count, and when it is shown again.
 */

export interface ChangesViewDeps {
    readonly api: AgentSessionsApi;
    openFile(path: string): void;
    onStatus(message: string): void;
}

export interface ChangesView {
    readonly element: HTMLElement;
    refresh(): Promise<void>;
    dispose(): void;
}

const CONFIRM_MS = 4000;

export function createChangesView(sessionId: string, deps: ChangesViewDeps): ChangesView {
    let files: readonly ChangedFileView[] = [];
    let selected: string | null = null;
    let busy = false;
    let disposed = false;
    let diff: ChangesDiff | null = null;
    let diffLoading: Promise<ChangesDiff> | null = null;
    let showToken = 0;

    const summary = el('span', { className: 'af-changes-summary muted', attrs: { 'data-testid': 'af-changes-summary' } });
    const keepAll = el('button', { className: 'secondary-button', text: 'Keep all', attrs: { type: 'button', 'data-testid': 'af-changes-keep-all', title: 'Accept every change as it is now' } });
    const undoAll = el('button', { className: 'secondary-button is-danger', text: 'Undo all', attrs: { type: 'button', 'data-testid': 'af-changes-undo-all', title: 'Put every file back as it was before the chat changed it' } });
    const notice = el('p', { className: 'af-changes-notice muted', attrs: { hidden: '', role: 'status' } });
    const list = el('ul', { className: 'af-changes-list', attrs: { 'aria-label': 'Changed files', 'data-testid': 'af-changes-list' } });
    const diffTitle = el('span', { className: 'af-changes-diff-title' });
    const openButton = el('button', { className: 'af-link-button', text: 'Open file', attrs: { type: 'button', hidden: '' } });
    const diffNote = el('p', { className: 'af-changes-diff-note muted', attrs: { hidden: '' } });
    const diffHost = el('div', { className: 'af-changes-diff-host', attrs: { 'data-testid': 'af-changes-diff' } });
    const element = el('section', { className: 'af-changes', attrs: { 'data-testid': 'af-changes', 'data-session': sessionId } }, [
        el('header', { className: 'af-changes-header' }, [
            el('div', { className: 'af-chat-heading' }, [el('h2', { className: 'af-chat-title', text: 'Changes' }), summary]),
            el('span', { className: 'af-spacer' }),
            keepAll,
            undoAll,
        ]),
        notice,
        el('div', { className: 'af-changes-body' }, [
            list,
            el('div', { className: 'af-changes-diff' }, [el('div', { className: 'af-changes-diff-head' }, [diffTitle, el('span', { className: 'af-spacer' }), openButton]), diffNote, diffHost]),
        ]),
    ]);

    openButton.addEventListener('click', () => {
        if (selected) {
            deps.openFile(selected);
        }
    });
    keepAll.addEventListener('click', () => void act(() => deps.api.keepChanges(sessionId, 'all'), 'Kept every change.'));
    let undoArmed: ReturnType<typeof setTimeout> | null = null;
    undoAll.addEventListener('click', () => {
        if (!undoArmed) {
            undoAll.textContent = `Undo ${files.length} file${files.length === 1 ? '' : 's'}?`;
            undoArmed = setTimeout(disarmUndo, CONFIRM_MS);
            return;
        }
        disarmUndo();
        void act(() => deps.api.undoChanges(sessionId, 'all'), 'Undid every change.');
    });
    function disarmUndo(): void {
        if (undoArmed) {
            clearTimeout(undoArmed);
        }
        undoArmed = null;
        undoAll.textContent = 'Undo all';
    }

    async function act(run: () => Promise<ChatChanges>, done: string): Promise<void> {
        if (busy) {
            return;
        }
        busy = true;
        renderButtons();
        try {
            apply(await run());
            deps.onStatus(done);
        } catch (error) {
            deps.onStatus(errorText(error));
        } finally {
            busy = false;
            renderButtons();
        }
    }

    function renderButtons(): void {
        keepAll.disabled = busy || files.length === 0;
        undoAll.disabled = busy || files.length === 0;
        for (const button of list.querySelectorAll('button')) {
            button.disabled = busy;
        }
    }

    function apply(changes: ChatChanges): void {
        if (disposed) {
            return;
        }
        const previousIndex = selected === null ? 0 : Math.max(0, files.findIndex((file) => file.path === selected));
        files = changes.files;
        summary.textContent = changesSummary(files);
        notice.hidden = changes.disabledReason === null && files.length > 0;
        notice.textContent = changes.disabledReason !== null
            ? `Checkpoints are off for this project: ${changes.disabledReason}`
            : 'Nothing to review: the files are as you last kept them.';
        const next = nextSelection(files, selected, previousIndex);
        renderList(next);
        renderButtons();
        if (next !== selected || next === null) {
            select(next);
        } else {
            void showDiff(next);
        }
    }

    function renderList(active: string | null): void {
        list.replaceChildren(...files.map((file) => {
            const slash = file.path.lastIndexOf('/');
            const name = file.path.slice(slash + 1);
            const folder = slash >= 0 ? file.path.slice(0, slash) : '';
            const keep = el('button', { className: 'af-link-button', text: 'Keep', attrs: { type: 'button', title: `Accept the change to ${file.path}`, 'data-action': 'keep' } });
            const undo = el('button', { className: 'af-link-button is-danger', text: 'Undo', attrs: { type: 'button', title: `Put ${file.path} back as it was`, 'data-action': 'undo' } });
            keep.addEventListener('click', (event) => {
                event.stopPropagation();
                void act(() => deps.api.keepChanges(sessionId, [file.path]), `Kept ${file.path}.`);
            });
            undo.addEventListener('click', (event) => {
                event.stopPropagation();
                void act(() => deps.api.undoChanges(sessionId, [file.path]), `Undid the change to ${file.path}.`);
            });
            const row = el('li', {
                className: `af-changes-row${file.path === active ? ' is-selected' : ''}`,
                attrs: { 'data-path': file.path, 'data-status': file.status, tabindex: '0', role: 'button', 'aria-label': `${file.path}, ${file.status}` },
            }, [
                el('span', { className: 'af-changes-status', text: statusLetter(file.status), attrs: { 'data-status': file.status, title: file.status } }),
                fileIcon(name, 'file'),
                el('span', { className: 'af-changes-name', text: name, attrs: { title: file.path } }),
                el('span', { className: 'af-changes-folder muted', text: folder }),
                el('span', { className: 'af-diff-counts' }, file.binary ? [el('span', { className: 'muted', text: 'binary' })] : [el('span', { className: 'is-add', text: `+${file.additions}` }), el('span', { className: 'is-remove', text: ` -${file.deletions}` })]),
                el('span', { className: 'af-changes-actions' }, [keep, undo]),
            ]);
            row.addEventListener('click', () => select(file.path));
            row.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    select(file.path);
                }
            });
            return row;
        }));
    }

    function select(filePath: string | null): void {
        selected = filePath;
        for (const row of list.querySelectorAll<HTMLElement>('.af-changes-row')) {
            row.classList.toggle('is-selected', row.dataset['path'] === filePath);
        }
        void showDiff(filePath);
    }

    function loadDiff(): Promise<ChangesDiff> {
        diffLoading ??= import('./changesDiff.ts').then(({ createChangesDiff }) => {
            const created = createChangesDiff(diffHost);
            if (disposed) {
                created.dispose();
            } else {
                diff = created;
            }
            return created;
        });
        return diffLoading;
    }

    async function showDiff(filePath: string | null): Promise<void> {
        const token = ++showToken;
        const file = files.find((candidate) => candidate.path === filePath) ?? null;
        diffTitle.textContent = file ? file.path : '';
        openButton.hidden = !file || file.status === 'deleted';
        diffNote.hidden = true;
        if (!file) {
            diff?.clear();
            return;
        }
        if (file.binary) {
            diff?.clear();
            diffNote.hidden = false;
            diffNote.textContent = 'A binary file: no text diff to show.';
            return;
        }
        try {
            const [editor, sides] = await Promise.all([loadDiff(), deps.api.changeDiff(sessionId, file.path)]);
            if (token !== showToken || disposed) {
                return;
            }
            editor.show(file.path, sides.oldText ?? '', sides.newText ?? '');
        } catch (error) {
            if (token === showToken) {
                diffNote.hidden = false;
                diffNote.textContent = `Could not show the change: ${errorText(error)}`;
            }
        }
    }

    async function refresh(): Promise<void> {
        try {
            apply(await deps.api.changes(sessionId));
        } catch (error) {
            notice.hidden = false;
            notice.textContent = errorText(error);
        }
    }

    summary.textContent = 'Loading...';
    renderButtons();

    return {
        element,
        refresh,
        dispose(): void {
            disposed = true;
            disarmUndo();
            diff?.dispose();
        },
    };
}

function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
