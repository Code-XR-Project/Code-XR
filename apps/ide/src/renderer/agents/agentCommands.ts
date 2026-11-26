import type { CommandDefinition, CommandRegistry } from '../commands/commandRegistry.ts';

/** What the agent commands act on, handed in by main.ts. */
export interface AgentCommandTargets {
    showAgents(): void;
    addProvider(): void;
}

/** The AI agent hub's entries in the command palette. */
export function agentCommands(targets: AgentCommandTargets): CommandDefinition[] {
    return [
        { id: 'agents.showView', category: 'Agents', title: 'Show AI Agents', run: () => targets.showAgents() },
        {
            id: 'agents.addProvider',
            category: 'Agents',
            title: 'Add AI Provider',
            run: () => {
                targets.showAgents();
                targets.addProvider();
            },
        },
    ];
}

export function registerAgentCommands(registry: CommandRegistry, targets: AgentCommandTargets): void {
    for (const command of agentCommands(targets)) {
        registry.register(command);
    }
}
