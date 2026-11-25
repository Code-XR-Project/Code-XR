import * as path from 'path';

/** The folder, at the extension root, that ships the scene and panel templates. */
export const TEMPLATES_FOLDER = 'templates';

/**
 * Absolute path of `templates/<segments…>` inside the installed extension.
 *
 * Always derive template paths from the extension root (`context.extensionPath`),
 * never from `__dirname`: the bundle runs from `dist/extension.js` while the
 * unbundled build runs from `out/<folder>/<file>.js`, so no `__dirname`-relative
 * path is right in both.
 */
export function resolveTemplatePath(extensionPath: string, ...segments: string[]): string {
    return path.join(extensionPath, TEMPLATES_FOLDER, ...segments);
}
