'use strict';

/**
 * Lifecycle characterization of the three Node servers: HttpServer and the
 * HTTPS pair (HttpsCustomServer, HttpsDefaultServer).
 *
 * It pins, by BEHAVIOUR and through compiled out/ code, what a structural
 * refactor of the HTTPS pair must not change: the constructor guard order,
 * the port search and its effect on the config, the TLS options (real
 * handshakes against the cipher list), the delegation to HttpServer for HTTP
 * requests and WebSocket upgrades, the per-class toasts and getConfig
 * redaction, and the shipped dispose-before-close order of stop() with a
 * keep-alive socket and an open wss socket. The console output is
 * normalized and compared as a whole transcript.
 *
 * Everything binds 127.0.0.1 on an ephemeral port. The port search is
 * stubbed (it probes 0.0.0.0, which depends on the platform) and records
 * what it was asked for; NetworkUtils is stubbed so no LAN address leaks into
 * a transcript.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const WebSocket = require('ws');

const { createFakeVscode, fakeExtensionContext, withFakeVscode } = require('../helpers/fakeVscode.cjs');
const { observeLogsAsConsole } = require('../helpers/logCapture.cjs');
const { templatesRoot } = require('../helpers/templatesRoot.cjs');

const ALLOWED_CIPHERS = [
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES128-SHA256',
    'ECDHE-RSA-AES256-SHA384',
    'DHE-RSA-AES128-GCM-SHA256',
    'DHE-RSA-AES256-GCM-SHA384',
    'AES128-GCM-SHA256',
    'AES256-GCM-SHA384',
];

function getFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

/** Captures console output as normalized first-argument lines. */
function captureConsole() {
    const lines = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    let replacements = [];
    const normalize = (value) => {
        let text = String(value);
        for (const [from, to] of replacements) {
            text = text.split(from).join(to);
        }
        return text.replace(/\d+ms\b/g, '<n>ms');
    };
    const record = (level, first) => {
        // Only the server modules' own lines: module-load banners of
        // shared singletons depend on which suite loaded them first.
        if (typeof first === 'string' && first.startsWith('SERVER:')) {
            lines.push(`${level}: ${normalize(first)}`);
        }
    };
    for (const level of Object.keys(original)) {
        console[level] = (first) => record(level, first);
    }
    return {
        lines,
        /**
         * Also records the logger calls of the modules loaded in this fake
         * scope, in the same console shape (helpers/logCapture.cjs). Call it
         * inside the scope, before the first line to capture.
         */
        observeLogger() {
            observeLogsAsConsole(require(path.join(__dirname, '..', '..', 'out', 'platform', 'logging', 'sink.js')), record);
        },
        /** Values replaced by stable placeholders in every later line (ports, temp paths). */
        setReplacements(next) {
            replacements = next;
        },
        restore() {
            Object.assign(console, original);
        },
    };
}

/** Stubs NetworkUtils and PortManager (shared by every server module in this load). */
function installNetworkStubs(requireOut, freePort) {
    const { NetworkUtils } = requireOut('core/server/networkUtils.js');
    const { PortManager } = requireOut('core/server/portManager.js');
    const calls = [];
    NetworkUtils.getPrimaryExternalUrl = (port, protocol) => `${protocol}://192.0.2.10:${port}`;
    NetworkUtils.generateServerUrls = (port, protocol) => ({
        localhost: `${protocol}://localhost:${port}`,
        localIP: `${protocol}://192.0.2.10:${port}`,
        allInterfaces: [],
    });
    NetworkUtils.displayNetworkInfo = (port, protocol) => {
        calls.push(['displayNetworkInfo', port === freePort ? '<port>' : port, protocol]);
    };
    // The requested port (4000) always reads as busy, so the servers take the
    // search path below whether or not 4000 happens to be free on this machine.
    PortManager.isPortAvailable = async (port) => port === freePort;
    PortManager.findAvailablePort = async (start, end, host) => {
        calls.push(['findAvailablePort', start, end - start, host]);
        return freePort;
    };
    return calls;
}

function httpsRequest(port, options = {}) {
    return new Promise((resolve, reject) => {
        const request = https.request({
            host: '127.0.0.1',
            port,
            path: '/health',
            method: 'GET',
            rejectUnauthorized: false,
            ...options,
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode,
                contentType: response.headers['content-type'],
                body: Buffer.concat(chunks).toString('utf8'),
                cipher: response.socket && response.socket.getCipher ? response.socket.getCipher() : null,
            }));
        });
        request.on('error', reject);
        request.end();
    });
}

function tlsHandshake(port, options) {
    return new Promise((resolve) => {
        const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, ...options }, () => {
            const cipher = socket.getCipher();
            const protocol = socket.getProtocol();
            socket.once('close', () => resolve({ ok: true, cipher: cipher.name, protocol }));
            socket.end();
        });
        socket.on('error', () => resolve({ ok: false }));
    });
}

function openSocket(url) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { rejectUnauthorized: false });
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for websocket open')), 2500);
        socket.once('open', () => {
            clearTimeout(timeout);
            resolve(socket);
        });
        socket.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
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

async function captureGuard(factory) {
    try {
        factory();
        return 'constructed';
    } catch (error) {
        return error.message;
    }
}

/**
 * Starts a server, exercises the TLS and delegation surface, then stops it
 * with a keep-alive socket and a live wss socket open. Returns the observable
 * record; the caller compares it with the pinned expectation.
 */
async function exerciseHttpsServer(server, port) {
    const record = {};
    const url = await server.start();
    record.startUrl = url.replace(String(port), '<port>');
    record.serverUrl = server.getServerUrl().replace(String(port), '<port>');
    record.isRunning = server.getIsRunning();
    record.secondStart = await server.start().then(() => 'resolved', (error) => error.message);

    const health = await httpsRequest(port);
    record.health = { status: health.status, contentType: health.contentType, body: JSON.parse(health.body).status };
    const notFound = await httpsRequest(port, { path: '/api/does-not-exist' });
    record.notFound = { status: notFound.status, message: JSON.parse(notFound.body).message };

    const tls12 = await tlsHandshake(port, { maxVersion: 'TLSv1.2' });
    record.tls12 = { ok: tls12.ok, protocol: tls12.protocol, cipherAllowed: ALLOWED_CIPHERS.includes(tls12.cipher) };
    record.tls12OutsideList = await tlsHandshake(port, { maxVersion: 'TLSv1.2', ciphers: 'ECDHE-RSA-CHACHA20-POLY1305' });
    record.tls13 = (await tlsHandshake(port, { minVersion: 'TLSv1.3' })).ok;

    // Upgrades reach the collaboration room and the broadcast server.
    const room = await openSocket(`wss://127.0.0.1:${port}/codexr-room`);
    const joined = nextMessage(room, 'room-joined');
    room.send(JSON.stringify({ type: 'room-join' }));
    record.roomJoined = (await joined).roomId;
    const broadcast = await openSocket(`wss://127.0.0.1:${port}/codexr-broadcast`);
    const registered = nextMessage(broadcast, 'registered');
    broadcast.send(JSON.stringify({ type: 'register', screenId: 'screen-1' }));
    record.broadcastRegistered = (await registered).screenId;
    broadcast.close();

    // The deadlock fix: dispose the runtime features BEFORE closing the server.
    const agent = new https.Agent({ keepAlive: true });
    await httpsRequest(port, { agent });
    const order = [];
    const handler = server.httpHandler;
    const originalDispose = handler.disposeRuntimeFeatures.bind(handler);
    handler.disposeRuntimeFeatures = () => {
        order.push('disposeRuntimeFeatures');
        originalDispose();
    };
    const nodeServer = server.server;
    const originalClose = nodeServer.close.bind(nodeServer);
    nodeServer.close = (callback) => {
        order.push('server.close');
        return originalClose(callback);
    };
    const roomClosed = new Promise((resolve) => room.once('close', (code) => resolve(code)));
    const sessionEnded = nextMessage(room, 'session-ended');
    const startedAt = Date.now();
    await server.stop();
    record.stopUnderTwoSeconds = Date.now() - startedAt < 2000;
    record.stopOrder = [...order];
    record.sessionEnded = (await sessionEnded).payload.reason;
    record.roomCloseCode = await roomClosed;
    agent.destroy();

    record.afterStop = { isRunning: server.getIsRunning(), serverUrl: server.getServerUrl() };
    await server.stop();
    server.forceStop();
    record.afterForceStop = server.getIsRunning();
    return record;
}

const EXPECTED_TLS_RECORD = {
    startUrl: 'https://localhost:<port>',
    serverUrl: 'https://127.0.0.1:<port>',
    isRunning: true,
    secondStart: 'SERVER: HTTPS server is already running',
    health: { status: 200, contentType: 'application/json', body: 'healthy' },
    notFound: { status: 404, message: 'API endpoint not found' },
    tls12: { ok: true, protocol: 'TLSv1.2', cipherAllowed: true },
    tls12OutsideList: { ok: false },
    tls13: true,
    roomJoined: 'codexr-session:default',
    broadcastRegistered: 'screen-1',
    stopUnderTwoSeconds: true,
    stopOrder: ['disposeRuntimeFeatures', 'server.close'],
    sessionEnded: 'host-closed',
    roomCloseCode: 4002,
    afterStop: { isRunning: false, serverUrl: null },
    afterForceStop: false,
};

let sharedStorage;

function sharedContext() {
    // One global-storage root for the whole file, so the generated pair is
    // minted once and reused (RSA key generation is the slow part).
    if (!sharedStorage) {
        sharedStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-server-lifecycle-'));
    }
    return fakeExtensionContext({ root: sharedStorage });
}

test.after(() => {
    if (sharedStorage) {
        fs.rmSync(sharedStorage, { recursive: true, force: true });
    }
});

test('HTTPS constructors keep their guard order and messages', async () => {
    const fake = createFakeVscode();
    await withFakeVscode(fake, async ({ requireOut }) => {
        const { HttpsCustomServer } = requireOut('core/server/httpsCustomServer.js');
        const { HttpsDefaultServer } = requireOut('core/server/httpsDefaultServer.js');
        const context = sharedContext();
        const consoleCapture = captureConsole();
        consoleCapture.observeLogger();
        try {
            const guards = {
                customNothing: await captureGuard(() => new HttpsCustomServer({ port: 1 })),
                customNoKey: await captureGuard(() => new HttpsCustomServer({ port: 1, certPath: 'c.pem', extensionContext: context })),
                customNoContext: await captureGuard(() => new HttpsCustomServer({ port: 1, certPath: 'c.pem', keyPath: 'k.pem' })),
                defaultNoContext: await captureGuard(() => new HttpsDefaultServer({ port: 1, certPath: 'c.pem', keyPath: 'k.pem' })),
            };
            assert.deepEqual(guards, {
                customNothing: 'SERVER: Certificate path and key path are required for custom HTTPS server',
                customNoKey: 'SERVER: Certificate path and key path are required for custom HTTPS server',
                customNoContext: 'SERVER: Extension context is required for HTTPS certificate fallback.',
                defaultNoContext: 'SERVER: Extension context is required for generated HTTPS certificates.',
            });
            // A rejected constructor logs nothing.
            assert.deepEqual(consoleCapture.lines, []);
        } finally {
            consoleCapture.restore();
        }
    });
});

test('HttpsDefaultServer: generated pair, TLS surface, VR toast and dispose-before-close stop', async () => {
    const fake = createFakeVscode();
    const port = await getFreePort();
    const context = sharedContext();
    const consoleCapture = captureConsole();
    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            consoleCapture.observeLogger();
            const calls = installNetworkStubs(requireOut, port);
            const { HttpsDefaultServer } = requireOut('core/server/httpsDefaultServer.js');
            const certDirectory = path.join(sharedStorage, 'global', 'server-certs');
            consoleCapture.setReplacements([[certDirectory, '<certs>'], [String(port), '<port>']]);

            const server = new HttpsDefaultServer({ port: 4000, host: '127.0.0.1', extensionContext: context });
            assert.equal(server.getServerUrl(), null);
            assert.equal(server.getIsRunning(), false);
            const record = await exerciseHttpsServer(server, port);
            assert.deepEqual(record, EXPECTED_TLS_RECORD);

            assert.deepEqual(calls, [
                ['findAvailablePort', 4000, 100, '127.0.0.1'],
                ['displayNetworkInfo', '<port>', 'https'],
            ]);
            const config = server.getConfig();
            assert.equal(config.port, port, 'the port search result is written back into the config');
            assert.equal(config.certPath, path.join(certDirectory, 'codexr-default-cert.pem'));
            assert.equal(config.keyPath, path.join(certDirectory, 'codexr-default-key.pem'));
            assert.equal(config.host, '127.0.0.1');
            assert.equal(config.enableCors, true);
            assert.deepEqual(config.allowedOrigins, ['*']);
            assert.equal(path.basename(config.staticRoot), 'templates');

            assert.deepEqual(fake.messages, [{
                kind: 'info',
                message: 'HTTPS server ready. VR/Mobile: https://192.0.2.10:<port>'.replace('<port>', String(port)),
                items: ['Copy VR URL', 'Copy Local URL', 'Show Instructions'],
            }]);
        });
    } finally {
        consoleCapture.restore();
    }

    assert.deepEqual(consoleCapture.lines, [
        'log: SERVER: HTTP server initialized with config:',
        'log: SERVER: HTTPS server (generated local certificates) initialized with config:',
        'log: SERVER: Validating generated local certificates...',
        'log: SERVER: Certificate path:',
        'log: SERVER: Key path:',
        'log: SERVER: Looking for available port starting from 4000 on host 127.0.0.1...',
        'log: SERVER: Port 4000 was busy, using <port> instead on host 127.0.0.1',
        'log: SERVER: SSL certificates loaded successfully',
        'log: SERVER: About to call server.listen with 127.0.0.1:<port>',
        'log: SERVER: HTTPS server successfully listening.',
        'log: SERVER: Address object:',
        'log: SERVER: Config host: "127.0.0.1"',
        'log: SERVER: Config port: <port>',
        `log: SERVER: Generated local certificates loaded from <certs>${path.sep}codexr-default-cert.pem`,
        'log: SERVER: NOTE: Using self-signed certificate - browsers may show security warnings',
        'log: SERVER: VR certificate instructions:',
        'log: SERVER: =====================================',
        'log: SERVER: VR/Mobile URL: https://192.0.2.10:<port>',
        'log: SERVER: Local URL: https://localhost:<port>',
        'log: SERVER: 1. Navigate to the VR/Mobile URL from your device',
        'log: SERVER: 2. Accept certificate warning in browser',
        'log: SERVER: 3. Then use VR headset to access the same URL',
        'log: SERVER: =====================================',
        'log: SERVER: Listen callback executed successfully',
        'log: SERVER: GET /health - Processing request',
        'log: SERVER: GET /health - Completed in <n>ms',
        'log: SERVER: GET /api/does-not-exist - Processing request',
        'log: SERVER: GET /api/does-not-exist - Completed in <n>ms',
        'warn: SERVER: TLS client error (non-critical):',
        'log: SERVER: GET /health - Processing request',
        'log: SERVER: GET /health - Completed in <n>ms',
        'log: SERVER: HTTPS server closed',
        'log: SERVER: HTTPS server stopped successfully',
        'log: SERVER: HTTPS server is not running',
    ]);
});

test('HttpsCustomServer: valid pair, redacted config, no toast; invalid pair falls back with one warning', async () => {
    const fake = createFakeVscode();
    const port = await getFreePort();
    const context = sharedContext();
    const consoleCapture = captureConsole();
    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            consoleCapture.observeLogger();
            const calls = installNetworkStubs(requireOut, port);
            const { HttpsCustomServer } = requireOut('core/server/httpsCustomServer.js');
            const { GeneratedHttpsCertificateManager } = requireOut('core/server/generatedHttpsCertificateManager.js');
            const generated = await new GeneratedHttpsCertificateManager(context).ensureDefaultCertificatePair();

            // A valid custom pair: copied out of the generated store.
            const customDirectory = fs.mkdtempSync(path.join(sharedStorage, 'custom-'));
            const certPath = path.join(customDirectory, 'cert.pem');
            const keyPath = path.join(customDirectory, 'key.pem');
            fs.copyFileSync(generated.certPath, certPath);
            fs.copyFileSync(generated.keyPath, keyPath);
            consoleCapture.setReplacements([[String(port), '<port>']]);

            const server = new HttpsCustomServer({ port: 4000, host: '127.0.0.1', certPath, keyPath, extensionContext: context });
            const record = await exerciseHttpsServer(server, port);
            assert.deepEqual(record, EXPECTED_TLS_RECORD);
            assert.deepEqual(calls, [
                ['findAvailablePort', 4000, 100, '127.0.0.1'],
                ['displayNetworkInfo', '<port>', 'https'],
            ]);
            const config = server.getConfig();
            assert.equal(config.certPath, '***REDACTED***');
            assert.equal(config.keyPath, '***REDACTED***');
            assert.equal(config.port, port);
            assert.deepEqual(fake.messages, [], 'a valid custom pair shows no toast');

            // A broken pair: the generated one is used instead, with one warning.
            calls.length = 0;
            fs.writeFileSync(certPath, 'not a certificate', 'utf8');
            const fallback = new HttpsCustomServer({ port: 4000, host: '127.0.0.1', certPath, keyPath, extensionContext: context });
            await fallback.start();
            assert.equal((await httpsRequest(port)).status, 200);
            await fallback.stop();
            assert.deepEqual(fake.messages, [{
                kind: 'warning',
                message: 'HTTPS server started with generated local certificates because the custom certificate pair was missing or invalid.',
                items: ['Configure Certificates'],
            }]);
            // getConfig stays redacted even after the fallback swapped the paths in.
            assert.equal(fallback.getConfig().certPath, '***REDACTED***');

            // A missing pair falls back too.
            const missing = new HttpsCustomServer({
                port: 4000,
                host: '127.0.0.1',
                certPath: path.join(customDirectory, 'absent-cert.pem'),
                keyPath: path.join(customDirectory, 'absent-key.pem'),
                extensionContext: context,
            });
            consoleCapture.setReplacements([[String(port), '<port>'], [customDirectory, '<custom>']]);
            await missing.start();
            const missingListener = missing.server;
            missing.forceStop();
            // forceStop now closes the listener itself and drops the reference.
            assert.equal(missing.server, null);
            assert.equal(missing.getListeningPort(), null);
            // 'close' is emitted asynchronously, so listening for it after
            // forceStop() still observes the port being released.
            await new Promise((resolve) => missingListener.once('close', resolve));
            assert.equal(missingListener.listening, false);
            assert.equal(fake.messages.length, 2);
        });
    } finally {
        consoleCapture.restore();
    }

    const sep = path.sep;
    assert.deepEqual(consoleCapture.lines, [
        'log: SERVER: HTTP server initialized with config:',
        'log: SERVER: HTTPS server (custom certificates) initialized with config:',
        'log: SERVER: Looking for available port starting from 4000 on host 127.0.0.1...',
        'log: SERVER: Port 4000 was busy, using <port> instead on host 127.0.0.1',
        'log: SERVER: Custom SSL certificates loaded successfully',
        'log: SERVER: HTTPS server listening on port <port>',
        'log: SERVER: Using custom certificates',
        'log: SERVER: Primary external URL: https://192.0.2.10:<port>',
        'log: SERVER: GET /health - Processing request',
        'log: SERVER: GET /health - Completed in <n>ms',
        'log: SERVER: GET /api/does-not-exist - Processing request',
        'log: SERVER: GET /api/does-not-exist - Completed in <n>ms',
        'warn: SERVER: TLS client error (non-critical):',
        'log: SERVER: GET /health - Processing request',
        'log: SERVER: GET /health - Completed in <n>ms',
        'log: SERVER: HTTPS server closed',
        'log: SERVER: HTTPS server stopped successfully',
        'log: SERVER: HTTPS server is not running',
        'log: SERVER: HTTP server initialized with config:',
        'log: SERVER: HTTPS server (custom certificates) initialized with config:',
        'warn: SERVER: Custom certificate pair failed validation and will use generated fallback:',
        'warn: SERVER: Falling back to generated local certificates because the custom pair is missing or invalid',
        'log: SERVER: Looking for available port starting from 4000 on host 127.0.0.1...',
        'log: SERVER: Port 4000 was busy, using <port> instead on host 127.0.0.1',
        'log: SERVER: Custom SSL certificates loaded successfully',
        'log: SERVER: HTTPS server listening on port <port>',
        'warn: SERVER: Using generated local certificates instead of custom certificates',
        'log: SERVER: Primary external URL: https://192.0.2.10:<port>',
        'log: SERVER: GET /health - Processing request',
        'log: SERVER: GET /health - Completed in <n>ms',
        'log: SERVER: HTTPS server closed',
        'log: SERVER: HTTPS server stopped successfully',
        'log: SERVER: HTTP server initialized with config:',
        'log: SERVER: HTTPS server (custom certificates) initialized with config:',
        `warn: SERVER: Custom certificate file not found: <custom>${sep}absent-cert.pem`,
        `warn: SERVER: Custom key file not found: <custom>${sep}absent-key.pem`,
        'warn: SERVER: Falling back to generated local certificates because the custom pair is missing or invalid',
        'log: SERVER: Looking for available port starting from 4000 on host 127.0.0.1...',
        'log: SERVER: Port 4000 was busy, using <port> instead on host 127.0.0.1',
        'log: SERVER: Custom SSL certificates loaded successfully',
        'log: SERVER: HTTPS server listening on port <port>',
        'warn: SERVER: Using generated local certificates instead of custom certificates',
        'log: SERVER: Primary external URL: https://192.0.2.10:<port>',
        'log: SERVER: HTTPS server closed',
    ]);
});

test('HttpServer: start, second start, health, stop order and idempotent stop', async () => {
    const fake = createFakeVscode();
    const port = await getFreePort();
    const consoleCapture = captureConsole();
    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            consoleCapture.observeLogger();
            installNetworkStubs(requireOut, port);
            const { HttpServer } = requireOut('core/server/httpServer.js');
            consoleCapture.setReplacements([[String(port), '<port>']]);
            const server = new HttpServer({ port, host: '127.0.0.1', staticRoot: templatesRoot() });
            assert.equal(await server.start(), `http://localhost:${port}`);
            assert.equal(server.getServerUrl(), `http://127.0.0.1:${port}`);
            // The launcher reports this port, so it must be the one actually bound.
            assert.equal(server.getListeningPort(), port);
            await assert.rejects(server.start(), { message: 'SERVER: HTTP server is already running' });

            const status = await new Promise((resolve, reject) => {
                http.get({ host: '127.0.0.1', port, path: '/health' }, (response) => {
                    response.resume();
                    response.on('end', () => resolve(response.statusCode));
                }).on('error', reject);
            });
            assert.equal(status, 200);

            const room = await openSocket(`ws://127.0.0.1:${port}/codexr-room`);
            const roomClosed = new Promise((resolve) => room.once('close', (code) => resolve(code)));
            await server.stop();
            assert.equal(await roomClosed, 4002);
            assert.equal(server.getIsRunning(), false);
            assert.equal(server.getServerUrl(), null);
            assert.equal(server.getListeningPort(), null);
            await server.stop();
            server.forceStop();
        });
    } finally {
        consoleCapture.restore();
    }

    assert.deepEqual(consoleCapture.lines, [
        'log: SERVER: HTTP server initialized with config:',
        'log: SERVER: HTTP server listening on http://127.0.0.1:<port>',
        'log: SERVER: Server address info:',
        'log: SERVER: GET /health - Processing request',
        'log: SERVER: GET /health - Completed in <n>ms',
        'log: SERVER: HTTP server closed',
        'log: SERVER: HTTP server stopped successfully',
        'log: SERVER: HTTP server is not running',
    ]);
});

test('httpsTlsOptions: the shared TLS literal both HTTPS servers listen with', async () => {
    const fake = createFakeVscode();
    await withFakeVscode(fake, async ({ requireOut }) => {
        const { HTTPS_CIPHER_SUITES, buildTlsServerOptions, isCertificateRejectedByClient } = requireOut('core/server/httpsTlsOptions.js');
        assert.deepEqual([...HTTPS_CIPHER_SUITES], ALLOWED_CIPHERS);
        const { SNICallback, ...literal } = buildTlsServerOptions('CERT', 'KEY');
        assert.deepEqual(literal, {
            cert: 'CERT',
            key: 'KEY',
            rejectUnauthorized: false,
            requestCert: false,
            secureProtocol: 'TLS_method',
            honorCipherOrder: false,
            ciphers: ALLOWED_CIPHERS.join(':'),
            secureOptions: 0,
        });
        const answers = [];
        SNICallback('host', (...args) => answers.push(args));
        assert.deepEqual(answers, [[null]]);
        assert.equal(isCertificateRejectedByClient(new Error('x SSLV3_ALERT_CERTIFICATE_UNKNOWN y')), true);
        assert.equal(isCertificateRejectedByClient(new Error('certificate unknown')), true);
        assert.equal(isCertificateRejectedByClient(new Error('SSL alert number 46')), true);
        assert.equal(isCertificateRejectedByClient(new Error('certificate expired')), false);
    });
});

test('PortManager: a port held on loopback only is reported busy', async () => {
    const fake = createFakeVscode();
    await withFakeVscode(fake, async ({ requireOut }) => {
        const { PortManager } = requireOut('core/server/portManager.js');
        const holder = net.createServer();
        await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
        const heldPort = holder.address().port;
        try {
            // A probe of the wildcard alone can succeed here on macOS and
            // Windows, which then hand the browser's localhost to the other
            // listener; the host-less check must look at loopback too.
            assert.equal(await PortManager.isPortFreeEverywhere(heldPort), false);
            assert.equal(await PortManager.isPortAvailable(heldPort), false);
        } finally {
            await new Promise((resolve) => holder.close(resolve));
        }
        assert.equal(await PortManager.isPortFreeEverywhere(heldPort), true);
    });
});
