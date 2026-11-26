import { BrowserWindow, clipboard, dialog, shell } from 'electron';
import path from 'node:path';
import type {
    CodeXRHost,
    HostCancellation,
    HostDisposable,
    HostMode,
    HostProgress,
    HostPromptOptions,
    HostSeverity,
    HostSignal,
    HostStatusIndicator,
} from '@codexr/core/host/codeXRHost';
import { plainCoreText } from '../../shared/output.ts';
import { JsonKeyValueStore } from './jsonStore.ts';
import { log } from '../log.ts';
import { openInWindowEditor, openWorkspaceRoots } from '../workspace/workspaceWindows.ts';

/**
 * The IDE's implementation of the core's host seam (#15; the extension's is
 * app/host/vscodeHost.ts). The core asks for UI by meaning (notify, confirm,
 * progress); this host answers with native dialogs for questions a person
 * must answer, and hands the rest to `HostEvents` for the renderer to show.
 *
 * Consent stays with the person: `confirm` is always a native modal dialog
 * shown by the main process, never something the renderer can answer.
 */

/** What the host reports for the renderer to display. */
export interface HostEvents {
    notify(severity: HostSeverity, message: string): void;
    progress(update: { id: number; title: string; message?: string | undefined; percent?: number | undefined; done: boolean }): void;
}

export interface ElectronHostOptions {
    /** Per-user storage of the core (python-env/, the global state file). */
    readonly storageDir: string;
    /** Where templates/ and the backend are found; the extension's package root while the IDE runs from the repository. */
    readonly installRoot: string;
    readonly mode: HostMode;
    readonly events: HostEvents;
}

const NOOP_DISPOSABLE: HostDisposable = { dispose(): void { /* nothing to release */ } };

const NEVER_CANCELLED: HostCancellation = {
    isCancellationRequested: false,
    onCancellationRequested: () => NOOP_DISPOSABLE,
};

export function createElectronHost(options: ElectronHostOptions): CodeXRHost {
    let progressIds = 0;
    const store = new JsonKeyValueStore(path.join(options.storageDir, 'global-state.json'));
    const ownerWindow = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

    return {
        paths: {
            installRoot: options.installRoot,
            globalStorageDir: options.storageDir,
            workspaceStorageDir: undefined,
            mode: options.mode,
        },
        globalState: store,
        notifier: {
            async notify(severity, raw, ...actions): Promise<string | undefined> {
                const message = plainCoreText(raw);
                log.info(`[core ${severity}] ${message}`);
                if (actions.length === 0) {
                    options.events.notify(severity, message);
                    return undefined;
                }
                // A notification with choices needs an answer: ask natively.
                return askNatively(ownerWindow(), severity, message, undefined, actions);
            },
            async confirm(message, confirmOptions): Promise<string | undefined> {
                return askNatively(ownerWindow(), confirmOptions.severity ?? 'warning', plainCoreText(message), confirmOptions.detail, confirmOptions.actions);
            },
            status(message: string): HostDisposable {
                options.events.notify('info', plainCoreText(message));
                return NOOP_DISPOSABLE;
            },
            createStatusIndicator(): HostStatusIndicator {
                // No core module the IDE uses keeps a status item yet; the IDE's
                // own status bar shows the Python environment (#15).
                return { text: '', show(): void {}, hide(): void {}, dispose(): void {} };
            },
        },
        async withProgress<T>(
            progressOptions: { title: string },
            task: (progress: HostProgress, cancellation: HostCancellation) => Promise<T>,
        ): Promise<T> {
            const id = ++progressIds;
            let percent = 0;
            options.events.progress({ id, title: progressOptions.title, done: false });
            const progress: HostProgress = {
                report(value): void {
                    if (typeof value.increment === 'number') {
                        // VS Code contract: each increment adds to the total so far (#158).
                        percent = Math.min(100, percent + Math.max(0, value.increment));
                    }
                    options.events.progress({ id, title: progressOptions.title, message: value.message, percent, done: false });
                },
            };
            try {
                return await task(progress, NEVER_CANCELLED);
            } finally {
                options.events.progress({ id, title: progressOptions.title, percent: 100, done: true });
            }
        },
        async prompt(promptOptions: HostPromptOptions): Promise<string | undefined> {
            // No core module the IDE uses asks for text yet (remote access will, with its own UI).
            log.warn(`Core asked for input the IDE cannot show yet: ${promptOptions.prompt}`);
            return undefined;
        },
        async clipboardWrite(text: string): Promise<void> {
            clipboard.writeText(text);
        },
        async openExternal(url: string): Promise<boolean> {
            if (!/^https?:\/\//i.test(url)) {
                log.warn(`Refused to open a non-web URL from the core: ${url}`);
                return false;
            }
            await shell.openExternal(url);
            return true;
        },
        workspaceFolders: () => openWorkspaceRoots(),
        // #16: "Open in editor" sent through the analysis server (a scene opened outside the IDE's own view).
        openInEditor: async (absolutePath: string, line?: number) => openInWindowEditor(absolutePath, line),
        signal(signal: HostSignal): void {
            // The extension maps these to tree refreshes and context keys; the
            // IDE's views pull their state instead, so nothing listens yet.
            void signal;
        },
    };
}

async function askNatively(
    owner: BrowserWindow | undefined,
    severity: HostSeverity,
    message: string,
    detail: string | undefined,
    actions: readonly string[],
): Promise<string | undefined> {
    const buttons = actions.length === 0 ? ['OK'] : [...actions, 'Cancel'];
    const dialogOptions = {
        type: severity === 'error' ? 'error' as const : severity === 'warning' ? 'warning' as const : 'info' as const,
        title: 'Code-XR',
        message,
        ...(detail ? { detail } : {}),
        buttons,
        defaultId: buttons.length - 1,
        cancelId: buttons.length - 1,
        noLink: true,
    };
    const { response } = owner ? await dialog.showMessageBox(owner, dialogOptions) : await dialog.showMessageBox(dialogOptions);
    return actions[response];
}
