import * as vscode from 'vscode';
import { CodeXRExtensionMode, CodeXRLogLevel, isVerboseLoggingEnabled } from './logPolicy';
import {
    attachLogTarget,
    detachLogTarget,
    getLogger,
    isVerboseLogging,
    MessageFactory,
    ScopedLogger,
    setVerboseLogging,
    writeLog,
} from './sink';

export type { MessageFactory, ScopedLogger } from './sink';

/**
 * The VS Code side of CodeXR logging: it attaches the "CodeXR" output channel
 * to the vscode-free sink (`sink.ts`) and keeps verbose logging in step with
 * the extension mode and `codeXR.debug.verboseLogs`. Verbose (debug/info)
 * logging stays off in production unless the user opts in explicitly.
 *
 * Modules that only need to log import `getLogger` from `./sink` instead, so
 * they do not depend on `vscode`; `CodeXRLogger.getLogger` is the same thing.
 */
export class CodeXRLogger {
    private static outputChannel: vscode.OutputChannel | undefined;
    private static initialized = false;

    public static initialize(context: vscode.ExtensionContext): void {
        this.updateLoggingMode(context);

        if (!this.outputChannel) {
            const outputChannel = vscode.window.createOutputChannel('CodeXR');
            this.outputChannel = outputChannel;
            // Disposed with the extension. The sink lets go of the channel
            // first, so later lines go back to the buffer (and warnings and
            // errors to the console) instead of into a dead channel.
            context.subscriptions.push({
                dispose: () => {
                    if (this.outputChannel === outputChannel) {
                        this.outputChannel = undefined;
                        detachLogTarget();
                    }
                    outputChannel.dispose();
                },
            });
            attachLogTarget(outputChannel);
        }

        if (this.initialized) {
            return;
        }

        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('codeXR.debug.verboseLogs')) {
                this.updateLoggingMode(context);
                this.write(
                    'info',
                    'LOGGER',
                    () => `Verbose logging ${isVerboseLogging() ? 'enabled' : 'disabled'}.`,
                );
            }
        }));

        this.initialized = true;
    }

    public static getLogger(scope: string): ScopedLogger {
        return getLogger(scope);
    }

    public static write(
        level: CodeXRLogLevel,
        scope: string,
        message: MessageFactory,
        metadata?: unknown,
    ): void {
        writeLog(level, scope, message, metadata);
    }

    private static updateLoggingMode(context: vscode.ExtensionContext): void {
        const verboseSettingEnabled = vscode.workspace
            .getConfiguration()
            .get<boolean>('codeXR.debug.verboseLogs', false);

        const extensionMode: CodeXRExtensionMode = context.extensionMode === vscode.ExtensionMode.Development
            ? 'development'
            : 'production';

        setVerboseLogging(isVerboseLoggingEnabled(extensionMode, verboseSettingEnabled));
    }
}
