'use strict';

/**
 * Characterization of ServerActionHandlers (handleServerActions.ts), through
 * compiled out/ code, before it is split (format module, then the registry
 * guard and the remote/participant actions).
 *
 * The real active-server registry holds the servers; these seams are
 * replaced: PreviewRenderer.openPreview, NetworkUtils.getLocalIPAddress,
 * ServerSettingsManager.getInstance (the cross-network setting),
 * RemoteAccessManager.getInstance, ServerControl.stopServer/stopAllServers,
 * and the window's toasts and quick picks (recorded WITH their modal detail,
 * which the shared fake drops). Date.now is pinned per scenario, so the
 * durations in the detail dialogs are stable; the participant's local clock
 * time is replaced by <clock>.
 *
 * Each scenario yields one normalized transcript, compared whole with the
 * golden file written on the unsplit source (CODEXR_UPDATE_GOLDEN=1 rewrites
 * it). It pins in particular: every unknown-id path, every clipboard string,
 * and stopAllServers (XR epic S4: it now returns { requested, stopped } and the
 * handler shows one summary; it used to treat the stopped-server COUNT
 * returned by ServerControl as a success flag, and refreshes the tree even
 * when that count is 0).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeVscode, withFakeVscode } = require('../helpers/fakeVscode.cjs');
const { observeLogsAsConsole } = require('../helpers/logCapture.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const goldenPath = path.join(__dirname, 'fixtures', 'serverActionHandlers.transcripts.json');
const fixtureRoot = path.resolve(path.sep, 'codexr-actions-fixture');
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const CONNECTED_AT = new Date(NOW - 125_000);

const PUBLIC_STATICS = [
    'showServerActions', 'openInBrowser', 'openInPanel', 'copyUrl', 'copyLanUrl',
    'startRemoteAccess', 'copyRemoteInvitation', 'stopRemoteAccess',
    'showParticipantDetails', 'removeParticipant', 'regeneratePairingCode',
    'showRemoteStatus', 'stopServer', 'showServerDetails', 'stopAllServers',
    'refreshServers',
];

function normalizeString(value) {
    return value
        .split(CONNECTED_AT.toLocaleTimeString()).join('<clock>')
        .split(projectRoot).join('<project>')
        .split(fixtureRoot).join('<fixture>')
        .replace(/\\/g, '/');
}

function normalize(value) {
    if (value === undefined) {
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
        return value.map(normalize);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            out[key] = normalize(entry);
        }
        return out;
    }
    return value;
}

/** A server runtime with collaboration participants and a pairing authority. */
function participantRuntime(log, options = {}) {
    const participants = [
        {
            peerId: 'peer-host', displayName: 'Ada (host)', role: 'host', avatarId: 'codexr-blue',
            clientKind: 'codexr', connectionScope: 'local', remoteAddress: '127.0.0.1',
            connectedAt: CONNECTED_AT.toISOString(),
        },
        {
            peerId: 'peer-remote', displayName: 'Grace', role: 'guest', avatarId: 'no-such-avatar',
            clientKind: 'browser', connectionScope: 'remote', remoteAddress: '203.0.113.7',
            connectedAt: CONNECTED_AT.toISOString(),
        },
        {
            peerId: 'peer-lan', displayName: 'Linus', role: 'guest', avatarId: 'codexr-blue',
            clientKind: 'browser', connectionScope: 'local', remoteAddress: '192.0.2.44',
            connectedAt: 'not a date',
        },
    ];
    const pending = options.pending || [];
    const runtime = {
        getConnectedParticipants: () => participants,
        createAuthenticatedBrowserUrl: (url) => `${url}/?codexr_token=fixture`,
        getRemoteSessionAuthority: () => ({
            listPendingPairingRequests: () => pending,
            regeneratePairingCode: (requestId) => {
                log.push(['regeneratePairingCode', requestId]);
                return { code: '123456', expiresAt: NOW + 60_000 };
            },
        }),
    };
    if (options.canRemove !== false) {
        runtime.removeParticipant = (peerId) => {
            log.push(['removeParticipant', peerId]);
            if (options.alreadyLeft) {
                return { removed: false, sessionRevoked: false };
            }
            return { removed: true, sessionRevoked: peerId === 'peer-remote' };
        };
    }
    return runtime;
}

const HTTP_SERVER = {
    port: 3000,
    url: 'http://localhost:3000',
    launchMode: 'browser',
    certMode: 'http',
    timestamp: NOW - 3_723_000,
    htmlFile: path.join(fixtureRoot, 'projects', 'demo', 'scene', 'index.html'),
    customName: 'Scene A',
    metadata: {
        serverType: 'http',
        staticRoot: path.join(fixtureRoot, 'projects', 'demo', 'scene'),
        description: 'Classic analysis of demo',
    },
};

const HTTPS_SERVER = {
    port: 3443,
    url: 'https://localhost:3443',
    launchMode: 'browser',
    certMode: 'https-default',
    timestamp: NOW - 42_000,
    customName: '   ',
};

const CUSTOM_CERT_SERVER = {
    port: 3444,
    url: 'https://localhost:3444',
    launchMode: 'lateralPanel',
    certMode: 'https-custom',
    timestamp: NOW - 5_000,
};

const SHARED_STATE = {
    status: 'shared',
    publicUrl: 'https://example.trycloudflare.com',
    invitationUrl: 'https://example.trycloudflare.com/invite#t',
    pendingRequests: 2,
};

const pick = (label) => (items) => items.find((item) => item.label === label);

/**
 * Scenario fields: servers ([{ ...config, remoteAccess?, runtime? }]),
 * remoteEnabled, remoteManager (true | 'missing'), localIp, previewFails,
 * control ({ stopServer, stopAllServers } results or 'throw'), answers (FIFO;
 * a function picks from the items), run(H, ids).
 */
const SCENARIOS = {
    'unknown server id, every public action': {
        remoteManager: 'missing',
        run: async (H) => {
            for (const name of PUBLIC_STATICS) {
                if (name === 'stopAllServers' || name === 'refreshServers') {
                    continue;
                }
                const args = name === 'showParticipantDetails' || name === 'removeParticipant'
                    ? ['missing-id', 'peer-x']
                    : ['missing-id'];
                await H.call(name, ...args);
            }
        },
    },
    'quick pick on an HTTP server, remote setting off: Server Info': {
        servers: [HTTP_SERVER],
        answers: [pick('Server Info')],
        run: async (H, ids) => H.call('showServerActions', ids[0]),
    },
    'quick pick on an HTTP server: Copy URL then Network URL': {
        servers: [HTTP_SERVER],
        answers: [pick('Copy URL'), pick('Network URL')],
        run: async (H, ids) => H.call('showServerActions', ids[0]),
    },
    'quick pick on an HTTP server: Open in Panel': {
        servers: [HTTP_SERVER],
        answers: [pick('Open in Panel')],
        run: async (H, ids) => H.call('showServerActions', ids[0]),
    },
    'quick pick dismissed': {
        servers: [HTTP_SERVER],
        run: async (H, ids) => H.call('showServerActions', ids[0]),
    },
    'quick pick on a shared HTTPS server: Remote status': {
        servers: [{ ...HTTPS_SERVER, remoteAccess: SHARED_STATE }],
        answers: [pick('Remote status')],
        run: async (H, ids) => H.call('showServerActions', ids[0]),
    },
    'quick pick on a shared HTTPS server: Copy remote invitation, then Stop remote connection': {
        servers: [{ ...HTTPS_SERVER, remoteAccess: SHARED_STATE }],
        answers: [pick('Copy remote invitation'), pick('Stop remote connection')],
        run: async (H, ids) => {
            await H.call('showServerActions', ids[0]);
            await H.call('showServerActions', ids[0]);
        },
    },
    'quick pick on a tunnel in error: View remote error': {
        servers: [{ ...HTTP_SERVER, remoteAccess: { status: 'error', error: 'cloudflared exited', pendingRequests: 0 } }],
        answers: [pick('View remote error')],
        run: async (H, ids) => H.call('showServerActions', ids[0]),
    },
    'quick pick with the remote setting on: Start remote connection': {
        servers: [HTTP_SERVER],
        remoteEnabled: true,
        answers: [pick('Start remote connection')],
        run: async (H, ids) => H.call('showServerActions', ids[0]),
    },
    'quick pick on a starting tunnel lists the shared entries': {
        servers: [{ ...CUSTOM_CERT_SERVER, remoteAccess: { status: 'starting', pendingRequests: 0 } }],
        answers: [pick('Server Info')],
        run: async (H, ids) => H.call('showServerActions', ids[0]),
    },
    'open in browser and in the panel, HTTP': {
        servers: [{ ...HTTP_SERVER, runtime: 'participants' }],
        run: async (H, ids) => {
            await H.call('openInBrowser', ids[0]);
            await H.call('openInPanel', ids[0]);
        },
    },
    'open an HTTPS server in the panel: redirected, then cancelled': {
        servers: [HTTPS_SERVER],
        answers: ['Open in Browser Instead', undefined],
        run: async (H, ids) => {
            await H.call('openInPanel', ids[0]);
            await H.call('openInPanel', ids[0]);
        },
    },
    'the preview fails in both modes': {
        servers: [HTTP_SERVER],
        previewFails: true,
        run: async (H, ids) => {
            await H.call('openInBrowser', ids[0]);
            await H.call('openInPanel', ids[0]);
        },
    },
    'copy URL: Local, cancelled, and on localhost': {
        servers: [HTTPS_SERVER],
        answers: [pick('Local URL'), undefined],
        run: async (H, ids) => {
            await H.call('copyUrl', ids[0]);
            await H.call('copyUrl', ids[0]);
            H.setLocalIp('localhost');
            await H.call('copyUrl', ids[0]);
        },
    },
    'copy the LAN URL': {
        servers: [HTTP_SERVER, HTTPS_SERVER],
        run: async (H, ids) => {
            await H.call('copyLanUrl', ids[0]);
            await H.call('copyLanUrl', ids[1]);
        },
    },
    'remote access through the manager': {
        servers: [HTTP_SERVER],
        run: async (H, ids) => {
            await H.call('startRemoteAccess', ids[0]);
            await H.call('copyRemoteInvitation', ids[0]);
            await H.call('stopRemoteAccess', ids[0]);
        },
    },
    'remote access started but not shared: no clipboard': {
        servers: [HTTP_SERVER],
        remoteStartState: { status: 'starting', pendingRequests: 0 },
        run: async (H, ids) => H.call('startRemoteAccess', ids[0]),
    },
    'participant details: a remote guest removed, the session revoked': {
        servers: [{ ...HTTP_SERVER, runtime: 'participants' }],
        answers: ['Remove from Session', 'Remove'],
        run: async (H, ids) => H.call('showParticipantDetails', ids[0], 'peer-remote'),
    },
    'participant details: the host (Close only) and a LAN guest with an invalid date': {
        servers: [{ ...HTTP_SERVER, runtime: 'participants' }],
        run: async (H, ids) => {
            await H.call('showParticipantDetails', ids[0], 'peer-host');
            await H.call('showParticipantDetails', ids[0], 'peer-lan');
            await H.call('showParticipantDetails', ids[0], 'peer-gone');
        },
    },
    'remove participant: host refused, LAN guest declined then removed, unknown peer': {
        servers: [{ ...HTTP_SERVER, runtime: 'participants' }],
        answers: [undefined, 'Remove'],
        run: async (H, ids) => {
            await H.call('removeParticipant', ids[0], 'peer-host');
            await H.call('removeParticipant', ids[0], 'peer-lan');
            await H.call('removeParticipant', ids[0], 'peer-lan');
            await H.call('removeParticipant', ids[0], 'peer-gone');
        },
    },
    'remove participant: runtime cannot remove, guest already left': {
        servers: [
            { ...HTTP_SERVER, runtime: 'participants-no-remove' },
            { ...HTTPS_SERVER, runtime: 'participants-already-left' },
        ],
        answers: ['Remove', 'Remove'],
        run: async (H, ids) => {
            await H.call('removeParticipant', ids[0], 'peer-remote');
            await H.call('removeParticipant', ids[1], 'peer-remote');
        },
    },
    'regenerate pairing code: no authority, nobody waiting, one waiting': {
        servers: [HTTP_SERVER, { ...HTTPS_SERVER, runtime: 'participants' }, { ...CUSTOM_CERT_SERVER, runtime: 'one-pending' }],
        run: async (H, ids) => {
            await H.call('regeneratePairingCode', ids[0]);
            await H.call('regeneratePairingCode', ids[1]);
            await H.call('regeneratePairingCode', ids[2]);
        },
    },
    'regenerate pairing code: two waiting, the second picked, then dismissed': {
        servers: [{ ...HTTP_SERVER, runtime: 'two-pending' }],
        answers: [pick('Bob'), undefined],
        run: async (H, ids) => {
            await H.call('regeneratePairingCode', ids[0]);
            await H.call('regeneratePairingCode', ids[0]);
        },
    },
    'remote status: not shared, shared, error, starting': {
        servers: [
            HTTP_SERVER,
            { ...HTTPS_SERVER, remoteAccess: SHARED_STATE },
            { ...CUSTOM_CERT_SERVER, remoteAccess: { status: 'error', pendingRequests: 0 } },
            { ...HTTP_SERVER, port: 3001, url: 'http://localhost:3001', remoteAccess: { status: 'shared', pendingRequests: 1 } },
        ],
        run: async (H, ids) => {
            for (const id of ids) {
                await H.call('showRemoteStatus', id);
            }
        },
    },
    'server details: full, minimal, shared with one request': {
        servers: [
            HTTP_SERVER,
            CUSTOM_CERT_SERVER,
            { ...HTTPS_SERVER, metadata: { staticRoot: 'short/root' }, remoteAccess: { ...SHARED_STATE, pendingRequests: 1 } },
        ],
        run: async (H, ids) => {
            for (const id of ids) {
                await H.call('showServerDetails', id);
            }
        },
    },
    'stop server: stopped, refused by control, control throws, cancelled': {
        servers: [HTTP_SERVER],
        control: { stopServer: [true, false, 'throw'] },
        answers: ['Stop', 'Stop', 'Stop', 'Cancel'],
        run: async (H, ids) => {
            for (let i = 0; i < 4; i += 1) {
                await H.call('stopServer', ids[0]);
            }
        },
    },
    'stop all: none running': {
        run: async (H) => H.call('stopAllServers'),
    },
    'stop all: one summary from the returned counts': {
        servers: [HTTP_SERVER, HTTPS_SERVER],
        control: { stopAllServers: [{ requested: 2, stopped: 2 }, { requested: 2, stopped: 1 }, 'throw'] },
        answers: ['Stop All', 'Stop All', 'Stop All', 'Cancel'],
        run: async (H) => {
            for (let i = 0; i < 4; i += 1) {
                await H.call('stopAllServers');
            }
        },
    },
    'stop all without a remote manager': {
        servers: [HTTP_SERVER],
        remoteManager: 'missing',
        control: { stopAllServers: [{ requested: 1, stopped: 1 }] },
        answers: ['Stop All'],
        run: async (H) => H.call('stopAllServers'),
    },
    'refresh': {
        run: async (H) => H.call('refreshServers'),
    },
};

function buildRuntime(kind, log) {
    switch (kind) {
        case 'participants':
            return participantRuntime(log);
        case 'participants-no-remove':
            return participantRuntime(log, { canRemove: false });
        case 'participants-already-left':
            return participantRuntime(log, { alreadyLeft: true });
        case 'one-pending':
            return participantRuntime(log, {
                pending: [{ requestId: 'req-1', displayName: 'Alice', remoteAddress: '203.0.113.9', codeValid: true }],
            });
        case 'two-pending':
            return participantRuntime(log, {
                pending: [
                    { requestId: 'req-1', displayName: 'Alice', remoteAddress: '203.0.113.9', codeValid: true },
                    { requestId: 'req-2', displayName: 'Bob', remoteAddress: '203.0.113.10', codeValid: false },
                ],
            });
        default:
            return undefined;
    }
}

async function runScenario(scenario) {
    const answers = [...(scenario.answers || [])];
    const transcript = { console: [], ui: [], calls: [] };
    const nextAnswer = (items) => {
        const answer = answers.length > 0 ? answers.shift() : undefined;
        return Promise.resolve(typeof answer === 'function' ? answer(items) : answer);
    };
    const showMessage = (kind) => (message, ...rest) => {
        const options = rest.length > 0 && rest[0] && typeof rest[0] === 'object' ? rest[0] : undefined;
        const items = (options ? rest.slice(1) : rest).filter((entry) => typeof entry === 'string');
        transcript.ui.push(normalize({ kind, message, ...(options ? { options } : {}), items }));
        // A toast without buttons has nothing to answer: it takes no queued answer.
        return items.length > 0 ? nextAnswer(items) : Promise.resolve(undefined);
    };
    const fake = createFakeVscode({
        overrides: {
            window: {
                showInformationMessage: showMessage('info'),
                showWarningMessage: showMessage('warning'),
                showErrorMessage: showMessage('error'),
                showQuickPick: (items, options) => {
                    transcript.ui.push(normalize({ kind: 'quickPick', items, options }));
                    return nextAnswer(items);
                },
            },
        },
    });

    // Console lines, and logger calls rendered in the same console shape
    // (helpers/logCapture.cjs), so the golden outlives the logging migration.
    const record = (level, first, rest) => {
        if (typeof first === 'string' && /^ACTIVE_SERVER(:|_)/.test(first)) {
            const extra = rest.length > 0 ? ` ${JSON.stringify(normalize(rest))}` : '';
            transcript.console.push(`${level}: ${normalizeString(first)}${extra}`);
        }
    };
    const original = { log: console.log, warn: console.warn, error: console.error };
    for (const level of Object.keys(original)) {
        console[level] = (first, ...rest) => record(level, first, rest);
    }
    const realNow = Date.now;
    let localIp = scenario.localIp || '192.0.2.10';

    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            const { ServerActionHandlers } = requireOut('features/active-servers/views/handleServerActions.js');
            const loaded = (relativePath) => require(path.join(projectRoot, 'out', ...relativePath.split('/')));
            observeLogsAsConsole(loaded('platform/logging/sink.js'), record);

            const { PreviewRenderer } = loaded('features/active-servers/services/previewRenderer.js');
            PreviewRenderer.openPreview = async (...args) => {
                transcript.calls.push(normalize(['openPreview', ...args]));
                if (scenario.previewFails) {
                    throw new Error('no browser available');
                }
            };
            const { NetworkUtils } = loaded('core/server/networkUtils.js');
            NetworkUtils.getLocalIPAddress = () => localIp;
            const { ServerSettingsManager } = loaded('core/server/serverSettingsManager.js');
            ServerSettingsManager.getInstance = () => ({
                getServerSettings: () => ({ remoteAccess: { enabled: scenario.remoteEnabled === true } }),
            });
            const { RemoteAccessManager } = loaded('core/remote-access/remoteAccessManager.js');
            RemoteAccessManager.getInstance = () => (scenario.remoteManager === 'missing' ? null : {
                startSharing: async (serverId) => {
                    transcript.calls.push(['startSharing', serverId]);
                    return scenario.remoteStartState || SHARED_STATE;
                },
                copyInvitation: async (serverId) => {
                    transcript.calls.push(['copyInvitation', serverId]);
                },
                stopSharing: async (...args) => {
                    transcript.calls.push(['stopSharing', ...args]);
                },
                stopAll: async () => {
                    transcript.calls.push(['stopAll']);
                },
            });
            const { ServerControl } = loaded('core/server/serverControl.js');
            const control = { stopServer: [...((scenario.control || {}).stopServer || [])], stopAllServers: [...((scenario.control || {}).stopAllServers || [])] };
            for (const method of ['stopServer', 'stopAllServers']) {
                ServerControl[method] = async (...args) => {
                    transcript.calls.push([`ServerControl.${method}`, ...args]);
                    const outcome = control[method].shift();
                    if (outcome === 'throw') {
                        throw new Error(`${method} exploded`);
                    }
                    return outcome;
                };
            }

            Date.now = () => NOW;
            const { getActiveServerRegistry } = loaded('core/server/registry/activeServerRegistry.js');
            const registry = getActiveServerRegistry();
            const ids = [];
            for (const config of scenario.servers || []) {
                const { remoteAccess, runtime, ...registration } = config;
                const server = registry.registerServer({ ...registration, serverInstance: buildRuntime(runtime, transcript.calls) });
                if (remoteAccess) {
                    server.remoteAccess = { ...remoteAccess };
                }
                ids.push(server.id);
            }

            const H = {
                async call(name, ...args) {
                    transcript.calls.push(normalize([name, ...args]));
                    try {
                        await ServerActionHandlers[name](...args);
                    } catch (error) {
                        transcript.calls.push(['threw', normalize(error)]);
                    }
                },
                setLocalIp(value) {
                    localIp = value;
                },
            };
            await scenario.run(H, ids);
            for (let i = 0; i < 3; i += 1) {
                await new Promise((resolve) => setImmediate(resolve));
            }
            transcript.publicStatics = PUBLIC_STATICS.filter((name) => typeof ServerActionHandlers[name] === 'function');
        });
    } finally {
        Date.now = realNow;
        Object.assign(console, original);
    }

    transcript.executedCommands = normalize(fake.executedCommands);
    transcript.clipboard = fake.clipboard;
    transcript.unusedAnswers = answers.length;
    return transcript;
}

const transcripts = {};

for (const [name, scenario] of Object.entries(SCENARIOS)) {
    test(`server actions: ${name}`, async () => {
        transcripts[name] = await runScenario(scenario);
        assert.equal(transcripts[name].unusedAnswers, 0, 'every queued answer is consumed');
        assert.deepEqual(transcripts[name].publicStatics, PUBLIC_STATICS);
    });
}

test('server action transcripts match the golden file written on the unsplit handlers', () => {
    assert.equal(Object.keys(transcripts).length, Object.keys(SCENARIOS).length);
    if (process.env.CODEXR_UPDATE_GOLDEN === '1') {
        fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
        fs.writeFileSync(goldenPath, `${JSON.stringify(transcripts, null, 2)}\n`);
    }
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
    assert.deepEqual(transcripts, golden);
});

test('server actions: the clipboard strings and stopAll, stated outright', () => {
    assert.equal(transcripts['quick pick on an HTTP server: Copy URL then Network URL'].clipboard, 'http://192.0.2.10:3000');
    assert.equal(transcripts['copy URL: Local, cancelled, and on localhost'].clipboard, 'https://localhost:3443');
    assert.equal(transcripts['copy the LAN URL'].clipboard, 'https://192.0.2.10:3443');
    assert.equal(transcripts['remote access through the manager'].clipboard, SHARED_STATE.invitationUrl);
    assert.equal(transcripts['remote access started but not shared: no clipboard'].clipboard, '');

    const stopAll = transcripts['stop all: one summary from the returned counts'];
    const toasts = stopAll.ui.filter((entry) => entry.kind !== 'warning' || !entry.message.startsWith('Stop all'));
    assert.deepEqual(toasts.map((entry) => entry.message), [
        'Stopped 2 server(s)',
        'Stopped 1 of 2 server(s). The others were removed from the list but did not shut down cleanly; see the Code-XR output.',
        'Error stopping servers: stopAllServers exploded',
    ]);
    // The tree is refreshed after a "partial" stop too, never after a throw.
    assert.deepEqual(stopAll.executedCommands.map((entry) => entry.id), [
        'codeXR.activeServers.refreshServers',
        'codeXR.activeServers.refreshServers',
    ]);
    // The remote tunnels are closed before the servers are, every time.
    const order = stopAll.calls.map((entry) => entry[0]).filter((name) => name === 'stopAll' || name === 'ServerControl.stopAllServers');
    assert.deepEqual(order, ['stopAll', 'ServerControl.stopAllServers', 'stopAll', 'ServerControl.stopAllServers', 'stopAll', 'ServerControl.stopAllServers']);
});
