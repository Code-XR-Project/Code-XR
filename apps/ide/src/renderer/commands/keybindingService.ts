import type { CommandRegistry } from './commandRegistry.ts';
import { createKeyDispatcher, parseChord, type KeyPlatform, type StrokeBinding } from './keybindings.ts';

/**
 * The workbench's own key handler (#18). It listens in the capture phase on
 * the window, so a binding wins over Monaco and xterm (as in VS Code, where
 * workbench shortcuts reach the workbench even from the terminal). Keys the
 * application menu owns are left to the menu: handling them here as well
 * would run the command twice.
 *
 * Chords (#169, `CmdOrCtrl+K Z`): the first stroke is never swallowed, so
 * Monaco still sees it and its own `Ctrl+K ...` chords keep working (Monaco
 * then drops the unknown second stroke instead of typing it). The second
 * stroke runs the command and is swallowed. A chord does not start from the
 * terminal, where `Ctrl+K` belongs to the shell. The logic is
 * `createKeyDispatcher` (keybindings.ts, unit-tested).
 */
export function installKeybindings(registry: CommandRegistry, platform: KeyPlatform, target: Window = window): () => void {
    const dispatcher = createKeyDispatcher();
    // Rebuilt on each key press: a few dozen commands, and commands can come
    // and go (the AI agents register theirs later), so nothing goes stale.
    function bindings(): readonly StrokeBinding[] {
        return registry.list().flatMap((command) => {
            const keys = [
                ...(command.keybinding && command.keybindingSource !== 'menu' ? [command.keybinding] : []),
                ...(command.secondaryKeybindings ?? []),
            ];
            return keys.map((key) => ({ id: command.id, strokes: parseChord(key, platform) }));
        });
    }

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.repeat || event.isComposing) {
            return;
        }
        const inTerminal = event.target instanceof Element && event.target.closest('.xterm') !== null;
        const hit = dispatcher.dispatch(event, bindings(), !inTerminal);
        if (!hit) {
            return;
        }
        if (hit.kind === 'chord') {
            event.preventDefault();
            event.stopPropagation();
            registry.execute(hit.id);
        } else if (registry.execute(hit.id)) {
            event.preventDefault();
            event.stopPropagation();
        }
    };
    target.addEventListener('keydown', onKeyDown, true);
    return () => target.removeEventListener('keydown', onKeyDown, true);
}
