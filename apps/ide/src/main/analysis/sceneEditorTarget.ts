import path from 'node:path';
import { isInside, parseWorkspacePath } from '../workspace/workspacePath.ts';

/**
 * Turns the path an analysis page asks to open (#16) into a path of the open
 * folder, or null when it is not one.
 *
 * A dependency-graph node names its file relative to the analysed folder; a
 * LivePanel row carries the absolute path the backend saw. Either way the
 * result must land inside `workspaceRoot`: the page is served over the
 * network and is not trusted to name any other file.
 */
export function sceneTargetToWorkspacePath(workspaceRoot: string, analysedFolder: string, requested: string): string | null {
    const candidate = path.isAbsolute(requested)
        ? path.resolve(requested)
        : path.resolve(analysedFolder, ...requested.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.'));
    if (!isInside(workspaceRoot, candidate)) {
        return null;
    }
    const relative = path.relative(path.resolve(workspaceRoot), candidate).split(path.sep).join('/');
    if (relative === '') {
        return null;
    }
    try {
        parseWorkspacePath(relative);
    } catch {
        return null;
    }
    return relative;
}
