import * as vscode from 'vscode';
import { VisualizationSettingsCommands } from '../../visualization_settings/commands/visualizationSettingsCommands';
import { ExtensionCommandRegistration } from '../../platform/commands/commandRegistry';

export function getVisualizationSettingsCommandRegistrations(
    context: vscode.ExtensionContext,
): ExtensionCommandRegistration[] {
    return VisualizationSettingsCommands.getCommandRegistrations(context);
}
