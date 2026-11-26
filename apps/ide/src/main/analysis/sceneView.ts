import { WebContentsView, net, session, type BrowserWindow, type Session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SceneBounds } from '../../shared/api.ts';
import { allowSceneOrigin } from '../hardening.ts';
import { log } from '../log.ts';
import { localSceneOrigin } from './sceneUrl.ts';
import { contentTypeOf, isLoopbackUrl, vendoredLibraryFor } from './sceneLibraries.ts';

/**
 * The analysis scene beside the code (#16): a `WebContentsView` laid over the
 * slot the renderer reserves, one per window.
 *
 * It is a separate page, not an <iframe> in the app's renderer, so the app's
 * CSP stays `frame-src 'none'` and the scene, which is served over the
 * network, can never reach `window.codexr`: no preload, sandboxed, context
 * isolation, and its own in-memory session (`codexr-scene`) that grants no
 * permission. It may navigate only within the local server it was opened on.
 */

const SCENE_PARTITION = 'codexr-scene';
let sceneSession: Session | null = null;
let librariesDir = '';

/** Where the vendored scene libraries are (see sceneLibraries.ts); set once at start-up. */
export function setSceneLibrariesDir(dir: string): void {
    librariesDir = dir;
}

function lockedSession(): Session {
    if (!sceneSession) {
        sceneSession = session.fromPartition(SCENE_PARTITION);
        // Nothing leaves the machine: the pinned CDN libraries are answered
        // from the vendored copies, any other https request is refused, and
        // the scene's own (loopback) server is reached as usual.
        sceneSession.protocol.handle('https', async (request) => {
            if (isLoopbackUrl(request.url)) {
                return net.fetch(request, { bypassCustomProtocolHandlers: true });
            }
            const file = vendoredLibraryFor(request.url);
            if (!file || !librariesDir) {
                log.warn(`Scene view: blocked ${request.url}`);
                return new Response(null, { status: 403 });
            }
            const body = await fs.readFile(path.join(librariesDir, file));
            return new Response(body, { headers: { 'content-type': contentTypeOf(file) } });
        });
        sceneSession.webRequest.onBeforeRequest((details, callback) => {
            const allowed = details.url.startsWith('https:') || isLoopbackUrl(details.url) || /^(?:data|blob|about):/.test(details.url);
            if (!allowed) {
                log.warn(`Scene view: blocked ${details.url}`);
            }
            callback({ cancel: !allowed });
        });
        // No camera, microphone, XR... until #19 allow-lists what entering XR needs.
        sceneSession.setPermissionRequestHandler((_wc, permission, callback) => {
            log.warn(`Scene view: denied permission request: ${permission}`);
            callback(false);
        });
        sceneSession.setPermissionCheckHandler(() => false);
    }
    return sceneSession;
}

const views = new Map<number, WebContentsView>();

/** Shows `url` in `win`'s scene view, replacing what it showed. Refuses anything but a local Code-XR server. */
export async function showScene(win: BrowserWindow, url: string): Promise<void> {
    const origin = localSceneOrigin(url);
    if (!origin) {
        throw new Error(`Refused to show ${url}: not a local Code-XR server.`);
    }
    closeScene(win);
    const view = new WebContentsView({
        webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            session: lockedSession(),
        },
    });
    allowSceneOrigin(view.webContents, origin);
    view.setVisible(false);
    win.contentView.addChildView(view);
    views.set(win.id, view);
    win.once('closed', () => views.delete(win.id));
    await view.webContents.loadURL(url);
}

/** Places the scene over the renderer's slot, or hides it (null). */
export function setSceneBounds(win: BrowserWindow, bounds: SceneBounds | null): void {
    const view = views.get(win.id);
    if (!view) {
        return;
    }
    if (bounds) {
        view.setBounds(bounds);
        view.setVisible(true);
    } else {
        view.setVisible(false);
    }
}

export function closeScene(win: BrowserWindow): void {
    const view = views.get(win.id);
    if (!view) {
        return;
    }
    views.delete(win.id);
    if (!win.isDestroyed()) {
        win.contentView.removeChildView(view);
    }
    view.webContents.close();
}

/** The URL the window's scene shows, for the smoke run and tests. */
export function sceneUrlOf(win: BrowserWindow): string | null {
    return views.get(win.id)?.webContents.getURL() ?? null;
}
