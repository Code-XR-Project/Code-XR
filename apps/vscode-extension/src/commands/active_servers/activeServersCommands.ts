import { ActiveServersCommands } from '../../active_servers/commands/activeServersCommands';
import { ExtensionCommandRegistration } from '../../platform/commands/commandRegistry';

interface RefreshableTreeProvider {
    refresh(): void;
}

export function getActiveServersCommandRegistrations(
    treeDataProvider?: RefreshableTreeProvider,
): ExtensionCommandRegistration[] {
    return ActiveServersCommands.getCommandRegistrations(treeDataProvider);
}
