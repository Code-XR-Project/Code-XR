/**
 * The scene's third-party libraries, served from the copies in the repository
 * instead of their CDNs (#16).
 *
 * Generated scenes load A-Frame, BabiaXR and friends from CDNs (pinned
 * versions). Inside the IDE the scene view answers those URLs from
 * `apps/vscode-extension/test/vendor/scene-libraries/` (the same copies, and
 * licences, the offline browser harnesses use) and refuses every other
 * request that leaves the machine: the project rule is no network access
 * without consent, and a scene must not depend on a CDN being up.
 *
 * Packaging (#20) has to ship that folder with the IDE.
 */

/** [URL pattern, vendored file]: the versions the templates pin (kept in step with test/helpers/harnessBrowser.cjs). */
export const SCENE_LIBRARIES: ReadonlyArray<readonly [RegExp, string]> = [
    [/^https:\/\/aframe\.io\/releases\/1\.7\.1\/aframe(?:\.min)?\.js(?:\?|$)/, 'aframe-1.7.1.min.js'],
    [/^https:\/\/unpkg\.com\/aframe-babia-components@1\.3\.4\//, 'aframe-babia-components-1.3.4.min.js'],
    [/^https:\/\/cdn\.jsdelivr\.net\/gh\/(?:c-frame|donmccurdy)\/aframe-extras@v?7\.5\.4\//, 'aframe-extras-7.5.4.min.js'],
    [/^https:\/\/unpkg\.com\/aframe-environment-component@1\.5\.0\//, 'aframe-environment-component-1.5.0.min.js'],
    [/^https:\/\/unpkg\.com\/aframe-geometry-merger-component@2\.0\.1\//, 'aframe-geometry-merger-component-2.0.1.min.js'],
    [/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/html2canvas\/1\.4\.1\/html2canvas(?:\.min)?\.js(?:\?|$)/, 'html2canvas-1.4.1.min.js'],
];

/** The vendored file name for a CDN URL, or null when the URL is not one of the pinned libraries. */
export function vendoredLibraryFor(url: string): string | null {
    return SCENE_LIBRARIES.find(([pattern]) => pattern.test(url))?.[1] ?? null;
}

/** Loopback requests (the scene's own server) go through untouched. */
export function isLoopbackUrl(url: string): boolean {
    try {
        const { hostname } = new URL(url);
        return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
    } catch {
        return false;
    }
}
