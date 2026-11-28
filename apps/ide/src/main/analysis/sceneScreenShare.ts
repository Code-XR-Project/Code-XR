/**
 * Sharing a screen or window from the scene pane (COLLAB-IDE-1, #366). Pure,
 * so it is unit-tested; `sceneView.ts` applies it.
 *
 * Electron has no picker of its own for `getDisplayMedia`: without a
 * display-media handler the request simply fails, so the virtual screen's
 * Share button did nothing in the IDE. The handler asks the person which
 * screen or window to share, in a native dialog, and answers only requests
 * from the scene's own local origin.
 */

/** Buttons a native dialog can show comfortably; the rest are not offered. */
export const MAX_SHARE_CHOICES = 8;

export interface ShareSource {
    readonly id: string;
    readonly name: string;
}

export interface ShareChoices {
    /** The dialog's buttons: one per offered source, then Cancel. */
    readonly buttons: string[];
    /** The source behind each button but the last. */
    readonly sources: ShareSource[];
    readonly cancelId: number;
}

/** Screens first, then windows; unnamed and duplicate entries dropped. */
export function shareChoices(sources: readonly ShareSource[]): ShareChoices {
    const seen = new Set<string>();
    const ordered = [...sources]
        .filter((source) => source.name.trim() !== '' && !seen.has(source.id) && seen.add(source.id))
        .sort((left, right) => Number(!left.id.startsWith('screen:')) - Number(!right.id.startsWith('screen:')))
        .slice(0, MAX_SHARE_CHOICES);
    const buttons = ordered.map((source, index) => (source.id.startsWith('screen:') ? `Screen ${index + 1}: ${source.name}` : source.name));
    buttons.push('Cancel');
    return { buttons, sources: ordered, cancelId: buttons.length - 1 };
}

/**
 * Whether a capture request may be answered: from the scene's own origin.
 * The scene pane only ever shows a local Code-XR server, but the check keeps
 * a page it navigated to from capturing the desktop.
 */
export function allowScreenShareRequest(sceneOrigin: string | null, requestingUrl: string): boolean {
    if (!sceneOrigin) {
        return false;
    }
    try {
        return new URL(requestingUrl).origin === sceneOrigin;
    } catch {
        return false;
    }
}

/** System audio can be captured with the picture on Windows only (Electron's loopback). */
export function shareAudioFor(platform: NodeJS.Platform): 'loopback' | undefined {
    return platform === 'win32' ? 'loopback' : undefined;
}
