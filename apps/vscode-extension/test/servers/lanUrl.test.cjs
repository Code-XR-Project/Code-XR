/**
 * Behavioural characterization of the three places that build a server's
 * local-network (LAN) address without a localhost guard, written before
 * ROADMAP T48 made them call NetworkUtils.getPrimaryExternalUrl:
 *   - the "Local network address" row under an active server
 *     (features/active-servers/views/activeServerItems.ts);
 *   - the "Network" line of the server details
 *     (features/active-servers/views/serverDetailsFormat.ts);
 *   - "Copy Network URL" (ServerActionHandlers.copyLanUrl).
 *
 * The first two take the protocol from certMode ('http' -> http, anything
 * else -> https), the third from the server URL's scheme. Both rules are
 * pinned as they are.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

function makeServer(overrides) {
    return {
        id: 'srv-1',
        port: 5555,
        url: 'https://localhost:5555',
        certMode: 'default',
        status: 'running',
        timestamp: Date.now(),
        metadata: {},
        ...overrides,
    };
}

async function withNetwork(body) {
    const fake = createFakeVscode();
    await withFakeVscode(fake, async ({ requireOut }) => {
        const { NetworkUtils } = requireOut('core/server/networkUtils.js');
        NetworkUtils.getLocalIPAddress = () => '192.0.2.7';
        await body({ fake, requireOut });
    });
}

test('the "Local network address" row: protocol from certMode, the local IP and the port', async () => {
    await withNetwork(async ({ requireOut }) => {
        const { ActiveServerItemFactory } = requireOut('features/active-servers/views/activeServerItems.js');
        const { ServerSettingsManager } = requireOut('core/server/serverSettingsManager.js');
        ServerSettingsManager.getInstance = () => ({ getServerSettings: () => ({ remoteAccess: { enabled: false } }) });
        const cases = [
            [{ certMode: 'http', url: 'http://localhost:5555' }, 'http://192.0.2.7:5555'],
            [{ certMode: 'default' }, 'https://192.0.2.7:5555'],
            [{ certMode: 'custom' }, 'https://192.0.2.7:5555'],
            [{ certMode: 'http', url: 'https://localhost:5555' }, 'http://192.0.2.7:5555'],
        ];
        for (const [overrides, expected] of cases) {
            const [first] = ActiveServerItemFactory.createServerChildren(makeServer(overrides), []);
            assert.equal(first.label, 'Local network address');
            assert.equal(first.description, expected, JSON.stringify(overrides));
            assert.equal(first.tooltip, `Local network address\n${expected}`);
        }
    });
});

test('the details "Network" line: protocol from certMode', async () => {
    await withNetwork(async ({ requireOut }) => {
        const { formatServerDetails } = requireOut('features/active-servers/views/serverDetailsFormat.js');
        assert.match(formatServerDetails(makeServer({ certMode: 'http', url: 'http://localhost:5555' })), /http:\/\/192\.0\.2\.7:5555/);
        assert.match(formatServerDetails(makeServer({ certMode: 'default' })), /https:\/\/192\.0\.2\.7:5555/);
    });
});

test('Copy Network URL: protocol from the server URL scheme', async () => {
    await withNetwork(async ({ fake, requireOut }) => {
        const { getActiveServerRegistry } = requireOut('core/server/registry/activeServerRegistry.js');
        const { ServerActionHandlers } = requireOut('features/active-servers/views/handleServerActions.js');
        const registry = getActiveServerRegistry();
        const originalGetServer = registry.getServer;
        const servers = {
            plain: makeServer({ id: 'plain', certMode: 'default', url: 'http://localhost:5555' }),
            secure: makeServer({ id: 'secure', certMode: 'http', url: 'https://localhost:6666', port: 6666 }),
        };
        registry.getServer = (id) => servers[id];
        try {
            await ServerActionHandlers.copyLanUrl('plain');
            assert.equal(fake.clipboard, 'http://192.0.2.7:5555');
            await ServerActionHandlers.copyLanUrl('secure');
            assert.equal(fake.clipboard, 'https://192.0.2.7:6666');
            assert.deepEqual(fake.messages.map((entry) => entry.message), [
                'Network address copied: http://192.0.2.7:5555',
                'Network address copied: https://192.0.2.7:6666',
            ]);
        } finally {
            registry.getServer = originalGetServer;
        }
    });
});
