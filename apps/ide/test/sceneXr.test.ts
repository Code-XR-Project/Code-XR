import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowXrPermission, isXrPermission, unsupportedXrMessage, XR_ARM_MS } from '../src/main/analysis/sceneXrPolicy.ts';
import { qrDrawing } from '../src/renderer/sceneQr.ts';

const ORIGIN = 'http://localhost:3000';
const NOW = 1_000_000;
const ARM = { origin: ORIGIN, until: NOW + XR_ARM_MS };

describe('allowXrPermission (#19)', () => {
    it('grants XR to the armed scene only, while the arm lasts', () => {
        assert.equal(allowXrPermission(ARM, 'unknown', `${ORIGIN}/index.html`, NOW + 1), true);
        assert.equal(allowXrPermission(ARM, 'unknown', `${ORIGIN}/`, NOW + XR_ARM_MS + 1), false);
        assert.equal(allowXrPermission(null, 'unknown', `${ORIGIN}/`, NOW), false);
    });

    it('refuses another origin, even on loopback', () => {
        assert.equal(allowXrPermission(ARM, 'unknown', 'http://localhost:3001/', NOW), false);
        assert.equal(allowXrPermission(ARM, 'unknown', 'not a url', NOW), false);
    });

    it('never grants the camera, the microphone or anything else', () => {
        for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'display-capture', 'openExternal']) {
            assert.equal(isXrPermission(permission), false, permission);
            assert.equal(allowXrPermission(ARM, permission, `${ORIGIN}/`, NOW), false, permission);
        }
        assert.equal(isXrPermission('xr-spatial-tracking'), true);
    });

    it('says what to do instead on every OS', () => {
        assert.match(unsupportedXrMessage('win32'), /OpenXR/);
        assert.match(unsupportedXrMessage('darwin'), /standalone headset/);
        assert.match(unsupportedXrMessage('linux'), /standalone headset/);
    });
});

describe('qrDrawing (#19)', () => {
    it('draws the three finder patterns inside a quiet zone', () => {
        const drawing = qrDrawing('https://calm-river-42.trycloudflare.com/join?token=abc');
        const modules = drawing.size - 8;
        assert.ok(modules >= 21 && (modules - 17) % 4 === 0, `a QR side is 4v+17 modules, got ${modules}`);
        assert.ok(drawing.path.startsWith('M4 4h1v1h-1z'), 'top-left finder corner after the 4-module quiet zone');
        assert.ok(drawing.path.includes(`M${modules + 3} 4h1v1h-1z`), 'top-right finder corner');
        assert.ok(drawing.path.includes(`M4 ${modules + 3}h1v1h-1z`), 'bottom-left finder corner');
    });
});
