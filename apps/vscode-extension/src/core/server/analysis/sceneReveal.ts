import * as path from 'path';
import { getActiveServerRegistry } from '../registry/activeServerRegistry';

/**
 * #178: "Reveal in XR scene", the other direction of "open in editor"
 * (editorNavigation.ts), shared by the VS Code extension and the Code-XR IDE.
 * The host names a file; every running analysis server whose analysed folder
 * holds it sends `reveal-in-scene` { path } to its room, with the path
 * relative to that folder, and the scene marks the file's element
 * (analysis-table runtime, sceneReveal.js). Only pages on this machine act on
 * it, so a guest's view never jumps because the host clicked something.
 */

export const REVEAL_IN_SCENE_MESSAGE = 'reveal-in-scene';

/** The file's path relative to the analysed folder, with forward slashes, or null when it is outside. */
export function scenePathOf(analysisRoot: string, absolutePath: string): string | null {
    const relative = path.relative(path.resolve(analysisRoot), path.resolve(absolutePath));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }
    return relative.split(path.sep).join('/');
}

/**
 * Asks the running scenes that show `absolutePath` to reveal it; returns how
 * many were asked. The extension asks every one; the IDE names its window's
 * scene in `serverIds`.
 */
export function revealInScene(absolutePath: string, serverIds?: readonly string[]): number {
    let asked = 0;
    for (const server of getActiveServerRegistry().getServersByStatus('running')) {
        if ((!serverIds || serverIds.includes(server.id)) && server.serverInstance?.revealInScene?.(absolutePath)) {
            asked++;
        }
    }
    return asked;
}
