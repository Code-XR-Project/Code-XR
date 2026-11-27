import type { AgentSessionsApi, AgentSessionState, WorktreeStatusView } from '../../shared/agentSession.ts';
import { el } from '../dom.ts';
import { mergeOutcome, suggestedCommitMessage, worktreeActions, worktreeSummary } from './worktreeModel.ts';

/**
 * AF12 (#277): the Worktree bar of a chat that runs in its own git worktree,
 * opened from the chat header. It shows what the agent changed on its branch
 * (files, commits ahead, commits the project's branch has that it does not),
 * and offers Commit (message prefilled from the chat title), Merge or Squash
 * into the project's current branch, and Discard worktree (confirmed inline).
 * Every call names the chat by id; the main process looks up the worktree.
 * Refusals (conflicts, uncommitted changes overlapping the agent's files...)
 * are shown in the bar as the main process words them.
 */

export interface WorktreeBar {
    readonly element: HTMLElement;
    /** Shows or hides the bar; shown, it reads the status. */
    toggle(open?: boolean): void;
    readonly isOpen: boolean;
    /** The chat changed (a turn ended, the worktree was discarded): re-reads the status when the bar is open. */
    update(state: AgentSessionState): void;
}

export interface WorktreeBarDeps {
    readonly api: AgentSessionsApi;
    onStatus(message: string): void;
}

export function createWorktreeBar(sessionId: string, deps: WorktreeBarDeps): WorktreeBar {
    let state: AgentSessionState | null = null;
    let status: WorktreeStatusView | null = null;
    let busy = false;
    let loading: Promise<void> | null = null;
    let messageTouched = false;

    const summary = el('p', { className: 'af-worktree-summary', attrs: { 'data-testid': 'af-worktree-summary' }, text: 'Reading the worktree...' });
    const files = el('ul', { className: 'af-worktree-files muted' });
    const message = el('input', { className: 'agents-input af-worktree-message', attrs: { type: 'text', 'aria-label': 'Commit message', placeholder: 'Commit message', 'data-testid': 'af-worktree-message' } });
    message.addEventListener('input', () => {
        messageTouched = true;
        render();
    });
    const commit = button('Commit', 'secondary-button af-small-button', 'af-worktree-commit');
    const merge = button('Merge', 'secondary-button af-small-button', 'af-worktree-merge');
    const squash = button('Squash', 'secondary-button af-small-button', 'af-worktree-squash');
    const discard = button('Discard worktree', 'secondary-button is-danger af-small-button', 'af-worktree-discard');
    const confirmText = el('span');
    const confirmYes = button('Discard', 'secondary-button is-danger af-small-button', 'af-worktree-discard-yes');
    const confirmNo = button('Cancel', 'secondary-button af-small-button', 'af-worktree-discard-no');
    const confirm = el('div', { className: 'af-worktree-confirm', attrs: { hidden: '', role: 'group', 'aria-label': 'Discard worktree' } }, [confirmText, confirmYes, confirmNo]);
    const error = el('p', { className: 'af-worktree-error', attrs: { hidden: '', role: 'alert', 'data-testid': 'af-worktree-error' } });
    const hint = el('span', { className: 'muted af-worktree-hint' });
    const element = el('div', { className: 'af-worktree', attrs: { hidden: '', role: 'region', 'aria-label': 'Worktree', 'data-testid': 'af-worktree' } }, [
        summary,
        files,
        el('div', { className: 'af-worktree-row' }, [message, commit]),
        el('div', { className: 'af-worktree-row' }, [merge, squash, hint, el('span', { className: 'af-spacer' }), discard]),
        confirm,
        error,
    ]);

    function button(text: string, className: string, testId: string): HTMLButtonElement {
        return el('button', { className, text, attrs: { type: 'button', 'data-testid': testId } });
    }

    function agentBusy(): boolean {
        return state?.status === 'running' || state?.status === 'awaiting';
    }

    function render(): void {
        const actions = worktreeActions(status, busy || agentBusy());
        summary.textContent = status ? worktreeSummary(status) : 'Reading the worktree...';
        const shown = status?.files.slice(0, 8) ?? [];
        files.replaceChildren(...shown.map((file) => el('li', { text: `${file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'} ${file.path}${file.uncommitted ? '' : ' (committed)'}` })));
        if (status && status.files.length > shown.length) {
            files.append(el('li', { text: `and ${status.files.length - shown.length} more` }));
        }
        const into = status?.into ?? 'the project';
        merge.textContent = `Merge into ${into}`;
        squash.textContent = `Squash into ${into}`;
        merge.title = 'A merge commit (--no-ff) on the project\'s current branch; refused, with nothing changed, if it would conflict.';
        squash.title = 'One ordinary commit with all of the agent\'s changes, titled after the chat.';
        commit.disabled = !actions.commit || !message.value.trim();
        merge.disabled = !actions.merge;
        squash.disabled = !actions.merge;
        discard.disabled = !actions.discard;
        hint.textContent = status && !status.removed && actions.mergeHint ? actions.mergeHint : '';
        const editable = !!status && !status.removed && status.exists;
        message.disabled = !editable;
        for (const node of [message, commit, merge, squash, discard]) {
            node.hidden = !!status?.removed;
        }
        if (!messageTouched && state) {
            message.value = suggestedCommitMessage(state.title);
        }
    }

    function showError(text: string | null): void {
        error.hidden = text === null;
        error.textContent = text ?? '';
    }

    async function load(): Promise<void> {
        loading ??= deps.api.worktreeStatus(sessionId).then((next) => {
            status = next;
            showError(null);
        }, (failure: unknown) => {
            showError(errorText(failure));
        }).finally(() => {
            loading = null;
            render();
        });
        return loading;
    }

    async function run(action: () => Promise<string | null>): Promise<void> {
        if (busy) {
            return;
        }
        busy = true;
        showError(null);
        render();
        try {
            const done = await action();
            if (done) {
                deps.onStatus(done);
            }
        } catch (failure) {
            showError(errorText(failure));
        } finally {
            busy = false;
            await load();
        }
    }

    commit.addEventListener('click', () => void run(async () => {
        const result = await deps.api.worktreeCommit(sessionId, message.value);
        messageTouched = false;
        return result.commit ? `Committed ${result.fileCount} file${result.fileCount === 1 ? '' : 's'} on the agent's branch.` : 'Nothing to commit.';
    }));
    for (const [node, strategy] of [[merge, 'merge'], [squash, 'squash']] as const) {
        node.addEventListener('click', () => void run(async () => mergeOutcome(await deps.api.worktreeMerge(sessionId, strategy))));
    }
    discard.addEventListener('click', () => {
        confirmText.textContent = `Remove this worktree and delete the branch ${status?.branch ?? ''}? Work that is not merged is lost.`;
        confirm.hidden = false;
        confirmNo.focus();
    });
    confirmNo.addEventListener('click', () => {
        confirm.hidden = true;
    });
    confirmYes.addEventListener('click', () => {
        confirm.hidden = true;
        void run(async () => {
            await deps.api.worktreeDiscard(sessionId);
            return 'The worktree and its branch were removed.';
        });
    });

    return {
        element,
        get isOpen() {
            return !element.hidden;
        },
        toggle(open?: boolean): void {
            const next = open ?? element.hidden;
            element.hidden = !next;
            if (next) {
                render();
                void load();
            } else {
                confirm.hidden = true;
            }
        },
        update(next: AgentSessionState): void {
            const before = state;
            state = next;
            const finished = before !== null && (before.status === 'running' || before.status === 'awaiting') && next.status !== 'running' && next.status !== 'awaiting';
            const discarded = before?.worktree?.removed !== next.worktree?.removed;
            if (!element.hidden && (finished || discarded)) {
                void load();
            } else {
                render();
            }
        },
    };
}

function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
