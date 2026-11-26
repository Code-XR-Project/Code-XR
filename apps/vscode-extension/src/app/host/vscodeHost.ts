/**
 * `CodeXRHost` for the VS Code extension: every member forwards to the VS
 * Code API call the core makes directly today, so moving a core module onto
 * the host changes nothing a user can see (#13).
 */
import * as vscode from 'vscode';
import type {
    CodeXRHost,
    HostPromptOptions,
    HostSignal,
    HostStatusIndicator,
} from '../../core/host/codeXRHost';
import { hostPathsFromContext } from '../../core/host/hostPaths';
import { getLogger } from '../../platform/logging/sink';

const logger = getLogger('HOST');

/** The VS Code command (and arguments) behind each host signal. */
/**
 * The `when`-clause context keys behind each state signal, spelled out in full:
 * package.json menus read them, and the feature baseline looks for the literals.
 */
const CONTEXT_KEYS: Record<Extract<HostSignal, { kind: 'state' }>['key'], string> = {
    'pythonEnv.uiLocked': 'codeXR.pythonEnv.uiLocked',
    'pythonEnv.retryAvailable': 'codeXR.pythonEnv.retryAvailable',
};

export function signalToCommand(signal: HostSignal): { command: string; args: unknown[] } {
    switch (signal.kind) {
        case 'refresh':
            return signal.view === 'servers'
                ? { command: 'codexr.servers.refresh', args: [] }
                : { command: 'codeXR.activeServers.refreshServers', args: [] };
        case 'state':
            return { command: 'setContext', args: [CONTEXT_KEYS[signal.key], signal.value] };
        case 'revealSidebar':
            return { command: 'workbench.view.extension.codeXRView', args: [] };
        case 'openServerSettings':
            return { command: 'codexr.server.configure', args: [] };
    }
}

/** `HostNotifier.confirm`: the VS Code message of the requested severity, modal unless told otherwise. */
async function showModalMessage(
    message: string,
    options: Parameters<CodeXRHost['notifier']['confirm']>[1],
): Promise<string | undefined> {
    const messageOptions: vscode.MessageOptions = { modal: options.modal ?? true };
    if (options.detail !== undefined) {
        messageOptions.detail = options.detail;
    }
    switch (options.severity ?? 'warning') {
        case 'info':
            return vscode.window.showInformationMessage(message, messageOptions, ...options.actions);
        case 'error':
            return vscode.window.showErrorMessage(message, messageOptions, ...options.actions);
        default:
            return vscode.window.showWarningMessage(message, messageOptions, ...options.actions);
    }
}

/** `CodeXRHost.prompt` as a VS Code input box; only the options that were given are set. */
async function showPrompt(options: HostPromptOptions): Promise<string | undefined> {
    const box: vscode.InputBoxOptions = { prompt: options.prompt };
    if (options.title !== undefined) { box.title = options.title; }
    if (options.placeHolder !== undefined) { box.placeHolder = options.placeHolder; }
    if (options.password !== undefined) { box.password = options.password; }
    if (options.value !== undefined) { box.value = options.value; }
    if (options.validate !== undefined) { box.validateInput = options.validate; }
    if (options.keepOpen !== undefined) { box.ignoreFocusOut = options.keepOpen; }
    return vscode.window.showInputBox(box);
}

export function createVSCodeHost(context: vscode.ExtensionContext): CodeXRHost {
    // Looked up on each call, not captured here: a test may replace a
    // `vscode.window` member after the host exists, and the call must reach it.
    const show = {
        info: (message: string, ...actions: string[]) => vscode.window.showInformationMessage(message, ...actions),
        warning: (message: string, ...actions: string[]) => vscode.window.showWarningMessage(message, ...actions),
        error: (message: string, ...actions: string[]) => vscode.window.showErrorMessage(message, ...actions),
    } as const;

    return {
        paths: hostPathsFromContext(context),
        globalState: context.globalState,
        notifier: {
            async notify(severity, message, ...actions) {
                return show[severity](message, ...actions);
            },
            confirm: showModalMessage,
            status(message, timeoutMs) {
                return timeoutMs === undefined
                    ? vscode.window.setStatusBarMessage(message)
                    : vscode.window.setStatusBarMessage(message, timeoutMs);
            },
            createStatusIndicator(options): HostStatusIndicator {
                const item = options?.priority === undefined
                    ? vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
                    : vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, options.priority);
                return {
                    get text() {
                        return item.text;
                    },
                    set text(value: string) {
                        item.text = value;
                    },
                    get tooltip() {
                        return typeof item.tooltip === 'string' ? item.tooltip : undefined;
                    },
                    set tooltip(value: string | undefined) {
                        item.tooltip = value;
                    },
                    show: () => item.show(),
                    hide: () => item.hide(),
                    dispose: () => item.dispose(),
                };
            },
        },
        async withProgress(options, task) {
            return vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: options.title,
                    cancellable: options.cancellable ?? false,
                },
                (progress, token) => task(progress, token),
            );
        },
        prompt: showPrompt,
        async clipboardWrite(text) {
            await vscode.env.clipboard.writeText(text);
        },
        async openExternal(url) {
            return vscode.env.openExternal(vscode.Uri.parse(url));
        },
        workspaceFolders() {
            return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
        },
        signal(signal) {
            const { command, args } = signalToCommand(signal);
            // A signal is fire-and-forget for the core; a failing command is logged, never left unhandled.
            vscode.commands.executeCommand(command, ...args).then(undefined, (error: unknown) => {
                logger.warn(`Host signal ${signal.kind} (${command}) failed:`, error);
            });
        },
    };
}
