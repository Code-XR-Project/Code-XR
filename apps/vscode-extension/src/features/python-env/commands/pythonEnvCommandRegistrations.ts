import * as vscode from 'vscode';
import { PythonEnvCommands } from './pythonEnvCommands';
import { ExtensionCommandRegistration } from '../../../platform/commands/commandRegistry';

let pythonEnvCommands: PythonEnvCommands | undefined;

export function getPythonEnvCommandRegistrations(
    context: vscode.ExtensionContext,
): ExtensionCommandRegistration[] {
    pythonEnvCommands = new PythonEnvCommands(context);
    return pythonEnvCommands.getCommandRegistrations();
}

export async function initializePythonEnvOnStartup(): Promise<void> {
    if (!pythonEnvCommands) {
        return;
    }

    await pythonEnvCommands.initializeOnStartup();
}

export function deactivatePythonEnvCommands(): void {
    pythonEnvCommands = undefined;
}
