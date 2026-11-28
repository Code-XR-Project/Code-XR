const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const WebSocket = require('ws');

// Coming back after a dropped connection (#360), removal everywhere (#361)
// and the room's integrity guards (#362).

const projectRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(projectRoot, 'out', 'core', 'server', 'collaboration');

function waitForOpen(socket) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for websocket open')), 2500);
        socket.once('open', () => {
            clearTimeout(timeout);
            resolve();
        });
        socket.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
}

function waitForMessage(socket, predicate, label = 'collaboration message') {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2500);
        function onMessage(raw) {
            const payload = JSON.parse(raw.toString('utf8'));
            if (!predicate(payload)) {
                return;
            }
            clearTimeout(timeout);
            socket.off('message', onMessage);
            resolve(payload);
        }
        socket.on('message', onMessage);
    });
}

function waitForClose(socket) {
    return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

async function join(url, roomId, resumeToken) {
    const socket = new WebSocket(url);
    await waitForOpen(socket);
    const joined = waitForMessage(socket, (payload) => payload.type === 'room-joined', 'room-joined');
    const snapshot = waitForMessage(socket, (payload) => payload.type === 'room-snapshot', 'room-snapshot');
    socket.send(JSON.stringify({
        type: 'room-join',
        roomId,
        ...(resumeToken ? { payload: { resumeToken } } : {}),
    }));
    return { socket, joined: await joined, snapshot: await snapshot };
}

async function createServer() {
    const { CollaborationRoomServer } = require(path.join(outDir, 'collaborationRoomServer.js'));
    const server = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end('ok');
    });
    const collaboration = new CollaborationRoomServer(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, collaboration, url: `ws://127.0.0.1:${server.address().port}/codexr-room` };
}

async function shutdown({ server, collaboration }, sockets) {
    for (const socket of sockets) {
        socket.close();
    }
    collaboration.dispose();
    await new Promise((resolve) => server.close(resolve));
}

const HOST_TOKEN = 'host-token-aaaaaaaaaaaa';
const GUEST_TOKEN = 'guest-token-bbbbbbbbbbb';
const ROOM = 'codexr-session:resume';

test('a host who drops comes back with the same name and takes the host role back from the interim guest', async () => {
    const ctx = await createServer();
    const sockets = [];
    try {
        const host = await join(ctx.url, ROOM, HOST_TOKEN);
        const guest = await join(ctx.url, ROOM, GUEST_TOKEN);
        sockets.push(host.socket, guest.socket);
        const hostName = host.joined.payload.participant.displayName;
        assert.equal(host.joined.payload.participant.role, 'host');

        const guestPromoted = waitForMessage(guest.socket, (payload) => (
            payload.type === 'role-updated' && payload.payload.peerId === guest.joined.peerId && payload.payload.role === 'host'
        ), 'interim promotion');
        host.socket.close();
        await guestPromoted;

        const guestDemoted = waitForMessage(guest.socket, (payload) => (
            payload.type === 'role-updated' && payload.payload.peerId === guest.joined.peerId && payload.payload.role === 'guest'
        ), 'interim demotion');
        const back = await join(ctx.url, ROOM, HOST_TOKEN);
        sockets.push(back.socket);
        await guestDemoted;
        assert.equal(back.joined.payload.participant.role, 'host');
        assert.equal(back.joined.payload.participant.displayName, hostName);
        assert.equal(ctx.collaboration.getConnectedParticipants(ROOM).length, 2);
    } finally {
        await shutdown(ctx, sockets);
    }
});

test('a role handed over on purpose is not taken back, and an unknown token is a new person', async () => {
    const ctx = await createServer();
    const sockets = [];
    try {
        const host = await join(ctx.url, ROOM, HOST_TOKEN);
        const guest = await join(ctx.url, ROOM, GUEST_TOKEN);
        sockets.push(host.socket, guest.socket);

        const transferred = waitForMessage(guest.socket, (payload) => (
            payload.type === 'role-updated' && payload.payload.peerId === guest.joined.peerId && payload.payload.role === 'host'
        ));
        host.socket.send(JSON.stringify({ type: 'host-transfer', payload: { peerId: guest.joined.peerId } }));
        await transferred;
        const gone = waitForMessage(guest.socket, (payload) => payload.type === 'presence-left');
        host.socket.close();
        await gone;

        const back = await join(ctx.url, ROOM, HOST_TOKEN);
        sockets.push(back.socket);
        assert.equal(back.joined.payload.participant.role, 'guest');

        const stranger = await join(ctx.url, ROOM, 'someone-else-cccccccccc');
        sockets.push(stranger.socket);
        assert.equal(stranger.joined.payload.participant.role, 'guest');
    } finally {
        await shutdown(ctx, sockets);
    }
});

test('rejoining with the token of a socket that still counts as joined replaces that ghost', async () => {
    const ctx = await createServer();
    const sockets = [];
    try {
        const host = await join(ctx.url, ROOM, HOST_TOKEN);
        const first = await join(ctx.url, ROOM, GUEST_TOKEN);
        sockets.push(host.socket, first.socket);
        const ghostClosed = waitForClose(first.socket);

        const second = await join(ctx.url, ROOM, GUEST_TOKEN);
        sockets.push(second.socket);
        await ghostClosed;
        const participants = ctx.collaboration.getConnectedParticipants(ROOM);
        assert.equal(participants.length, 2);
        assert.equal(second.joined.payload.participant.displayName, first.joined.payload.participant.displayName);
        assert.equal(host.joined.payload.participant.role, 'host');
    } finally {
        await shutdown(ctx, sockets);
    }
});

test('a kicked guest is removed everywhere, reported once, and cannot resume under its token', async () => {
    const ctx = await createServer();
    const sockets = [];
    try {
        const host = await join(ctx.url, ROOM, HOST_TOKEN);
        const guest = await join(ctx.url, ROOM, GUEST_TOKEN);
        sockets.push(host.socket, guest.socket);
        const reports = [];
        ctx.collaboration.onParticipantRemoved((roomId, result) => reports.push({ roomId, result }));

        const closed = waitForClose(guest.socket);
        host.socket.send(JSON.stringify({ type: 'participant-kick', payload: { peerId: guest.joined.peerId } }));
        assert.equal(await closed, 4001);
        assert.equal(reports.length, 1);
        assert.equal(reports[0].roomId, ROOM);
        assert.equal(reports[0].result.removed, true);

        const { takeResumable } = require(path.join(outDir, 'roomResume.js'));
        const room = ctx.collaboration.registry?.rooms?.get(ROOM);
        assert.ok(room, 'the room outlives the kick (the host is still there)');
        assert.equal(takeResumable(room, GUEST_TOKEN), null);
    } finally {
        await shutdown(ctx, sockets);
    }
});

test('resume state is pure: tokens are validated, kept for a grace period and taken once', () => {
    const resume = require(path.join(outDir, 'roomResume.js'));
    assert.equal(resume.normalizeResumeToken('short'), null);
    assert.equal(resume.normalizeResumeToken('has spaces in it here'), null);
    assert.equal(resume.normalizeResumeToken(42), null);
    assert.equal(resume.normalizeResumeToken(GUEST_TOKEN), GUEST_TOKEN);

    const room = { participants: new Map(), entities: new Map() };
    const participant = { peerId: 'peer-1', displayName: 'Ahsoka', role: 'guest', isPresenter: true };
    resume.bindResumeToken(room, 'peer-1', GUEST_TOKEN);
    resume.rememberLeavingParticipant(room, participant, 1000);
    assert.equal(resume.hasResumable(room, 1000), true);
    assert.equal(resume.takeResumable(room, GUEST_TOKEN, 1000 + resume.RESUME_GRACE_MS + 1), null);

    resume.bindResumeToken(room, 'peer-1', GUEST_TOKEN);
    resume.rememberLeavingParticipant(room, participant, 1000);
    const entry = resume.takeResumable(room, GUEST_TOKEN, 2000);
    assert.equal(entry.participant.displayName, 'Ahsoka');
    assert.equal(entry.participant.isPresenter, false);
    assert.equal(resume.takeResumable(room, GUEST_TOKEN, 2000), null);
});

test('peers cannot write server-owned entities, and a non-broadcaster cannot stop a share', async () => {
    const ctx = await createServer();
    const sockets = [];
    try {
        const host = await join(ctx.url, ROOM);
        const guest = await join(ctx.url, ROOM);
        sockets.push(host.socket, guest.socket);
        ctx.collaboration.upsertServerEntity(ROOM, { entityKind: 'analysis-view', entityId: 'main', state: { mode: 'classic' } });

        const refused = waitForMessage(guest.socket, (payload) => payload.type === 'error', 'refusal');
        guest.socket.send(JSON.stringify({
            type: 'entity-updated',
            roomId: ROOM,
            payload: { entityKind: 'analysis-view', entityId: 'main', state: { mode: 'agent-flow' } },
        }));
        await refused;

        const shared = waitForMessage(guest.socket, (payload) => payload.type === 'entity-added' && payload.payload?.entityKind === 'screen');
        host.socket.send(JSON.stringify({
            type: 'entity-added',
            roomId: ROOM,
            payload: {
                entityKind: 'screen',
                entityId: 'screen-1',
                broadcast: { active: true, broadcasterPeerId: host.joined.peerId },
            },
        }));
        await shared;
        const hostSaw = waitForMessage(host.socket, (payload) => payload.type === 'entity-updated' && payload.payload?.entityKind === 'screen');
        guest.socket.send(JSON.stringify({
            type: 'entity-updated',
            roomId: ROOM,
            payload: {
                entityKind: 'screen',
                entityId: 'screen-1',
                broadcast: { active: false, broadcasterPeerId: '' },
                size: 'large',
            },
        }));
        const update = await hostSaw;
        assert.equal(update.payload.broadcast.active, true);
        assert.equal(update.payload.size, 'large');

        const ended = waitForMessage(guest.socket, (payload) => (
            payload.type === 'entity-updated' && payload.payload?.entityKind === 'screen' && payload.payload.broadcast?.active === false
        ), 'broadcast ended');
        host.socket.close();
        await ended;
    } finally {
        await shutdown(ctx, sockets);
    }
});
