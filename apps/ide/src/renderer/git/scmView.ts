import type { CodeXRApi } from '../../shared/api.ts';
import { emptyGitStatus, type GitChange, type GitStatus } from '../../shared/git.ts';
import type { QuickInputProvider } from '../commands/quickInput.ts';
import { el, fileIcon, icon } from '../dom.ts';
import { branchLabel, branchPickerView, changeCount, letterTitle, parseBranchAction, scmGroups, splitPath, type ScmGroup } from './scmModel.ts';
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
 */

export interface ScmView {
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
    notify(severity: 'info' | 'error', message: string): void;
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
};

/** How often the view re-reads the status while it is on screen and the window has focus. */
const POLL_MS = 5000;

export function createScmView(container: HTMLElement, api: CodeXRApi['git'], hooks: ScmViewHooks): ScmView {
    let status: GitStatus = emptyGitStatus('no-folder', 'Open a folder to use Source Control.');
    let running: Promise<void> | null = null;
    let again = false;
    let busy = false;
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
        ]),
    ]);
    container.replaceChildren(header, empty, commitBox, list);

    const badge = el('span', { className: 'scm-badge', attrs: { 'aria-hidden': 'true', hidden: '' } });
    hooks.activityItem?.append(badge);

    const branchButton = el('button', { className: 'status-item scm-branch', attrs: { type: 'button', 'data-testid': 'scm-branch', hidden: '' } }, [icon(ICONS.branch), el('span')]);
    branchButton.addEventListener('click', () => pickBranch());
    hooks.branchStatus.replaceChildren(branchButton);

    message.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void commit();
        }
    });
    commitButton.addEventListener('click', () => void commit());

    function render(): void {
        const key = JSON.stringify([status, busy]);
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
        focus(): void {
            hooks.showView();
            message.focus();
        },
    };
}

/** IPC errors arrive as "Error invoking remote method '...': Error: <message>"; keep the message. */
function cleanError(error: unknown): string {
    const text = String(error instanceof Error ? error.message : error);
    return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
