import { CommonCommands } from '../../utils/commonCommands';
import { ExtensionCommandRegistration } from '../../platform/commands/commandRegistry';
import { getLogger } from '../../core/logging/sink';

const logger = getLogger('GENERAL_COMMANDS');

/**
 * General/common commands used throughout the extension.
 */
export function getGeneralCommandRegistrations(): ExtensionCommandRegistration[] {
    return [
        {
            id: 'codexr.tree.refresh',
            module: 'GENERAL_COMMANDS',
            description: 'Tree refresh',
            handler: () => {
                logger.debug('Tree refresh command executed');
                CommonCommands.refreshTreeView();
            },
        },
        {
            id: 'codexr.servers.refresh',
            module: 'GENERAL_COMMANDS',
            description: 'Legacy tree refresh',
            handler: () => {
                logger.debug('Legacy servers refresh command executed, delegating to tree refresh');
                CommonCommands.refreshTreeView();
            },
        },
        {
            id: 'codexr.servers.refreshServers',
            module: 'GENERAL_COMMANDS',
            description: 'Legacy server tree refresh alias',
            handler: () => {
                logger.debug('Legacy server refresh alias executed, delegating to tree refresh');
                CommonCommands.refreshTreeView();
            },
        },
        {
            id: 'codeXR.modularTree.refresh',
            module: 'GENERAL_COMMANDS',
            description: 'Modular tree refresh',
            handler: () => {
                logger.debug('Modular tree refresh command executed');
                CommonCommands.refreshTreeView();
            },
        },
    ];
}
