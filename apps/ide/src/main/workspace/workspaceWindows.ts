import { BrowserWindow, dialog, type WebContents } from 'electron';
import path from 'node:path';
import type { SceneOpenInEditorEvent, WorkspaceInfo } from '../../shared/api.ts';
import { IPC_EVENTS } from '../../shared/api.ts';
import { Workspace } from './workspace.ts';
import { log } from '../log.ts';
import { RecentFolders } from '../recentFolders.ts';
import { unsavedCount } from '../unsavedGuard.ts';

/**
 * Which folder each window has open (#14). Keyed by `webContents.id`, so the
 * IPC handlers find the workspace of the frame that called them and a window
 * can never read another window's folder. Dropped when the window goes.
 */
const workspaces = new Map<number, Workspace>();
/** Told when a window's folder changes (#139: the analysis of the previous folder stops). */
let onFolderChange: ((contents: WebContents, root: string | null) => void) | null = null;

export function setFolderChangeListener(listener: (contents: WebContents, root: string | null) => void): void {
    onFolderChange = listener;
}
/** #21: more listeners (the language servers of the previous folder stop). */
const extraFolderListeners: ((contents: WebContents, root: string | null) => void)[] = [];
export function addFolderChangeListener(listener: (contents: WebContents, root: string | null) => void): void {
    extraFolderListeners.push(listener);
}
function folderChanged(contents: WebContents, root: string | null): void {
    onFolderChange?.(contents, root);
    for (const listener of extraFolderListeners) {
        listener(contents, root);
    }
}
let recent: RecentFolders | null = null;

/** Starts recording opened folders in `file` (not in the smoke run, which must leave no trace). */
export async function initRecentFolders(file: string, onChange: (list: readonly string[]) => void): Promise<void> {
    recent = new RecentFolders(file, onChange);
    await recent.load();
}

export function recentFolderList(): readonly string[] {
    return recent?.folders ?? [];
}

export async function clearRecentFolders(): Promise<void> {
    await recent?.clear();
}

/** Opens a folder from the recent list; refuses any other path. A folder that is gone leaves the list. */
export async function openRecentFolder(contents: WebContents, folder: unknown): Promise<WorkspaceInfo> {
    if (!recent?.has(folder)) {
        throw new Error('Only a recently opened folder can be opened this way.');
    }
    try {
        return await setWorkspace(contents, folder);
    } catch (error) {
        await recent.remove(folder);
        throw new Error(`${folder} could not be opened and was removed from the recent list: ${String(error)}`);
    }
}

/**
 * File > Open Recent: the menu acts without the renderer, so it asks here
 * before discarding unsaved editors, then tells the renderer what opened.
 */
export async function openRecentFromMenu(win: BrowserWindow, folder: string): Promise<void> {
    const contents = win.webContents;
    const dirty = unsavedCount(contents);
    if (dirty > 0) {
        const { response } = await dialog.showMessageBox(win, {
            type: 'warning',
            title: 'Unsaved changes',
            message: `Open ${folder} and discard the changes to ${dirty === 1 ? '1 file' : `${dirty} files`}?`,
            buttons: ['Discard and Open', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
        });
        if (response !== 0) {
            return;
        }
    }
    try {
        contents.send(IPC_EVENTS.workspaceChanged, await openRecentFolder(contents, folder));
    } catch (error) {
        log.error('Open Recent failed.', error);
        void dialog.showMessageBox(win, { type: 'error', title: 'Open Recent', message: String(error instanceof Error ? error.message : error) });
    }
}

/**
 * #16: opens `absolutePath` in the editor of the window whose folder holds it
 * (the most recently focused one first). The core already checked the path;
 * the renderer gets it workspace-relative, as for any other open.
 */
export function openInWindowEditor(absolutePath: string, line: number | undefined): boolean {
    const focused = BrowserWindow.getFocusedWindow();
    const candidates = [...workspaces.entries()].sort(([a], [b]) => Number(b === focused?.webContents.id) - Number(a === focused?.webContents.id));
    for (const [contentsId, workspace] of candidates) {
        const relative = path.relative(path.resolve(workspace.root), path.resolve(absolutePath));
        if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
            continue;
        }
        const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.webContents.id === contentsId);
        if (!win) {
            continue;
        }
        const request: SceneOpenInEditorEvent = { path: relative.split(path.sep).join('/'), ...(line === undefined ? {} : { line }) };
        win.webContents.send(IPC_EVENTS.analysisOpenInEditor, request);
        win.focus();
        return true;
    }
    return false;
}

/** The root folder of every open window, for the core's `workspaceFolders()`. */
export function openWorkspaceRoots(): string[] {
    return [...new Set([...workspaces.values()].map((workspace) => workspace.root))];
}

export function workspaceOf(contents: WebContents): Workspace {
    const workspace = workspaces.get(contents.id);
    if (!workspace) {
        throw new Error('No folder is open in this window.');
    }
    return workspace;
}

/** The window's open folder, or null (settings work without one). */
export function workspaceOrNull(contents: WebContents): Workspace | null {
    return workspaces.get(contents.id) ?? null;
}

export function currentWorkspaceInfo(contents: WebContents): WorkspaceInfo | null {
    return workspaces.get(contents.id)?.info ?? null;
}

/** Opens `folder` in the window that owns `contents`. */
export async function setWorkspace(contents: WebContents, folder: string): Promise<WorkspaceInfo> {
    const workspace = await Workspace.open(folder);
    const previous = workspaces.get(contents.id);
    if (previous) {
        previous.dispose();
    } else {
        contents.once('destroyed', () => {
            workspaces.get(contents.id)?.dispose();
            workspaces.delete(contents.id);
            folderChanged(contents, null);
        });
    }
    workspaces.set(contents.id, workspace);
    log.info(`Opened folder ${workspace.root}`);
    folderChanged(contents, workspace.root);
    await recent?.add(workspace.root).catch((error: unknown) => log.warn(`Could not record ${workspace.root} as recent: ${String(error)}`));
    return workspace.info;
}

/** The folder picker; resolves with the opened workspace, or null when cancelled. */
export async function pickAndOpenFolder(contents: WebContents): Promise<WorkspaceInfo | null> {
    const owner = BrowserWindow.fromWebContents(contents);
    const options = { title: 'Open Folder', properties: ['openDirectory' as const, 'createDirectory' as const] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const [folder] = result.filePaths;
    if (result.canceled || !folder) {
        return null;
    }
    return setWorkspace(contents, folder);
}
