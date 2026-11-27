import * as vscode from 'vscode';
import { BabiaExamplesCommands } from './babiaExamplesCommands';
import { BabiaExamplesTreeDataProvider } from '../views/babiaExamplesTreeView';
import { ExtensionCommandRegistration } from '../../../platform/commands/commandRegistry';

export function getBabiaExamplesCommandRegistrations(
    context: vscode.ExtensionContext,
    treeDataProvider?: BabiaExamplesTreeDataProvider,
): ExtensionCommandRegistration[] {
    return BabiaExamplesCommands.getCommandRegistrations(context, treeDataProvider);
}
