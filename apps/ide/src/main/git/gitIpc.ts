import { BrowserWindow, dialog, shell, type IpcMainInvokeEvent, type MessageBoxOptions, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { emptyGitStatus, GIT_IPC_CHANNELS, GIT_IPC_EVENTS, type GitCommitResult, type GitStatus } from '../../shared/git.ts';
import type { GitBlameLine } from '../../shared/gitGutter.ts';
import { log } from '../log.ts';
import { workspaceOrNull } from '../workspace/workspaceWindows.ts';
import { GitService } from './gitService.ts';
import { addTrustChangeListener, isWorkspaceTrusted } from '../trust/workspaceTrust.ts';

type Handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

/**
 * The main-process side of `window.codexr.git` (#17), registered through
 * ipc.ts's `handle` so the trusted-frame check applies. Each window gets a
 * `GitService` for the folder it has open (a new one when the folder
 * changes) and a watcher on that repository's index, HEAD and branches, which
 * tells the window to refresh when git state changes, from the IDE or from a
 * terminal. Every path and name the page sends is validated by the service.
 */

interface WindowGit {
    readonly root: string;
    readonly service: GitService;
    watchers: fs.FSWatcher[];
    watching: boolean;
    timer: NodeJS.Timeout | null;
}

const windows = new Map<number, WindowGit>();
/** Windows whose `destroyed` listener is installed (once per window). */
const tracked = new Set<number>();

/** The git directory entries whose change means the view is stale. */
const WATCHED_GIT_FILES = new Set(['index', 'HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'packed-refs']);

/** The calling window's GitService, for the folder it has open now; null without a folder. */
export function gitServiceOf(contents: WebContents): GitService | null {
    const workspace = workspaceOrNull(contents);
    if (!workspace) {
        dispose(contents.id);
        return null;
    }
    const existing = windows.get(contents.id);
    if (existing?.root === workspace.root) {
        return existing.service;
    }
    dispose(contents.id);
    let realRoot = workspace.root;
    try {
        realRoot = fs.realpathSync.native(workspace.root);
    } catch {
        // Gone: every later call fails on its own.
    }
    const entry: WindowGit = { root: workspace.root, service: new GitService(workspace.root, realRoot), watchers: [], watching: false, timer: null };
    if (!tracked.has(contents.id)) {
        tracked.add(contents.id);
        const id = contents.id;
        contents.once('destroyed', () => {
            dispose(id);
            tracked.delete(id);
        });
    }
    windows.set(contents.id, entry);
    return entry.service;
}

function dispose(id: number): void {
    const entry = windows.get(id);
    if (!entry) {
        return;
    }
    for (const watcher of entry.watchers) {
        watcher.close();
    }
    if (entry.timer) {
        clearTimeout(entry.timer);
    }
    windows.delete(id);
}

/** Starts watching the repository once it is known to exist (after the first `ok` status). */
async function watchRepository(contents: WebContents, entry: WindowGit): Promise<void> {
    if (entry.watching) {
        return;
    }
    const repo = await entry.service.repository().catch(() => null);
    if (!repo || windows.get(contents.id) !== entry || entry.watching) {
        return;
    }
    entry.watching = true;
    const notify = (): void => {
        if (entry.timer) {
            return;
        }
        entry.timer = setTimeout(() => {
            entry.timer = null;
            if (!contents.isDestroyed()) {
                contents.send(GIT_IPC_EVENTS.gitChanged);
            }
        }, 250);
    };
    const watch = (folder: string, accept: (name: string) => boolean): void => {
        try {
            const watcher = fs.watch(folder, { persistent: false }, (_event, filename) => {
                const name = filename?.toString() ?? '';
                if (accept(name)) {
                    notify();
                }
            });
            watcher.on('error', () => watcher.close());
            entry.watchers.push(watcher);
        } catch (error) {
            log.warn(`Could not watch ${folder}: ${String(error)}`);
        }
    };
    watch(repo.gitDir, (name) => WATCHED_GIT_FILES.has(name));
    if (repo.commonDir !== repo.gitDir) {
        // A linked worktree: branches and packed refs live in the common directory.
        watch(repo.commonDir, (name) => name === 'packed-refs');
    }
    watch(path.join(repo.commonDir, 'refs', 'heads'), (name) => !name.endsWith('.lock'));
}

export const RESTRICTED_GIT_MESSAGE = 'Restricted Mode: Git does not run in this folder until you trust it. A repository brings its own hooks, filters and configuration, which Git would run. Use Manage Workspace Trust.';

async function statusOf(contents: WebContents): Promise<GitStatus> {
    if (workspaceOrNull(contents) && !isWorkspaceTrusted(contents)) {
        dispose(contents.id);
        return emptyGitStatus('restricted', RESTRICTED_GIT_MESSAGE);
    }
    const service = gitServiceOf(contents);
    if (!service) {
        return emptyGitStatus('no-folder', 'Open a folder to use Source Control.');
    }
    const status = await service.status();
    const entry = windows.get(contents.id);
    if (status.state === 'ok' && entry) {
        void watchRepository(contents, entry);
    }
    return status;
}

function requireService(contents: WebContents): GitService {
    if (workspaceOrNull(contents) && !isWorkspaceTrusted(contents)) {
        throw new Error(RESTRICTED_GIT_MESSAGE);
    }
    const service = gitServiceOf(contents);
    if (!service) {
        throw new Error('No folder is open in this window.');
    }
    return service;
}

async function confirm(contents: WebContents, options: MessageBoxOptions): Promise<number> {
    const owner = BrowserWindow.fromWebContents(contents);
    const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
    return result.response;
}

export function registerGitHandlers(handle: Handle): void {
    // #177: a trust change turns Git on or off for the window; its Source Control view refreshes.
    addTrustChangeListener((contents) => {
        dispose(contents.id);
        if (!contents.isDestroyed()) {
            contents.send(GIT_IPC_EVENTS.gitChanged);
        }
    });
    handle(GIT_IPC_CHANNELS.gitStatus, (event) => statusOf(event.sender));
    handle(GIT_IPC_CHANNELS.gitStage, async (event, paths) => {
        await requireService(event.sender).stage(paths);
        return statusOf(event.sender);
    });
    handle(GIT_IPC_CHANNELS.gitUnstage, async (event, paths) => {
        const service = requireService(event.sender);
        // A staged rename is unstaged together with its source; those come from git's own status, not the page.
        const status = await service.status();
        const requested = new Set(Array.isArray(paths) ? paths : []);
        const origPaths = status.staged.flatMap((change) => (requested.has(change.path) && change.origPath ? [change.origPath] : []));
        await service.unstage(paths, origPaths);
        return statusOf(event.sender);
    });
    // Discard asks in a native dialog the page cannot answer; an untracked file goes to the OS trash.
    handle(GIT_IPC_CHANNELS.gitDiscard, async (event, file) => {
        const service = requireService(event.sender);
        const plan = await service.discardPlan(file);
        const name = plan.path.split('/').pop() ?? plan.path;
        const response = await confirm(event.sender, plan.kind === 'trash'
            ? {
                type: 'warning',
                title: 'Discard Changes',
                message: `Delete the untracked file ${name}?`,
                detail: `${plan.path} will be moved to the trash.`,
                buttons: ['Move to Trash', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
            }
            : {
                type: 'warning',
                title: 'Discard Changes',
                message: `Discard the changes in ${name}?`,
                detail: `${plan.path} goes back to its staged or committed version. This cannot be undone.`,
                buttons: ['Discard Changes', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
            });
        if (response === 0) {
            if (plan.kind === 'trash') {
                await shell.trashItem(plan.absolute);
            } else {
                await service.restore(plan.path);
            }
        }
        return statusOf(event.sender);
    });
    handle(GIT_IPC_CHANNELS.gitCommit, async (event, message): Promise<GitCommitResult> => {
        const service = requireService(event.sender);
        const status = await service.status();
        if (status.state !== 'ok') {
            throw new Error(status.message ?? 'Source Control is not available.');
        }
        if (status.staged.length === 0) {
            if (status.changes.length === 0 && status.untracked.length === 0) {
                throw new Error('There are no changes to commit.');
            }
            const response = await confirm(event.sender, {
                type: 'question',
                title: 'Commit',
                message: 'There are no staged changes to commit.',
                detail: 'Stage all your changes and commit them directly?',
                buttons: ['Stage All and Commit', 'Cancel'],
                defaultId: 0,
                cancelId: 1,
                noLink: true,
            });
            if (response !== 0) {
                return { commit: null };
            }
            await service.stageAll();
        }
        return { commit: await service.commit(message) };
    });
    handle(GIT_IPC_CHANNELS.gitBranches, (event) => requireService(event.sender).branches());
    handle(GIT_IPC_CHANNELS.gitSwitchBranch, async (event, name) => {
        await requireService(event.sender).switchBranch(name);
        return statusOf(event.sender);
    });
    handle(GIT_IPC_CHANNELS.gitCreateBranch, async (event, name) => {
        await requireService(event.sender).createBranch(name);
        return statusOf(event.sender);
    });
    handle(GIT_IPC_CHANNELS.gitHeadContent, (event, file) => requireService(event.sender).headContent(file));
    // #175: the editor asks on every file it opens, so "nothing to show" is null, never an error.
    handle(GIT_IPC_CHANNELS.gitBaseline, async (event, file) => {
        try {
            return await requireService(event.sender).headContent(file);
        } catch {
            return null;
        }
    });
    handle(GIT_IPC_CHANNELS.gitBlame, async (event, file, contents): Promise<GitBlameLine[] | null> => {
        if (typeof contents !== 'string' || contents.length > MAX_BLAME_CONTENTS) {
            return null;
        }
        try {
            const lines = await requireService(event.sender).blame(file, contents);
            return lines.map((entry) => ({
                line: entry.line,
                hash: entry.commit.hash.slice(0, 8),
                author: entry.commit.author,
                authorMail: entry.commit.authorMail,
                authorTime: entry.commit.authorTime,
                summary: entry.commit.summary,
                uncommitted: entry.commit.uncommitted,
            }));
        } catch {
            // Untracked, not a repository, no git, Restricted Mode: no blame.
            return null;
        }
    });
}

const MAX_BLAME_CONTENTS = 5 * 1024 * 1024;
