/**
 * Chromium for the browser harnesses, offline (S15, #87).
 *
 * The scenes load A-Frame, BabiaXR and friends from CDNs. Each CDN URL is
 * answered from test/vendor/scene-libraries/ and every other non-local
 * request is aborted, so the harnesses run in CI and behind a firewall and a
 * harness can never depend on the network by accident.
 */
const path = require('node:path');

const VENDOR = path.join(__dirname, '..', 'vendor', 'scene-libraries');

/** [URL pattern, vendored file]: the versions the templates pin. */
const SCENE_LIBRARIES = [
    [/aframe\.io\/releases\/1\.7\.1\/aframe(?:\.min)?\.js/, 'aframe-1.7.1.min.js'],
    [/aframe-babia-components@1\.3\.4\//, 'aframe-babia-components-1.3.4.min.js'],
    [/aframe-extras@v?7\.5\.4\//, 'aframe-extras-7.5.4.min.js'],
    [/aframe-environment-component@1\.5\.0\//, 'aframe-environment-component-1.5.0.min.js'],
    [/aframe-geometry-merger-component@2\.0\.1\//, 'aframe-geometry-merger-component-2.0.1.min.js'],
    [/html2canvas\/1\.4\.1\/html2canvas(?:\.min)?\.js/, 'html2canvas-1.4.1.min.js'],
];

const LOCAL_URL = /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/|file:|data:|blob:|about:)/;

function vendoredFileFor(url) {
    const hit = SCENE_LIBRARIES.find(([pattern]) => pattern.test(url));
    return hit ? path.join(VENDOR, hit[1]) : null;
}

/** Serves the scene libraries locally and blocks the rest of the internet. */
async function routeSceneLibraries(context) {
    await context.route((url) => !LOCAL_URL.test(url.href), (route) => {
        const file = vendoredFileFor(route.request().url());
        if (file) {
            return route.fulfill({ path: file, contentType: 'application/javascript' });
        }
        return route.abort('blockedbyclient');
    });
}

/**
 * `chromium.launch(options)`, with every context and page it opens routed
 * through routeSceneLibraries.
 */
async function launchHarnessChromium(chromium, options = {}) {
    const browser = await chromium.launch(options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
        const context = await newContext(...args);
        await routeSceneLibraries(context);
        return context;
    };
    browser.newPage = async (...args) => {
        const context = await browser.newContext(...args);
        const page = await context.newPage();
        // A page from browser.newPage() owns its context: close them together.
        page.on('close', () => { context.close().catch(() => {}); });
        return page;
    };
    return browser;
}

module.exports = { SCENE_LIBRARIES, VENDOR, launchHarnessChromium, routeSceneLibraries, vendoredFileFor };
