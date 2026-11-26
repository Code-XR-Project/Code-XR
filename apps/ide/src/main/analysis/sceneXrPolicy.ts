/**
 * #19: what the scene view may ask for when the person enters XR from the
 * IDE. Pure, so it is unit-tested; `sceneView.ts` applies it.
 *
 * The scene's session grants no permission by default. An immersive WebXR
 * session needs one, which Electron reports under a name it does not list
 * (`unknown`, or `xr`-something in later releases). It is granted only for a
 * few seconds after the person pressed *Enter XR* in the header, and only to
 * the scene's own loopback origin: a page cannot start XR on its own.
 */
export const XR_ARM_MS = 15_000;

/** The permission names an immersive session may be requested under. */
export function isXrPermission(permission: string): boolean {
    return permission === 'unknown' || /xr|vr/i.test(permission);
}

export interface XrArm {
    /** The origin of the scene the person asked to enter, `http://127.0.0.1:<port>`. */
    readonly origin: string;
    /** Epoch ms after which the grant lapses. */
    readonly until: number;
}

export function allowXrPermission(arm: XrArm | null, permission: string, requestingUrl: string, now: number): boolean {
    if (!arm || now > arm.until || !isXrPermission(permission)) {
        return false;
    }
    try {
        return new URL(requestingUrl).origin === arm.origin;
    } catch {
        return false;
    }
}

/** Why the IDE cannot start an immersive session, for the header and the docs' support matrix. */
export function unsupportedXrMessage(platform: NodeJS.Platform): string {
    const common = 'No XR headset is available to the IDE.';
    switch (platform) {
        case 'win32':
            return `${common} Connect a PC VR headset with its OpenXR runtime running (SteamVR, Oculus/Meta Link, Windows Mixed Reality), or open the scene in your browser or on a standalone headset.`;
        case 'darwin':
            return `${common} macOS has no WebXR headset support: open the scene on a standalone headset instead.`;
        default:
            return `${common} Chromium has no headset support on Linux: open the scene on a standalone headset instead.`;
    }
}
