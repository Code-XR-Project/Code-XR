/**
 * The command registry (#18): the single list of everything the IDE can do.
 * The command palette, the menu accelerators, the renderer keybindings and,
 * later, voice commands and the AI agents' tools all go through it, so an
 * action exists once and is reachable from everywhere.
 *
 * IDs are unique: registering an ID twice throws, like
 * `assertUniqueCommandIds` in the extension, so two features cannot silently
 * shadow each other. Pure module: no DOM, unit-tested in Node.
 */

export interface CommandDefinition {
    /** Stable ID, `area.action` (for example `file.save`). */
    readonly id: string;
    /** What the palette shows after the category ("Save All"). */
    readonly title: string;
    /** Palette prefix ("File", "View", "Code-XR"). */
    readonly category?: string;
    /**
     * Default key, written as an Electron accelerator ("CmdOrCtrl+Shift+P").
     * `keybindingSource` says who listens for it.
     */
    readonly keybinding?: string;
    /**
     * `menu`: the application menu owns the accelerator (it works even while
     * the scene view or the terminal has focus); the registry only shows it.
     * `renderer` (default): the workbench's own key handler runs it.
     */
    readonly keybindingSource?: 'menu' | 'renderer';
    /** More keys for the same command, always handled by the workbench (F1 for the palette). */
    readonly secondaryKeybindings?: readonly string[];
    /** False for commands that should not appear under "recently used" (the palette itself). */
    readonly recordRecent?: boolean;
    /** Hidden from the palette and not runnable while false. */
    readonly enabled?: () => boolean;
    run(): void | Promise<void>;
}

export interface CommandRegistry {
    register(command: CommandDefinition): () => void;
    get(id: string): CommandDefinition | undefined;
    /** Every command, in registration order. */
    list(): readonly CommandDefinition[];
    isEnabled(id: string): boolean;
    /** Runs a command; false if it is unknown or disabled. Errors go to `onError`. */
    execute(id: string): boolean;
    /** The IDs run most recently, newest first (the palette lists them first). */
    recent(): readonly string[];
}

const ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/;
const RECENT_LIMIT = 20;

export function createCommandRegistry(onError: (id: string, error: unknown) => void = () => undefined): CommandRegistry {
    const commands = new Map<string, CommandDefinition>();
    let recentIds: string[] = [];

    function isEnabled(id: string): boolean {
        const command = commands.get(id);
        if (!command) {
            return false;
        }
        try {
            return command.enabled ? command.enabled() : true;
        } catch {
            return false;
        }
    }

    return {
        register(command) {
            if (!ID_PATTERN.test(command.id)) {
                throw new Error(`Invalid command ID "${command.id}": use area.action.`);
            }
            if (commands.has(command.id)) {
                throw new Error(`Duplicate command ID "${command.id}".`);
            }
            if (command.title.trim() === '') {
                throw new Error(`Command "${command.id}" has no title.`);
            }
            commands.set(command.id, command);
            return () => {
                if (commands.get(command.id) === command) {
                    commands.delete(command.id);
                    recentIds = recentIds.filter((id) => id !== command.id);
                }
            };
        },
        get: (id) => commands.get(id),
        list: () => [...commands.values()],
        isEnabled,
        execute(id) {
            const command = commands.get(id);
            if (!command || !isEnabled(id)) {
                return false;
            }
            if (command.recordRecent !== false) {
                recentIds = [id, ...recentIds.filter((other) => other !== id)].slice(0, RECENT_LIMIT);
            }
            try {
                const result = command.run();
                if (result instanceof Promise) {
                    result.catch((error: unknown) => onError(id, error));
                }
            } catch (error) {
                onError(id, error);
            }
            return true;
        },
        recent: () => recentIds,
    };
}

/** "File: Save All", or the title alone without a category. */
export function commandLabel(command: Pick<CommandDefinition, 'title' | 'category'>): string {
    return command.category ? `${command.category}: ${command.title}` : command.title;
}
