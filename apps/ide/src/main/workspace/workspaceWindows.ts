import { BrowserWindow, dialog, type WebContents } from 'electron';
import type { WorkspaceInfo } from '../../shared/api.ts';
import { Workspace } from './workspace.ts';
import { log } from '../log.ts';

/**
 * Which folder each window has open (#14). Keyed by `webContents.id`, so the
 * IPC handlers find the workspace of the frame that called them and a window
 * can never read another window's folder. Dropped when the window goes.
 */
const workspaces = new Map<number, Workspace>();

export function workspaceOf(contents: WebContents): Workspace {
    const workspace = workspaces.get(contents.id);
    if (!workspace) {
        throw new Error('No folder is open in this window.');
    }
    return workspace;
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
        });
    }
    workspaces.set(contents.id, workspace);
    log.info(`Opened folder ${workspace.root}`);
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
