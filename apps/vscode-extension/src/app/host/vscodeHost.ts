/**
 * `CodeXRHost` for the VS Code extension: every member forwards to the VS
 * Code API call the core makes directly today, so moving a core module onto
 * the host changes nothing a user can see (#13).
 */
import * as vscode from 'vscode';
import type {
    CodeXRHost,
    HostSignal,
    HostStatusIndicator,
} from '../../core/host/codeXRHost';
import { hostPathsFromContext } from '../../core/host/hostPaths';

/** The VS Code command (and arguments) behind each host signal. */
export function signalToCommand(signal: HostSignal): { command: string; args: unknown[] } {
    switch (signal.kind) {
        case 'refresh':
            return signal.view === 'servers'
                ? { command: 'codexr.servers.refresh', args: [] }
                : { command: 'codeXR.activeServers.refreshServers', args: [] };
        case 'state':
            return { command: 'setContext', args: [`codeXR.${signal.key}`, signal.value] };
        case 'revealSidebar':
            return { command: 'workbench.view.extension.codeXRView', args: [] };
        case 'openServerSettings':
            return { command: 'codexr.server.configure', args: [] };
    }
}

export function createVSCodeHost(context: vscode.ExtensionContext): CodeXRHost {
    const show = {
        info: vscode.window.showInformationMessage,
        warning: vscode.window.showWarningMessage,
        error: vscode.window.showErrorMessage,
    } as const;

    return {
        paths: hostPathsFromContext(context),
        globalState: context.globalState,
        notifier: {
            async notify(severity, message, ...actions) {
                return show[severity](message, ...actions);
            },
            async confirm(message, options) {
                const messageOptions: vscode.MessageOptions = { modal: options.modal ?? true };
                if (options.detail !== undefined) {
                    messageOptions.detail = options.detail;
                }
                return vscode.window.showWarningMessage(message, messageOptions, ...options.actions);
            },
            status(message, timeoutMs) {
                return timeoutMs === undefined
                    ? vscode.window.setStatusBarMessage(message)
                    : vscode.window.setStatusBarMessage(message, timeoutMs);
            },
            createStatusIndicator(): HostStatusIndicator {
                const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
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
        async prompt(options) {
            return vscode.window.showInputBox(options);
        },
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
            void vscode.commands.executeCommand(command, ...args);
        },
    };
}
