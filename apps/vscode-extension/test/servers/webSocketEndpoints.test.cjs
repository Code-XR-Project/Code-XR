'use strict';

/**
 * The WebSocket scaffold shared by the collaboration room and the screen
 * broadcast server: both attach to the same HTTP(S) server's 'upgrade'
 * event, each answers only its own path, refuses an unauthorized upgrade by
 * destroying the socket, normalizes a path given without its leading slash,
 * detaches on dispose without disturbing the other, and falls back to the
 * same default room id. Both suites (collaborationRoomServer,
 * screenBroadcastSignalingServer) exercise the message protocols; this one
 * pins the scaffold itself. Binds 127.0.0.1 on an ephemeral port.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const WebSocket = require('ws');

const projectRoot = path.resolve(__dirname, '..', '..');
const out = (...segments) => require(path.join(projectRoot, 'out', ...segments));

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

/** Resolves 'open' or the failure kind; never hangs past 2.5 s. */
function tryConnect(url) {
    return new Promise((resolve) => {
        const socket = new WebSocket(url);
        const timeout = setTimeout(() => {
            socket.terminate();
            resolve({ outcome: 'timeout' });
        }, 2500);
        socket.once('open', () => {
            clearTimeout(timeout);
            resolve({ outcome: 'open', socket });
        });
        socket.once('error', (error) => {
            clearTimeout(timeout);
            resolve({ outcome: 'error', message: error.message });
        });
    });
}

function nextMessage(socket, type) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2500);
        const onMessage = (raw) => {
            const payload = JSON.parse(raw.toString('utf8'));
            if (payload.type === type) {
                clearTimeout(timeout);
                socket.off('message', onMessage);
                resolve(payload);
            }
        };
        socket.on('message', onMessage);
    });
}

test('room and broadcast endpoints share one server, each on its own path, and fall back to the same default room', async () => {
    const { CollaborationRoomServer } = out('servers', 'runtime', 'collaboration', 'collaborationRoomServer.js');
    const { ScreenBroadcastSignalingServer } = out('servers', 'runtime', 'broadcast', 'screenBroadcastSignalingServer.js');
    const server = http.createServer((_req, res) => res.end('ok'));
    const scopes = [];
    // Paths given without the leading slash are normalized.
    const room = new CollaborationRoomServer(server, 'codexr-room');
    const broadcast = new ScreenBroadcastSignalingServer(server, 'codexr-broadcast', () => true, (request) => {
        scopes.push(typeof request.headers.host);
        return 'local';
    });
    const port = await listen(server);
    try {
        assert.equal(server.listenerCount('upgrade'), 2);

        const roomClient = await tryConnect(`ws://127.0.0.1:${port}/codexr-room?x=1`);
        assert.equal(roomClient.outcome, 'open', 'the query string is ignored when matching the path');
        const joined = nextMessage(roomClient.socket, 'room-joined');
        roomClient.socket.send(JSON.stringify({ type: 'room-join' }));
        assert.equal((await joined).roomId, 'codexr-session:default');

        const broadcastClient = await tryConnect(`ws://127.0.0.1:${port}/codexr-broadcast`);
        assert.equal(broadcastClient.outcome, 'open');
        const registered = nextMessage(broadcastClient.socket, 'registered');
        broadcastClient.socket.send(JSON.stringify({ type: 'register', screenId: 'screen-a' }));
        assert.equal((await registered).roomId, 'codexr-session:default');
        assert.deepEqual(scopes, ['string'], 'the scope resolver sees the upgrade request once per connection');

        // Disposing one endpoint detaches only its own upgrade listener.
        const roomClosed = new Promise((resolve) => roomClient.socket.once('close', (code) => resolve(code)));
        room.dispose();
        assert.equal(await roomClosed, 4002);
        assert.equal(server.listenerCount('upgrade'), 1);
        const afterDispose = await tryConnect(`ws://127.0.0.1:${port}/codexr-broadcast`);
        assert.equal(afterDispose.outcome, 'open');
        afterDispose.socket.close();

        broadcastClient.socket.close();
        broadcast.dispose();
        assert.equal(server.listenerCount('upgrade'), 0);
        room.dispose();
        broadcast.dispose();
    } finally {
        room.dispose();
        broadcast.dispose();
        server.closeAllConnections();
        await close(server);
    }
});

test('an unauthorized upgrade has its socket destroyed; an authorized one on the same path connects', async () => {
    const { CollaborationRoomServer } = out('servers', 'runtime', 'collaboration', 'collaborationRoomServer.js');
    const { ScreenBroadcastSignalingServer } = out('servers', 'runtime', 'broadcast', 'screenBroadcastSignalingServer.js');
    const server = http.createServer((_req, res) => res.end('ok'));
    const allow = (request) => new URL(request.url, 'http://x').searchParams.get('ok') === '1';
    const room = new CollaborationRoomServer(server, '/codexr-room', { authorizeUpgrade: allow });
    const broadcast = new ScreenBroadcastSignalingServer(server, '/codexr-broadcast', allow);
    const port = await listen(server);
    try {
        for (const endpointPath of ['/codexr-room', '/codexr-broadcast']) {
            const refused = await tryConnect(`ws://127.0.0.1:${port}${endpointPath}`);
            assert.equal(refused.outcome, 'error', `${endpointPath} must refuse`);
            assert.match(refused.message, /socket hang up|ECONNRESET/);
            const accepted = await tryConnect(`ws://127.0.0.1:${port}${endpointPath}?ok=1`);
            assert.equal(accepted.outcome, 'open', `${endpointPath} must accept`);
            accepted.socket.terminate();
        }
    } finally {
        room.dispose();
        broadcast.dispose();
        server.closeAllConnections();
        await close(server);
    }
});
