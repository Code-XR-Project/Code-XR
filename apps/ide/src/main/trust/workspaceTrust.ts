import { BrowserWindow, type WebContents } from 'electron';
import path from 'node:path';
import { IPC_EVENTS, type WorkspaceTrustInfo } from '../../shared/api.ts';
import { log } from '../log.ts';
import { workspaceOrNull } from '../workspace/workspaceWindows.ts';
import { parseDecisions, trustedThrough, trustOf, withDecision, type TrustDecision } from './trustModel.ts';

/**
 * #177: workspace trust in the main process. The decisions live in the
 * user-data folder (never in the project, which could otherwise trust
 * itself), or in memory for the smoke run. Everything that would run
 * something the folder defines asks `isWorkspaceTrusted` first: Git (its
 * hooks, filters and config come with the repository), the Python language
 * server (pyright runs the interpreter a project's config names), and tasks
 * (#176). Reading, editing, the terminal the person opens and the Code-XR
 * analysis (which parses files and never runs them) are not gated.
 */
export interface TrustStorage {
    load(): unknown;
    save(decisions: readonly TrustDecision[]): Promise<void>;
}

let decisions: TrustDecision[] = [];
let storage: TrustStorage | null = null;
const listeners: ((contents: WebContents) => void)[] = [];

export function initWorkspaceTrust(store: TrustStorage): void {
    storage = store;
    decisions = parseDecisions(store.load());
}

/** Told when a window's trust changes (the language servers of that window restart). */
export function addTrustChangeListener(listener: (contents: WebContents) => void): void {
    listeners.push(listener);
}

export function trustInfoOf(contents: WebContents): WorkspaceTrustInfo {
    const folder = workspaceOrNull(contents)?.root ?? null;
    if (!folder) {
        return { state: 'unknown', folder: null, trustedThrough: null, parent: null };
    }
    const state = trustOf(folder, decisions, process.platform);
    const parent = path.dirname(folder);
    return {
        state,
        folder,
        trustedThrough: state === 'trusted' ? trustedThrough(folder, decisions, process.platform) : null,
        parent: parent === folder ? null : parent,
    };
}

export function isWorkspaceTrusted(contents: WebContents): boolean {
    return trustInfoOf(contents).state === 'trusted';
}

export async function setWorkspaceTrust(contents: WebContents, choice: unknown): Promise<WorkspaceTrustInfo> {
    if (choice !== 'folder' && choice !== 'parent' && choice !== 'restrict') {
        throw new Error('Unknown trust choice.');
    }
    const info = trustInfoOf(contents);
    if (!info.folder) {
        throw new Error('No folder is open in this window.');
    }
    const target = choice === 'parent' ? info.parent : info.folder;
    if (!target) {
        throw new Error('This folder has no parent folder to trust.');
    }
    decisions = withDecision(decisions, target, choice !== 'restrict', process.platform);
    if (choice === 'parent') {
        // Trusting the parent also lifts a Restricted Mode set on this folder itself.
        decisions = decisions.filter((decision) => decision.trusted || path.resolve(decision.path) !== path.resolve(info.folder ?? ''));
    }
    log.info(`Workspace trust: ${choice === 'restrict' ? 'restricted' : 'trusted'} ${target}`);
    await storage?.save(decisions);
    notifyAll();
    return trustInfoOf(contents);
}

/** Every window's trust may have moved (a parent covers several): each one is told its own state. */
function notifyAll(): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) {
            continue;
        }
        const contents = win.webContents;
        contents.send(IPC_EVENTS.workspaceTrustChanged, trustInfoOf(contents));
        for (const listener of listeners) {
            listener(contents);
        }
    }
}

/** For tests and the smoke run: forget everything. */
export function resetWorkspaceTrust(): void {
    decisions = [];
}
