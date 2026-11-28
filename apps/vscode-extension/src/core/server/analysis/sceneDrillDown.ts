import * as fs from 'fs';
import { getActiveServerRegistry } from '../registry/activeServerRegistry';

/**
 * #339: "Analyze in XR Scene" from the editor, shared by the VS Code
 * extension and the Code-XR IDE. The host names a file or folder; every
 * running XR analysis server whose drill-down boundary holds it switches its
 * table to that target in place (drillDownHostWiring.ts). No analysis is
 * launched and no window opens.
 */

/** The kind of a path on disk, or null when it is neither a file nor a folder. */
export function drillKindOf(absolutePath: string): 'file' | 'directory' | null {
    try {
        const stat = fs.statSync(absolutePath);
        return stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : null;
    } catch {
        return null;
    }
}

/**
 * Asks the running scenes that can reach `absolutePath` to drill into it;
 * returns how many took it. The extension asks every one; the IDE names its
 * window's scene in `serverIds`.
 */
export function drillDownInScenes(absolutePath: string, serverIds?: readonly string[]): number {
    const kind = drillKindOf(absolutePath);
    if (!kind) {
        return 0;
    }
    let asked = 0;
    for (const server of getActiveServerRegistry().getServersByStatus('running')) {
        if ((!serverIds || serverIds.includes(server.id)) && server.serverInstance?.drillDownInScene?.(absolutePath, kind)) {
            asked++;
        }
    }
    return asked;
}
