'use strict';

/**
 * #19: the address a standalone headset opens, and the page VS Code shows it
 * on (features/active-servers/services/headsetPage.ts, core/xr/headsetQr.ts).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { headsetTarget, headsetPageHtml } = require('../../out/features/active-servers/services/headsetPage.js');
const { qrDrawing, qrSvgMarkup } = require('../../out/core/xr/headsetQr.js');

const INVITE = 'https://calm-river-42.trycloudflare.com/?invite=abc';
const LAN = 'https://192.168.1.20:3000';

test('a shared server sends the headset to its invitation link', () => {
    const server = { certMode: 'http', remoteAccess: { status: 'shared', invitationUrl: INVITE, pendingRequests: 0 } };
    assert.deepEqual(headsetTarget(server, 'http://192.168.1.20:3000'), { kind: 'invitation', url: INVITE });
});

test('an HTTPS server not shared sends it to the local network address', () => {
    assert.deepEqual(headsetTarget({ certMode: 'https-default' }, LAN), { kind: 'lan', url: LAN });
    assert.deepEqual(headsetTarget({ certMode: 'https-default', remoteAccess: { status: 'starting', pendingRequests: 0 } }, LAN), { kind: 'lan', url: LAN });
});

test('a plain HTTP server not shared has no address a headset can use', () => {
    assert.deepEqual(headsetTarget({ certMode: 'http' }, 'http://192.168.1.20:3000'), { kind: 'none' });
    assert.deepEqual(headsetTarget({ certMode: 'http', remoteAccess: { status: 'shared', invitationUrl: 'http://evil', pendingRequests: 0 } }, 'http://x'), { kind: 'none' });
});

test('the page has no script, escapes the address and carries the QR code', () => {
    const page = headsetPageHtml({ kind: 'invitation', url: 'https://a.trycloudflare.com/?a=1&b=<x>' }, 'Demo "server"', 'vscode-resource:');
    assert.doesNotMatch(page, /<script/i);
    assert.match(page, /default-src 'none'/);
    assert.match(page, /a=1&#38;b=&#60;x&#62;/);
    assert.match(page, /Demo &#34;server&#34;/);
    assert.match(page, /<svg [^>]*role="img"/);
    assert.match(headsetPageHtml({ kind: 'none' }, 'Demo', 'vscode-resource:'), /Start Remote Access/);
});

test('the QR code keeps a 4-module quiet zone and the three finder patterns', () => {
    const drawing = qrDrawing(INVITE);
    const modules = drawing.size - 8;
    assert.equal((modules - 17) % 4, 0);
    assert.ok(drawing.path.startsWith('M4 4h1v1h-1z'));
    assert.ok(drawing.path.includes(`M${modules + 3} 4h1v1h-1z`));
    assert.ok(drawing.path.includes(`M4 ${modules + 3}h1v1h-1z`));
    assert.match(qrSvgMarkup(INVITE), new RegExp(`viewBox="0 0 ${drawing.size} ${drawing.size}"`));
});
