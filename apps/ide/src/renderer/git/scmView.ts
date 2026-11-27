import type { CodeXRApi } from '../../shared/api.ts';
import { emptyGitStatus, type GitChange, type GitRemoteOperation, type GitStatus } from '../../shared/git.ts';
import type { QuickInputProvider } from '../commands/quickInput.ts';
import { showContextMenu, type ContextMenuItem } from '../contextMenu.ts';
import { el, fileIcon, icon } from '../dom.ts';
import { gitCommandEntries, type GitActions } from './gitCommands.ts';
import {
    branchLabel, branchPickerView, changeCount, deleteBranchPickerView, letterTitle, parseBranchAction, parseStashPick,
    remoteProgressTitle, scmGroups, splitPath, stashPickerView, syncItem, type ScmGroup,
} from './scmModel.ts';
import './scm.css';

/**
 * The Source Control view (#17): VS Code's, kept minimal. The changed files
 * of the open folder grouped Staged / Changes / Untracked with their letter;
 * stage, unstage and discard per file (discard asks in a native dialog, in
 * the main process); a message box and Commit; the branch in the status bar,
 * which opens a picker to switch or create one.
 *
 * Git runs in the main process (main/git/). This view only ever sends the
 * workspace-relative paths git itself reported, and main checks them again.
 * It refreshes when the repository changes on disk (main watches the index,
 * HEAD and branches), when files of the folder change, when the window gets
 * focus, and every few seconds while it is the view on screen.
 *
 * #284: the "..." menu, the palette's Git commands and the sync item beside
 * the branch run push, pull, fetch, sync, the stash commands and Delete
 * Branch (`GitActions`). A remote operation shows a progress notification
 * whose Cancel stops git; its failure carries Show Output (the Git channel).
 */

export interface ScmView extends GitActions {
    /** Recomputes the status now (coalesced with one already running). */
    refresh(): Promise<void>;
    /** Another folder opened, or none: start over. */
    reset(): void;
    /** Opens the branch picker (the status-bar item's click). */
    pickBranch(): void;
    focus(): void;
}

export interface ScmViewHooks {
    /** The status bar's slot for the branch. */
    readonly branchStatus: HTMLElement;
    /** The activity-bar item, for the change count badge. */
    readonly activityItem: HTMLElement | null;
    /** The editor area, which the diff view covers while it is open. */
    readonly editorArea: HTMLElement;
    openFile(path: string): void;
    /** A working-tree file's text for the diff view; null when it is gone or not text. */
    readFile(path: string): Promise<string | null>;
    openQuickInput(provider: QuickInputProvider): void;
    /** True while this view is the one shown in the side bar. */
    isVisible(): boolean;
    showView(): void;
    /** `showOutput` adds a Show Output button on the Git channel (#284). */
    notify(severity: 'info' | 'error', message: string, showOutput?: boolean): void;
    /** #284: the progress notification of a remote operation, with its Cancel. */
    showProgress(title: string, cancel: () => void): void;
    hideProgress(): void;
    /** #284: asks a yes/no question (deleting an unmerged branch, dropping a stash). */
    confirm(message: string): boolean;
    /** Files of the folder changed on disk (the workspace watcher's events). */
    onDidChangeFiles(listener: () => void): void;
    /** #175: every new status, for the explorer's decorations. */
    onStatus?(status: GitStatus): void;
}

const ICONS = {
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
    commit: 'M5 12l5 5L20 7',
    stage: 'M12 5v14M5 12h14',
    unstage: 'M5 12h14',
    discard: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
    openFile: 'M6 3h8l5 5v13H6zM14 3v5h5',
    diff: 'M8 4v12M4 12l4 4 4-4M16 20V8M12 12l4-4 4 4',
    branch: 'M6 3v12M6 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM18 9a3 3 0 1 0 0-6a3 3 0 1 0 0 6zM18 9c0 6-12 3-12 6',
    close: 'M6 6l12 12M18 6L6 18',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    sync: 'M20 11a8 8 0 0 0-14.3-4.9M4 4v5h5M4 13a8 8 0 0 0 14.3 4.9M20 20v-5h-5',
    publish: 'M12 16V6M7 11l5-5 5 5M5 20h14',
};

/** How often the view re-reads the status while it is on screen and the window has focus. */
const POLL_MS = 5000;

export function createScmView(container: HTMLElement, api: CodeXRApi['git'], hooks: ScmViewHooks): ScmView {
    let status: GitStatus = emptyGitStatus('no-folder', 'Open a folder to use Source Control.');
    let running: Promise<void> | null = null;
    let again = false;
    let busy = false;
    /** #284: the remote operation running, if any (one at a time). */
    let remoteRunning: GitRemoteOperation | null = null;
    /** What the list shows now, so an unchanged status (the poll, a focus) does not rebuild it. */
    let rendered = '';

    const iconButton = (label: string, path: string, testId: string, run: () => void): HTMLButtonElement => {
        const button = el('button', { className: 'icon-button', attrs: { type: 'button', title: label, 'aria-label': label, 'data-testid': testId } }, [icon(path)]);
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            run();
        });
        return button;
    };

    // #284: the "..." menu, VS Code's: remote operations, stashes, branches.
    function moreButton(): HTMLButtonElement {
        const button = iconButton('More Actions...', ICONS.more, 'scm-more', () => {
            const rect = button.getBoundingClientRect();
            const ok = status.state === 'ok';
            const items: ContextMenuItem[] = gitCommandEntries(actions).map((entry) => (entry === null
                ? { separator: true }
                : { label: entry.title, run: entry.run, enabled: ok, testId: `scm-menu-${entry.id}` }));
            showContextMenu(items, rect.left, rect.bottom + 2, { label: 'Source Control actions' });
        });
        button.setAttribute('aria-haspopup', 'menu');
        return button;
    }

    const message = el('textarea', {
        className: 'scm-message',
        attrs: { rows: '3', placeholder: 'Message (Ctrl+Enter to commit)', 'aria-label': 'Commit message', spellcheck: 'true', 'data-testid': 'scm-message' },
    });
    const commitButton = el('button', { className: 'primary-button scm-commit', attrs: { type: 'button', 'data-testid': 'scm-commit' } }, [icon(ICONS.commit), el('span', { text: 'Commit' })]);
    const commitBox = el('div', { className: 'scm-commit-box' }, [message, commitButton]);
    const empty = el('div', { className: 'scm-empty', attrs: { 'data-testid': 'scm-empty' } });
    const list = el('div', { className: 'scm-groups', attrs: { role: 'tree', 'aria-label': 'Changes', 'data-testid': 'scm-groups' } });
    const header = el('div', { className: 'side-bar-header' }, [
        el('h2', { className: 'side-bar-title', text: 'Source Control' }),
        el('div', { className: 'side-bar-actions' }, [
            iconButton('Commit', ICONS.commit, 'scm-commit-action', () => void commit()),
            iconButton('Refresh', ICONS.refresh, 'scm-refresh', () => void refresh()),
            moreButton(),
        ]),
    ]);
    container.replaceChildren(header, empty, commitBox, list);

    const badge = el('span', { className: 'scm-badge', attrs: { 'aria-hidden': 'true', hidden: '' } });
    hooks.activityItem?.append(badge);

    const branchButton = el('button', { className: 'status-item scm-branch', attrs: { type: 'button', 'data-testid': 'scm-branch', hidden: '' } }, [icon(ICONS.branch), el('span')]);
    branchButton.addEventListener('click', () => pickBranch());
    // #284: ahead/behind beside the branch; a click syncs (or publishes a branch with no upstream).
    const syncButton = el('button', { className: 'status-item scm-sync', attrs: { type: 'button', 'data-testid': 'scm-sync', hidden: '' } }, [icon(ICONS.sync), el('span')]);
    syncButton.addEventListener('click', () => {
        const item = syncItem(status);
        if (item) {
            remote(item.operation);
        }
    });
    hooks.branchStatus.replaceChildren(branchButton, syncButton);

    message.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void commit();
        }
    });
    commitButton.addEventListener('click', () => void commit());

    function render(): void {
        const key = JSON.stringify([status, busy, remoteRunning]);
        if (key === rendered) {
            return;
        }
        rendered = key;
        const ok = status.state === 'ok';
        empty.hidden = ok;
        commitBox.hidden = !ok;
        list.hidden = !ok;
        if (!ok) {
            empty.replaceChildren(
                el('p', { className: 'muted side-note', text: status.message ?? 'Source Control is not available.' }),
                ...(status.state === 'not-repo' ? [el('p', { className: 'muted side-note small', text: 'Run "git init" in the terminal to start one; this view follows.' })] : []),
            );
        }
        const target = status.branch ?? 'HEAD';
        message.placeholder = `Message (${navigator.userAgent.includes('Macintosh') ? 'Cmd' : 'Ctrl'}+Enter to commit on "${target}")`;
        commitButton.disabled = busy;
        list.replaceChildren(...(ok ? scmGroups(status).map(renderGroup) : []));
        if (ok && changeCount(status) === 0) {
            list.append(el('p', { className: 'muted side-note small', attrs: { 'data-testid': 'scm-clean' }, text: 'No changes in the working tree.' }));
        }

        const count = ok ? changeCount(status) : 0;
        badge.hidden = count === 0;
        badge.textContent = count > 999 ? '999+' : String(count);

        const label = branchLabel(status);
        branchButton.hidden = label === null;
        const text = branchButton.querySelector('span');
        if (text) {
            text.textContent = label ?? '';
        }
        branchButton.title = label === null ? '' : `${label} - Switch or create a branch`;
        branchButton.setAttribute('aria-label', label === null ? 'Branch' : `Branch ${label}, switch or create a branch`);

        const sync = syncItem(status);
        syncButton.hidden = sync === null;
        syncButton.disabled = remoteRunning !== null;
        syncButton.classList.toggle('is-running', remoteRunning !== null);
        syncButton.replaceChildren(icon(sync?.operation === 'push' ? ICONS.publish : ICONS.sync), el('span', { text: sync?.text ?? '' }));
        const syncTitle = remoteRunning !== null ? remoteProgressTitle(remoteRunning, status) : sync?.title ?? '';
        syncButton.title = syncTitle;
        syncButton.setAttribute('aria-label', syncTitle === '' ? 'Synchronize Changes' : syncTitle);
    }

    function renderGroup(group: ScmGroup): HTMLElement {
        const paths = group.changes.map((change) => change.path);
        const actions = group.id === 'staged'
            ? [iconButton('Unstage All Changes', ICONS.unstage, `scm-unstage-all`, () => void run(() => api.unstage(paths)))]
            : [iconButton(group.id === 'untracked' ? 'Stage All Untracked' : 'Stage All Changes', ICONS.stage, `scm-stage-all-${group.id}`, () => void run(() => api.stage(paths)))];
        const head = el('div', { className: 'scm-group-header', attrs: { role: 'treeitem', 'aria-expanded': 'true', 'data-group': group.id } }, [
            el('span', { className: 'scm-group-label', text: group.label }),
            el('span', { className: 'scm-row-actions' }, actions),
            el('span', { className: 'scm-count', text: String(group.changes.length) }),
        ]);
        return el('div', { className: 'scm-group', attrs: { role: 'group', 'data-testid': `scm-group-${group.id}` } }, [head, ...group.changes.map((change) => renderChange(group, change))]);
    }

    function renderChange(group: ScmGroup, change: GitChange): HTMLElement {
        const { name, folder } = splitPath(change.path);
        const deleted = change.letter === 'D';
        const actions: HTMLButtonElement[] = [
            iconButton('Open Changes', ICONS.diff, 'scm-open-diff', () => void openDiff(change)),
        ];
        if (!deleted) {
            actions.push(iconButton('Open File', ICONS.openFile, 'scm-open-file', () => hooks.openFile(change.path)));
        }
        if (group.id === 'staged') {
            actions.push(iconButton('Unstage Changes', ICONS.unstage, 'scm-unstage', () => void run(() => api.unstage([change.path]))));
        } else {
            actions.push(iconButton('Discard Changes', ICONS.discard, 'scm-discard', () => void run(() => api.discard(change.path))));
            actions.push(iconButton('Stage Changes', ICONS.stage, 'scm-stage', () => void run(() => api.stage([change.path]))));
        }
        const title = `${change.origPath ? `${change.origPath} -> ` : ''}${change.path} - ${letterTitle(change.letter)}`;
        const row = el('div', {
            className: `scm-change${deleted ? ' is-deleted' : ''}`,
            attrs: { role: 'treeitem', tabindex: '0', title, 'data-path': change.path, 'data-letter': change.letter, 'data-testid': 'scm-change' },
        }, [
            fileIcon(name, 'file'),
            el('span', { className: 'scm-name', text: name }),
            el('span', { className: 'scm-folder muted', text: folder }),
            el('span', { className: 'scm-row-actions' }, actions),
            el('span', { className: 'scm-letter', attrs: { 'data-letter': change.letter, 'aria-label': letterTitle(change.letter) }, text: change.letter }),
        ]);
        const open = (): void => {
            if (deleted) {
                void openDiff(change);
            } else {
                hooks.openFile(change.path);
            }
        };
        row.addEventListener('click', open);
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                open();
            }
        });
        return row;
    }

    /** Runs a change and shows the status it resolves with; errors go to a notification. */
    async function run(action: () => Promise<GitStatus>): Promise<void> {
        try {
            status = await action();
            render();
            hooks.onStatus?.(status);
        } catch (error) {
            hooks.notify('error', cleanError(error));
            await refresh();
        }
    }

    async function commit(): Promise<void> {
        if (busy || status.state !== 'ok') {
            return;
        }
        if (message.value.trim() === '') {
            hooks.notify('error', 'Write a commit message first.');
            message.focus();
            return;
        }
        busy = true;
        render();
        try {
            const result = await api.commit(message.value);
            if (result.commit) {
                message.value = '';
                hooks.notify('info', `Committed ${result.commit} on ${status.branch ?? 'HEAD'}.`);
            }
        } catch (error) {
            hooks.notify('error', cleanError(error));
        } finally {
            busy = false;
            await refresh();
        }
    }

    function refresh(): Promise<void> {
        if (running) {
            again = true;
            return running;
        }
        running = (async () => {
            do {
                again = false;
                try {
                    status = await api.status();
                } catch (error) {
                    status = emptyGitStatus('error', cleanError(error));
                }
                render();
                hooks.onStatus?.(status);
            } while (again);
        })().finally(() => {
            running = null;
        });
        return running;
    }

    function pickBranch(): void {
        void api.branches().then(({ branches, current }) => {
            hooks.openQuickInput({
                label: 'Select a branch to switch to, or type a new branch name',
                view: (value) => branchPickerView(branches, current, value),
                accept: (action) => {
                    const choice = action.kind === 'pick' ? parseBranchAction(action.id) : null;
                    if (!choice || (choice.kind === 'switch' && choice.name === current)) {
                        return;
                    }
                    void run(() => (choice.kind === 'switch' ? api.switchBranch(choice.name) : api.createBranch(choice.name))).then(() => {
                        if (status.branch === choice.name) {
                            hooks.notify('info', choice.kind === 'switch' ? `Switched to ${choice.name}.` : `Created and switched to ${choice.name}.`);
                        }
                    });
                },
            });
        }, (error: unknown) => hooks.notify('error', cleanError(error)));
    }

    // #284: push, pull, fetch and sync. One at a time; the progress notification's Cancel stops git.
    function remote(operation: GitRemoteOperation): void {
        if (remoteRunning !== null) {
            hooks.notify('info', 'A Git push, pull or fetch is already running.');
            return;
        }
        if (status.state !== 'ok') {
            hooks.notify('error', status.message ?? 'Source Control is not available.');
            return;
        }
        remoteRunning = operation;
        render();
        hooks.showProgress(`Git: ${remoteProgressTitle(operation, status)}`, () => void api.cancelRemote());
        void api.remote(operation).then((result) => {
            status = result.status;
            render();
            hooks.onStatus?.(status);
            if (result.done) {
                hooks.notify('info', remoteDoneMessage(operation, status));
            }
        }, (error: unknown) => {
            const text = cleanError(error);
            if (/ was cancelled\.$/.test(text)) {
                hooks.notify('info', `Git: ${operation} cancelled.`);
            } else {
                hooks.notify('error', text, true);
            }
        }).finally(() => {
            remoteRunning = null;
            hooks.hideProgress();
            void refresh();
        });
    }

    function stash(includeUntracked: boolean): void {
        const before = changeCount(status);
        void run(() => api.stash(includeUntracked)).then(() => {
            if (status.state === 'ok' && changeCount(status) < before) {
                hooks.notify('info', includeUntracked ? 'Stashed the changes and the untracked files.' : 'Stashed the changes.');
            }
        });
    }

    function stashAction(action: 'apply' | 'pop' | 'drop'): void {
        void api.stashes().then((stashes) => {
            if (stashes.length === 0) {
                hooks.notify('info', 'There are no stashes.');
                return;
            }
            hooks.openQuickInput({
                label: `Pick a stash to ${action}`,
                view: (value) => stashPickerView(stashes, value),
                accept: (picked) => {
                    const index = picked.kind === 'pick' ? parseStashPick(picked.id) : null;
                    const entry = stashes.find((candidate) => candidate.index === index);
                    if (index === null || !entry) {
                        return;
                    }
                    if (action === 'drop' && !hooks.confirm(`Drop the stash "${entry.label}"? This cannot be undone.`)) {
                        return;
                    }
                    void run(() => (action === 'apply' ? api.stashApply(index) : action === 'pop' ? api.stashPop(index) : api.stashDrop(index)));
                },
            });
        }, (error: unknown) => hooks.notify('error', cleanError(error)));
    }

    function deleteBranch(): void {
        void api.branches().then(({ branches, current }) => {
            hooks.openQuickInput({
                label: 'Select a branch to delete',
                view: (value) => deleteBranchPickerView(branches, current, value),
                accept: (picked) => {
                    const name = picked.kind === 'pick' && picked.id.startsWith('delete:') ? picked.id.slice('delete:'.length) : null;
                    if (name !== null) {
                        void removeBranch(name);
                    }
                },
            });
        }, (error: unknown) => hooks.notify('error', cleanError(error)));
    }

    // #284: -d first; an unmerged branch is forced (-D) only after the person agrees.
    async function removeBranch(name: string): Promise<void> {
        try {
            let result = await api.deleteBranch(name, false);
            if (result.notMerged) {
                if (!hooks.confirm(`The branch "${name}" is not fully merged. Its commits may be lost.\n\nDelete it anyway?`)) {
                    return;
                }
                result = await api.deleteBranch(name, true);
            }
            status = result.status;
            render();
            hooks.onStatus?.(status);
            if (result.deleted) {
                hooks.notify('info', `Deleted the branch ${name}.`);
            }
        } catch (error) {
            hooks.notify('error', cleanError(error));
            await refresh();
        }
    }

    const actions: GitActions = {
        hasRepository: () => status.state === 'ok',
        remote,
        stash,
        stashAction,
        deleteBranch,
    };

    // The diff view: Monaco's diff editor over the editor area, HEAD on the left, the working tree on the right.
    let diff: { dispose(): void } | null = null;
    async function openDiff(change: GitChange): Promise<void> {
        try {
            const { showDiff } = await import('./diffView.ts');
            diff?.dispose();
            diff = await showDiff(hooks.editorArea, change, {
                headContent: (path) => api.headContent(path),
                readFile: (path) => hooks.readFile(path),
                openFile: (path) => hooks.openFile(path),
                onClose: () => { diff = null; },
            });
        } catch (error) {
            hooks.notify('error', `Could not open the changes of ${change.path}: ${cleanError(error)}`);
        }
    }

    // Refresh triggers: the repository on disk, the window's focus, and a slow poll while the view is on screen.
    api.onDidChange(() => void refresh());
    let filesTimer: ReturnType<typeof setTimeout> | undefined;
    hooks.onDidChangeFiles(() => {
        clearTimeout(filesTimer);
        filesTimer = setTimeout(() => void refresh(), 300);
    });
    window.addEventListener('focus', () => void refresh());
    window.setInterval(() => {
        if (hooks.isVisible() && document.hasFocus() && !running) {
            void refresh();
        }
    }, POLL_MS);

    render();
    return {
        refresh,
        reset(): void {
            diff?.dispose();
            diff = null;
            message.value = '';
            void refresh();
        },
        pickBranch,
        ...actions,
        focus(): void {
            hooks.showView();
            message.focus();
        },
    };
}

/** #284: the info toast after a remote operation succeeded. */
function remoteDoneMessage(operation: GitRemoteOperation, status: GitStatus): string {
    const where = status.upstream ?? 'the remote';
    switch (operation) {
        case 'push': return `Pushed ${status.branch ?? 'the branch'} to ${where}.`;
        case 'pull': return `Pulled from ${where}.`;
        case 'fetch': return status.upstream && status.behind > 0 ? `Fetched: ${status.behind} incoming commit${status.behind === 1 ? '' : 's'} on ${where}.` : 'Fetched.';
        case 'sync': return `Synchronized with ${where}.`;
    }
}

/** IPC errors arrive as "Error invoking remote method '...': Error: <message>"; keep the message. */
function cleanError(error: unknown): string {
    const text = String(error instanceof Error ? error.message : error);
    return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
