import type { CommandRegistry } from './commandRegistry.ts';
import { matchesKeybinding, parseKeybinding, type KeyPlatform, type ParsedKeybinding } from './keybindings.ts';

/**
 * The workbench's own key handler (#18). It listens in the capture phase on
 * the window, so a binding wins over Monaco and xterm (as in VS Code, where
 * workbench shortcuts reach the workbench even from the terminal). Keys the
 * application menu owns are left to the menu: handling them here as well
 * would run the command twice.
 */
export function installKeybindings(registry: CommandRegistry, platform: KeyPlatform, target: Window = window): () => void {
    // Rebuilt on each key press: a few dozen commands, and commands can come
    // and go (the AI agents register theirs later), so nothing goes stale.
    function bindings(): readonly { readonly id: string; readonly key: ParsedKeybinding }[] {
        return registry.list().flatMap((command) => {
            const keys = [
                ...(command.keybinding && command.keybindingSource !== 'menu' ? [command.keybinding] : []),
                ...(command.secondaryKeybindings ?? []),
            ];
            return keys.map((key) => ({ id: command.id, key: parseKeybinding(key, platform) }));
        });
    }

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.repeat || event.isComposing) {
            return;
        }
        const hit = bindings().find((binding) => matchesKeybinding(event, binding.key));
        if (hit && registry.execute(hit.id)) {
            event.preventDefault();
            event.stopPropagation();
        }
    };
    target.addEventListener('keydown', onKeyDown, true);
    return () => target.removeEventListener('keydown', onKeyDown, true);
}
