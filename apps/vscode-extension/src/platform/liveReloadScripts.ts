import * as fs from 'fs';
import { resolveTemplatePath } from './templatePaths';

/**
 * The live reload `main.js` of a generated page (#345): the shared live channel
 * runtime (templates/components/live/liveChannel.js) followed by the page
 * script for its kind. Every place that ships one (file and directory XR
 * scenes, structural placeholders, the DOM template processor, the export
 * refresh) goes through here, so they cannot drift apart.
 */
export type LiveReloadKind = 'xr' | 'dom';

const PAGE_SCRIPTS: Readonly<Record<LiveReloadKind, string>> = {
    xr: 'liveReloadXR.js',
    dom: 'liveReloadDOM.js',
};

/** The shared runtime; the LivePanel bundles it ahead of its shared components. */
export function liveChannelRuntimePath(extensionPath: string): string {
    return resolveTemplatePath(extensionPath, 'components', 'live', 'liveChannel.js');
}

export function liveReloadPageScriptPath(extensionPath: string, kind: LiveReloadKind): string {
    return resolveTemplatePath(extensionPath, 'xr', 'live', PAGE_SCRIPTS[kind]);
}

/** Runtime + page script, or null when either file is missing. */
export function readLiveReloadScript(extensionPath: string, kind: LiveReloadKind): string | null {
    const runtimePath = liveChannelRuntimePath(extensionPath);
    const pagePath = liveReloadPageScriptPath(extensionPath, kind);
    if (!fs.existsSync(runtimePath) || !fs.existsSync(pagePath)) {
        return null;
    }
    return `${fs.readFileSync(runtimePath, 'utf8')}\n\n${fs.readFileSync(pagePath, 'utf8')}`;
}
