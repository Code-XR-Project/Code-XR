import type { GitRemoteOperation } from '../../shared/git.ts';
import type { CommandDefinition, CommandRegistry } from '../commands/commandRegistry.ts';

/**
 * #284: Source Control's remote, stash and branch actions, under VS Code's
 * command ids so the palette and keybindings.json speak the same names. The
 * same list fills the "..." menu of the Source Control view (`null` marks a
 * separator there). Pure: no DOM, unit-tested in Node.
 */

export interface GitActions {
    /** True when the open folder is a repository Git may run in (trusted, Git found). */
    hasRepository(): boolean;
    remote(operation: GitRemoteOperation): void;
    stash(includeUntracked: boolean): void;
    /** Opens the stash picker, then applies, pops or drops the chosen one. */
    stashAction(action: 'apply' | 'pop' | 'drop'): void;
    /** Opens the branch picker, then deletes the chosen one (asking before forcing). */
    deleteBranch(): void;
}

export interface GitCommandEntry {
    readonly id: string;
    readonly title: string;
    readonly run: () => void;
}

/** The menu's order, VS Code's: remote operations, stashes, branches. */
export function gitCommandEntries(actions: GitActions): (GitCommandEntry | null)[] {
    return [
        { id: 'git.pull', title: 'Pull', run: () => actions.remote('pull') },
        { id: 'git.push', title: 'Push', run: () => actions.remote('push') },
        { id: 'git.sync', title: 'Sync', run: () => actions.remote('sync') },
        { id: 'git.fetch', title: 'Fetch', run: () => actions.remote('fetch') },
        null,
        { id: 'git.stash', title: 'Stash', run: () => actions.stash(false) },
        { id: 'git.stashIncludeUntracked', title: 'Stash (Include Untracked)', run: () => actions.stash(true) },
        { id: 'git.stashApply', title: 'Apply Stash...', run: () => actions.stashAction('apply') },
        { id: 'git.stashPop', title: 'Pop Stash...', run: () => actions.stashAction('pop') },
        { id: 'git.stashDrop', title: 'Drop Stash...', run: () => actions.stashAction('drop') },
        null,
        { id: 'git.deleteBranch', title: 'Delete Branch...', run: () => actions.deleteBranch() },
    ];
}

export function gitCommands(actions: GitActions): CommandDefinition[] {
    return gitCommandEntries(actions)
        .filter((entry): entry is GitCommandEntry => entry !== null)
        .map((entry) => ({ id: entry.id, category: 'Git', title: entry.title, enabled: actions.hasRepository, run: entry.run }));
}

export function registerGitCommands(registry: CommandRegistry, actions: GitActions): void {
    for (const command of gitCommands(actions)) {
        registry.register(command);
    }
}
