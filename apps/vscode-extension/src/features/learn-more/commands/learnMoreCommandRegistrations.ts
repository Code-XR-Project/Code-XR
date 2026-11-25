import * as vscode from 'vscode';
import { LearnMoreCommands } from './learnMoreCommands';
import { ExtensionCommandRegistration } from '../../../platform/commands/commandRegistry';

export function getLearnMoreCommandRegistrations(
    _context: vscode.ExtensionContext,
): ExtensionCommandRegistration[] {
    return LearnMoreCommands.getCommandRegistrations();
}
