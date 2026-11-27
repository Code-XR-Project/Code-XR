import { app } from 'electron';
import path from 'node:path';

/**
 * Where the Code-XR extension package lives: the IDE runs the extension's
 * core and reuses its resources rather than keeping copies. Unpackaged,
 * out/main/index.cjs sits in apps/ide, so it is apps/vscode-extension;
 * packaged (#20), the resources folder.
 */
export function installRoot(): string {
    return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..', '..', 'vscode-extension');
}

/** The Code-XR logo, the same file the extension uses as its icon (window, dock, About). */
export function appIconPath(): string {
    return path.join(installRoot(), 'resources', 'icon.png');
}
