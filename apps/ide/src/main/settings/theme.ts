import { nativeTheme } from 'electron';
import { isColorTheme, type ColorTheme } from '../../shared/settings.ts';

/**
 * The colour theme (#171). The whole UI already follows
 * `prefers-color-scheme` (the workbench tokens, Monaco, xterm, the file icons
 * and the scene), so the theme is one switch: `nativeTheme.themeSource`,
 * which is what Chromium reports to every page of every window. `system`
 * keeps following the OS live.
 */

let stored: ColorTheme = 'system';

/** Applies the user's setting (anything unexpected means `system`). */
export function applyColorTheme(value: unknown): void {
    stored = isColorTheme(value) ? value : 'system';
    nativeTheme.themeSource = stored;
}

/** Shows a theme while the picker moves through the list; null goes back to the stored one. */
export function previewColorTheme(value: unknown): void {
    nativeTheme.themeSource = isColorTheme(value) ? value : stored;
}
