import type { ExtensionRunState } from '../../shared/extensions.ts';

/**
 * #263: whether an installed extension runs in a window, and why not. Pure,
 * so the rules are unit-tested without Electron:
 * - `--disable-extensions` or the person's choice (`extensions.json` in the
 *   user-data folder, never the project) turns it off;
 * - in Restricted Mode, an extension with code runs only when its manifest
 *   declares `capabilities.untrustedWorkspaces.supported` (`true` or
 *   `"limited"`); declarative ones (themes, grammars) always run.
 */
export interface RunStateInput {
    readonly enabled: boolean;
    readonly disabledByFlag: boolean;
    readonly hasCode: boolean;
    readonly supportsUntrusted: boolean;
    /** The window's folder trust; null when there is no window (nothing restricts then). */
    readonly trusted: boolean | null;
}

export function extensionRunState(input: RunStateInput): ExtensionRunState {
    if (!input.enabled || input.disabledByFlag) {
        return 'disabled';
    }
    return input.hasCode && !input.supportsUntrusted && input.trusted === false ? 'restricted' : 'enabled';
}

/** Whether its code may start in that window's extension host. */
export function mayRunCode(input: Omit<RunStateInput, 'hasCode'>): boolean {
    return extensionRunState({ ...input, hasCode: true }) === 'enabled';
}
