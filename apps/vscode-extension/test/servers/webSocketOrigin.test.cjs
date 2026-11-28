'use strict';

/**
 * Who may open a room, broadcast or live socket (COLLAB-ROOM-6), and who
 * counts as the person on this machine (COLLAB-ROOM-9).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { RemoteAccessPolicy, isWebSocketOriginAllowed } = require(path.join(projectRoot, 'out', 'core', 'server', 'remote', 'remoteAccessPolicy.js'));

function request(headers, remoteAddress = '127.0.0.1') {
    return { headers, socket: { remoteAddress } };
}

const loopback = (address) => address === '127.0.0.1' || address === '::1';

test('a socket from the page itself, a webview or a non-browser client is allowed', () => {
    assert.equal(isWebSocketOriginAllowed(request({ host: 'localhost:3000' })), true);
    assert.equal(isWebSocketOriginAllowed(request({ host: 'localhost:3000', origin: 'https://localhost:3000' })), true);
    assert.equal(isWebSocketOriginAllowed(request({ host: '127.0.0.1:3000', origin: 'https://localhost:3000' })), true);
    assert.equal(isWebSocketOriginAllowed(request({ host: '192.0.2.2:3000', origin: 'https://192.0.2.2:3000' })), true);
    assert.equal(isWebSocketOriginAllowed(request({ host: 'abc.trycloudflare.com', origin: 'https://abc.trycloudflare.com' })), true);
    assert.equal(isWebSocketOriginAllowed(request({ host: 'localhost:3000', origin: 'vscode-webview://1234abcd' })), true);
});

test('a page from another site or another local port cannot open a socket', () => {
    assert.equal(isWebSocketOriginAllowed(request({ host: 'localhost:3000', origin: 'https://evil.example' })), false);
    assert.equal(isWebSocketOriginAllowed(request({ host: 'localhost:3000', origin: 'http://localhost:5173' })), false);
    assert.equal(isWebSocketOriginAllowed(request({ host: 'localhost:3000', origin: 'null' })), false);
    assert.equal(isWebSocketOriginAllowed(request({ host: 'localhost:3000', origin: 'file://' })), false);
    assert.equal(isWebSocketOriginAllowed(request({ origin: 'https://localhost:3000' })), false);

    const policy = new RemoteAccessPolicy({ resolveCookie: () => null });
    assert.equal(policy.isWebSocketAuthorized(request({ host: 'localhost:3000', origin: 'https://evil.example' })), false);
    assert.equal(policy.isWebSocketAuthorized(request({ host: 'localhost:3000', origin: 'https://localhost:3000' })), true);
});

test('only a direct loopback connection is the local person; any proxy is not', () => {
    const policy = new RemoteAccessPolicy({ resolveCookie: () => null });
    assert.equal(policy.isLocalRequest(request({ host: 'localhost:3000' }), loopback), true);
    assert.equal(policy.isLocalRequest(request({ host: 'localhost:3000' }, '192.0.2.7'), loopback), false);
    assert.equal(policy.isLocalRequest(request({ host: 'localhost:3000', 'x-forwarded-for': '203.0.113.9' }), loopback), false);
    assert.equal(policy.isLocalRequest(request({ host: 'localhost:3000', forwarded: 'for=203.0.113.9' }), loopback), false);
    assert.equal(policy.isLocalRequest(request({ host: 'abc.trycloudflare.com' }), loopback), false);
    assert.equal(policy.isLocalRequest(request({ host: 'localhost:3000', 'cf-connecting-ip': '203.0.113.9' }), loopback), false);
});
