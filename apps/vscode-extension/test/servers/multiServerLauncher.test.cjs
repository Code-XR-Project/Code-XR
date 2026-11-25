'use strict';

/**
 * Characterization of MultiServerLauncher.launchServer, through compiled out/
 * code, before the launcher is split (factory, notifications, conflict
 * dialog).
 *
 * Every scenario runs the real launcher, the real server registrar and the
 * real active-server registry, with these seams replaced:
 * - the three server classes, by recorders (constructor config, start());
 * - ServerSettingsManager.getInstance, by the scenario's settings;
 * - PortManager's probe and search, NetworkUtils.getLocalIPAddress;
 * - PreviewRenderer.openPreview, the last step of "open in browser/panel".
 *
 * Each scenario yields one transcript: the normalized console lines of the
 * server modules, the toasts and the answers given to them, executed
 * commands, the clipboard, the servers constructed and started, the port
 * calls, the previews opened, the launch result and the running count. The
 * transcripts are compared, whole, with the golden file written on the
 * unsplit source (CODEXR_UPDATE_GOLDEN=1 rewrites it).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeVscode, withFakeVscode } = require('../helpers/fakeVscode.cjs');
const { observeLogsAsConsole } = require('../helpers/logCapture.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const goldenPath = path.join(__dirname, 'fixtures', 'multiServerLauncher.transcripts.json');
// A path that never has to exist: nothing reads the scene, the launcher only
// splits it into a static root and a main file.
const fixtureRoot = path.resolve(path.sep, 'codexr-launcher-fixture');
const htmlFile = path.join(fixtureRoot, 'scene', 'index.html');
const REQUESTED_PORT = 3000;

function normalizeString(value) {
    return value
        .split(projectRoot).join('<project>')
        .split(fixtureRoot).join('<fixture>')
        .replace(/\\/g, '/')
        .replace(/server_\d+_[a-z0-9]+/g, 'server_<time>_<random>')
        .replace(/server-(\d+)-\d+/g, 'server-$1-<time>');
}

function normalize(value, context) {
    if (value === context) {
        return '<extensionContext>';
    }
    if (value === undefined) {
        // Kept visible: the golden file is JSON, which drops undefined keys.
        return '<undefined>';
    }
    if (typeof value === 'string') {
        return normalizeString(value);
    }
    if (typeof value === 'function') {
        return '<function>';
    }
    if (value instanceof Error) {
        return `<${value.name}: ${normalizeString(value.message)}>`;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => normalize(entry, context));
    }
    if (value && typeof value === 'object') {
        if (value.isFakeServer === true) {
            return `<${value.kind} server>`;
        }
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            out[key] = key === 'timestamp' ? '<time>' : normalize(entry, context);
        }
        return out;
    }
    return value;
}

function baseSettings(overrides = {}) {
    return {
        mode: 'HTTP',
        https: { certSource: 'default', certPath: '', keyPath: '' },
        defaultPort: REQUESTED_PORT,
        launch: { autoOpen: true, openMode: 'browser' },
        ...overrides,
    };
}

const customCertSettings = {
    certSource: 'custom',
    certPath: path.join(fixtureRoot, 'certs', 'cert.pem'),
    keyPath: path.join(fixtureRoot, 'certs', 'key.pem'),
};

/**
 * Scenario fields: settings, answers (toast answers, FIFO), portFree,
 * portSearch ('ok' | 'fail'), startFails, registrarFails, previewFails,
 * registryLookupFailsOnce, localIp, launches ([htmlFile, customName, metadata]).
 */
const SCENARIOS = {
    'http, browser, auto-open, scene file and metadata': {
        settings: baseSettings(),
        launches: [[htmlFile, 'My scene', { sessionId: 'analysis-1', analysisType: 'xr' }]],
    },
    'http, no scene file: the templates root, no main file': {
        settings: baseSettings(),
        launches: [[undefined, undefined, undefined]],
    },
    'http, lateral panel, auto-open': {
        settings: baseSettings({ launch: { autoOpen: true, openMode: 'lateralPanel' } }),
        launches: [[htmlFile, undefined, { sessionId: 42 }]],
    },
    'https-default, browser, busy port moves to the next free one': {
        settings: baseSettings({ mode: 'HTTPS' }),
        portFree: false,
        launches: [[htmlFile, 'Secure', undefined]],
    },
    'https-custom, browser: certificate paths reach the server, redacted in the log': {
        settings: baseSettings({ mode: 'HTTPS', https: customCertSettings }),
        launches: [[htmlFile, undefined, { sessionId: 'analysis-2' }]],
    },
    'https-custom without certificate paths fails before any server starts': {
        settings: baseSettings({ mode: 'HTTPS', https: { certSource: 'custom', certPath: '', keyPath: '' } }),
        launches: [[htmlFile, undefined, undefined]],
    },
    'https + lateral panel: HTTP override, the dialog answered "Change to Browser Mode"': {
        settings: baseSettings({ mode: 'HTTPS', launch: { autoOpen: true, openMode: 'lateralPanel' } }),
        answers: ['Change to Browser Mode'],
        launches: [[htmlFile, undefined, undefined]],
    },
    'https-custom + lateral panel: HTTP override, the dialog dismissed': {
        settings: baseSettings({ mode: 'HTTPS', https: customCertSettings, launch: { autoOpen: true, openMode: 'lateralPanel' } }),
        launches: [[htmlFile, undefined, undefined]],
    },
    'no auto-open on a LAN address, answered "Copy Network URL"': {
        settings: baseSettings({ launch: { autoOpen: false, openMode: 'browser' } }),
        answers: ['Copy Network URL'],
        launches: [[htmlFile, undefined, undefined]],
    },
    'no auto-open, answered "Open Now" in browser mode': {
        settings: baseSettings({ launch: { autoOpen: false, openMode: 'browser' } }),
        answers: ['Open Now'],
        launches: [[htmlFile, undefined, undefined]],
    },
    'no auto-open, answered "Open Now" in panel mode': {
        settings: baseSettings({ launch: { autoOpen: false, openMode: 'lateralPanel' } }),
        answers: ['Open Now'],
        launches: [[htmlFile, undefined, undefined]],
    },
    'no auto-open without a LAN address: plain toast, "Copy Network URL" copies nothing': {
        settings: baseSettings({ mode: 'HTTPS', launch: { autoOpen: false, openMode: 'browser' } }),
        localIp: 'localhost',
        answers: ['Copy Network URL'],
        launches: [[htmlFile, undefined, undefined]],
    },
    'auto-open fails in the registry lookup, answered "Open Manually"': {
        settings: baseSettings(),
        registryLookupFailsOnce: true,
        answers: ['Open Manually'],
        launches: [[htmlFile, undefined, undefined]],
    },
    'auto-open: the preview itself fails': {
        settings: baseSettings(),
        previewFails: true,
        launches: [[htmlFile, undefined, undefined]],
    },
    'server start rejects': {
        settings: baseSettings(),
        startFails: true,
        launches: [[htmlFile, undefined, undefined]],
    },
    'no free port anywhere': {
        settings: baseSettings(),
        portFree: false,
        portSearch: 'fail',
        launches: [[htmlFile, undefined, undefined]],
    },
    'registration fails: the server is stopped and the launch fails': {
        settings: baseSettings(),
        registrarFails: true,
        launches: [[htmlFile, undefined, undefined]],
    },
    'invalid mode': {
        settings: baseSettings({ mode: 'FTP' }),
        launches: [[htmlFile, undefined, undefined]],
    },
    'two launches on one launcher': {
        settings: baseSettings(),
        launches: [[htmlFile, 'first', undefined], [htmlFile, 'second', undefined]],
    },
};

function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

async function runScenario(scenario) {
    const fake = createFakeVscode();
    for (const answer of scenario.answers || []) {
        fake.queueAnswer(answer);
    }
    const context = { name: 'fake extension context', extensionPath: projectRoot };
    const transcript = {
        console: [],
        constructed: [],
        started: [],
        portCalls: [],
        previews: [],
        results: [],
    };

    // Console lines, and logger calls rendered in the same console shape
    // (helpers/logCapture.cjs), so the golden outlives the logging migration.
    const record = (level, first, rest) => {
        if (typeof first === 'string' && /^(SERVER|ACTIVE_SERVER)/.test(first)) {
            const extra = rest.length > 0 ? ` ${JSON.stringify(normalize(rest, context))}` : '';
            transcript.console.push(`${level}: ${normalizeString(first)}${extra}`);
        }
    };
    const original = { log: console.log, warn: console.warn, error: console.error };
    for (const level of Object.keys(original)) {
        console[level] = (first, ...rest) => record(level, first, rest);
    }

    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            // Load the launcher (and with it the whole module graph) once,
            // then patch the modules it holds: a second requireOut of a
            // dependency would build a fresh copy nobody else references.
            const { MultiServerLauncher } = requireOut('core/server/multiServerLauncher.js');
            const loaded = (relativePath) => require(path.join(projectRoot, 'out', ...relativePath.split('/')));
            observeLogsAsConsole(loaded('platform/logging/sink.js'), record);
            const makeFakeServer = (kind) => class {
                constructor(config) {
                    this.isFakeServer = true;
                    this.kind = kind;
                    this.config = config;
                    transcript.constructed.push({ kind, config: normalize(config, context) });
                }

                async start() {
                    transcript.started.push(this.kind);
                    if (scenario.startFails) {
                        throw new Error('EADDRINUSE: address already in use');
                    }
                    const scheme = this.kind === 'http' ? 'http' : 'https';
                    return `${scheme}://localhost:${this.config.port}`;
                }

                createAuthenticatedBrowserUrl(url) {
                    return `${url}/?codexr_token=fixture`;
                }
            };
            loaded('core/server/httpServer.js').HttpServer = makeFakeServer('http');
            loaded('core/server/httpsDefaultServer.js').HttpsDefaultServer = makeFakeServer('https-default');
            loaded('core/server/httpsCustomServer.js').HttpsCustomServer = makeFakeServer('https-custom');

            const { ServerSettingsManager } = loaded('core/server/serverSettingsManager.js');
            ServerSettingsManager.getInstance = (ctx) => {
                assert.equal(ctx, context);
                return {
                    ensureInitialized: async () => undefined,
                    getServerSettings: () => scenario.settings,
                };
            };

            const { PortManager } = loaded('core/server/portManager.js');
            PortManager.isPortAvailable = async (...args) => {
                transcript.portCalls.push(['isPortAvailable', ...args]);
                return scenario.portFree !== false;
            };
            PortManager.findAvailablePort = async (...args) => {
                transcript.portCalls.push(['findAvailablePort', ...args]);
                if (scenario.portSearch === 'fail') {
                    throw new Error('No available ports found in range');
                }
                return args[0];
            };

            const { NetworkUtils } = loaded('core/server/networkUtils.js');
            NetworkUtils.getLocalIPAddress = () => scenario.localIp || '192.0.2.10';

            const { PreviewRenderer } = loaded('features/active-servers/services/previewRenderer.js');
            PreviewRenderer.openPreview = async (...args) => {
                transcript.previews.push(normalize(args, context));
                if (scenario.previewFails) {
                    throw new Error('no browser available');
                }
            };

            if (scenario.registrarFails) {
                const { ServerRegistrar } = loaded('core/server/registry/serverRegistrar.js');
                ServerRegistrar.prototype.registerServer = () => {
                    throw new Error('registry unavailable');
                };
            }
            if (scenario.registryLookupFailsOnce) {
                const { ActiveServerRegistry } = loaded('core/server/registry/activeServerRegistry.js');
                const realGetServer = ActiveServerRegistry.prototype.getServer;
                let failed = false;
                ActiveServerRegistry.prototype.getServer = function getServer(...args) {
                    if (!failed) {
                        failed = true;
                        throw new Error('registry lookup failed');
                    }
                    return realGetServer.apply(this, args);
                };
            }

            const launcher = new MultiServerLauncher(context);
            for (const [file, customName, metadata] of scenario.launches) {
                const result = await launcher.launchServer(file, customName, metadata);
                // The toasts' .then() handlers run after the launch resolves.
                for (let i = 0; i < 5; i += 1) {
                    await flush();
                }
                transcript.results.push(normalize(result, context));
            }
            transcript.runningCount = launcher.getRunningServerCount();
        });
    } finally {
        Object.assign(console, original);
    }

    transcript.messages = normalize(fake.messages, context);
    transcript.executedCommands = normalize(fake.executedCommands, context);
    transcript.clipboard = fake.clipboard;
    return transcript;
}

const transcripts = {};

for (const [name, scenario] of Object.entries(SCENARIOS)) {
    test(`launcher: ${name}`, async () => {
        transcripts[name] = await runScenario(scenario);
    });
}

test('launcher transcripts match the golden file written on the unsplit launcher', () => {
    assert.equal(Object.keys(transcripts).length, Object.keys(SCENARIOS).length);
    if (process.env.CODEXR_UPDATE_GOLDEN === '1') {
        fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
        fs.writeFileSync(goldenPath, `${JSON.stringify(transcripts, null, 2)}\n`);
    }
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
    assert.deepEqual(transcripts, golden);
});

test('launcher: the key behaviours, stated outright', () => {
    const plain = transcripts['http, browser, auto-open, scene file and metadata'];
    assert.deepEqual(plain.constructed[0].config, {
        port: REQUESTED_PORT,
        host: '0.0.0.0',
        staticRoot: '<fixture>/scene',
        enableCors: true,
        allowedOrigins: ['*'],
        mainFile: 'index.html',
        extensionContext: '<extensionContext>',
        analysisSessionId: 'analysis-1',
    });
    assert.deepEqual(plain.previews, [[
        `http://localhost:${REQUESTED_PORT}/?codexr_token=fixture`, '<fixture>/scene/index.html', 'browser',
    ]]);

    // No scene file: the templates folder of the extension root (context.extensionPath).
    const templates = transcripts['http, no scene file: the templates root, no main file'];
    assert.equal(templates.constructed[0].config.staticRoot, '<project>/templates');
    assert.equal(templates.constructed[0].config.mainFile, '<undefined>');

    // HTTPS in the lateral panel is launched as HTTP, with a dialog.
    const override = transcripts['https + lateral panel: HTTP override, the dialog answered "Change to Browser Mode"'];
    assert.equal(override.constructed[0].kind, 'http');
    assert.equal(override.results[0].httpsOverridden, true);
    assert.deepEqual(override.executedCommands.map((entry) => entry.id), ['codexr.server.config.openMode']);

    const busy = transcripts['https-default, browser, busy port moves to the next free one'];
    assert.equal(busy.results[0].port, REQUESTED_PORT + 1);
    assert.equal(busy.messages[0].message, `Port ${REQUESTED_PORT} was busy, launching server on port ${REQUESTED_PORT + 1} instead.`);

    const copy = transcripts['no auto-open on a LAN address, answered "Copy Network URL"'];
    assert.equal(copy.clipboard, `http://192.0.2.10:${REQUESTED_PORT}`);

    const lost = transcripts['registration fails: the server is stopped and the launch fails'];
    // XR epic S4 (audit LAUNCHER-16): an unregistered server could never be
    // found or stopped again, so the launch now stops it and fails.
    assert.equal(lost.results[0].success, false);
    assert.match(lost.results[0].error, /^Failed to register the server: /);
    assert.equal(lost.runningCount, 0);
});
