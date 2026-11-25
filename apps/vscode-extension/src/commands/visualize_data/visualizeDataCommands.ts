import * as vscode from 'vscode';
import { VisualizeDataCommands } from '../../visualize_data/commands/visualizeDataCommands';
import { ExtensionCommandRegistration } from '../../platform/commands/commandRegistry';

export function getVisualizeDataCommandRegistrations(
    context: vscode.ExtensionContext,
): ExtensionCommandRegistration[] {
    return VisualizeDataCommands.getCommandRegistrations(context);
}
