import { BrowserWindow, WebContentsView, desktopCapturer, dialog, net, session, type Session, type WebContents } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SceneBounds } from '../../shared/api.ts';
import { allowSceneOrigin } from '../hardening.ts';
import { log } from '../log.ts';
import { localSceneOrigin } from './sceneUrl.ts';
import { allowXrPermission, XR_ARM_MS, type XrArm } from './sceneXrPolicy.ts';
import { allowScreenShareRequest, shareAudioFor, shareChoices } from './sceneScreenShare.ts';
import { contentTypeOf, isLoopbackUrl, vendoredLibraryFor } from './sceneLibraries.ts';

/**
 * The analysis scene beside the code (#16): a `WebContentsView` laid over the
 * slot the renderer reserves, one per window.
 *
 * It is a separate page, not an <iframe> in the app's renderer, so the app's
 * CSP keeps frames to extensions' webviews (`codexr-webview:`) and the scene, which is served over the
 * network, can never reach `window.codexr`: sandboxed, context isolation,
 * and its own in-memory session (`codexr-scene`) that grants no permission.
 * Its only preload (src/scenePreload) exposes one call, `CodeXRHostBridge.
 * openInEditor`, which the main process checks against the open folder. It
 * may navigate only within the local server it was opened on.
 */

const SCENE_PARTITION = 'codexr-scene';
let sceneSession: Session | null = null;
let librariesDir = '';
let preloadPath = '';

/** Where the scene preload was built (out/scenePreload/index.cjs); set once at start-up. */
export function setScenePreloadPath(file: string): void {
    preloadPath = file;
}

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
        // No camera, microphone... XR only for a few seconds after the
        // person pressed Enter XR, and only for that scene (#19, sceneXrPolicy.ts).
        sceneSession.setPermissionRequestHandler((contents, permission, callback, details) => {
            const win = windowOfScene(contents);
            const arm = win ? xrArms.get(win.id) ?? null : null;
            if (allowXrPermission(arm, permission, details.requestingUrl, Date.now())) {
                log.info(`Scene view: granted ${permission} to enter XR`);
                callback(true);
                return;
            }
            log.warn(`Scene view: denied permission request: ${permission}`);
            callback(false);
        });
        sceneSession.setPermissionCheckHandler(() => false);
        sceneSession.setDisplayMediaRequestHandler((request, callback) => {
            void answerScreenShare(request.frame?.url ?? '', callback);
        });
    }
    return sceneSession;
}

const views = new Map<number, WebContentsView>();

type DisplayMediaCallback = (streams: Electron.Streams | null) => void;

/**
 * COLLAB-IDE-1: the virtual screen's Share button. Asks the person which
 * screen or window to share; refusing (or Cancel) answers with nothing, which
 * the scene reports as a cancelled share.
 */
async function answerScreenShare(requestingUrl: string, callback: DisplayMediaCallback): Promise<void> {
    const scene = sceneOfUrl(requestingUrl);
    if (!scene || !allowScreenShareRequest(localSceneOrigin(scene.view.webContents.getURL()), requestingUrl)) {
        log.warn(`Scene view: refused a screen capture request from ${requestingUrl}`);
        callback({});
        return;
    }
    try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        const choices = shareChoices(sources.map((source) => ({ id: source.id, name: source.name })));
        const options = {
            type: 'question' as const,
            message: 'Share which screen or window in the scene?',
            detail: 'Everybody in the room sees it on the virtual screen.',
            buttons: choices.buttons,
            cancelId: choices.cancelId,
            defaultId: 0,
        };
        const { response } = scene.win ? await dialog.showMessageBox(scene.win, options) : await dialog.showMessageBox(options);
        const picked = choices.sources[response];
        const source = picked ? sources.find((candidate) => candidate.id === picked.id) : undefined;
        if (!source) {
            callback({});
            return;
        }
        const audio = shareAudioFor(process.platform);
        callback(audio ? { video: source, audio } : { video: source });
    } catch (error) {
        log.error('Scene view: screen capture failed', error);
        callback({});
    }
}

/** The scene view (and its window) showing a page of this URL's origin. */
function sceneOfUrl(url: string): { view: WebContentsView; win: BrowserWindow | null } | null {
    let origin: string;
    try {
        origin = new URL(url).origin;
    } catch {
        return null;
    }
    for (const [windowId, view] of views) {
        if (localSceneOrigin(view.webContents.getURL()) === origin) {
            return { view, win: BrowserWindow.fromId(windowId) };
        }
    }
    return null;
}
/** #19: per window, the scene the person just asked to enter in XR. */
const xrArms = new Map<number, XrArm>();

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
            ...(preloadPath ? { preload: preloadPath } : {}),
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

/**
 * #19: whether the window's scene can start an immersive session here (a
 * headset and its runtime that Chromium sees). False without a scene.
 */
export async function sceneSupportsImmersiveXr(win: BrowserWindow): Promise<boolean> {
    const view = views.get(win.id);
    if (!view) {
        return false;
    }
    const supported: unknown = await view.webContents.executeJavaScript(
        'navigator.xr ? navigator.xr.isSessionSupported("immersive-vr").catch(() => false) : false',
    );
    return supported === true;
}

/**
 * #19: enters the window's scene in XR, as its own VR button would. The
 * request counts as the person's gesture (they pressed Enter XR in the
 * header), and the XR permission is armed for this scene only, briefly.
 */
export async function enterSceneXr(win: BrowserWindow): Promise<void> {
    const view = views.get(win.id);
    const origin = view ? localSceneOrigin(view.webContents.getURL()) : null;
    if (!view || !origin) {
        throw new Error('This window shows no scene.');
    }
    xrArms.set(win.id, { origin, until: Date.now() + XR_ARM_MS });
    setTimeout(() => xrArms.delete(win.id), XR_ARM_MS).unref();
    const entered: unknown = await view.webContents.executeJavaScript(
        '(() => { const scene = document.querySelector("a-scene"); if (!scene || !scene.enterVR) { return false; } return Promise.resolve(scene.enterVR()).then(() => true); })()',
        true,
    );
    if (entered !== true) {
        throw new Error('This scene has no XR mode (a LivePanel is a 2D page).');
    }
}

/** The URL the window's scene shows, for the smoke run and tests. */
export function sceneUrlOf(win: BrowserWindow): string | null {
    return views.get(win.id)?.webContents.getURL() ?? null;
}

/** The window whose scene view `contents` is, or null: anything else that sends is not a scene. */
export function windowOfScene(contents: WebContents): BrowserWindow | null {
    for (const [windowId, view] of views) {
        if (view.webContents === contents) {
            return BrowserWindow.fromId(windowId);
        }
    }
    return null;
}
