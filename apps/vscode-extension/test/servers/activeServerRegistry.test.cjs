'use strict';

/**
 * Characterization of the active-server registry's change event
 * (active_servers/registry/activeServerRegistry.ts), through compiled out/
 * code. Three consumers subscribe to `onRegistryChange` (the ACTIVE SERVERS
 * tree, the analysis watcher integration and the remote-access manager) and
 * rely on the VS Code `Event` contract: `(listener, thisArgs?, disposables?)`
 * returns a disposable, listeners run in subscription order, and nothing is
 * delivered after the registry is disposed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createFakeVscode, withFakeVscode } = require('../helpers/fakeVscode.cjs');

const REGISTRY = 'active_servers/registry/activeServerRegistry.js';
const projectRoot = path.resolve(__dirname, '..', '..');

function loadRegistry(callback) {
    return withFakeVscode(createFakeVscode(), ({ requireOut }) => {
        const { ActiveServerRegistry } = requireOut(REGISTRY);
        return callback(ActiveServerRegistry.getInstance());
    });
}

function serverConfig(port) {
    return {
        port,
        url: `http://localhost:${port}`,
        launchMode: 'browser',
        certMode: 'http',
        timestamp: 1000 + port,
        htmlFile: '/fixture/index.html',
    };
}

function summarize(event) {
    return {
        type: event.type,
        serverId: event.serverId,
        server: event.server ? `${event.server.id}:${event.server.status}` : event.server,
        timestamp: typeof event.timestamp,
    };
}

test('registry events: every mutation fires one event with type, id, server and a timestamp', () => {
    loadRegistry((registry) => {
        const events = [];
        registry.onRegistryChange((event) => events.push(summarize(event)));

        const server = registry.registerServer(serverConfig(3000));
        assert.equal(server.id, 'server-3000-4000');
        assert.equal(registry.updateServerStatus(server.id, 'stopped'), true);
        assert.equal(registry.updateRemoteAccessState(server.id, { status: 'shared' }), true);
        assert.equal(registry.unregisterServer(server.id), true);
        registry.registerServer(serverConfig(3001));
        registry.clearAll();

        assert.deepEqual(events, [
            { type: 'serverAdded', serverId: 'server-3000-4000', server: 'server-3000-4000:running', timestamp: 'number' },
            { type: 'serverUpdated', serverId: 'server-3000-4000', server: 'server-3000-4000:stopped', timestamp: 'number' },
            { type: 'serverUpdated', serverId: 'server-3000-4000', server: 'server-3000-4000:stopped', timestamp: 'number' },
            { type: 'serverRemoved', serverId: 'server-3000-4000', server: 'server-3000-4000:stopped', timestamp: 'number' },
            { type: 'serverAdded', serverId: 'server-3001-4001', server: 'server-3001-4001:running', timestamp: 'number' },
            { type: 'registryCleared', serverId: undefined, server: undefined, timestamp: 'number' },
        ]);
    });
});

test('registry events: operations on an unknown id fire nothing and return false', () => {
    loadRegistry((registry) => {
        const events = [];
        registry.onRegistryChange((event) => events.push(event.type));

        assert.equal(registry.unregisterServer('missing'), false);
        assert.equal(registry.updateServerStatus('missing', 'error'), false);
        assert.equal(registry.updateRemoteAccessState('missing', { status: 'shared' }), false);
        assert.deepEqual(events, []);
    });
});

test('registry events: listeners run in subscription order, honour thisArgs and push into disposables', () => {
    loadRegistry((registry) => {
        const calls = [];
        const owner = { name: 'owner' };
        const disposables = [];
        registry.onRegistryChange(() => calls.push('first'));
        const returned = registry.onRegistryChange(function bound() {
            calls.push(`second:${this.name}`);
        }, owner, disposables);
        registry.onRegistryChange(() => calls.push('third'));

        assert.equal(disposables.length, 1);
        assert.equal(disposables[0], returned);
        assert.equal(typeof returned.dispose, 'function');

        registry.registerServer(serverConfig(3002));
        assert.deepEqual(calls, ['first', 'second:owner', 'third']);
    });
});

test('registry events: a disposed subscription receives nothing more', () => {
    loadRegistry((registry) => {
        const kept = [];
        const dropped = [];
        registry.onRegistryChange((event) => kept.push(event.type));
        const subscription = registry.onRegistryChange((event) => dropped.push(event.type));

        registry.registerServer(serverConfig(3003));
        subscription.dispose();
        subscription.dispose();
        registry.clearAll();

        assert.deepEqual(kept, ['serverAdded', 'registryCleared']);
        assert.deepEqual(dropped, ['serverAdded']);
    });
});

test('registry dispose: clears the servers without delivering registryCleared', () => {
    loadRegistry((registry) => {
        const events = [];
        registry.onRegistryChange((event) => events.push(event.type));
        registry.registerServer(serverConfig(3004));

        registry.dispose();

        assert.equal(registry.getServerCount(), 0);
        assert.deepEqual(events, ['serverAdded']);
    });
});

test('registry events: a throwing listener is reported and does not stop the others', () => {
    withFakeVscode(createFakeVscode(), ({ requireOut }) => {
        const { observeLogEntries } = requireOut('core/logging/sink.js');
        const { ActiveServerRegistry } = requireOut(REGISTRY);
        const registry = ActiveServerRegistry.getInstance();
        const errors = [];
        const stopObserving = observeLogEntries((entry) => {
            if (entry.level === 'error') {
                errors.push(`${entry.scope}: ${entry.message}`);
            }
        });
        const calls = [];
        registry.onRegistryChange(() => {
            throw new Error('listener failed');
        });
        registry.onRegistryChange((event) => calls.push(event.type));

        try {
            assert.doesNotThrow(() => registry.registerServer(serverConfig(3005)));
        } finally {
            stopObserving();
        }

        assert.deepEqual(calls, ['serverAdded']);
        assert.deepEqual(errors, ['ACTIVE_SERVERS: Registry change listener failed:']);
    });
});

test('registry module: loads without the vscode module, and a late subscriber after dispose hears nothing', () => {
    const filename = path.join(projectRoot, 'out', ...REGISTRY.split('/'));
    delete require.cache[filename];
    try {
        const { ActiveServerRegistry } = require(filename);
        const registry = ActiveServerRegistry.getInstance();
        const events = [];
        registry.onRegistryChange((event) => events.push(event.type));
        registry.registerServer(serverConfig(3006));
        registry.dispose();
        registry.onRegistryChange((event) => events.push(`late:${event.type}`));
        registry.registerServer(serverConfig(3007));
        assert.deepEqual(events, ['serverAdded']);
    } finally {
        delete require.cache[filename];
    }
});
