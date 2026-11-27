/**
 * The command registry (#18): the single list of everything the IDE can do.
 * The command palette, the menu accelerators, the renderer keybindings and,
 * later, voice commands and the AI agents' tools all go through it, so an
 * action exists once and is reachable from everywhere.
 *
 * IDs are unique: registering an ID twice throws, like
 * `assertUniqueCommandIds` in the extension, so two features cannot silently
 * shadow each other. Pure module: no DOM, unit-tested in Node.
 *
 * Keys (#18, part 3): a definition carries its built-in keys; the user's
 * rules (`keybindings.json`) are applied on top by `keybindings(id)`, which
 * is what the key handler, the palette and the menu read.
 */

import { resolveKeybindings, type UserKeybinding } from '../../shared/keybindings.ts';

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
    /**
     * #259: a command an extension contributes. Its id is the extension's
     * (VS Code allows any non-empty id, `_` prefixes and all), so the
     * `area.action` rule does not apply; ids still never repeat.
     */
    readonly source?: 'extension';
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
    /** A command's built-in keys: its keybinding, then its secondary keys. */
    defaultKeybindings(id: string): readonly string[];
    /** A command's keys with the user's rules applied (the first is the one to show). */
    keybindings(id: string): readonly string[];
    /** The user's rules, from `keybindings.json`. */
    userKeybindings(): readonly UserKeybinding[];
    setUserKeybindings(entries: readonly UserKeybinding[]): void;
}

const ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/;
const RECENT_LIMIT = 20;

export function createCommandRegistry(onError: (id: string, error: unknown) => void = () => undefined, platform = 'linux'): CommandRegistry {
    const commands = new Map<string, CommandDefinition>();
    let recentIds: string[] = [];
    let userRules: readonly UserKeybinding[] = [];
    // Rebuilt when a command comes or goes or the rules change, not on every key press.
    let resolved: Map<string, string[]> | null = null;

    function defaultKeybindings(id: string): readonly string[] {
        const command = commands.get(id);
        return command ? [...(command.keybinding ? [command.keybinding] : []), ...(command.secondaryKeybindings ?? [])] : [];
    }

    function keybindings(id: string): readonly string[] {
        if (!resolved) {
            const defaults = new Map([...commands.keys()].map((key) => [key, defaultKeybindings(key)] as const));
            resolved = resolveKeybindings(defaults, userRules, platform);
        }
        return commands.has(id) ? resolved.get(id) ?? [] : [];
    }

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
            if (command.source === 'extension' ? !/^\S{1,300}$/.test(command.id) : !ID_PATTERN.test(command.id)) {
                throw new Error(`Invalid command ID "${command.id}": use area.action.`);
            }
            if (commands.has(command.id)) {
                throw new Error(`Duplicate command ID "${command.id}".`);
            }
            if (command.title.trim() === '') {
                throw new Error(`Command "${command.id}" has no title.`);
            }
            commands.set(command.id, command);
            resolved = null;
            return () => {
                if (commands.get(command.id) === command) {
                    commands.delete(command.id);
                    resolved = null;
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
        defaultKeybindings,
        keybindings,
        userKeybindings: () => userRules,
        setUserKeybindings(entries) {
            userRules = [...entries];
            resolved = null;
        },
    };
}

/** "File: Save All", or the title alone without a category. */
export function commandLabel(command: Pick<CommandDefinition, 'title' | 'category'>): string {
    return command.category ? `${command.category}: ${command.title}` : command.title;
}
